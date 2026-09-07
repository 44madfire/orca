import { z } from 'zod'
import { defineMethod, isStreamingMethod } from '../core'
import { GITHUB_PROJECT_METHODS } from './github-project-methods'

// The bridge envelope is 600 KB, and a 500-item project view can exceed it, so the page asks for
// one row window at a time and this handler decides where each window ends.
const MAX_RESULT_BYTES = 512 * 1024

const ProjectTableWindow = z.object({
  owner: z.string().min(1).max(512),
  host: z.string().max(512).optional(),
  ownerType: z.enum(['organization', 'user']),
  projectNumber: z.number().int().positive(),
  viewId: z.string().min(1).max(240),
  queryOverride: z.string().max(4_096).optional(),
  rowOffset: z.number().int().nonnegative().max(100_000).optional()
})

type ProjectTableRow = Record<string, unknown>

function projectViewTableMethod() {
  const method = GITHUB_PROJECT_METHODS.find((entry) => entry.name === 'github.project.viewTable')
  if (!method || isStreamingMethod(method)) {
    throw new Error('Missing unary method: github.project.viewTable')
  }
  return method
}
const viewTable = projectViewTableMethod()

export const MOBILE_WEB_TASK_PROJECT_TABLE_METHOD = defineMethod({
  name: 'mobileWeb.tasks.projectTable',
  params: ProjectTableWindow,
  handler: async (params, context) => {
    const { rowOffset = 0, ...request } = params
    const raw = await viewTable.handler(request, context)
    const table = tableOf(raw)
    if (!table) {
      return raw
    }
    const rows = Array.isArray(table.rows) ? (table.rows as ProjectTableRow[]) : []
    const window = rowWindow(table, rows, rowOffset)
    const nextRowOffset = rowOffset + window.length
    return {
      ...(raw as Record<string, unknown>),
      data: { ...table, rows: window },
      ...(nextRowOffset < rows.length ? { nextRowOffset } : {})
    }
  }
})

function tableOf(raw: unknown): Record<string, unknown> | null {
  const envelope = raw as { ok?: boolean; data?: unknown } | null
  if (!envelope || envelope.ok === false) {
    return null
  }
  const table = envelope.data
  return typeof table === 'object' && table !== null ? (table as Record<string, unknown>) : null
}

/** Always yields at least one row so a caller that has not reached the end always advances. */
function rowWindow(
  table: Record<string, unknown>,
  rows: ProjectTableRow[],
  offset: number
): ProjectTableRow[] {
  const window: ProjectTableRow[] = []
  for (const row of rows.slice(offset)) {
    window.push(row)
    if (
      window.length > 1 &&
      Buffer.byteLength(JSON.stringify({ ...table, rows: window })) > MAX_RESULT_BYTES
    ) {
      window.pop()
      break
    }
  }
  return window
}
