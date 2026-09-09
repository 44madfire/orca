import { realpath } from 'node:fs/promises'
import { fileUriToFilesystemPath } from '../../shared/file-uri-path'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { BrowserError } from '../browser/browser-error'

export type BrowserFileUrlWorktreeTarget = {
  id: string
  path?: string
  hostId?: ExecutionHostId
}

export function isBrowserFileUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'file:'
  } catch {
    return false
  }
}

/**
 * A paired client (phone, web client, remote desktop, remote CLI) is not trusted to name a
 * filesystem path: a `file:` create or navigation only renders a file inside the workspace it
 * named, on this host. Local callers keep their existing reach, and the screencast that streams
 * the render back never leaves that root.
 */
export async function assertPairedBrowserFileUrlAllowed(input: {
  url: string
  pairedCaller: boolean
  worktree: BrowserFileUrlWorktreeTarget | undefined
}): Promise<void> {
  if (!input.pairedCaller || !isBrowserFileUrl(input.url)) {
    return
  }
  const root = input.worktree?.path
  if (!root) {
    throw new BrowserError(
      'forbidden',
      'A file:// browser page requires an explicit workspace on this host.'
    )
  }
  if (input.worktree?.hostId !== undefined && input.worktree.hostId !== LOCAL_EXECUTION_HOST_ID) {
    // Why: the URL would be opened against this host's filesystem, where a remote workspace's path
    // names a different file (or none) than the one the caller asked for.
    throw new BrowserError(
      'forbidden',
      'A file:// browser page is not available for a remote workspace.'
    )
  }
  let candidate: string | null
  try {
    candidate = fileUriToFilesystemPath(new URL(input.url))
  } catch {
    candidate = null
  }
  if (!candidate || !(await resolvedPathIsInsideRoot(root, candidate))) {
    throw new BrowserError('forbidden', 'That file is outside the requested workspace.')
  }
}

// Why: a lexical containment check passes a symlink that sits inside the root and points out of
// it, so both sides are compared after realpath. Requiring the target to exist is what makes a
// dangling symlink refusable — its nearest existing ancestor is still inside the root.
async function resolvedPathIsInsideRoot(root: string, candidate: string): Promise<boolean> {
  try {
    return isPathInsideOrEqual(await realpath(root), await realpath(candidate))
  } catch {
    return false
  }
}
