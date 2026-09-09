export type HostSessionTabCloseResult =
  | { outcome: 'closed' }
  | { outcome: 'refused'; reason: string | null }

export type HostSessionTabOperations = {
  createBrowser(workspaceId: string, url: string): Promise<{ browserPageId?: string }>
  close(workspaceId: string, tabId: string): Promise<HostSessionTabCloseResult>
}
