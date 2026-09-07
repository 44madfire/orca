// The relay half of the SSH liveness readback. A client may only read "this id is absent from my
// listing" as an exit when the relay that minted the id is the one answering, so the generation
// stamped into every id has to be the generation `pty.getCapabilities` names. If these two ever
// disagree, every SSH absence silently becomes unverifiable forever and no SSH worker can be
// retired (docs/reference/ssh-execution-boundary.md).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    process: 'zsh',
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'
import { parseRelayPtyMintEpoch } from '../shared/relay-pty-mint-epoch'

describe('PtyHandler mint epoch', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  const { spawnPty } = createPtyRequestHelpers(() => dispatcher)

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(() => {
    endPtyHandlerTest(handler, originalPlatform)
  })

  async function capabilities(): Promise<{ ptyIdMintEpoch?: unknown }> {
    return (await dispatcher.callRequest('pty.getCapabilities', {})) as { ptyIdMintEpoch?: unknown }
  }

  it('names the generation that minted its PTY ids', async () => {
    const { id } = await spawnPty()

    const mintEpoch = parseRelayPtyMintEpoch(id)
    expect(mintEpoch).toBeTruthy()
    expect((await capabilities()).ptyIdMintEpoch).toBe(mintEpoch)
  })

  it('keeps that generation stable across ids and reads', async () => {
    const first = await spawnPty()
    const second = await spawnPty()

    expect(parseRelayPtyMintEpoch(second.id)).toBe(parseRelayPtyMintEpoch(first.id))
    expect((await capabilities()).ptyIdMintEpoch).toBe((await capabilities()).ptyIdMintEpoch)
  })
})
