import { describe, expect, it } from 'vitest'
import {
  backgroundTaskKindGlyph,
  backgroundTaskKindLabel
} from './native-chat-background-task-kinds'

describe('background task kind presentation', () => {
  it('resolves each tool-backed kind through the shared glyph table', () => {
    // Same names the tool rows use, so a subagent cannot draw two ways.
    expect(backgroundTaskKindGlyph('agent')).toBe('bot')
    expect(backgroundTaskKindGlyph('command')).toBe('square-terminal')
    expect(backgroundTaskKindGlyph('workflow')).toBe('list-checks')
    expect(backgroundTaskKindGlyph('unknown')).toBe('wrench')
  })

  it('draws a monitor as the heartbeat, the one monitoring glyph app-wide', () => {
    // The sidebar and AgentStateDot already mean "monitoring" with the
    // heartbeat; a second glyph here would split one idea in two.
    expect(backgroundTaskKindGlyph('monitor')).toBe('heartbeat')
  })

  it('labels a row by what it is', () => {
    expect(backgroundTaskKindLabel('agent')).toBe('Subagent')
    expect(backgroundTaskKindLabel('command')).toBe('Shell command')
    expect(backgroundTaskKindLabel('monitor')).toBe('Monitor')
  })
})
