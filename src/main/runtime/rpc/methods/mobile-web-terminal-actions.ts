import { z } from 'zod'
import { defineMethod, isStreamingMethod, type RpcContext } from '../core'
import { TERMINAL_QUERY_METHODS } from './terminal/terminal-query-methods'
import { TERMINAL_VIEWPORT_METHODS_BEFORE_STREAMS } from './terminal/terminal-viewport-methods'
import {
  registerMobileWebPageResource,
  resolveMobileWebPageResource
} from './mobile-web-page-resources'

const Scope = z.object({
  worktree: z.string().min(1).max(4096),
  pageSession: z.string().min(1).max(160)
})
const Tab = z.object({
  id: z.string(),
  type: z.literal('terminal'),
  status: z.literal('ready'),
  terminal: z.string().min(1).max(256)
})
type Binding = { tabId: string; terminal: string; worktreeId: string }
const actions = new Map(
  [...TERMINAL_QUERY_METHODS, ...TERMINAL_VIEWPORT_METHODS_BEFORE_STREAMS]
    .filter((method) =>
      ['terminal.setDisplayMode', 'terminal.clearBuffer', 'terminal.rename'].includes(method.name)
    )
    .map((method) => [method.name, method])
)

async function readBinding(context: RpcContext, worktree: string, tabId: string): Promise<Binding> {
  const snapshot = await context.runtime.listMobileSessionTabs(worktree, context.pairedDeviceId)
  const parsed = Tab.safeParse(snapshot.tabs.find((tab) => tab.id === tabId))
  if (!parsed.success) {
    throw new Error('selector_not_found')
  }
  return { tabId, terminal: parsed.data.terminal, worktreeId: snapshot.worktree }
}

export const MOBILE_WEB_TERMINAL_ACTION_METHODS = [
  defineMethod({
    name: 'mobileWeb.terminal.bind',
    params: Scope.extend({ tabId: z.string().min(1).max(512) }),
    handler: async (params, context) => {
      const binding = await readBinding(context, params.worktree, params.tabId)
      return {
        resourceId: registerMobileWebPageResource(context, params.pageSession, {
          kind: 'terminal',
          workspace: params.worktree,
          identity: JSON.stringify(binding),
          value: binding
        })
      }
    }
  }),
  defineMethod({
    name: 'mobileWeb.terminal.action',
    params: Scope.extend({
      resourceId: z.string().min(1).max(160),
      timeoutMs: z.number().int().min(1).max(15_000),
      method: z.enum(['terminal.setDisplayMode', 'terminal.clearBuffer', 'terminal.rename']),
      fields: z.record(z.string(), z.unknown())
    }),
    handler: async (params, context) => {
      const deadline = Date.now() + params.timeoutMs
      if (!context.clientId || context.signal?.aborted) {
        throw new Error('runtime_unavailable')
      }
      const binding = resolveMobileWebPageResource<Binding>(
        context,
        params.pageSession,
        params.worktree,
        'terminal',
        params.resourceId
      )
      const current = await readBinding(context, params.worktree, binding.tabId)
      if (JSON.stringify(current) !== JSON.stringify(binding)) {
        throw new Error('selector_not_found')
      }
      const action = actions.get(params.method)
      if (!action || isStreamingMethod(action)) {
        throw new Error('method_not_found')
      }
      const input = action.params!.parse({
        ...params.fields,
        terminal: binding.terminal,
        client: { id: context.clientId, type: 'mobile' }
      })
      if (context.signal?.aborted || Date.now() >= deadline) {
        throw new Error('runtime_unavailable')
      }
      await action.handler(input, context)
      return { applied: true }
    }
  })
]
