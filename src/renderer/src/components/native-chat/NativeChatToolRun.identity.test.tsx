// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatToolRun } from './NativeChatToolRun'
import type { NativeChatToolCallBlock } from '../../../../shared/native-chat-types'

vi.mock('./NativeChatDiffCard', () => ({ NativeChatDiffCard: () => null }))
vi.mock('./NativeChatDiffView', () => ({ NativeChatDiffView: () => null }))
afterEach(cleanup)

const shell: NativeChatToolCallBlock = {
  type: 'tool-call',
  name: 'shell',
  input: { command: 'missing-command' },
  state: 'failed',
  exitCode: 127,
  durationMs: 400
}

describe('inline tool annotations', () => {
  it('keeps command completion annotations on the collapsed tool line', () => {
    render(
      <NativeChatToolRun
        blocks={[shell]}
        expandSignal={false}
        expandOverride
        activeTurnIsWorking={false}
      />
    )
    expect(screen.getByText('exit 127').closest('button')).toBe(
      screen.getByText('400ms').closest('button')
    )
    expect(screen.getByText('exit 127').closest('button')?.getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(screen.queryByText('0s')).toBeNull()
  })
  it('renders a legacy command without invented metadata', () => {
    render(
      <NativeChatToolRun
        blocks={[{ type: 'tool-call', name: 'shell', input: null }]}
        expandSignal
      />
    )
    expect(screen.queryByText(/exit \d/)).toBeNull()
    expect(screen.queryByText(/\d+ms/)).toBeNull()
  })
  it('shows distinct MCP names while retaining the raw identifier', () => {
    const name = 'mcp__linear__list_issues'
    render(<NativeChatToolRun blocks={[{ type: 'tool-call', name, input: null }]} expandSignal />)
    expect(screen.getByText('Linear')).toBeTruthy()
    expect(screen.getByText('list issues')).toBeTruthy()
    expect(screen.getByTitle(name)).toBeTruthy()
  })
  it('reveals safe result links only inside row disclosure and routes clicks through chat', () => {
    const onLinkClick = vi.fn((event) => event.preventDefault())
    const block: NativeChatToolCallBlock = {
      type: 'tool-call',
      name: 'web_search',
      input: { query: 'docs' },
      state: 'completed',
      webSearchResults: [{ title: 'Reference docs', url: 'https://example.com/docs' }]
    }
    render(
      <NativeChatToolRun
        blocks={[block]}
        expandSignal={false}
        expandOverride
        onLinkClick={onLinkClick}
      />
    )
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(screen.getByText('web_search').closest('button')!)
    const link = screen.getByRole('link', { name: /Reference docs/ })
    expect(link.getAttribute('href')).toBe('https://example.com/docs')
    expect(link.closest('button')).toBeNull()
    fireEvent.click(link)
    expect(onLinkClick).toHaveBeenCalledWith(expect.anything(), 'https://example.com/docs')
    fireEvent(link, new MouseEvent('auxclick', { button: 1, bubbles: true }))
    expect(onLinkClick).toHaveBeenCalledTimes(2)
  })
})
