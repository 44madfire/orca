// Pi-family RPC transport tests over scripted children (PIF-2, #23).
//
// No real provider binaries or credentials: every case spawns a scripted
// node child (Pi-like or OMP-like) through the transport's injected spawn.
// Framing/correlation cases run equivalently against both fixtures; OMP
// extras, readiness, stream control, and shared wrappers follow.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiFamilyRpcConnection } from './pi-family-rpc-connection'
import { PiRpcError } from './pi-rpc-errors'
import { PI_FAMILY_MAX_REASSEMBLED_BYTES } from './pi-family-rpc-chunks'
import type { SpawnedProcess } from '../../../shared/child-process/process-spec'
import type { PiServerEvent } from './pi-wire-protocol'

const PI_SCRIPT = fileURLToPath(new URL('./__fixtures__/scripted-pi-child.mjs', import.meta.url))
const OMP_SCRIPT = fileURLToPath(new URL('./__fixtures__/scripted-omp-child.mjs', import.meta.url))

type Provider = 'pi' | 'omp'
const PROVIDERS: Provider[] = ['pi', 'omp']

const live: PiFamilyRpcConnection[] = []
afterEach(async () => {
  for (const conn of live.splice(0)) {
    await conn.close(50).catch(() => undefined)
  }
})

function spawnScript(script: string, extraEnv: Record<string, string> = {}) {
  return (
    _command: string,
    _args: string[],
    options: { stdio: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
  ): SpawnedProcess => {
    const child: ChildProcess = spawn(process.execPath, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.env, ...extraEnv }
    })
    return child
  }
}

function buildConn(
  provider: Provider,
  env: Record<string, string> = {},
  maxReassembledBytes = PI_FAMILY_MAX_REASSEMBLED_BYTES
): PiFamilyRpcConnection {
  const conn = new PiFamilyRpcConnection({
    provider,
    piCommand: process.execPath,
    piArgs: [provider === 'pi' ? PI_SCRIPT : OMP_SCRIPT],
    defaultTimeoutMs: 3_000,
    startupTimeoutMs: 10_000,
    maxReassembledBytes,
    spawnFn: spawnScript(provider === 'pi' ? PI_SCRIPT : OMP_SCRIPT, env)
  })
  live.push(conn)
  return conn
}

async function startConn(
  provider: Provider,
  env: Record<string, string> = {}
): Promise<PiFamilyRpcConnection> {
  const conn = buildConn(provider, env)
  await conn.start()
  return conn
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) {
      return
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for scripted transport condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

function stringField(data: unknown, field: string): string {
  if (data && typeof data === 'object' && field in data) {
    const found = data[field]
    if (typeof found === 'string') {
      return found
    }
  }
  throw new Error(`test requires a string ${field} in the response data`)
}

async function ambientError(promise: Promise<unknown>): Promise<PiRpcError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PiRpcError) {
      return error
    }
    throw error
  }
  throw new Error('test requires the request to fail')
}
const responseLine = (id: string, marker: string): string =>
  `${JSON.stringify({ type: 'response', command: 'test_hang', success: true, id, data: { marker } })}\n`

