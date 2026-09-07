import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { isMobileWebHostRpcMethod } from './mobile-web-host-rpc-allowlist'
import { MOBILE_WEB_BROWSER_INPUT_METHODS } from './mobile-web-browser-input'
import { resetMobileWebBrowserInputRateLimit } from './mobile-web-browser-input-rate-limit'

const methods = new Map(MOBILE_WEB_BROWSER_INPUT_METHODS.map((method) => [method.name, method]))
const pointer = methods.get('mobileWeb.browser.pointer')!
const keyboard = methods.get('mobileWeb.browser.keyboard')!
const dialog = methods.get('mobileWeb.browser.dialog')!

const TARGET = { worktree: 'id:workspace', page: 'page-1' }

function fixture() {
  const runtime = {
    browserMouseMove: vi.fn().mockResolvedValue({}),
    browserMouseWheel: vi.fn().mockResolvedValue({}),
    browserMouseClick: vi.fn().mockResolvedValue({}),
    browserMouseDown: vi.fn().mockResolvedValue({}),
    browserMouseUp: vi.fn().mockResolvedValue({}),
    browserKeypress: vi.fn().mockResolvedValue({}),
    browserKeyboardInsertText: vi.fn().mockResolvedValue({}),
    browserDialogAccept: vi.fn().mockResolvedValue({}),
    browserDialogDismiss: vi.fn().mockResolvedValue({})
  }
  const context = { runtime, connectionId: 'connection' } as unknown as RpcContext
  return { context, runtime }
}

beforeEach(() => resetMobileWebBrowserInputRateLimit())

describe('host-owned browser input', () => {
  it('turns one scroll into the host move and wheel pair', async () => {
    const f = fixture()

    expect(
      await pointer.handler(
        { ...TARGET, action: 'scroll', x: 10, y: 20, dx: 0, dy: -40 },
        f.context
      )
    ).toEqual({ applied: true })

    expect(f.runtime.browserMouseMove).toHaveBeenCalledWith({ ...TARGET, x: 10, y: 20 })
    expect(f.runtime.browserMouseWheel).toHaveBeenCalledWith({ ...TARGET, dx: 0, dy: -40 })
  })

  it('clicks with the requested button, modifiers and radius', async () => {
    const f = fixture()

    await pointer.handler(
      { ...TARGET, action: 'click', x: 5, y: 6, button: 'right', modifiers: ['shift'], radius: 12 },
      f.context
    )

    expect(f.runtime.browserMouseClick).toHaveBeenCalledWith({
      ...TARGET,
      x: 5,
      y: 6,
      button: 'right',
      modifiers: ['shift'],
      radius: 12
    })
    expect(f.runtime.browserMouseDown).not.toHaveBeenCalled()
  })

  it('falls back to press and release when a plain click fails', async () => {
    const f = fixture()
    f.runtime.browserMouseClick.mockRejectedValueOnce(new Error('browser_error'))

    await pointer.handler(
      { ...TARGET, action: 'click', x: 5, y: 6, button: 'left', modifiers: [] },
      f.context
    )

    expect(f.runtime.browserMouseMove).toHaveBeenCalledWith({ ...TARGET, x: 5, y: 6 })
    expect(f.runtime.browserMouseDown).toHaveBeenCalledWith({ ...TARGET, button: 'left' })
    expect(f.runtime.browserMouseUp).toHaveBeenCalledWith({ ...TARGET, button: 'left' })
  })

  it('never synthesizes a press for a modified click that failed', async () => {
    const f = fixture()
    f.runtime.browserMouseClick.mockRejectedValueOnce(new Error('browser_error'))

    await expect(
      pointer.handler(
        { ...TARGET, action: 'click', x: 5, y: 6, button: 'left', modifiers: ['cmd'] },
        f.context
      )
    ).rejects.toThrow('browser_error')
    expect(f.runtime.browserMouseDown).not.toHaveBeenCalled()
  })

  it('routes keyboard actions to the matching host command', async () => {
    const f = fixture()

    expect(
      await keyboard.handler({ ...TARGET, action: 'insertText', text: 'hello' }, f.context)
    ).toEqual({ applied: true })
    await keyboard.handler({ ...TARGET, action: 'keypress', key: 'Enter' }, f.context)

    expect(f.runtime.browserKeyboardInsertText).toHaveBeenCalledWith({ ...TARGET, text: 'hello' })
    expect(f.runtime.browserKeypress).toHaveBeenCalledWith({ ...TARGET, key: 'Enter' })
  })

  it('routes dialog actions to accept and dismiss', async () => {
    const f = fixture()

    await dialog.handler({ ...TARGET, action: 'accept' }, f.context)
    await dialog.handler({ ...TARGET, action: 'dismiss' }, f.context)

    expect(f.runtime.browserDialogAccept).toHaveBeenCalledWith(TARGET)
    expect(f.runtime.browserDialogDismiss).toHaveBeenCalledWith(TARGET)
  })

  it('accepts only the four keys and two buttons the page may send', () => {
    expect(keyboard.params!.safeParse({ ...TARGET, action: 'keypress', key: 'F12' }).success).toBe(
      false
    )
    expect(keyboard.params!.safeParse({ ...TARGET, action: 'keypress', key: 'Tab' }).success).toBe(
      true
    )
    expect(
      pointer.params!.safeParse({
        ...TARGET,
        action: 'click',
        x: 1,
        y: 1,
        button: 'middle',
        modifiers: []
      }).success
    ).toBe(false)
  })

  it('rate-limits input per connection and lets a second connection through', async () => {
    const f = fixture()
    const other = { ...f.context, connectionId: 'other' } as RpcContext
    const move = { ...TARGET, action: 'scroll', x: 1, y: 1, dx: 0, dy: 1 } as const

    let rejected = 0
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await Promise.resolve(pointer.handler(move, f.context)).catch(() => {
        rejected += 1
      })
    }

    expect(rejected).toBeGreaterThan(0)
    await expect(pointer.handler(move, other)).resolves.toEqual({ applied: true })
  })

  it('exposes every input method to the page lane', () => {
    for (const name of methods.keys()) {
      expect(isMobileWebHostRpcMethod(name), name).toBe(true)
    }
  })
})
