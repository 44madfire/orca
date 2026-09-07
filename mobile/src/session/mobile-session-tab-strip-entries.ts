import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/tui-agent-display-names'
import type { MobileSessionTab, MobileSessionTabType } from './mobile-session-route-types'
import {
  getMobileSessionTabTitle,
  resolveMobileTerminalTabAgentId
} from './mobile-terminal-tab-agent'
import { toMobileSessionTabStripRowKey } from './mobile-session-tab-strip-row-key'

/**
 * The only session-tab fields the tab strip draws. Everything else the live tab carries (unsent
 * launch drafts, absolute file paths, browser URLs, agent session ids) stays on the wire. The id
 * itself is wire-supplied too: an editor tab's id embeds its absolute path, so the cache stores
 * a digest of it, never the id.
 */
export type MobileSessionTabStripEntry = {
  id: string
  type: MobileSessionTabType
  title: string
  agentId: string | null
}

export type MobileSessionTabStripPreview = {
  tabs: readonly MobileSessionTabStripEntry[]
  activeTabId: string | null
}

export type MobileSessionTabStripRow = {
  /** React key. A digest of the tab id, so a preview row and its live successor share one. */
  key: string
  entry: MobileSessionTabStripEntry
  isActive: boolean
  /** null on a preview row: switching to that tab needs a live connection. */
  tab: MobileSessionTab | null
}

export function toMobileSessionTabStripEntry(tab: MobileSessionTab): MobileSessionTabStripEntry {
  return {
    id: tab.id,
    type: tab.type,
    title: getMobileSessionTabTitle(tab),
    agentId:
      tab.type === 'agent-session'
        ? tab.agent
        : tab.type === 'terminal'
          ? resolveMobileTerminalTabAgentId(tab)
          : null
  }
}

/**
 * Every tab type the strip knows how to draw. A stored entry naming anything else is dropped
 * rather than trusted, so a type added later fails closed: its rows go missing from the preview
 * instead of carrying an unreviewed title into storage.
 */
const drawableTabTypes = new Set<string>([
  'terminal',
  'markdown',
  'file',
  'browser',
  'agent-session'
] satisfies readonly MobileSessionTabType[])

export function isDrawableTabStripType(type: string): type is MobileSessionTabType {
  return drawableTabTypes.has(type)
}

const agentDisplayNames: Readonly<Record<string, string>> = TUI_AGENT_DISPLAY_NAMES

/** An agent id is only kept on disk when it names a known agent; anything else is hook text. */
export function getPersistableTabStripAgentId(agentId: string | null): string | null {
  return agentId !== null && Object.hasOwn(agentDisplayNames, agentId) ? agentId : null
}

/**
 * The title a strip entry may be written to disk under. Nothing wire-supplied passes through.
 *
 * A terminal's title is whatever the shell last set, which is routinely the command line —
 * `psql postgres://user:password@host/db`, `curl -H "Authorization: Bearer ..."`. A browser
 * tab's page title, a file or markdown tab's basename, and an agent session's title are no
 * better: each names what the user was working on. Every type collapses to a fixed label, so
 * what survives is the shape of the strip, not its contents. A resolved agent still names
 * itself, because that lookup is a closed enum.
 */
export function getPersistableTabStripTitle(
  entry: Pick<MobileSessionTabStripEntry, 'type' | 'agentId'>
): string {
  const agentLabel = agentDisplayNames[getPersistableTabStripAgentId(entry.agentId) ?? '']
  switch (entry.type) {
    case 'terminal':
    case 'agent-session':
      return agentLabel ?? (entry.type === 'terminal' ? 'Terminal' : 'Agent')
    case 'browser':
      return 'Browser'
    case 'markdown':
      return 'Markdown'
    case 'file':
      return 'File'
  }
}

export function toMobileSessionTabStripPreview(
  tabs: readonly MobileSessionTab[],
  activeTabId: string | null
): MobileSessionTabStripPreview {
  return { tabs: tabs.map(toMobileSessionTabStripEntry), activeTabId }
}

/**
 * Rows for the header strip. Live tabs always win; the preview only fills a strip that has no
 * live rows yet. A preview id is already a row key, and a live row keys under the digest of its
 * id, so the swap reuses the same React keys.
 */
export function getMobileSessionTabStripRows(args: {
  liveTabs: readonly MobileSessionTab[]
  activeSessionTabId: string | null
  preview: MobileSessionTabStripPreview | null
}): MobileSessionTabStripRow[] {
  const { liveTabs, activeSessionTabId, preview } = args
  if (liveTabs.length > 0 || !preview) {
    return liveTabs.map((tab) => ({
      key: toMobileSessionTabStripRowKey(tab.id),
      entry: toMobileSessionTabStripEntry(tab),
      isActive: tab.id === activeSessionTabId,
      tab
    }))
  }
  return preview.tabs.map((entry) => ({
    key: entry.id,
    entry,
    isActive: entry.id === preview.activeTabId,
    tab: null
  }))
}
