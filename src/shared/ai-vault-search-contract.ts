import { z } from 'zod'
import { AI_VAULT_AGENTS, AI_VAULT_SCOPE_PATHS_MAX_COUNT } from './ai-vault-types'
import {
  AI_VAULT_SEARCH_LIMIT_MAX,
  AI_VAULT_SEARCH_QUERY_MAX_LENGTH
} from './ai-vault-search-types'

export const SessionSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(AI_VAULT_SEARCH_QUERY_MAX_LENGTH),
  limit: z.number().int().min(1).max(AI_VAULT_SEARCH_LIMIT_MAX).optional(),
  agents: z.array(z.enum(AI_VAULT_AGENTS)).max(AI_VAULT_AGENTS.length).optional(),
  scopePaths: z.array(z.string().min(1).max(4096)).max(AI_VAULT_SCOPE_PATHS_MAX_COUNT).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(['relevance', 'newest']).optional(),
  tier: z.enum(['full', 'conversation']).optional(),
  refresh: z.boolean().optional()
})

export const SessionSearchConfigureSchema = z.object({
  enabled: z.boolean().optional(),
  paused: z.boolean().optional(),
  historyDays: z.number().int().min(1).max(3650).nullable().optional(),
  clearIndex: z.boolean().optional()
})
export type SessionSearchConfigure = z.infer<typeof SessionSearchConfigureSchema>

export const SessionSearchStatusSchema = z.object({
  enabled: z.boolean(),
  paused: z.boolean().optional(),
  historyDays: z.number().int().positive().nullable(),
  indexSizeBytes: z.number().nonnegative().nullable(),
  available: z.boolean().optional(),
  applied: z.boolean().optional(),
  reason: z.string().max(4096).optional()
})

const boundedText = z.string().max(32768)

/**
 * Why the received-payload enums fall back instead of failing: a client and the
 * host it queries update independently, so a host that learns one new route,
 * indexing phase, or message role must not cost an older client the whole
 * response. Each fallback is the value that already means "nothing specific".
 */
export const SessionSearchHitSchema = z.object({
  agent: z.enum(AI_VAULT_AGENTS),
  sessionId: boundedText,
  filePath: boundedText,
  codexHome: boundedText.nullable(),
  title: boundedText,
  cwd: boundedText.nullable(),
  branch: boundedText.nullable(),
  updatedAt: boundedText.nullable(),
  messageCount: z.number().nonnegative(),
  resumeCommand: boundedText,
  score: z.number(),
  duplicateCount: z.number().optional(),
  evidence: z.object({
    role: z.enum(['user', 'assistant', 'tool', 'system', 'unknown']).catch('unknown'),
    timestamp: boundedText.nullable(),
    snippet: boundedText
  })
})

export const SessionSearchResultSchema = z.object({
  // Why per-hit and not per-response: an agent the client cannot name has no
  // resume command it could run, so that hit is the only thing it should lose.
  hits: z
    .array(SessionSearchHitSchema.nullable().catch(null))
    .max(AI_VAULT_SEARCH_LIMIT_MAX)
    .transform((hits) => hits.filter((hit) => hit !== null)),
  route: z.enum(['phrase', 'and', 'or', 'typo+phrase', 'typo+and', 'typo+or']).catch('or'),
  repairedTerms: z.array(boundedText).max(512).optional(),
  durationMs: z.number().nonnegative(),
  coverage: z.object({
    enabled: z.boolean().optional(),
    sessionsIndexed: z.number().nonnegative(),
    messagesIndexed: z.number().nonnegative(),
    providers: z
      .array(
        z.object({
          agent: z.enum(AI_VAULT_AGENTS),
          sessionsIndexed: z.number().nonnegative(),
          messagesIndexed: z.number().nonnegative(),
          filesDiscovered: z.number().optional(),
          parseFailures: z.number().optional(),
          scanIssues: z.number().optional()
        })
      )
      .max(AI_VAULT_AGENTS.length),
    // An unknown backfill state is not evidence the index is finished.
    backfill: z.enum(['idle', 'running', 'complete']).catch('running'),
    filesPending: z.number().nonnegative(),
    lastIndexedAt: boundedText.nullable(),
    indexing: z
      .object({
        // Unknown phases report as work in flight; `idle` would claim the
        // opposite of what a newer host is telling us.
        phase: z
          .enum(['idle', 'discovering', 'indexing', 'updating', 'paused', 'complete', 'error'])
          .catch('indexing'),
        filesProcessed: z.number().nonnegative(),
        filesTotal: z.number().nonnegative().nullable(),
        failures: z.number().nonnegative(),
        startedAt: z.number()
      })
      .optional()
  }),
  omittedHits: z.number().int().nonnegative().optional(),
  truncatedSnippets: z.number().int().nonnegative().optional(),
  sourceUnavailableFiles: z.number().int().nonnegative().optional()
})
