import {
  MOBILE_WEB_FILE_CHUNK_MAX_BYTES,
  MobileWebFileChunkResultSchema,
  MobileWebFileDirectoryEntrySchema,
  MobileWebFileDirectoryResultSchema,
  type MobileWebFileChunkWireResult,
  type MobileWebFileDirectoryEntry,
  type MobileWebFileDirectoryResult
} from './bridge-operation-contract'
import { MobileWebBrokerError } from './bridge-operation-error'
import {
  compareMobileWebDirectoryEntries,
  mobileWebDirectoryRevision
} from './file-directory-presentation'

export function sanitizeDirectoryResult(
  result: unknown,
  workspaceId: string,
  relativePath: string,
  limit: number
): MobileWebFileDirectoryResult {
  if (!Array.isArray(result)) {
    throw new MobileWebBrokerError('host_error')
  }
  const names = new Set<string>()
  const entries = result.slice(0, limit).flatMap((value): MobileWebFileDirectoryEntry[] => {
    if (!isRecord(value) || typeof value.name !== 'string' || names.has(value.name)) {
      return []
    }
    const parsed = MobileWebFileDirectoryEntrySchema.safeParse({
      name: value.name,
      isDirectory: value.isDirectory === true,
      isSymlink: value.isSymlink === true
    })
    if (!parsed.success) {
      return []
    }
    names.add(parsed.data.name)
    return [parsed.data]
  })
  entries.sort(compareMobileWebDirectoryEntries)
  const truncated = result.length > entries.length
  return MobileWebFileDirectoryResultSchema.parse({
    workspaceId,
    relativePath,
    revision: mobileWebDirectoryRevision(entries, truncated),
    entries,
    truncated
  })
}

export function sanitizeChunkResult(
  result: unknown,
  payload: {
    workspaceId: string
    relativePath: string
    offset: number
    length: number
  }
): MobileWebFileChunkWireResult {
  if (
    !isRecord(result) ||
    typeof result.contentBase64 !== 'string' ||
    typeof result.bytesRead !== 'number' ||
    !Number.isSafeInteger(result.bytesRead) ||
    result.bytesRead < 0 ||
    result.bytesRead > payload.length ||
    result.bytesRead > MOBILE_WEB_FILE_CHUNK_MAX_BYTES ||
    typeof result.eof !== 'boolean'
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebFileChunkResultSchema.parse({
    workspaceId: payload.workspaceId,
    relativePath: payload.relativePath,
    offset: payload.offset,
    contentBase64: result.contentBase64,
    bytesRead: result.bytesRead,
    eof: result.eof
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
