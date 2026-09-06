import {
  MobileWebFileEntrySchema,
  MobileWebFileListResultSchema,
  type MobileWebFileEntry,
  type MobileWebFileListResult
} from './file-operation-contract'
import { MobileWebBrokerError } from './bridge-operation-error'

export function sanitizeListResult(
  result: unknown,
  pageWorkspaceId: string,
  hostWorkspaceId: string | undefined,
  limit: number
): MobileWebFileListResult {
  if (!isRecord(result) || result.worktree !== hostWorkspaceId || !Array.isArray(result.files)) {
    throw new MobileWebBrokerError('host_error')
  }
  const files = result.files.slice(0, limit).flatMap((value): MobileWebFileEntry[] => {
    if (!isRecord(value) || typeof value.relativePath !== 'string') {
      return []
    }
    const parsed = MobileWebFileEntrySchema.safeParse({
      relativePath: value.relativePath,
      basename: value.relativePath.split('/').at(-1)?.slice(0, 255),
      kind: value.kind === 'binary' ? 'binary' : 'text'
    })
    return parsed.success ? [parsed.data] : []
  })
  const totalCount =
    typeof result.totalCount === 'number' &&
    Number.isSafeInteger(result.totalCount) &&
    result.totalCount >= 0
      ? result.totalCount
      : result.files.length
  return MobileWebFileListResultSchema.parse({
    workspaceId: pageWorkspaceId,
    files,
    totalCount,
    truncated:
      result.truncated === true || result.files.length > files.length || totalCount > files.length
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
