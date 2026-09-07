// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatReasoningRow } from './NativeChatReasoningRow'
import { MessageRow } from './NativeChatMessageRow'

vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>
}))

afterEach(cleanup)

describe('reasoning disclosure', () => {
  it('starts collapsed with the first meaningful line and does not mount markdown', () => {
    render(<NativeChatReasoningRow markdown={'\n\nInspecting the request\nFull reasoning'} />)
    expect(
      screen.getByRole('button', { name: 'Reasoning: Inspecting the request' })
    ).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
    expect(screen.queryByText(/Thought for/)).not.toBeInTheDocument()
  })

  it('expands through a native button and preserves disclosure state through revisions', () => {
    const { rerender } = render(<NativeChatReasoningRow markdown="Inspecting" />)
    const trigger = screen.getByRole('button')
    expect(trigger.tagName).toBe('BUTTON')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('markdown')).toHaveTextContent('Inspecting')
    rerender(<NativeChatReasoningRow markdown={'Inspecting the request\nMore reasoning'} />)
    expect(screen.getByRole('button')).toBe(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('markdown')).toHaveTextContent('More reasoning')
    fireEvent.click(trigger)
    rerender(<NativeChatReasoningRow markdown={'Inspecting the request\nFinal reasoning'} />)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
  })

  it.each(['', ' \n\t'])('omits blank reasoning %j', (markdown) => {
    const { container } = render(<NativeChatReasoningRow markdown={markdown} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('bounds a growing summary without changing the collapsed layout', () => {
    render(<NativeChatReasoningRow markdown={'a'.repeat(200)} />)
    expect(screen.getByRole('button')).toHaveTextContent(`${'a'.repeat(120)}…`)
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
  })

  it('uses the existing message prose pipeline for reasoning-role messages', () => {
    const message: NativeChatMessage = {
      id: 'reasoning-1',
      role: 'reasoning',
      source: 'transcript',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Inspecting the request\nFull reasoning' }]
    }
    render(<MessageRow message={message} expandSignal={false} onScrollMessageToTop={vi.fn()} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('markdown')).toHaveTextContent('Full reasoning')
  })
})
