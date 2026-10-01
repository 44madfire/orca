// MAJOR-3 host-level Pi and OMP happy path through the real host boundary.
// Proves attach ownership plus send settlement plus journal lifecycle plus proven close.
// Enters via StructuredAgentSessionHost, then router, then one shared adapter.
// Uses production createPiRpcBackend plus scripted pi and omp children.
// Covers only the primary happy path; restart and handoff keep their own suites.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { spawnProcess } from '../../../shared/child-process/run-process'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { createPiRpcBackend } from '../../pi/pi-rpc-backend'
import { PiStructuredSessionAdapter } from '../../pi/pi-structured-session-adapter'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import { attachFingerprintFields } from './structured-agent-session-attach'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { StructuredAgentSessionHost } from './structured-agent-session-host'

const PI_SCRIPT = fileURLToPath(
  new URL('../../pi/rpc/__fixtures__/scripted-pi-child.mjs', import.meta.url)
)
const OMP_SCRIPT = fileURLToPath(
  new URL('../../pi/rpc/__fixtures__/scripted-omp-child.mjs', import.meta.url)
)

type Provider = 'pi' | 'omp'
type Settlement = {
  sessionId: string
  clientMessageId: string
  session: string
  recordId: string
}

const CALLER = { callerKey: 'client-1' }
const DIRS: string[] = []
afterEach(() => {
  for (const dir of DIRS.splice(0)) {
    rmDir(dir)
  }
  vi.restoreAllMocks()
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-family-host-'))
  DIRS.push(dir)
  return dir
}

function rmDir(dir: string): void {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      const start = Date.now()
      while (Date.now() - start < 100) {
        // Busy-wait keeps the test synchronous and short.
      }
    }
  }
}

function textBody(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function inertAdapter(): StructuredAgentSessionAdapter {
  const refuse = async (): Promise<never> => {
    throw new Error('inert stub adapter owns no sessions')
  }
  return {
    acquire: refuse,
    dispatch: refuse,
    cancelTurn: refuse,
    answerPrompt: refuse,
    setOption: refuse
  }
}

function locationFor(): AgentSessionExecutionLocation {
  return {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'folder'
  }
}

function attachParamsFor(
  sessionId: string,
  provider: Provider,
  accountPath: string,
  operationId: string
): AgentSessionAttachParams {
  const base: AgentSessionAttachParams = {
    envelope: {
      sessionId,
      clientOperationId: operationId,
      expectedRuntimeFence: null,
      payloadFingerprint: '0'.repeat(64)
    },
    location: locationFor(),
    provider,
    agent: provider,
    accountHome: { variable: 'PI_STATE_DIR', path: accountPath },
    runtimeKind: 'native'
  }
  const fingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.attach',
    sessionId,
    fields: attachFingerprintFields(base)
  })
  return {
    ...base,
    envelope: { ...base.envelope, payloadFingerprint: fingerprint }
  }
}

