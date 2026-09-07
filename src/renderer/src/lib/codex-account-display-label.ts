export type CodexDisplayAccount = {
  id: string
  email: string
  workspaceLabel?: string | null
}

export function getCodexAccountDisplayDetail(
  account: CodexDisplayAccount,
  accounts: readonly CodexDisplayAccount[]
): string | null {
  const workspace = account.workspaceLabel?.trim() || null
  const peers = accounts.filter(
    (entry) =>
      entry.id !== account.id &&
      entry.email.trim().toLowerCase() === account.email.trim().toLowerCase()
  )
  const workspaces = [workspace, ...peers.map((entry) => entry.workspaceLabel?.trim() || null)]
  if (
    peers.length === 0 ||
    (workspaces.every(Boolean) && new Set(workspaces).size === workspaces.length)
  ) {
    return workspace
  }

  // Extend the stored account ID prefix until even same-prefix accounts are distinguishable.
  let length = Math.min(8, account.id.length)
  while (
    length < account.id.length &&
    peers.some((entry) => entry.id.slice(0, length) === account.id.slice(0, length))
  ) {
    length += 1
  }
  const identifier = account.id.slice(0, length)
  return workspace ? `${workspace} · ${identifier}` : identifier
}

export function getCodexAccountDisplayLabel(
  account: CodexDisplayAccount,
  accounts: readonly CodexDisplayAccount[]
): string {
  const detail = getCodexAccountDisplayDetail(account, accounts)
  return detail ? `${account.email} (${detail})` : account.email
}
