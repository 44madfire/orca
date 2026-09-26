// Pi-family prompt mapping and exactly-once answers (PIF-6, #27).
//
// Over scripted children for BOTH providers: provider blocking UI requests
// map into EXISTING Orca prompt types (confirm -> one approval, select ->
// question with preserved options, input -> free-text question); an
// unsupported OMP-specific UI record stays bounded and non-blocking. Answers
// are exactly-once through the adapter claim -> host commit -> single
// provider response order: the first valid answer commits and sends one
// response, duplicates send none, stale requests are refused before commit,
// an answer-vs-prompt-cancel race has exactly one winner, and provider final
// settle (flavor predicate, never a hard-coded event name), close, exit, and
// generation replacement all retire outstanding requests. No live LLM.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { AgentSessionPromptUnavailableError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createPiRpcBackend } from './pi-rpc-backend'
import { PiFamilyPromptClaims } from './pi-family-prompt-answers'
import { PiStructuredSessionAdapter } from './pi-structured-session-adapter'
import { PiFamilyRpcConnection } from './rpc/pi-family-rpc-connection'

const PI_SCRIPT = fileURLToPath(
  new URL('./rpc/__fixtures__/scripted-pi-child.mjs', import.meta.url)
)
const OMP_SCRIPT = fileURLToPath(
  new URL('./rpc/__fixtures__/scripted-omp-child.mjs', import.meta.url)
)

type Provider = 'pi' | 'omp'
type Row = { identityKey: string; body: AgentJournalItemBody }

const DIRS: string[] = []
afterEach(() => {
  for (const dir of DIRS.splice(0)) {
    rmDir(dir)
  }
  vi.restoreAllMocks()
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-family-prompts-'))
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

function sessionEnv(provider: Provider, dir: string, sessionId: string): Record<string, string> {
  const file = join(dir, `${provider}-session.jsonl`)
  writeFileSync(file, '')
  return provider === 'pi'
    ? { PI_SCRIPT_SESSION_FILE: file, PI_SCRIPT_SESSION_ID: sessionId }
    : { OMP_SCRIPT_SESSION_FILE: file, OMP_SCRIPT_SESSION_ID: sessionId }
}

function backendWithScripts(env: Record<string, string>) {
  return createPiRpcBackend({
    piCommand: process.execPath,
    piArgs: [PI_SCRIPT],
    ompCommand: process.execPath,
    ompArgs: [OMP_SCRIPT],
    resolveEnv: () => ({ ...process.env, ...env })
  })
}

function freshIdentity(sessionId: string, provider: Provider): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: provider,
    providerHandle: { kind: 'opaque', agent: provider, value: 'pending' }
  }
}

function textBody(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function capturingSink(rows: Row[]): StructuredAgentSessionEventSink {
  return {
    appendItem: (identity, body) => {
      rows.push({ identityKey: agentJournalItemKey(identity), body })
    },
    appendTombstone: () => undefined,
    publish: () => undefined,
    setActivity: () => undefined
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) {
      return
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for scripted Pi-family prompt condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function responsesSpy() {
  return vi.spyOn(PiFamilyRpcConnection.prototype, 'respondToExtensionUi')
}

function promptOwnerOf(
  backend: ReturnType<typeof backendWithScripts>,
  sessionId: string,
  itemKey: string
): { requestId: string; opId: string } | null {
  return backend.promptOwner?.({ orcaSessionId: sessionId, itemKey }) ?? null
}

function must<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`test requires backend.${name}`)
  }
  return value
}

function promptRows(rows: Row[]): Row[] {
  return rows.filter((row) => row.body.kind === 'approval' || row.body.kind === 'question')
}

async function waitPromptKey(rows: Row[]): Promise<string> {
  let key = ''
  await waitFor(() => {
    const found = promptRows(rows).at(0)
    if (found) {
      key = found.identityKey
      return true
    }
    return false
  })
  return key
}