describe.each(PROVIDERS)('framing/correlation over a %s-like child', (provider) => {
  it('resolves multiple in-flight requests by id, out of order', async () => {
    const conn = await startConn(provider)
    const order: string[] = []
    const slow = conn
      .request<{ marker: string }>({ type: 'test_delay', ms: 90, marker: 'slow' })
      .then((data) => {
        order.push(data.marker)
        return data
      })
    const fast = conn
      .request<{ marker: string }>({ type: 'test_delay', ms: 10, marker: 'fast' })
      .then((data) => {
        order.push(data.marker)
        return data
      })
    const mid = conn
      .request<{ marker: string }>({ type: 'test_delay', ms: 40, marker: 'mid' })
      .then((data) => {
        order.push(data.marker)
        return data
      })
    const [slowData, fastData, midData] = await Promise.all([slow, fast, mid])
    expect([slowData.marker, fastData.marker, midData.marker]).toEqual(['slow', 'fast', 'mid'])
    expect(order).toEqual(['fast', 'mid', 'slow'])
  })

  it('interleaves async events with in-flight requests', async () => {
    const conn = await startConn(provider)
    const seen: string[] = []
    conn.onEvent((event) => {
      if (typeof event.type === 'string') {
        seen.push(event.type)
      }
    })
    const [state] = await Promise.all([
      conn.request<Record<string, unknown>>({ type: 'get_state' }),
      conn.prompt('hello')
    ])
    expect(typeof state['sessionId']).toBe('string')
    await waitFor(() => seen.length > 0)
    if (provider === 'pi') {
      expect(seen.some((type) => type === 'turn_start' || type === 'message_update')).toBe(true)
    } else {
      expect(seen).toContain('prompt_result')
    }
  })

  it('parses multiple records per chunk and split records across chunks', async () => {
    const conn = await startConn(provider)
    const first = responseLine('k1', 'one')
    const cut = Math.floor(Buffer.byteLength(first, 'utf8') / 2)
    const firstBytes = Buffer.from(first, 'utf8')
    const chunks = [
      firstBytes.subarray(0, cut).toString('base64'),
      Buffer.concat([
        firstBytes.subarray(cut),
        Buffer.from(`${responseLine('k2', 'two')}${responseLine('k3', 'three')}`, 'utf8')
      ]).toString('base64')
    ]
    const p1 = conn.requestRaw({ type: 'test_hang', id: 'k1' })
    const p2 = conn.requestRaw({ type: 'test_hang', id: 'k2' })
    const p3 = conn.requestRaw({ type: 'test_hang', id: 'k3' })
    await conn.request({ type: 'test_emit', chunks, delayMs: 10 })
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(stringField(r1.data, 'marker')).toBe('one')
    expect(stringField(r2.data, 'marker')).toBe('two')
    expect(stringField(r3.data, 'marker')).toBe('three')
  })

  it('does not split records on U+2028/U+2029, even mid-multibyte across chunks', async () => {
    const conn = await startConn(provider)
    const note = 'a b c'
    const line = `${JSON.stringify({ type: 'message_update', note })}\n`
    const bytes = Buffer.from(line, 'utf8')
    const splitAt = bytes.indexOf(Buffer.from([0xe2, 0x80])) + 1
    const received: string[] = []
    conn.onEvent((event: PiServerEvent) => {
      if (typeof event.note === 'string') {
        received.push(event.note)
      }
    })
    await conn.request({
      type: 'test_emit',
      chunks: [
        bytes.subarray(0, splitAt).toString('base64'),
        bytes.subarray(splitAt).toString('base64')
      ],
      delayMs: 10
    })
    await waitFor(() => received.length > 0)
    expect(received).toEqual([note])
  })

  it('bounds a malformed line and later valid records survive', async () => {
    const conn = await startConn(provider)
    const previews: string[] = []
    conn.onMalformedLine(({ linePreview }) => {
      previews.push(linePreview)
    })
    const pending = conn.requestRaw({ type: 'test_hang', id: 'k4' })
    await conn.request({
      type: 'test_emit',
      chunks: [b64(`${'x'.repeat(2000)}\n`), b64(responseLine('k4', 'four'))],
      delayMs: 10
    })
    const res = await pending
    expect(stringField(res.data, 'marker')).toBe('four')
    expect(conn.malformedLineCount).toBe(1)
    expect(previews).toHaveLength(1)
    expect(previews[0].length).toBeLessThan(2000)
  })

  it('never settles a request from an unmatched response id', async () => {
    const conn = await startConn(provider)
    const observed: (string | undefined)[] = []
    conn.onResponse((res) => {
      observed.push(res.id)
    })
    const pending = conn.requestRaw({ type: 'test_hang', id: 'k5' })
    await conn.request({
      type: 'test_emit',
      chunks: [b64(responseLine('nope-x', 'wrong')), b64(responseLine('k5', 'five'))],
      delayMs: 10
    })
    const res = await pending
    expect(stringField(res.data, 'marker')).toBe('five')
    expect(observed).toContain('nope-x')
    expect(conn.unmatchedResponseCount).toBeGreaterThanOrEqual(1)
  })

  it('exposes the Orca-owned child and pid', async () => {
    const conn = await startConn(provider)
    expect(conn.child).not.toBeNull()
    expect(conn.pid).toBeGreaterThan(0)
    expect(conn.child?.pid).toBe(conn.pid)
  })

  it('serves the shared typed wrappers', async () => {
    const conn = await startConn(provider)
    const state = await conn.getState()
    expect(typeof state.sessionId).toBe('string')
    const entries = await conn.getEntries()
    expect(typeof entries.leafId).toBe('string')
    const tree = await conn.getTree()
    expect(typeof tree.leafId).toBe('string')
    const models = await conn.getAvailableModels()
    expect(models.models.length).toBeGreaterThan(0)
    const first = models.models[0]
    await expect(conn.setModel(first.provider, first.id)).resolves.toMatchObject({ id: first.id })
    const levels = await conn.getAvailableThinkingLevels()
    expect(levels.levels.length).toBeGreaterThan(0)
    await conn.setThinkingLevel(levels.levels[0])
    await conn.setAutoCompaction(true)
    await conn.compact()
    const dir = mkdtempSync(join(tmpdir(), 'pi-family-switch-'))
    try {
      const sessionFile = join(dir, 'exact-provider-file.jsonl')
      writeFileSync(sessionFile, '')
      const switched = await conn.switchSession(sessionFile)
      expect(switched.cancelled).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    await conn.prompt('hello')
    await conn.abort()
    expect(() =>
      conn.respondToExtensionUi({ type: 'extension_ui_response', id: 'x', cancelled: true })
    ).not.toThrow()
  })

  it('classifies provider refusal as definite and timeouts as ambiguous', async () => {
    const conn = await startConn(provider)
    const refusal = await ambientError(conn.requestRaw({ type: 'test_bogus_xyz' }))
    expect(refusal).toBeInstanceOf(PiRpcError)
    expect(refusal.code).toBe('rejected')
    expect(refusal.ambiguous).toBe(false)
    const timeout = await ambientError(conn.requestRaw({ type: 'test_hang' }, { timeoutMs: 100 }))
    expect(timeout.code).toBe('request-timeout')
    expect(timeout.ambiguous).toBe(true)
  })

  it('classifies process exit with a request in flight as ambiguous', async () => {
    const conn = await startConn(provider)
    const error = await ambientError(conn.prompt('EXIT now'))
    expect(error.code).toBe('process-exited')
    expect(error.ambiguous).toBe(true)
  })

  it('pauses and resumes the underlying stdout', async () => {
    const conn = await startConn(provider)
    const stdout = conn.child?.stdout
    if (!stdout) {
      throw new Error('test requires a live child stdout')
    }
    const onPause = vi.spyOn(stdout, 'pause')
    const onResume = vi.spyOn(stdout, 'resume')
    conn.pause()
    conn.resume()
    expect(onPause).toHaveBeenCalledTimes(1)
    expect(onResume).toHaveBeenCalledTimes(1)
    onPause.mockRestore()
    onResume.mockRestore()
  })

  it('closes idempotently and settles pending waiters as ambiguous', async () => {
    const conn = await startConn(provider)
    const pendings = [
      conn.requestRaw({ type: 'test_hang', id: 'w1' }),
      conn.requestRaw({ type: 'test_hang', id: 'w2' })
    ]
    const first = await conn.close(50)
    const second = await conn.close(50)
    expect(second).toBe(first)
    for (const pending of pendings) {
      const error = await ambientError(pending)
      expect(error.code).toBe('transport-closed')
      expect(error.ambiguous).toBe(true)
    }
  })

  it('bounds and redacts the stderr tail', async () => {
    const conn = await startConn(provider, { SCRIPT_STDERR_FLOOD: '1' })
    await waitFor(() => conn.stderrTail !== '')
    expect(conn.stderrTail.length).toBeLessThanOrEqual(4100)
    expect(conn.stderrTail).toContain('[REDACTED]')
    expect(conn.stderrTail).not.toContain('sk-proj-abcdef1234567890')
    expect(conn.stderrTail).not.toContain('fixtureuser')
  })
})

describe('OMP startup and chunk extras', () => {
  it('tolerates ready and negotiates without stealing a correlation slot', async () => {
    const conn = buildConn('omp')
    const readySeen: string[] = []
    conn.onEvent((event) => {
      if (event.type === 'ready') {
        readySeen.push(event.type)
      }
    })
    let readyCount = 0
    const off = conn.onReady(() => {
      readyCount += 1
    })
    await conn.start()
    off()
    expect(readySeen).toEqual(['ready'])
    expect(readyCount).toBe(1)
    expect(conn.observedReady).not.toBeNull()
    expect(conn.observedReady?.supportedProtocolVersions).toContain(2)
    expect(conn.negotiatedProtocolVersion).toBe(2)
    expect(conn.pendingCount).toBe(0)
    await conn.getState()
  })

  it('stays on v1 when the advertised ceiling exceeds local capacity', async () => {
    const conn = buildConn('omp', {}, 1024)
    await conn.start()
    expect(conn.observedReady).not.toBeNull()
    expect(conn.negotiatedProtocolVersion).toBe(1)
    const state = await conn.getState()
    expect(typeof state.sessionId).toBe('string')
  })

  it('starts an OMP child without ready frames on the probe alone', async () => {
    const conn = await startConn('omp', { OMP_SCRIPT_NO_STARTUP_FRAMES: '1' })
    expect(conn.observedReady).toBeNull()
    expect(conn.negotiatedProtocolVersion).toBe(1)
    const state = await conn.getState()
    expect(typeof state.sessionId).toBe('string')
  })

  it('reassembles a multi-frame rpc_chunk exactly once', async () => {
    const conn = await startConn('omp')
    const seenIds: (string | undefined)[] = []
    conn.onResponse((res) => {
      seenIds.push(res.id)
    })
    const res = await conn.requestRaw({ type: 'test_chunked', id: 'chunk-1', padBytes: 1_100_000 })
    expect(stringField(res.data, 'pad')).toHaveLength(1_100_000)
    expect(seenIds.filter((id) => id === 'chunk-1')).toHaveLength(1)
    await conn.getState()
  })

  it('bounds chunk violations without crashing the connection', async () => {
    const conn = await startConn('omp')
    const before = conn.malformedLineCount
    await conn.request({
      type: 'test_emit',
      chunks: [
        b64(
          `${JSON.stringify({ type: 'rpc_chunk', chunkId: 'bad', index: 1, count: 2, byteLength: 1_100_000, data: 'eA==' })}\n`
        ),
        b64(
          `${JSON.stringify({ type: 'rpc_chunk', chunkId: 'int-1', index: 0, count: 2, byteLength: 1_100_000, data: 'eA==' })}\n`
        ),
        b64(`${JSON.stringify({ type: 'notice', message: 'interrupt' })}\n`)
      ],
      delayMs: 10
    })
    await waitFor(() => conn.malformedLineCount >= before + 2)
    const state = await conn.getState()
    expect(typeof state.sessionId).toBe('string')
  })

  it('rejects chunk sequences past the reassembly ceiling', async () => {
    const conn = await startConn('omp')
    const before = conn.malformedLineCount
    await conn.request({
      type: 'test_emit',
      chunks: [
        b64(
          `${JSON.stringify({ type: 'rpc_chunk', chunkId: 'huge', index: 0, count: 300, byteLength: 70 * 1024 * 1024, data: 'eA==' })}\n`
        )
      ],
      delayMs: 10
    })
    await waitFor(() => conn.malformedLineCount >= before + 1)
    const state = await conn.getState()
    expect(typeof state.sessionId).toBe('string')
  })

  it('keeps host-tool, subagent, and unknown frames observable and ignorable', async () => {
    const conn = await startConn('omp')
    const seen = new Set<string>()
    conn.onEvent((event) => {
      seen.add(event.type)
    })
    await conn.request({ type: 'test_noise' })
    await waitFor(() => seen.has('omp_future_xyz'))
    for (const type of [
      'available_commands_update',
      'host_tool_call',
      'subagent_lifecycle',
      'notice',
      'omp_future_xyz'
    ]) {
      expect(seen.has(type)).toBe(true)
    }
    await conn.getState()
  })
})

describe('readiness gating', () => {
  it('requires a successful probe even after OMP ready', async () => {
    const conn = new PiFamilyRpcConnection({
      provider: 'omp',
      piCommand: process.execPath,
      piArgs: [OMP_SCRIPT],
      defaultTimeoutMs: 3_000,
      startupTimeoutMs: 1_200,
      spawnFn: spawnScript(OMP_SCRIPT, { OMP_SCRIPT_READY_ONLY: '1' })
    })
    live.push(conn)
    const error = await ambientError(conn.start())
    expect(error.code).toBe('startup-timeout')
    expect(conn.observedReady).not.toBeNull()
    expect(conn.child).toBeNull()
    expect(conn.pendingCount).toBe(0)
    await conn.close(50)
  })

  it.each(PROVIDERS)('reports post-spawn startup failure for %s', async (provider) => {
    const conn = new PiFamilyRpcConnection({
      provider,
      piCommand: process.execPath,
      piArgs: [provider === 'pi' ? PI_SCRIPT : OMP_SCRIPT],
      defaultTimeoutMs: 3_000,
      startupTimeoutMs: 5_000,
      spawnFn: spawnScript(
        provider === 'pi' ? PI_SCRIPT : OMP_SCRIPT,
        provider === 'pi' ? { PI_SCRIPT_EXIT_AT_START: '1' } : { OMP_SCRIPT_EXIT_AT_START: '1' }
      )
    })
    live.push(conn)
    const error = await ambientError(conn.start())
    expect(error.code).toBe('startup-failed')
  })

  it('reports spawn failure distinctly from startup failure', async () => {
    const conn = new PiFamilyRpcConnection({
      provider: 'pi',
      spawnFn: () => {
        throw new Error('spawn test-binary ENOENT')
      }
    })
    live.push(conn)
    const error = await ambientError(conn.start())
    expect(error.code).toBe('spawn-failed')
  })
})
