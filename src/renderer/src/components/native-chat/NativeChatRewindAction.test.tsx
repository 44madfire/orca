// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageRow } from './NativeChatMessageRow'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

afterEach(cleanup)
function row(
  role: NativeChatMessage['role'],
  disabledReason: string | null = null,
  enabled = true
) {
  const request = vi.fn()
  render(
    <MessageRow
      message={{
        id: 'user-1',
        role,
        timestamp: 1,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Prompt' }]
      }}
      expandSignal={false}
      onScrollMessageToTop={vi.fn()}
      rewind={enabled ? { request, disabledReason } : undefined}
    />
  )
  return request
}
describe('user-row rewind affordance', () => {
  it('is keyboard reachable and calls the selected user item from the hover strip', () => {
    const request = row('user')
    const button = screen.getByRole('button', { name: 'Revert to here' })
    button.focus()
    expect(button).toHaveFocus()
    expect(button.parentElement).toHaveClass(
      'group-hover:opacity-100',
      'group-focus-within:opacity-100'
    )
    fireEvent.click(button)
    expect(request).toHaveBeenCalledWith('user-1')
  })
  it('exposes the disabled reason to keyboard users and cannot invoke rewind', () => {
    const request = row('user', 'This older Codex conversation does not support rewinding.')
    const button = screen.getByRole('button', { name: 'Revert to here' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute(
      'aria-description',
      'This older Codex conversation does not support rewinding.'
    )
    button.focus()
    expect(button).toHaveFocus()
    fireEvent.click(button)
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['assistant', 'reasoning', 'system'] as const)('omits rewind for %s', (role) => {
    row(role)
    expect(screen.queryByRole('button', { name: 'Revert to here' })).toBeNull()
  })
  it('leaves legacy user rows without rewind', () => {
    row('user', null, false)
    expect(screen.queryByRole('button', { name: 'Revert to here' })).toBeNull()
  })
})
