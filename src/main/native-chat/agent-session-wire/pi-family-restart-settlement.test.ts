// PIF-8 (#29): restart settlement for Pi and OMP through the GENERIC journal
// reconciler. A crashed host leaves pending submissions; the next attach marks
// them unknown and lets stable provider history prove delivery. The windows
// under test are built by the shared Pi-family builder, exactly as the adapter
// sampler builds them; no live provider child is needed here.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { ProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import { reconcileJournalSubmissionsAgainstHistory } from '../agent-session-journal/journal-restart-reconciliation'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  buildPiFamilyHistoryWindow,
  PI_FAMILY_INCONSISTENT_WINDOW
} from '../../pi/pi-family-history-window'
import { PiStructuredSessionAdapter } from '../../pi/pi-structured-session-adapter'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { attachJournal, type AgentSessionAttachParams } from './structured-agent-session-attach'

const RECORD = agentSessionRecordFixture()
const ORCA_SESSION = RECORD.sessionId
const FENCE = RECORD.lease.runtimeFence

const PARAMS: AgentSessionAttachParams = {
  envelope: {
    sessionId: ORCA_SESSION,
    clientOperationId: 'op-1',
    expectedRuntimeFence: FENCE,
    payloadFingerprint: 'fp'
  },
  location: RECORD.location,
  provider: 'pi',
  agent: 'pi',
  accountHome: RECORD.accountHome,
  runtimeKind: 'native'
}

function userMessage(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function fingerprint(text: string): string {
  return computeAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: ORCA_SESSION,
    fields: { body: userMessage(text) }
  })
}

function piMessage(id: string, parentId: string | null, role: string, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] }
  }
}

/** Provider history holding exactly the submitted user text after the anchor. */
function windowFor(
  provider: 'pi' | 'omp',
  providerSessionId: string,
  anchor: string,
  text: string,
  leaf: string
): ProviderHistoryWindow {
  const prior =
    provider === 'pi'
      ? piMessage(anchor, null, 'assistant', 'prior')
      : { type: 'omp_message', id: anchor, parentId: null, role: 'assistant', text: 'prior' }
  const user =
    provider === 'pi'
      ? piMessage('n1', anchor, 'user', text)
      : { type: 'omp_message', id: 'n1', parentId: anchor, role: 'user', text }
  const built = buildPiFamilyHistoryWindow({
    provider,
    providerSessionId,
    orcaSessionId: ORCA_SESSION,
    anchorLeafId: anchor,
    entries: [prior, user],
    leafId: leaf
  })
  if (!built.ok) {
    throw new Error(`fixture window failed: ${built.code}`)
  }
  return built.window
}

let root: string
const journals = createTrackedJournalOpener()

