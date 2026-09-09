import type { SessionTabsResult } from './mobile-session-route-types'

export type HostSessionTabCloseResult =
  | { outcome: 'closed' }
  | { outcome: 'refused'; reason: string | null }

export type HostSessionTabOperations = {
  createBrowser(workspaceId: string, url: string): Promise<{ browserPageId?: string }>
  close(workspaceId: string, tabId: string): Promise<HostSessionTabCloseResult>
}

export type { SessionTabsResult }
