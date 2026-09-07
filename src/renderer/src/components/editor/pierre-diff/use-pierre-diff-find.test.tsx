// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePierreDiffFind } from './use-pierre-diff-find'

vi.mock('../editor-shortcuts', () => ({
  editorShortcutMatches: (_: string, event: KeyboardEvent) => event.key === 'f' && event.ctrlKey
}))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'linux' }))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  document.body.replaceChildren()
})

function setup(isEditable: boolean) {
  vi.useFakeTimers()
  const container = document.createElement('div')
  const host = document.createElement('diffs-container')
  const shadow = host.attachShadow({ mode: 'open' })
  container.append(host)
  document.body.append(container)
  const { result } = renderHook(() =>
    usePierreDiffFind({ isEditable, containerRef: { current: container } })
  )
  const attachContent = () => {
    const content = document.createElement('div')
    content.setAttribute('contenteditable', 'true')
    shadow.append(content)
    return content
  }
  const find = () =>
    act(() =>
      result.current.handleContainerKeyDown({
        key: 'f',
        ctrlKey: true,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn()
      } as unknown as React.KeyboardEvent<HTMLElement>)
    )
  return { result, attachContent, find }
}

describe('Pierre find shortcut', () => {
  it('opens on the first press when the editable surface is already attached', () => {
    const { attachContent, find } = setup(true)
    const content = attachContent()
    const search = vi.fn()
    content.addEventListener('keydown', search)
    find()
    act(() => vi.runOnlyPendingTimers())
    expect(search).toHaveBeenCalledOnce()
    expect(search.mock.calls[0][0]).toMatchObject({ key: 'f', ctrlKey: true })
  })

  it('opens after a read-only find session attaches and cancels on Escape', () => {
    const { result, attachContent, find } = setup(false)
    find()
    expect(result.current.editEnabled).toBe(true)
    const content = attachContent()
    const search = vi.fn()
    content.addEventListener('keydown', search)
    act(() => result.current.handleEditorAttach({ focus: vi.fn() }))
    act(() =>
      result.current.handleContainerKeyDown({ key: 'Escape' } as React.KeyboardEvent<HTMLElement>)
    )
    act(() => vi.runOnlyPendingTimers())
    expect(search).not.toHaveBeenCalled()
    expect(result.current.editEnabled).toBe(false)
  })
})
