// Pi resume and history rebuild (SNC1.9 native Pi).
//
// Restores an existing Pi session file into a fresh `pi --mode rpc` child via
// typed `switch_session` (never CLI pickers) and rebuilds only the active
// branch (root → current leaf) for journal replacement. Mirrors the proven
// orca-pi `pi-provider.ts` resume flow (`onPiAcquireResume`,
// `checkResumePathCwd`, `rebuildHistoryFromPi`): the Pi session file is
// authoritative after the switch, abandoned sibling branches are excluded,
// and every failure is an actionable `PI_*` code — never a silent truncated
// transcript. Diagnostics never include either path.

import { open } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import type { PiFamilyProvider } from './rpc/pi-family-rpc-types'
import type { PiRpcConnection } from './rpc/pi-rpc-connection'
import type { PiEntry, PiState, PiTreeNode } from './rpc/pi-wire-protocol'
import { translatePiFamilyBranchToHistory } from './pi-family-history'
import {
  extractActiveBranch,
  extractActiveBranchFromTree,
  type ActiveBranchResult,
  type PiHistoryEntryLike,
  type PiHistoryTreeNodeLike
} from './translation/pi-branch-history'
import type { PiHistoryRow } from './translation/pi-session-events'

export type PiResumeHistory = {
  rows: PiHistoryRow[]
  leafId: string
}

export type PiResumeFailure = {
  ok: false
  code:
    | 'PI_RESUME_UNSUPPORTED'
    | 'PI_RESUME_FAILED'
    | 'PI_RESUME_CANCELLED'
    | 'PI_RESUME_CWD_MISMATCH'
    | 'PI_STATE_FAILED'
    | 'PI_HISTORY_EMPTY'
    | 'PI_HISTORY_LEAF_MISSING'
    | 'PI_HISTORY_CHAIN_BROKEN'
    | 'PI_HISTORY_CYCLE'
    | 'PI_HISTORY_INCOMPATIBLE'
    | 'PI_HISTORY_BUSY'
    | 'PI_EXITED'
  message: string
}

export type PiHistoryRebuild = { ok: true; history: PiResumeHistory } | PiResumeFailure

type SwitchCapableConnection = Pick<PiRpcConnection, 'switchSession' | 'getState'>

/**
 * Switch one fresh child onto an existing session file and re-read state.
 * Runs the header CWD check first (a foreign file would rebind Pi tools
 * outside the leased workspace), honors extension vetoes, and never names
 * either path in diagnostics.
 */
export async function resumePiSession(
  conn: SwitchCapableConnection,
  input: { resumePath: string; workspaceRoot: string; timeoutMs: number }
): Promise<{ state: PiState; resumed: boolean }> {
  const cwdCheck = await checkResumePathCwd(input.resumePath, input.workspaceRoot)
  if (!cwdCheck.ok) {
    throw new Error(`${cwdCheck.code}: ${cwdCheck.message}`)
  }
  let cancelled = false
  try {
    const switched = await conn.switchSession(input.resumePath, { timeoutMs: input.timeoutMs })
    cancelled = switched?.cancelled === true
  } catch {
    throw new Error('PI_RESUME_FAILED: Pi session resume failed (reacquire without resume for a fresh session)')
  }
  if (cancelled) {
    throw new Error('PI_RESUME_CANCELLED: Pi refused the session switch (vetoed by an extension)')
  }
  try {
    return { state: await conn.getState({ timeoutMs: input.timeoutMs }), resumed: true }
  } catch {
    throw new Error('PI_STATE_FAILED: Pi resumed but get_state failed (reacquire the session)')
  }
}

/**
 * Switch one fresh child onto an existing session file for either provider.
 * The file must already exist: a missing path would silently become a new
 * empty session on real providers, so resume fails closed before switching.
 * Pi files keep the header CWD check; OMP files stay opaque (same-provider
 * switch plus session-id verification, never parsed here).
 */
export async function resumePiFamilySession(
  conn: SwitchCapableConnection,
  input: { provider: PiFamilyProvider; resumePath: string; workspaceRoot: string; timeoutMs: number }
): Promise<{ state: PiState; resumed: boolean }> {
  try {
    const handle = await open(input.resumePath, 'r')
    await handle.close().catch(() => undefined)
  } catch {
    throw new Error('PI_RESUME_FAILED: Pi-family session file is missing (reacquire without resume for a fresh session)')
  }
  if (input.provider === 'omp') {
    let cancelled = false
    try {
      const switched = await conn.switchSession(input.resumePath, { timeoutMs: input.timeoutMs })
      cancelled = switched?.cancelled === true
    } catch {
      throw new Error('PI_RESUME_FAILED: OMP session resume failed (reacquire without resume for a fresh session)')
    }
    if (cancelled) {
      throw new Error('PI_RESUME_CANCELLED: OMP refused the session switch')
    }
    try {
      return { state: await conn.getState({ timeoutMs: input.timeoutMs }), resumed: true }
    } catch {
      throw new Error('PI_STATE_FAILED: OMP resumed but get_state failed (reacquire the session)')
    }
  }
  return resumePiSession(conn, input)
}

type HistoryCapableConnection = Pick<PiRpcConnection, 'getEntries' | 'getTree' | 'switchSession' | 'getState'>