/** A previous process rendered the optimistic row, wrote the submission, and died. */
async function crashedJournal(clientMessageId: string, text: string): Promise<AgentSessionJournal> {
  const journal = await journals.open({
    identity: {
      sessionId: ORCA_SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'pi',
      providerHandle: { kind: 'opaque', agent: 'pi', value: 'pending' }
    },
    journalDir: journalDirectoryFor(root, { workspaceId: 'workspace-1', sessionId: ORCA_SESSION })
  })
  const body = userMessage(text)
  await journal.appendItem({ provider: 'orca', clientMessageId }, body, { fence: FENCE })
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: fingerprint(text),
    body,
    fence: FENCE
  })
  return journal
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-pi-restart-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe.each(['pi', 'omp'] as const)('restart settlement for %s', (provider) => {
  it('settles a matching stable user entry through the generic reconciler', async () => {
    const journal = await crashedJournal('cm_1', 'deploy the thing')
    await journal.markPendingSubmissionsUnknown(FENCE)
    const settled = await reconcileJournalSubmissionsAgainstHistory({
      journal,
      fence: FENCE,
      history: windowFor(provider, `${provider}-ses-1`, 'a0', 'deploy the thing', 'n1')
    })
    expect(settled).toEqual(['cm_1'])
    const submission = journal.submissions().find((entry) => entry.clientMessageId === 'cm_1')
    expect(submission?.dispatchState).toBe('accepted')
    expect(submission?.providerItemId).toContain('n1')
  })

  it('leaves absence from an unproven window unknown', async () => {
    const journal = await crashedJournal('cm_1', 'deploy the thing')
    await journal.markPendingSubmissionsUnknown(FENCE)
    const settled = await reconcileJournalSubmissionsAgainstHistory({
      journal,
      fence: FENCE,
      history: PI_FAMILY_INCONSISTENT_WINDOW
    })
    expect(settled).toEqual([])
    expect(journal.submissions()[0]?.dispatchState).toBe('unknown')
  })

  it('rejects absence from a proven-empty window', async () => {
    const journal = await crashedJournal('cm_1', 'deploy the thing')
    await journal.markPendingSubmissionsUnknown(FENCE)
    const built = buildPiFamilyHistoryWindow({
      provider,
      providerSessionId: `${provider}-ses-1`,
      orcaSessionId: ORCA_SESSION,
      anchorLeafId: 'a0',
      entries: [],
      leafId: 'a0'
    })
    if (!built.ok) {
      throw new Error(`fixture window failed: ${built.code}`)
    }
    const settled = await reconcileJournalSubmissionsAgainstHistory({
      journal,
      fence: FENCE,
      history: built.window
    })
    expect(settled).toEqual(['cm_1'])
    expect(journal.submissions()[0]?.dispatchState).toBe('rejected')
  })

  it('settles multiple pendings only to matching entries', async () => {
    const journal = await crashedJournal('cm_1', 'first task')
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'cm_2' },
      userMessage('second task'),
      {
        fence: FENCE
      }
    )
    await journal.appendSubmission({
      clientMessageId: 'cm_2',
      payloadFingerprint: fingerprint('second task'),
      body: userMessage('second task'),
      fence: FENCE
    })
    await journal.markPendingSubmissionsUnknown(FENCE)
    // Only the first text reached the provider against a proven boundary.
    const settled = await reconcileJournalSubmissionsAgainstHistory({
      journal,
      fence: FENCE,
      history: windowFor(provider, `${provider}-ses-1`, 'a0', 'first task', 'n1')
    })
    // Both leave the unconfirmed set: the match accepts, the proven absence rejects.
    expect(settled).toEqual(['cm_1', 'cm_2'])
    expect(
      journal.submissions().find((entry) => entry.clientMessageId === 'cm_1')?.dispatchState
    ).toBe('accepted')
    expect(
      journal.submissions().find((entry) => entry.clientMessageId === 'cm_2')?.dispatchState
    ).toBe('rejected')
  })

  it('reconciles idempotently: a second pass settles nothing new', async () => {
    const journal = await crashedJournal('cm_1', 'deploy the thing')
    await journal.markPendingSubmissionsUnknown(FENCE)
    const history = windowFor(provider, `${provider}-ses-1`, 'a0', 'deploy the thing', 'n1')
    expect(
      await reconcileJournalSubmissionsAgainstHistory({ journal, fence: FENCE, history })
    ).toEqual(['cm_1'])
    expect(
      await reconcileJournalSubmissionsAgainstHistory({ journal, fence: FENCE, history })
    ).toEqual([])
    expect(journal.submissions()[0]?.dispatchState).toBe('accepted')
  })
})

describe('restart cross-provider discrimination', () => {
  it('an OMP session never samples Pi history: the sampler fails closed', async () => {
    const calls: { acquire: unknown[]; readEntries: unknown[]; close: unknown[] } = {
      acquire: [],
      readEntries: [],
      close: []
    }
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend: {
        acquire: async () => {
          calls.acquire.push({})
          return { piSessionId: 'pi-ses-1', leafId: 'b', pid: 1, sessionFilePath: '/tmp/pi.jsonl' }
        },
        readEntries: async () => {
          calls.readEntries.push({})
          return { entries: [], leafId: 'b' }
        },
        dispatch: async () => ({ status: 'accepted' as const }),
        cancel: async () => ({ cancelled: false }),
        close: async () => {
          calls.close.push({})
          return true
        }
      },
      readProcessStartTime: async () => 1
    })
    // OMP durable handle aimed at a Pi session file: session-id verification refuses,
    // so no Pi evidence can ever satisfy the OMP submission waiting in the journal.
    const window = await adapter.providerHistoryWindow?.({
      identity: {
        sessionId: ORCA_SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'omp',
        providerHandle: { kind: 'opaque', agent: 'omp', value: 'omp:omp-ses-9' }
      },
      accountHome: RECORD.accountHome,
      resumeSessionFile: '/tmp/pi.jsonl',
      durableLeafId: 'b'
    })
    expect(window).toBe(null)
    expect(calls.acquire).toHaveLength(1)
    expect(calls.readEntries).toEqual([])
    expect(calls.close).toHaveLength(1)
  })

  it('attach reconciliation settles through history and never sends', async () => {
    const journal = await crashedJournal('cm_1', 'deploy the thing')
    await journal.close()
    const dispatch = vi.fn()
    // Only the two reconciliation entrance points are exercised here; the
    // remaining adapter surface is never reached by attachJournal in this test.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowed fake with the exact methods this attach path calls.
    const adapter = {
      dispatch,
      providerHistoryWindow: async () => windowFor('pi', 'pi-ses-1', 'a0', 'deploy the thing', 'n1')
    } as unknown as StructuredAgentSessionAdapter
    const attached = await attachJournal({
      record: RECORD,
      params: PARAMS,
      journalRoot: root,
      adapter
    })
    journals.track(attached.journal)
    expect(attached.unconfirmedClientMessageIds).toEqual([])
    expect(attached.journal.submissions()[0]?.dispatchState).toBe('accepted')
    // Deciding is not sending: nothing here puts the message back on the wire.
    expect(dispatch).not.toHaveBeenCalled()
  })
})
