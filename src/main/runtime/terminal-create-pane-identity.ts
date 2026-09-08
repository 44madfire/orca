import { randomUUID } from 'node:crypto'
import { isValidHostTerminalTabId } from '../../shared/terminal-tab-id'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'

export function resolveTerminalCreatePaneIdentity(options: { tabId?: string; leafId?: string }): {
  tabId: string
  leafId: string
  paneKey: string
} {
  const hintedTabId = options.tabId?.trim()
  const canAdopt =
    hintedTabId !== undefined &&
    isValidHostTerminalTabId(hintedTabId) &&
    options.leafId !== undefined &&
    isTerminalLeafId(options.leafId)
  const tabId = canAdopt ? hintedTabId! : randomUUID()
  const leafId = canAdopt ? options.leafId! : randomUUID()
  return { tabId, leafId, paneKey: makePaneKey(tabId, leafId) }
}