function asEntryLikes(entries: readonly PiEntry[]): PiHistoryEntryLike[] {
  return entries as unknown as PiHistoryEntryLike[]
}

function asTreeLikes(tree: readonly PiTreeNode[]): PiHistoryTreeNodeLike[] {
  return tree as unknown as PiHistoryTreeNodeLike[]
}

/**
 * Validate a resume file's session-header cwd against the Orca-selected
 * workspaceRoot BEFORE switching: `switch_session` rebinds the runtime cwd
 * to the file's stored cwd, so resuming a foreign file would run Pi tools
 * outside the leased workspace. A missing file is fine (Pi creates it as a
 * new empty session); anything else unreadable, a header without a usable
 * cwd, or a mismatch fails closed without naming either path.
 */
export async function checkResumePathCwd(
  resumePath: string,
  workspaceRoot: string
): Promise<{ ok: true } | { ok: false; code: 'PI_RESUME_FAILED' | 'PI_RESUME_CWD_MISMATCH'; message: string }> {
  const unreadable = {
    ok: false as const,
    code: 'PI_RESUME_FAILED' as const,
    message:
      'Pi session file is unreadable or incompatible (check the path and retry without resume for a fresh session)'
  }
  let firstLine: string
  try {
    const fh = await open(resumePath, 'r')
    try {
      const buf = Buffer.alloc(65536)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const chunk = buf.toString('utf8', 0, bytesRead)
      const nl = chunk.indexOf('\n')
      firstLine = (nl === -1 ? chunk : chunk.slice(0, nl)).replace(/\r$/, '')
    } finally {
      await fh.close().catch(() => undefined)
    }
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'ENOENT') {
      return { ok: true }
    }
    return unreadable
  }
  let storedCwd: unknown
  try {
    const parsed: unknown = JSON.parse(firstLine)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('bad header')
    }
    storedCwd = (parsed as Record<string, unknown>)['cwd']
  } catch {
    return unreadable
  }
  if (typeof storedCwd !== 'string' || storedCwd === '') {
    return {
      ok: false,
      code: 'PI_RESUME_FAILED',
      message: 'Pi session file is incompatible (missing session cwd; update Pi or choose another session file)'
    }
  }
  const norm = (value: string): string => {
    const resolved = resolvePath(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  let same = false
  try {
    same = norm(storedCwd) === norm(workspaceRoot)
  } catch {
    same = false
  }
  if (!same) {
    return {
      ok: false,
      code: 'PI_RESUME_CWD_MISMATCH',
      message:
        'Pi session belongs to a different workspace (resume refused; reacquire without resume for a fresh session or choose a session file from this workspace)'
    }
  }
  return { ok: true }
}

function branchResultToFailure(result: Exclude<ActiveBranchResult, { ok: true }>): PiResumeFailure {
  return { ok: false, code: result.code, message: result.message }
}

/**
 * Rebuild one idle session's history from Pi's active branch. Tries
 * `get_entries` + leaf first with `get_tree` as fallback when the flat chain
 * is broken; roles outside user/assistant/tool/textual system are skipped
 * (bounded ignore, never fabricated). Fails closed when the connection is
 * gone, a turn streams, or the chain does not resolve to exactly one branch.
 */
export async function rebuildPiHistory(
  conn: HistoryCapableConnection,
  opts: { timeoutMs: number; busy: boolean; closed: boolean; provider?: PiFamilyProvider }
): Promise<PiHistoryRebuild> {
  if (opts.closed) {
    return { ok: false, code: 'PI_EXITED', message: 'pi-exited (reacquire the session)' }
  }
  if (opts.busy) {
    return {
      ok: false,
      code: 'PI_HISTORY_BUSY',
      message: 'cannot rebuild history while a turn streams (wait for idle or cancel)'
    }
  }
  let leafId: string | undefined
  let branchEntries: PiHistoryEntryLike[] | null = null
  try {
    const data = await conn.getEntries(undefined, { timeoutMs: opts.timeoutMs })
    leafId = data.leafId
    const branch = extractActiveBranch(asEntryLikes(data.entries), data.leafId)
    if (!branch.ok) {
      if (branch.code !== 'PI_HISTORY_CHAIN_BROKEN') {
        return branchResultToFailure(branch)
      }
      const tree = await conn.getTree({ timeoutMs: opts.timeoutMs })
      leafId = tree.leafId
      const fromTree = extractActiveBranchFromTree(asTreeLikes(tree.tree), tree.leafId)
      if (!fromTree.ok) {
        return branchResultToFailure(fromTree)
      }
      branchEntries = fromTree.branch
    } else {
      branchEntries = branch.branch
    }
  } catch {
    return {
      ok: false,
      code: 'PI_HISTORY_EMPTY',
      message: 'Pi history is empty or unavailable (reacquire the session)'
    }
  }
  if (!leafId || !branchEntries) {
    return {
      ok: false,
      code: 'PI_HISTORY_EMPTY',
      message: 'Pi history is empty or unavailable (reacquire the session)'
    }
  }
  // One structural walk for both providers; only the entry normalizer is provider-aware.
  const rows = translatePiFamilyBranchToHistory(branchEntries, opts.provider ?? 'pi')
  return { ok: true, history: { rows, leafId } }
}