let operations = 0
function operationId(): string {
  operations += 1
  return `${Date.now()}-${operations.toString(16).padStart(32, '0')}`
}
function sendEnvelopeFor(
  sessionId: string,
  fence: number,
  clientMessageId: string,
  body: AgentJournalMessageItem
): AgentSessionMutationEnvelope {
  return {
    sessionId,
    clientOperationId: clientMessageId,
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId,
      fields: { body }
    })
  }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) {
      return
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for host integration condition: ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe.each(['pi', 'omp'] as const)('host-level happy path for %s', (provider) => {
  it('attach owns the lease, send settles, journal proves it, close proves the exit', async () => {
    const root = workspace()
    const workspaceDir = join(root, 'workspace')
    mkdirSync(workspaceDir, { recursive: true })
    mkdirSync(join(root, 'pi-state'), { recursive: true })
    const providerSessionId = `${provider}-host-happy-1`
    const sessionFile = join(workspaceDir, `${provider}-session.jsonl`)
    writeFileSync(sessionFile, '')
    const env =
      provider === 'pi'
        ? { PI_SCRIPT_SESSION_FILE: sessionFile, PI_SCRIPT_SESSION_ID: providerSessionId }
        : { OMP_SCRIPT_SESSION_FILE: sessionFile, OMP_SCRIPT_SESSION_ID: providerSessionId }
    const sessionId = `ses-host-${provider}-happy`
    const store = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    const settlements: Settlement[] = []
    const spawns: string[] = []
    // Circular wiring matches production: late settlement and exits re-enter the host.
    let host: StructuredAgentSessionHost | null = null
    const backend = createPiRpcBackend({
      piCommand: process.execPath,
      piArgs: [PI_SCRIPT],
      ompCommand: process.execPath,
      ompArgs: [OMP_SCRIPT],
      resolveEnv: () => ({ ...process.env, ...env }),
      spawnImpl: (spec) => {
        spawns.push(`${spec.program} ${(spec.args ?? []).join(' ')}`)
        return spawnProcess(spec)
      }
    })
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => workspaceDir,
      backend,
      readProcessStartTime: async () => 777,
      onDispatchSettledLate: (settlement) => {
        const identity = settlement.providerIdentity
        if (identity.provider !== 'legacy') {
          return
        }
        settlements.push({
          sessionId: settlement.sessionId,
          clientMessageId: settlement.clientMessageId,
          session: identity.sessionId,
          recordId: identity.recordId
        })
        void host?.settleLateDispatch(settlement).catch(() => undefined)
      },
      onEvent: (event) => {
        void host?.handleAdapterEvent(event).catch(() => undefined)
      }
    })
    // Test seam covers the Windows start-time proof; acquire still uses the real adapter path.
    adapter.supportsCreate = () => true
    adapter.supportsLocation = () => true
    const router = new StructuredAgentSessionAdapterRouter(
      { claude: inertAdapter(), codex: inertAdapter(), pi: adapter },
      async () => {
        await adapter.closeAll()
      }
    )
    host = new StructuredAgentSessionHost({
      store,
      adapter: router,
      recoveryCapsule: new AgentSessionRecoveryCapsule(root),
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken: () => `spawn-${sessionId}`,
      now: () => Date.now()
    })
    const live = host
    try {
      // Capability answers through the host, never around it.
      expect(live.supportsCreate(locationFor(), provider)).toBe(true)
      operations = 0
      const attached = await live.attach(
        CALLER,
        attachParamsFor(sessionId, provider, join(root, 'pi-state'), operationId())
      )
      if (!attached.ok) {
        throw new Error(`host attach refused: ${attached.refusal.code} ${attached.refusal.message}`)
      }
      const fence = attached.fence
      expect(fence).toBeGreaterThan(0)
      expect(live.hasSession(sessionId)).toBe(true)
      // Durable ownership: live lease plus exact provider chain head.
      const record = store.getRecord(sessionId)
      if (!record) {
        throw new Error('host attach left no durable record')
      }
      expect(record.provider).toBe(provider)
      expect(record.lease.claimStatus).toBe('live')
      expect(record.lease.runtimeFence).toBe(fence)
      expect(record.lease.handoffStage).toBeNull()
      const pid = record.lease.ownerProcess?.pid ?? 0
      expect(pid).toBeGreaterThan(0)
      const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
      if (!head || head.handle.provider !== provider) {
        throw new Error('durable chain head misses the provider discriminant')
      }
      expect(head.handle.sessionId).toBe(providerSessionId)
      expect(head.handle.sessionFile).toBe(sessionFile)
      // Exactly one provider child for the live session.
      expect(spawns).toHaveLength(1)
      // Primary turn through the host mutation path.
      const body = textBody('hello host happy path')
      const clientMessageId = operationId()
      const sent = await live.send(CALLER, {
        envelope: sendEnvelopeFor(sessionId, fence, clientMessageId, body),
        body
      })
      if (!sent.ok) {
        throw new Error(`host send refused: ${sent.refusal.code}`)
      }
      expect(sent.value.clientMessageId).toBe(clientMessageId)
      await waitFor(
        () => settlements.some((entry) => entry.clientMessageId === clientMessageId),
        `late settlement for ${clientMessageId}`
      )
      const settled = settlements.find((entry) => entry.clientMessageId === clientMessageId)
      if (!settled) {
        throw new Error('late settlement vanished after the wait')
      }
      expect(settled.session).toBe(providerSessionId)
      expect(settled.recordId.length).toBeGreaterThan(0)
      expect(settled.recordId).not.toBe(clientMessageId)
      // Journal lifecycle: durable submission accepted plus provider history proof.
      await waitFor(() => {
        const snapshot = live.journalSnapshot(sessionId)
        const row = snapshot.submissions.find((entry) => entry.clientMessageId === clientMessageId)
        return row?.dispatchState === 'accepted'
      }, `journal acceptance for ${clientMessageId}`)
      const snapshot = live.journalSnapshot(sessionId)
      const submission = snapshot.submissions.find(
        (entry) => entry.clientMessageId === clientMessageId
      )
      if (!submission || submission.dispatchState !== 'accepted') {
        throw new Error('journal submission never reached accepted')
      }
      expect(submission.providerItemId).toContain(settled.recordId)
      expect(snapshot.cursor.sequence).toBeGreaterThan(0)
      const history = await backend.readEntries?.({ orcaSessionId: sessionId })
      const historyIds: string[] = []
      for (const entry of history?.entries ?? []) {
        if (typeof entry === 'object' && entry !== null && 'id' in entry) {
          const id: unknown = entry.id
          if (typeof id === 'string') {
            historyIds.push(id)
          }
        }
      }
      expect(historyIds).toContain(settled.recordId)
      const page = live.history({ sessionId, direction: 'tail' })
      if (!page.ok) {
        throw new Error('host history refused the live session')
      }
      expect(page.page.fence).toBe(fence)
      // Proven close keeps the durable record while forgetting the live child.
      await live.close(sessionId)
      expect(live.hasSession(sessionId)).toBe(false)
      expect(store.getRecord(sessionId)?.lease.claimStatus).toBe('released')
      expect(spawns).toHaveLength(1)
      await live.close(sessionId)
    } finally {
      await live.flushAllStreamedEvents().catch(() => undefined)
    }
  })
})
