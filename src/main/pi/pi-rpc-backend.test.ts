// Production-path Pi backend tests over a scripted `pi --mode rpc` child.
//
// These prove the real transport → driver → journal path the coordinator
// requires: one Pi child per session in the workspaceRoot, typed RPC (no
// bridge/helper/shell strings), provider-confirmed streaming into journal
// rows, exactly-once prompts, exact-match options, history resume on the same
// session/leaf, proven close, and fail-closed failures. Fake-backend adapter
// tests still cover fence/exit-unproven branches; this file covers behavior
// only a live child can prove.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { getAgentResumeArgv } from '../../shared/agent-session-resume'
import { buildPiTuiResumeProviderSession } from './pi-structured-tui-resume'
import { piProviderHandleLink } from './pi-structured-owner-identity'
import { createPiRpcBackend } from './pi-rpc-backend'
import { PiRpcSessionDriver } from './pi-rpc-session-driver'

const SCRIPT = fileURLToPath(new URL('./rpc/__fixtures__/scripted-pi-child.mjs', import.meta.url))

type Row = { identityKey: string; body: AgentJournalItemBody }

function messageTexts(body: AgentJournalItemBody): string[] {
  if (body.kind !== 'message') {
    return []
  }
  return body.blocks.map((block) => (block.type === 'text' ? block.text : ''))
}

function must<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`test requires backend.${name}`)
  }
  return value
}

function testSink(rows: Row[], activity: { current: unknown }): StructuredAgentSessionEventSink {
  return {
    appendItem: (identity, body) => {
      rows.push({ identityKey: agentJournalItemKey(identity), body })
    },
    appendTombstone: () => undefined,
    publish: () => undefined,
    setActivity: (next) => {
      activity.current = next
    }
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) {
      return
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for scripted Pi condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'pi-driver-ws-'))
}

function backendWithScript(env: Record<string, string>, extra: Record<string, unknown> = {}) {
  return createPiRpcBackend({
    piCommand: process.execPath,
    piArgs: [SCRIPT],
    resolveEnv: () => ({ ...process.env, ...env }),
    ...(extra as object)
  })
}