describe.each(['pi', 'omp'] as const)('prompt mapping over a %s child', (provider) => {
  it('maps confirm to one approval', async () => {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv(provider, dir, `${provider}-map-confirm`))
    const rows: Row[] = []
    const sessionId = `ses-${provider}-map-confirm`
    try {
      await backend.acquire({
        orcaSessionId: sessionId,
        workspaceRoot: dir,
        provider,
        spawnToken: 's1',
        sink: capturingSink(rows)
      })
      const pending = backend.dispatch({
        orcaSessionId: sessionId,
        body: textBody('PROMPT-ME please')
      })
      const key = await waitPromptKey(rows)
      const found = promptRows(rows)
      expect(found).toHaveLength(1)
      expect(found[0]?.identityKey).toBe(key)
      expect(found[0]?.body).toMatchObject({
        kind: 'approval',
        title: 'Scripted?',
        options: [
          { id: 'confirm', label: 'Confirm' },
          { id: 'cancel', label: 'Cancel' }
        ],
        resolution: { state: 'pending' }
      })
      await must(
        backend.answerPrompt,
        'answerPrompt'
      )({ orcaSessionId: sessionId, itemKey: key, kind: 'approval', optionId: 'confirm' })
      await expect(pending).resolves.toEqual({ status: 'accepted' })
      await waitFor(() => (backend.liveTurnId?.({ orcaSessionId: sessionId }) ?? null) === null)
      await expect(backend.close({ orcaSessionId: sessionId })).resolves.toBe(true)
    } finally {
      await backend.close({ orcaSessionId: sessionId }).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('maps select to a question preserving options', async () => {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv(provider, dir, `${provider}-map-select`))
    const rows: Row[] = []
    const sessionId = `ses-${provider}-map-select`
    try {
      await backend.acquire({
        orcaSessionId: sessionId,
        workspaceRoot: dir,
        provider,
        spawnToken: 's1',
        sink: capturingSink(rows)
      })
      const pending = backend.dispatch({
        orcaSessionId: sessionId,
        body: textBody('PROMPT-SELECT please')
      })
      const key = await waitPromptKey(rows)
      expect(promptRows(rows)).toHaveLength(1)
      expect(promptRows(rows)[0]?.body).toMatchObject({
        kind: 'question',
        question: 'Pick one',
        options: [
          { id: 'alpha', label: 'alpha' },
          { id: 'beta', label: 'beta' }
        ],
        resolution: { state: 'pending' }
      })
      await must(
        backend.answerPrompt,
        'answerPrompt'
      )({ orcaSessionId: sessionId, itemKey: key, kind: 'question', optionId: 'alpha' })
      await expect(pending).resolves.toEqual({ status: 'accepted' })
      await waitFor(() => (backend.liveTurnId?.({ orcaSessionId: sessionId }) ?? null) === null)
      await expect(backend.close({ orcaSessionId: sessionId })).resolves.toBe(true)
    } finally {
      await backend.close({ orcaSessionId: sessionId }).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('maps input to the free-text question shape', async () => {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv(provider, dir, `${provider}-map-input`))
    const rows: Row[] = []
    const sessionId = `ses-${provider}-map-input`
    try {
      await backend.acquire({
        orcaSessionId: sessionId,
        workspaceRoot: dir,
        provider,
        spawnToken: 's1',
        sink: capturingSink(rows)
      })
      const pending = backend.dispatch({
        orcaSessionId: sessionId,
        body: textBody('PROMPT-INPUT please')
      })
      const key = await waitPromptKey(rows)
      expect(promptRows(rows)).toHaveLength(1)
      expect(promptRows(rows)[0]?.body).toMatchObject({
        kind: 'question',
        question: 'Name it',
        options: [{ id: 'submit', label: 'Submit' }],
        freeTextQuestionId: 'input',
        resolution: { state: 'pending' }
      })
      await must(
        backend.answerPrompt,
        'answerPrompt'
      )({ orcaSessionId: sessionId, itemKey: key, kind: 'question', optionId: 'submit' })
      await expect(pending).resolves.toEqual({ status: 'accepted' })
      await waitFor(() => (backend.liveTurnId?.({ orcaSessionId: sessionId }) ?? null) === null)
      await expect(backend.close({ orcaSessionId: sessionId })).resolves.toBe(true)
    } finally {
      await backend.close({ orcaSessionId: sessionId }).catch(() => undefined)
      rmDir(dir)
    }
  })
})

describe('OMP extras stay bounded and non-blocking', () => {
  it('ignores host-tool/subagent/notice records mid-turn and still settles', async () => {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv('omp', dir, 'omp-noise-turn'))
    const rows: Row[] = []
    const sessionId = 'ses-omp-noise-turn'
    try {
      await backend.acquire({
        orcaSessionId: sessionId,
        workspaceRoot: dir,
        provider: 'omp',
        spawnToken: 's1',
        sink: capturingSink(rows)
      })
      const drain = backend.drainPromptFacts?.bind(backend)
      expect(drain).toBeDefined()
      drain?.({ orcaSessionId: sessionId })
      await expect(
        backend.dispatch({ orcaSessionId: sessionId, body: textBody('NOISE-TURN please') })
      ).resolves.toEqual({ status: 'accepted' })
      await waitFor(() => (backend.liveTurnId?.({ orcaSessionId: sessionId }) ?? null) === null)
      // No new UI type was created for the extras: zero prompt rows.
      expect(promptRows(rows)).toHaveLength(0)
      // The turn itself still settled through the normal dialect frames.
      expect(drain?.({ orcaSessionId: sessionId })).toContainEqual({
        kind: 'prompt-result',
        agentInvoked: true
      })
      await expect(backend.close({ orcaSessionId: sessionId })).resolves.toBe(true)
    } finally {
      await backend.close({ orcaSessionId: sessionId }).catch(() => undefined)
      rmDir(dir)
    }
  })
})

describe.each(['pi', 'omp'] as const)('exactly-once answers over a %s child', (provider) => {
  async function acquired(sessionSuffix: string, fence = 3) {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv(provider, dir, `${provider}-answer`))
    const rows: Row[] = []
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => dir,
      backend,
      readProcessStartTime: async () => Date.now()
    })
    const sessionId = `ses-${provider}-answer-${sessionSuffix}`
    const acquisition = await adapter.acquire({
      identity: freshIdentity(sessionId, provider),
      fence,
      spawnToken: `s-${sessionSuffix}`,
      events: capturingSink(rows)
    })
    return { dir, backend, adapter, rows, sessionId, pid: acquisition.process.pid }
  }

  it('commits the first valid answer and sends exactly one response; duplicates send none', async () => {
    const { dir, backend, adapter, rows, sessionId } = await acquired('once')
    const responses = responsesSpy()
    try {
      const pending = backend.dispatch({
        orcaSessionId: sessionId,
        body: textBody('PROMPT-ME please')
      })
      const key = await waitPromptKey(rows)
      // Sanity: the prompt row the adapter will answer is really there.
      expect(key).not.toBe('')
      const commit = vi.fn(async () => undefined)
      await adapter.answerPrompt({
        sessionId,
        itemId: key,
        kind: 'approval',
        optionId: 'confirm',
        fence: 3,
        commit
      })
      expect(commit).toHaveBeenCalledTimes(1)
      expect(responses).toHaveBeenCalledTimes(1)
      await expect(pending).resolves.toEqual({ status: 'accepted' })
      await waitFor(() => (backend.liveTurnId?.({ orcaSessionId: sessionId }) ?? null) === null)
      // Duplicate: refused before commit, no second provider response.
      const retryCommit = vi.fn(async () => undefined)
      await expect(
        adapter.answerPrompt({
          sessionId,
          itemId: key,
          kind: 'approval',
          optionId: 'confirm',
          fence: 3,
          commit: retryCommit
        })
      ).rejects.toBeInstanceOf(AgentSessionPromptUnavailableError)
      expect(retryCommit).not.toHaveBeenCalled()
      expect(responses).toHaveBeenCalledTimes(1)
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('refuses a stale request before commit without touching the provider', async () => {
    const { dir, adapter, sessionId } = await acquired('stale')
    const responses = responsesSpy()
    try {
      const commit = vi.fn(async () => undefined)
      await expect(
        adapter.answerPrompt({
          sessionId,
          itemId: 'legacy:ses-1:no-such-prompt',
          kind: 'approval',
          optionId: 'confirm',
          fence: 3,
          commit
        })
      ).rejects.toBeInstanceOf(AgentSessionPromptUnavailableError)
      expect(commit).not.toHaveBeenCalled()
      expect(responses).not.toHaveBeenCalled()
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('lets a prompt-bound cancel win when it claims first: the answer sends nothing', async () => {
    const { dir, backend, adapter, rows, sessionId } = await acquired('cancel-wins')
    const responses = responsesSpy()
    const aborts = vi.spyOn(PiFamilyRpcConnection.prototype, 'abort')
    try {
      const pending = backend.dispatch({
        orcaSessionId: sessionId,
        body: textBody('PROMPT-ME please')
      })
      const key = await waitPromptKey(rows)
      const turnId = backend.liveTurnId?.({ orcaSessionId: sessionId })
      expect(turnId).toBeTruthy()
      await expect(
        adapter.cancelTurn({
          sessionId,
          turnId: turnId ?? '',
          fence: 3,
          resolveLiveTurnId: () => turnId ?? null,
          prompt: { itemId: key }
        })
      ).resolves.toEqual({ cancelled: true })
      expect(aborts).toHaveBeenCalledTimes(1)
      // The cancelled prompt is retired: the late answer is refused before commit.
      const commit = vi.fn(async () => undefined)
      await expect(
        adapter.answerPrompt({
          sessionId,
          itemId: key,
          kind: 'approval',
          optionId: 'confirm',
          fence: 3,
          commit
        })
      ).rejects.toBeInstanceOf(AgentSessionPromptUnavailableError)
      expect(commit).not.toHaveBeenCalled()
      expect(responses).not.toHaveBeenCalled()
      // The aborted prompt dispatch resolves as refused, never accepted.
      await expect(pending).resolves.toMatchObject({ status: 'rejected' })
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('lets a concurrent answer win: the prompt-bound cancel sends nothing', async () => {
    const { dir, backend, adapter, rows, sessionId } = await acquired('answer-wins')
    const responses = responsesSpy()
    const aborts = vi.spyOn(PiFamilyRpcConnection.prototype, 'abort')
    try {
      const pending = backend.dispatch({
        orcaSessionId: sessionId,
        body: textBody('PROMPT-ME please')
      })
      const key = await waitPromptKey(rows)
      const turnId = backend.liveTurnId?.({ orcaSessionId: sessionId })
      expect(turnId).toBeTruthy()
      const commit = vi.fn(async () => undefined)
      const [answerOutcome, cancelOutcome] = await Promise.all([
        adapter
          .answerPrompt({
            sessionId,
            itemId: key,
            kind: 'approval',
            optionId: 'confirm',
            fence: 3,
            commit
          })
          .then(
            () => 'answered',
            (error: unknown) => error
          ),
        adapter.cancelTurn({
          sessionId,
          turnId: turnId ?? '',
          fence: 3,
          resolveLiveTurnId: () => turnId ?? null,
          prompt: { itemId: key }
        })
      ])
      // Exactly one winner: the answer claimed first, so the cancel loses.
      expect(answerOutcome).toBe('answered')
      expect(cancelOutcome).toEqual({ cancelled: false })
      expect(commit).toHaveBeenCalledTimes(1)
      expect(responses).toHaveBeenCalledTimes(1)
      expect(aborts).not.toHaveBeenCalled()
      await expect(pending).resolves.toEqual({ status: 'accepted' })
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('retires outstanding requests on provider final settle', async () => {
    const { dir, backend, adapter, rows, sessionId } = await acquired('settle')
    const responses = responsesSpy()
    try {
      const pending = backend.dispatch({
        orcaSessionId: sessionId,
        body: textBody('PROMPT-ME please')
      })
      const key = await waitPromptKey(rows)
      expect(promptOwnerOf(backend, sessionId, key)).not.toBeNull()
      // The dialog is answered at the driver level; the provider's own final
      // frames (Pi `agent_settled`, OMP terminal `agent_end`) settle the turn.
      await must(
        backend.answerPrompt,
        'answerPrompt'
      )({ orcaSessionId: sessionId, itemKey: key, kind: 'approval', optionId: 'confirm' })
      await expect(pending).resolves.toEqual({ status: 'accepted' })
      await waitFor(() => (backend.liveTurnId?.({ orcaSessionId: sessionId }) ?? null) === null)
      expect(promptOwnerOf(backend, sessionId, key)).toBeNull()
      // A late answer after settle is refused before commit: no second response.
      const commit = vi.fn(async () => undefined)
      await expect(
        adapter.answerPrompt({
          sessionId,
          itemId: key,
          kind: 'approval',
          optionId: 'confirm',
          fence: 3,
          commit
        })
      ).rejects.toBeInstanceOf(AgentSessionPromptUnavailableError)
      expect(commit).not.toHaveBeenCalled()
      expect(responses).toHaveBeenCalledTimes(1)
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('retires outstanding requests on close', async () => {
    const { dir, backend, adapter, rows, sessionId } = await acquired('close')
    const responses = responsesSpy()
    try {
      const pending = backend.dispatch({
        orcaSessionId: sessionId,
        body: textBody('PROMPT-ME please')
      })
      void pending
      const key = await waitPromptKey(rows)
      expect(promptOwnerOf(backend, sessionId, key)).not.toBeNull()
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
      expect(promptOwnerOf(backend, sessionId, key)).toBeNull()
      const commit = vi.fn(async () => undefined)
      await expect(
        adapter.answerPrompt({
          sessionId,
          itemId: key,
          kind: 'approval',
          optionId: 'confirm',
          fence: 3,
          commit
        })
      ).rejects.toBeInstanceOf(AgentSessionPromptUnavailableError)
      expect(commit).not.toHaveBeenCalled()
      expect(responses).not.toHaveBeenCalled()
    } finally {
      await adapter.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('retires outstanding requests when the child exits', async () => {
    const { dir, backend, adapter, rows, sessionId, pid } = await acquired('exit')
    const responses = responsesSpy()
    try {
      const pending = backend.dispatch({
        orcaSessionId: sessionId,
        body: textBody('PROMPT-ME please')
      })
      void pending
      const key = await waitPromptKey(rows)
      expect(promptOwnerOf(backend, sessionId, key)).not.toBeNull()
      expect(pid).toBeDefined()
      process.kill(pid ?? -1)
      await waitFor(() => promptOwnerOf(backend, sessionId, key) === null)
      // Retired on exit: the late answer is refused before commit and sends nothing.
      const commit = vi.fn(async () => undefined)
      await expect(
        adapter.answerPrompt({
          sessionId,
          itemId: key,
          kind: 'approval',
          optionId: 'confirm',
          fence: 3,
          commit
        })
      ).rejects.toBeInstanceOf(AgentSessionPromptUnavailableError)
      expect(commit).not.toHaveBeenCalled()
      expect(responses).not.toHaveBeenCalled()
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('refuses a stale generation through a replacement child', async () => {
    const { dir, backend, adapter, rows, sessionId } = await acquired('replace')
    const responses = responsesSpy()
    try {
      const pending = backend.dispatch({
        orcaSessionId: sessionId,
        body: textBody('PROMPT-ME please')
      })
      void pending
      const key = await waitPromptKey(rows)
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
      await adapter.acquire({
        identity: freshIdentity(sessionId, provider),
        fence: 6,
        spawnToken: 's2',
        events: capturingSink(rows)
      })
      // Stale fence: refused on the fence alone.
      const staleCommit = vi.fn(async () => undefined)
      await expect(
        adapter.answerPrompt({
          sessionId,
          itemId: key,
          kind: 'approval',
          optionId: 'confirm',
          fence: 3,
          commit: staleCommit
        })
      ).rejects.toBeInstanceOf(AgentSessionPromptUnavailableError)
      expect(staleCommit).not.toHaveBeenCalled()
      // Current fence but stale callback: the replacement child never owned it.
      const freshCommit = vi.fn(async () => undefined)
      await expect(
        adapter.answerPrompt({
          sessionId,
          itemId: key,
          kind: 'approval',
          optionId: 'confirm',
          fence: 6,
          commit: freshCommit
        })
      ).rejects.toBeInstanceOf(AgentSessionPromptUnavailableError)
      expect(freshCommit).not.toHaveBeenCalled()
      expect(responses).not.toHaveBeenCalled()
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })
})

describe('PiFamilyPromptClaims', () => {
  it('serializes one winner per prompt and scopes releases by session', () => {
    const claims = new PiFamilyPromptClaims()
    expect(claims.claim('ses-a', 'item-1')).toBe(true)
    expect(claims.claim('ses-a', 'item-1')).toBe(false)
    expect(claims.claim('ses-b', 'item-1')).toBe(false)
    // A stranger's release never frees another session's claim.
    claims.release('ses-b', 'item-1')
    expect(claims.claim('ses-a', 'item-1')).toBe(false)
    claims.release('ses-a', 'item-1')
    expect(claims.claim('ses-b', 'item-1')).toBe(true)
    claims.dropSession('ses-b')
    expect(claims.claim('ses-a', 'item-1')).toBe(true)
    claims.dropSession('ses-a')
    expect(claims.claim('ses-a', 'item-1')).toBe(true)
  })
})
