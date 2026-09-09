// What each background task ROW is called and which glyph stands for it.
//
// A row names what the work actually is — a subagent, a shell — instead of a
// generic "Background <kind>". Every glyph but the monitor's resolves through
// the shared tool-icon table, so a subagent here and a subagent on a tool row
// can never draw as different categories. The collapsed header summary is not
// this module's concern; it is owned separately.

import { Activity } from 'lucide-react'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import type { NativeChatToolIconName } from '../../../../shared/native-chat-tool-icon'
import { NativeChatGlyphSlot, NativeChatToolRunIcon } from './NativeChatToolIcon'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type BackgroundTaskKind = AgentSessionBackgroundTask['kind']

/** `heartbeat` is deliberately outside the tool table: monitoring is one idea
 *  app-wide, and the heartbeat is the glyph that already stands for it in the
 *  agent sidebar and on AgentStateDot. A second monitor glyph would split it. */
type BackgroundTaskGlyph = NativeChatToolIconName | 'heartbeat'

const KIND_GLYPHS: Record<BackgroundTaskKind, BackgroundTaskGlyph> = {
  agent: 'bot',
  workflow: 'list-checks',
  command: 'square-terminal',
  monitor: 'heartbeat',
  unknown: 'wrench'
}

/** The amber AgentStateDot and the sidebar's StatusIndicator both use for
 *  monitoring. Exported so a test can pin the two together. */
export const MONITOR_GLYPH_COLOR = 'text-yellow-500'

export function backgroundTaskKindGlyph(kind: BackgroundTaskKind): BackgroundTaskGlyph {
  return KIND_GLYPHS[kind]
}

/** The row's name when the provider sent no description of its own. */
export function backgroundTaskKindLabel(kind: BackgroundTaskKind): string {
  switch (kind) {
    case 'agent':
      return translate('components.native-chat.backgroundTasks.agent', 'Subagent')
    case 'workflow':
      return translate('components.native-chat.backgroundTasks.workflow', 'Workflow')
    case 'command':
      return translate('components.native-chat.backgroundTasks.command', 'Shell command')
    case 'monitor':
      return translate('components.native-chat.backgroundTasks.monitor', 'Monitor')
    case 'unknown':
      return translate('components.native-chat.backgroundTasks.task', 'Background task')
  }
}

/**
 * Decorative: the row's own word is its accessible name.
 *
 * The other kinds stay muted because they only mark a category. Monitoring is a
 * STATE the app already colours, so the heartbeat carries the same amber
 * AgentStateDot and the sidebar give it — same glyph and same treatment, or it
 * does not read as the same thing. `cn` is tailwind-merge aware, so this wins
 * over a muted class the caller passed.
 */
export function BackgroundTaskKindIcon({
  kind,
  className
}: {
  kind: BackgroundTaskKind
  className?: string
}): React.JSX.Element {
  const glyph = backgroundTaskKindGlyph(kind)
  return glyph === 'heartbeat' ? (
    <NativeChatGlyphSlot glyph={Activity} className={cn(className, MONITOR_GLYPH_COLOR)} />
  ) : (
    <NativeChatToolRunIcon iconName={glyph} className={className} />
  )
}