function rmDir(dir: string): void {
  // Best-effort: Windows may hold the workspace lock briefly after child
  // exit. Child-liveness itself is proven by close() === true, not by this.
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

function assistantTexts(rows: Row[]): string[] {
  return rows
    .filter((row) => row.body.kind === 'message' && (row.body.role === 'assistant' || row.body.role === 'reasoning'))
    .map((row) => messageTexts(row.body).join(''))
}

describe('Pi RPC backend over a scripted child', () => {
  it('acquires fresh with provider-confirmed identity and a trusted session file', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const backend = backendWithScript({ PI_SCRIPT_SESSION_FILE: file, PI_SCRIPT_SESSION_ID: 'pi-fresh-1' })
    try {
      const acquired = await backend.acquire({
        orcaSessionId: 'ses-fresh',
        workspaceRoot: dir,
        spawnToken: 'spawn-1',
        sink: testSink([], { current: null })
      })
      expect(acquired.piSessionId).toBe('pi-fresh-1')
      expect(acquired.leafId).toBeNull()
      expect(acquired.sessionFilePath).toBe(file)
      expect(acquired.pid).toBeGreaterThan(0)
      expect(acquired.model).toBe('script-provider/script-model')
      await expect(backend.close({ orcaSessionId: 'ses-fresh' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })

  it.each([
    ['false', 'PI_STALE_SESSION_UNCLOSED: previous Pi session exit was not proven'],
    ['throws', 'PI_STALE_SESSION_UNCLOSED: previous Pi session teardown failed']
  ])('does not replace a stale driver when close %s', async (_outcome, expectedError) => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const backend = backendWithScript({ PI_SCRIPT_SESSION_FILE: file })
    const acquire = vi.spyOn(PiRpcSessionDriver.prototype, 'acquire')
    const close = vi.spyOn(PiRpcSessionDriver.prototype, 'close')
    if (_outcome === 'false') {
      close.mockResolvedValueOnce(false)
    } else {
      close.mockRejectedValueOnce(new Error('teardown failed'))
    }
    try {
      await backend.acquire({ orcaSessionId: 'ses-stale', workspaceRoot: dir, spawnToken: 's1' })
      expect(acquire).toHaveBeenCalledTimes(1)
      await expect(
        backend.acquire({ orcaSessionId: 'ses-stale', workspaceRoot: dir, spawnToken: 's2' })
      ).rejects.toThrow(expectedError)
      expect(acquire).toHaveBeenCalledTimes(1)
    } finally {
      close.mockRestore()
      acquire.mockRestore()
      await backend.close({ orcaSessionId: 'ses-stale' }).catch(() => undefined)
      rmDir(dir)
    }
  })

  it.each([
    [
      'false',
      'PI_ACQUIRE_UNCLOSED: failed Pi session teardown was not proven',
      'PI_STALE_SESSION_UNCLOSED: previous Pi session exit was not proven'
    ],
    [
      'throws',
      'PI_ACQUIRE_UNCLOSED: failed Pi session teardown was not proven',
      'PI_STALE_SESSION_UNCLOSED: previous Pi session teardown failed'
    ]
  ])(
    'fences a spawned driver when acquisition cleanup %s',
    async (_outcome, firstError, expectedError) => {
      const dir = workspace()
      const file = join(dir, 'pi-session.jsonl')
      writeFileSync(file, '')
      const backend = backendWithScript({
        PI_SCRIPT_SESSION_FILE: file,
        PI_SCRIPT_EXIT_AT_START: '1'
      })
      const acquire = vi.spyOn(PiRpcSessionDriver.prototype, 'acquire')
      const close = vi.spyOn(PiRpcSessionDriver.prototype, 'close')
      if (_outcome === 'false') {
        close.mockResolvedValue(false)
      } else {
        close.mockRejectedValue(new Error('teardown failed'))
      }
      try {
        await expect(
          backend.acquire({
            orcaSessionId: 'ses-acquire-failed',
            workspaceRoot: dir,
            spawnToken: 's1'
          })
        ).rejects.toThrow(firstError)
        expect(acquire).toHaveBeenCalledTimes(1)
        await expect(
          backend.acquire({
            orcaSessionId: 'ses-acquire-failed',
            workspaceRoot: dir,
            spawnToken: 's2'
          })
        ).rejects.toThrow(expectedError)
        expect(acquire).toHaveBeenCalledTimes(1)
      } finally {
        close.mockRestore()
        acquire.mockRestore()
        await backend.close({ orcaSessionId: 'ses-acquire-failed' }).catch(() => undefined)
        rmDir(dir)
      }
    }
  )

  it('dispatches text to settled with journaled rows and cleared activity', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const rows: Row[] = []
    const activity: { current: unknown } = { current: undefined }
    const backend = backendWithScript({ PI_SCRIPT_SESSION_FILE: file })
    try {
      await backend.acquire({ orcaSessionId: 'ses-1', workspaceRoot: dir, spawnToken: 's1', sink: testSink(rows, activity) })
      const outcome = await backend.dispatch({
        orcaSessionId: 'ses-1',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] } as never
      })
      expect(outcome).toEqual({ status: 'accepted' })
      await waitFor(() => activity.current === null)
      const texts = assistantTexts(rows)
      expect(texts.some((text) => text.includes('scripted reply for turn'))).toBe(true)
      const second = await backend.dispatch({
        orcaSessionId: 'ses-1',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'again' }] } as never
      })
      expect(second).toEqual({ status: 'accepted' })
      await expect(backend.close({ orcaSessionId: 'ses-1' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })

  it('keeps thinking out of prose and tool output in tool rows', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const rows: Row[] = []
    const backend = backendWithScript({ PI_SCRIPT_SESSION_FILE: file })
    try {
      await backend.acquire({ orcaSessionId: 'ses-tt', workspaceRoot: dir, spawnToken: 's1', sink: testSink(rows, { current: null }) })
      await backend.dispatch({
        orcaSessionId: 'ses-tt',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'do THINK TOOL' }] } as never
      })
      await waitFor(() =>
        rows.some((row) => row.body.kind === 'tool-call' && row.body.state === 'completed')
      )
      const assistantOnly = rows
        .filter((row) => row.body.kind === 'message' && row.body.role === 'assistant')
        .map((row) => messageTexts(row.body).join(''))
        .join('\n')
      expect(assistantOnly).not.toContain('scripted tool output')
      expect(assistantOnly).not.toContain('scripted thinking trace')
      const reasoning = rows.filter((row) => row.body.kind === 'message' && row.body.role === 'reasoning')
      expect(reasoning.length).toBeGreaterThan(0)
      const tool = rows.find((row) => row.body.kind === 'tool-call' && row.body.state === 'completed')
      expect(tool).toMatchObject({ body: { state: 'completed' } })
      await expect(backend.close({ orcaSessionId: 'ses-tt' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })

  it('shapes turn errors without leaking and settles the turn', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const rows: Row[] = []
    const activity: { current: unknown } = { current: undefined }
    const backend = backendWithScript({ PI_SCRIPT_SESSION_FILE: file })
    try {
      await backend.acquire({ orcaSessionId: 'ses-err', workspaceRoot: dir, spawnToken: 's1', sink: testSink(rows, activity) })
      await backend.dispatch({
        orcaSessionId: 'ses-err',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'ERROR-TURN' }] } as never
      })
      await waitFor(() => activity.current === null)
      const status = rows.filter((row) => row.body.kind === 'status')
      expect(status.length).toBeGreaterThan(0)
      await expect(backend.close({ orcaSessionId: 'ses-err' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })

  it('cancels a slow turn and reports unknown (never resends) when the child dies mid-turn', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const log = join(dir, 'pi-log.txt')
    writeFileSync(log, '')
    const backend = backendWithScript({ PI_SCRIPT_SESSION_FILE: file, PI_SCRIPT_LOG: log })
    const rows: Row[] = []
    const activity: { current: unknown } = { current: null }
    try {
      await backend.acquire({ orcaSessionId: 'ses-cancel', workspaceRoot: dir, spawnToken: 's1', sink: testSink(rows, activity) })
      const pending = backend.dispatch({
        orcaSessionId: 'ses-cancel',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'SLOW turn' }] } as never
      })
      // The SLOW turn streams nothing until its 1500ms settle, so journal
      // rows only arrive at turn end: gate cancel on turn_start activity
      // instead, otherwise cancel races the natural settle and flakes.
      await waitFor(() => activity.current !== null)
      await expect(backend.cancel({ orcaSessionId: 'ses-cancel' })).resolves.toEqual({ cancelled: true })
      await expect(pending).resolves.toMatchObject({ status: 'accepted' })
      // Abort settle clears the active turn; without this the EXIT dispatch
      // would hit `already-streaming` (rejected) instead of the transport.
      await waitFor(() => activity.current === null)
      const dying = await backend.dispatch({
        orcaSessionId: 'ses-cancel',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'EXIT now' }] } as never
      })
      expect(dying.status).toBe('unknown')
      const { readFileSync } = await import('node:fs')
      const prompts = readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('prompt:'))
      expect(prompts).toHaveLength(2)
      await expect(backend.dispatch({
        orcaSessionId: 'ses-cancel',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'after death' }] } as never
      })).resolves.toMatchObject({ status: 'rejected' })
    } finally {
      rmDir(dir)
    }
  })

  it('answers prompts exactly once and refuses stale answers', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const rows: Row[] = []
    const backend = backendWithScript({ PI_SCRIPT_SESSION_FILE: file })
    try {
      await backend.acquire({ orcaSessionId: 'ses-p', workspaceRoot: dir, spawnToken: 's1', sink: testSink(rows, { current: null }) })
      const pending = backend.dispatch({
        orcaSessionId: 'ses-p',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'PROMPT-ME please' }] } as never
      })
      let itemKey = ''
      await waitFor(() => {
        const found = rows.find((row) => row.body.kind === 'approval' || row.body.kind === 'question')
        if (found) {
          itemKey = found.identityKey
          return true
        }
        return false
      })
      await must(backend.answerPrompt, 'answerPrompt')({ orcaSessionId: 'ses-p', itemKey, kind: 'approval', optionId: 'confirm' })
      await expect(pending).resolves.toEqual({ status: 'accepted' })
      await expect(must(backend.answerPrompt, 'answerPrompt')({ orcaSessionId: 'ses-p', itemKey, kind: 'approval', optionId: 'confirm' })).rejects.toThrow(
        'UNKNOWN_REQUEST'
      )
      await expect(backend.close({ orcaSessionId: 'ses-p' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })

  it('applies exact model/thinking refs and fails closed on unknown ones', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const backend = backendWithScript({ PI_SCRIPT_SESSION_FILE: file })
    try {
      await backend.acquire({ orcaSessionId: 'ses-o', workspaceRoot: dir, spawnToken: 's1' })
      await expect(
        must(backend.setOption, 'setOption')({ orcaSessionId: 'ses-o', key: 'model', value: 'script-provider/script-model' })
      ).resolves.toMatchObject({ model: 'script-provider/script-model' })
      await expect(
        must(backend.setOption, 'setOption')({ orcaSessionId: 'ses-o', key: 'model', value: 'dup-model' })
      ).rejects.toThrow('AMBIGUOUS_MODEL')
      await expect(
        must(backend.setOption, 'setOption')({ orcaSessionId: 'ses-o', key: 'model', value: 'nope/nope' })
      ).rejects.toThrow('UNKNOWN_MODEL')
      await expect(
        must(backend.setOption, 'setOption')({ orcaSessionId: 'ses-o', key: 'thinkingLevel', value: 'high' })
      ).resolves.toMatchObject({ thinkingLevel: 'high' })
      await expect(
        must(backend.setOption, 'setOption')({ orcaSessionId: 'ses-o', key: 'thinkingLevel', value: 'ultra' })
      ).rejects.toThrow('UNKNOWN_THINKING_LEVEL')
      await expect(backend.close({ orcaSessionId: 'ses-o' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })

  it('sends images on capable models with text-only history, and refuses them otherwise', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const png = join(dir, 'shot.png')
    writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 1]))
    const rows: Row[] = []
    const backend = backendWithScript({ PI_SCRIPT_SESSION_FILE: file })
    try {
      await backend.acquire({ orcaSessionId: 'ses-img', workspaceRoot: dir, spawnToken: 's1', sink: testSink(rows, { current: null }) })
      const outcome = await backend.dispatch({
        orcaSessionId: 'ses-img',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'look' }, { type: 'image-ref', path: png }] } as never
      })
      expect(outcome).toEqual({ status: 'accepted' })
      await waitFor(() => rows.some((row) => row.body.kind === 'message'), 15_000)
      const blob = JSON.stringify(rows)
      expect(blob).not.toContain(Buffer.from([137, 80, 78, 71]).toString('base64'))
      await must(backend.setOption, 'setOption')({ orcaSessionId: 'ses-img', key: 'model', value: 'script-provider/text-model' })
      await expect(
        backend.dispatch({
          orcaSessionId: 'ses-img',
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'look' }, { type: 'image-ref', path: png }] } as never
        })
      ).resolves.toMatchObject({ status: 'rejected', reason: expect.stringContaining('model-rejects-images') })
      await expect(backend.close({ orcaSessionId: 'ses-img' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })

  it('resumes the same session/leaf with wholesale history and plans the exact TUI command', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    const header = { type: 'session', sessionId: 'pi-resume-1', cwd: dir, leafId: 'e3' }
    const entries = [
      { type: 'message', id: 'e1', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'message', id: 'e2', parentId: 'e1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
      { type: 'message', id: 'e3', parentId: 'e2', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'third' }] } },
      { type: 'message', id: 'abandoned', parentId: 'e1', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sibling' }] } }
    ]
    writeFileSync(file, [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join('\n'))
    const backend = backendWithScript({ PI_SCRIPT_SESSION_FILE: join(dir, 'other.jsonl') })
    try {
      const acquired = await backend.acquire({
        orcaSessionId: 'ses-r',
        workspaceRoot: dir,
        resumePiSessionId: 'pi-resume-1',
        resumeSessionFile: file,
        spawnToken: 's1'
      })
      expect(acquired.piSessionId).toBe('pi-resume-1')
      expect(acquired.sessionFilePath).toBe(file)
      const history = await must(backend.readResumeHistory, 'readResumeHistory')({ orcaSessionId: 'ses-r' })
      expect(history.leafId).toBe('e3')
      const transcript = history.rows.map((row) => row.text).join('|')
      expect(transcript).toContain('first')
      expect(transcript).toContain('third')
      expect(transcript).not.toContain('sibling')
      const link = piProviderHandleLink({
        sessionId: acquired.piSessionId,
        leafId: history.leafId,
        resumed: true,
        fence: 9,
        observedAt: Date.now(),
        sessionFile: acquired.sessionFilePath ?? file
      })
      const record = {
        sessionId: 'ses-r',
        location: { executionHostId: 'local', wslDistro: null, workspaceId: 'workspace-1', workspaceKind: 'folder' },
        provider: 'pi',
        providerHandleChain: [link],
        accountHome: { variable: 'PI_STATE_DIR', path: dir }
      } as never
      const providerSession = buildPiTuiResumeProviderSession(record)
      expect(getAgentResumeArgv('pi', providerSession)).toEqual(['pi', '--session', file])
      await expect(backend.close({ orcaSessionId: 'ses-r' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })

  it('fails closed on missing binary, bad workspace, TUI flags, and CWD mismatch', async () => {
    const dir = workspace()
    try {
      const missing = createPiRpcBackend({ piCommand: 'pi-binary-that-does-not-exist-zzz', resolveEnv: () => process.env })
      await expect(
        missing.acquire({ orcaSessionId: 's', workspaceRoot: dir, spawnToken: 's' })
      ).rejects.toThrow('PI_STARTUP_FAILED')
      const backend = backendWithScript({})
      await expect(backend.acquire({ orcaSessionId: 's', workspaceRoot: 'relative/path', spawnToken: 's' })).rejects.toThrow(
        'BAD_WORKSPACE'
      )
      const tuiFlags = createPiRpcBackend({
        piCommand: process.execPath,
        piArgs: [SCRIPT, '--theme', 'dark'],
        resolveEnv: () => process.env
      })
      await expect(tuiFlags.acquire({ orcaSessionId: 's', workspaceRoot: dir, spawnToken: 's' })).rejects.toThrow(
        'PI_TUI_FLAG'
      )
      const other = workspace()
      try {
        const foreign = join(other, 'foreign.jsonl')
        writeFileSync(foreign, `${JSON.stringify({ type: 'session', sessionId: 'pi-x', cwd: other, leafId: 'e1' })}\n`)
        await expect(
          backend.acquire({
            orcaSessionId: 's',
            workspaceRoot: dir,
            resumePiSessionId: 'pi-x',
            resumeSessionFile: foreign,
            spawnToken: 's'
          })
        ).rejects.toThrow('PI_RESUME_CWD_MISMATCH')
      } finally {
        rmDir(other)
      }
    } finally {
      rmDir(dir)
    }
  })
})
