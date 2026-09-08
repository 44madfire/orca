import { isSafeGitRefName } from './git-status-upstream-ref'

type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

function refspecMatch(pattern: string, ref: string): string | null {
  const parts = pattern.split('*')
  if (parts.length === 1) {
    return pattern === ref ? '' : null
  }
  if (parts.length !== 2 || !ref.startsWith(parts[0]!) || !ref.endsWith(parts[1]!)) {
    return null
  }
  return ref.length >= parts[0]!.length + parts[1]!.length
    ? ref.slice(parts[0]!.length, ref.length - parts[1]!.length)
    : null
}

function isMissingTrackingRef(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const candidate = error as Error & { code?: unknown; stderr?: unknown }
  if (typeof candidate.stderr === 'string' && candidate.stderr.trim()) {
    return false
  }
  return candidate.code === 1 || /(?:exited with|exit code) 1\b/i.test(candidate.message)
}

// Only configured fetch destinations establish tracking authority, regardless of namespace.
export async function readGitRemoteTrackingRef(
  runGit: GitCommandRunner,
  remote: string,
  branch: string
): Promise<string | null> {
  let stdout: string
  try {
    ;({ stdout } = await runGit(['config', '--get-all', `remote.${remote}.fetch`]))
  } catch (error) {
    if (isMissingTrackingRef(error)) {
      return null
    }
    throw error
  }
  const source = `refs/heads/${branch}`
  const specs = stdout.trim().split(/\r?\n/)
  if (specs.some((spec) => spec.startsWith('^') && refspecMatch(spec.slice(1), source) !== null)) {
    return null
  }
  for (const spec of specs) {
    const [from, to, extra] = spec.replace(/^\+/, '').split(':')
    if (!from || !to || extra !== undefined) {
      continue
    }
    const match = refspecMatch(from, source)
    if (match === null || from.includes('*') !== to.includes('*') || to.split('*').length > 2) {
      continue
    }
    const ref = to.replace('*', () => match)
    if (!isSafeGitRefName(ref)) {
      continue
    }
    try {
      await runGit(['rev-parse', '--verify', '--quiet', ref])
      return ref
    } catch (error) {
      if (isMissingTrackingRef(error)) {
        return null
      }
      throw error
    }
  }
  return null
}
