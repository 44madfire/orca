import { isSafeGitRefName } from '../../shared/git-status-upstream-ref'
import {
  gitBranchNameFromFullRef,
  gitTrackingRefDisplayName
} from '../../shared/git-upstream-identity'
import { resolveEffectiveGitUpstreamForBranch } from '../../shared/git-effective-upstream'

type GitStatusUpstreamRefExec = (
  args: string[],
  cwd: string,
  signal: AbortSignal
) => Promise<{ stdout: string }>

export async function resolveGitStatusUpstreamRef(
  execGit: GitStatusUpstreamRefExec,
  worktreePath: string,
  branch: string,
  upstreamName: string,
  signal: AbortSignal,
  trackingRef?: string
): Promise<string | undefined> {
  const branchName = gitBranchNameFromFullRef(branch)
  if (!branchName || !isSafeGitRefName(branch)) {
    return undefined
  }
  const runGit = (args: string[]): Promise<{ stdout: string }> =>
    execGit(args, worktreePath, signal)
  const result = await runGit([
    'for-each-ref',
    '--format=%(refname)%00%(upstream)',
    '--count=1',
    branch
  ])
  const fields = result.stdout.replace(/\r?\n$/, '').split('\0')
  if (fields.length !== 2 || fields[0] !== branch) {
    return undefined
  }
  if (trackingRef !== undefined) {
    return isSafeGitRefName(trackingRef) ? trackingRef : undefined
  }
  // Older status publishers can be matched to host-owned refs, never parsed into revisions.
  if (isSafeGitRefName(fields[1]) && gitTrackingRefDisplayName(fields[1]) === upstreamName) {
    return fields[1]
  }
  const effective = await resolveEffectiveGitUpstreamForBranch(runGit, branchName)
  return effective?.upstreamName === upstreamName &&
    effective.upstreamRef &&
    isSafeGitRefName(effective.upstreamRef)
    ? effective.upstreamRef
    : undefined
}
