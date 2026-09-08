// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatTaskList } from './NativeChatTaskList'
import type { NativeChatTaskList as TaskList } from '../../../../shared/native-chat-task-list'

afterEach(cleanup)
const previous: TaskList = {
  tasks: [
    { content: 'Read', status: 'in_progress', activeForm: 'Reading' },
    { content: 'Write', status: 'pending', activeForm: 'Writing' },
    { content: 'Test', status: 'pending' }
  ]
}
const current: TaskList = {
  tasks: [
    { content: 'Read', status: 'completed', activeForm: 'Reading' },
    { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
    { content: 'Test', status: 'pending' }
  ]
}

describe('NativeChatTaskList', () => {
  it('starts as quiet chrome and reveals tri-state tasks on demand', () => {
    const { container } = render(<NativeChatTaskList list={current} />)
    const toggle = screen.getByRole('button', { name: 'Tasks 1 of 3 tasks completed' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Test')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('Read')).toHaveClass('line-through')
    expect(screen.getByText('Writing').closest('li')).toHaveClass('text-foreground')
    expect(screen.getByLabelText('1 of 3 tasks completed')).toHaveTextContent('1/3')
    for (const glyph of ['circle', 'circle-dot', 'circle-check']) {
      expect(container.querySelector(`.lucide-${glyph}`)).not.toBeNull()
    }
    expect(screen.getByText('In progress:')).toHaveClass('sr-only')
  })

  it('updates the same expanded list without appending a change feed', () => {
    const { rerender } = render(<NativeChatTaskList list={previous} />)
    const toggle = screen.getByRole('button', { name: 'Tasks 0 of 3 tasks completed' })
    fireEvent.click(toggle)
    rerender(<NativeChatTaskList list={{ ...current, explanation: 'Continuing verification' }} />)
    expect(screen.getByRole('button', { name: 'Tasks 1 of 3 tasks completed' })).toBe(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('list')).toHaveLength(1)
    expect(screen.getByText('Read')).toHaveClass('line-through')
    expect(screen.getByText('Writing')).toBeInTheDocument()
    expect(screen.queryByText('Completed Read')).toBeNull()
    expect(screen.queryByText('Started Write')).toBeNull()
    expect(screen.getByText('Continuing verification')).toBeInTheDocument()
  })
})
