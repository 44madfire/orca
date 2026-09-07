import { formatNativeChatDuration } from './native-chat-turn-status'

export type NativeChatWebSearchResult = { title: string; url: string }

export type NativeChatToolMetadata = {
  exitCode?: number
  durationMs?: number
  webSearchResults?: NativeChatWebSearchResult[]
}

export function toolExecutionMetadata(item: Record<string, unknown>): NativeChatToolMetadata {
  const durationMs = item.durationMs ?? item.duration_ms
  return {
    ...(typeof item.exitCode === 'number' && Number.isSafeInteger(item.exitCode)
      ? { exitCode: item.exitCode }
      : {}),
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMs }
      : {})
  }
}

export function formatToolDuration(durationMs: unknown): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return null
  }
  return durationMs < 1000
    ? `${Math.round(durationMs)}ms`
    : formatNativeChatDuration(durationMs / 1000)
}

// Unprefixed qualified names must not turn file names or paths into MCP identities.
const FILE_EXTENSION =
  /^(?:[cm]?[jt]sx?|py|rs|go|sh|bash|zsh|ps1|cmd|bat|exe|json|ya?ml|toml|md|txt|css|html|sql|rb|java|c|h|cpp|svg|png)$/i
const PATH_ROOT = /^(?:src|lib|bin|dist|build|scripts|tests|node_modules)$/i

export function mcpToolIdentity(name: string): { server: string; tool: string } | null {
  const raw = name.trim()
  const prefixed = /^mcp__([^\s]+?)__(\S+)$/.exec(raw)
  const qualified = /^([\w-]+)[/.]([\w-]+)$/.exec(raw)
  const match = prefixed ?? qualified
  if (!match || (!prefixed && (FILE_EXTENSION.test(match[2]!) || PATH_ROOT.test(match[1]!)))) {
    return null
  }
  const server = match[1]!.replace(/[_-]+/g, ' ')
  return {
    server: server.charAt(0).toUpperCase() + server.slice(1),
    tool: match[2]!.replace(/[_-]+/g, ' ')
  }
}

export const MAX_TOOL_SEARCH_RESULTS = 5
const MAX_SEARCH_RESULT_SCAN = 100
const MAX_SEARCH_URL_LENGTH = 2048
const MAX_SEARCH_TITLE_LENGTH = 200

/** A bounded, link-safe subset; the provider's full output remains the detail fallback. */
export function toolWebSearchResults(value: unknown): NativeChatWebSearchResult[] {
  if (!Array.isArray(value)) {
    return []
  }
  const results: NativeChatWebSearchResult[] = []
  const seen = new Set<string>()
  for (const entry of value.slice(0, MAX_SEARCH_RESULT_SCAN)) {
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') {
      continue
    }
    const url = entry.url.trim()
    if (url.length > MAX_SEARCH_URL_LENGTH || !/^https?:\/\//i.test(url)) {
      continue
    }
    try {
      const parsed = new URL(url)
      if (!parsed.hostname || parsed.username || parsed.password || seen.has(parsed.href)) {
        continue
      }
      seen.add(parsed.href)
    } catch {
      continue
    }
    const title = typeof entry.title === 'string' ? entry.title.trim() : ''
    results.push({ title: title.slice(0, MAX_SEARCH_TITLE_LENGTH) || url, url })
    if (results.length === MAX_TOOL_SEARCH_RESULTS) {
      break
    }
  }
  return results
}
