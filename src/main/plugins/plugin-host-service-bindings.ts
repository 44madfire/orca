import type { PluginEventName } from '../../shared/plugins/plugin-manifest'
import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../shared/plugins/plugin-host-api'
import type { PluginHostServices } from './plugin-host-methods'
import { PluginSecretsStore } from './plugin-secrets-store'
import { PluginKvStore } from './plugin-storage-store'
import {
  describeAgentSessionPtyWriteRefusal,
  isAgentSessionPtyWriteRefusedError
} from '../../shared/agent-session-pty-write-admission'

/** Structural subset of OrcaRuntimeService exposed to plugin facade bindings. */
export type PluginRuntimeDelegate = {
  resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
  } | null>
  listTerminals(
    worktreeSelector?: string,
    limit?: number,
    opts?: { includeVisualLayouts?: boolean }
  ): Promise<{ terminals: { handle: string; title: string | null }[] }>
  sendTerminal(
    handle: string,
    action: { text?: string; enter?: boolean }
  ): Promise<{ accepted: boolean }>
  dispatchPluginNotification(input: {
    pluginId: string
    title: string
    body?: string
  }): Promise<{ delivered: boolean }>
}

/** Host-owned service implementation: receives only a structured JSON
 *  request, never exec paths, shell strings, cwd, or env overrides. */
export type PluginHostServiceHandler = (
  request: unknown,
  context: { pluginId: string; serviceId: string }
) => unknown

/** Host-owned registry: only ids registered by trusted host code are callable. */
export type PluginHostServiceRegistry = ReadonlyMap<string, PluginHostServiceHandler>

export function bindPluginHostServices(input: {
  delegate: PluginRuntimeDelegate | null
  pluginsDataDir: string
  subscribeEvents: (pluginKey: string, events: PluginEventName[]) => PluginEventName[]
  services?: PluginHostServiceRegistry | null
}): PluginHostServices {
  const { delegate, pluginsDataDir, subscribeEvents, services: serviceRegistry } = input
  const requireDelegate = (): PluginRuntimeDelegate => {
    if (!delegate) {
      throw new Error('runtime is not available')
    }
    return delegate
  }
  return {
    resolveActiveWorktreeContext: async () => {
      const context = await requireDelegate().resolveActiveWorktreeContext()
      if (!context) {
        return null
      }
      // Why: retain the internal id only for host-side terminal membership;
      // the public handler projects it out because it embeds provider paths.
      return {
        worktreeId: context.worktreeId,
        branch: context.branch,
        displayName: context.displayName
      }
    },
    listWorktreeTerminals: async (worktreeId) => {
      const result = await requireDelegate().listTerminals(
        `id:${worktreeId}`,
        PLUGIN_WORKSPACE_TERMINAL_LIMIT,
        { includeVisualLayouts: false }
      )
      return result.terminals
        .slice(0, PLUGIN_WORKSPACE_TERMINAL_LIMIT)
        .map((terminal) => ({ id: terminal.handle }))
    },
    sendTerminalText: async (terminalId, action) => {
      try {
        const result = await requireDelegate().sendTerminal(terminalId, action)
        return { accepted: result.accepted }
      } catch (error) {
        // Why: the plugin API carries only `accepted`, so a lease refusal would read as a silent
        // drop; restate it as the message idiom plugin methods already surface to callers.
        if (isAgentSessionPtyWriteRefusedError(error)) {
          throw new Error(describeAgentSessionPtyWriteRefusal(error.refusal))
        }
        throw error
      }
    },
    dispatchPluginNotification: (notification) =>
      requireDelegate().dispatchPluginNotification(notification),
    storage: {
      get: (key, itemKey) => new PluginKvStore(pluginsDataDir, key, 'storage.json').get(itemKey),
      set: (key, itemKey, value) =>
        new PluginKvStore(pluginsDataDir, key, 'storage.json').set(itemKey, value),
      delete: (key, itemKey) =>
        new PluginKvStore(pluginsDataDir, key, 'storage.json').delete(itemKey),
      keys: (key) => new PluginKvStore(pluginsDataDir, key, 'storage.json').keys()
    },
    secrets: {
      get: (key, itemKey) => new PluginSecretsStore(pluginsDataDir, key).get(itemKey),
      set: (key, itemKey, value) => new PluginSecretsStore(pluginsDataDir, key).set(itemKey, value),
      delete: (key, itemKey) => new PluginSecretsStore(pluginsDataDir, key).delete(itemKey)
    },
    settings: {
      getAll: (key) => new PluginKvStore(pluginsDataDir, key, 'settings.json').getAll(),
      set: (key, itemKey, value) =>
        new PluginKvStore(pluginsDataDir, key, 'settings.json').set(itemKey, value)
    },
    subscribeEvents,
    invokeService: async (pluginId, serviceId, request) => {
      const handler = serviceRegistry?.get(serviceId)
      if (!handler) {
        throw new Error(`unknown service: ${serviceId}`)
      }
      return handler(request, { pluginId, serviceId })
    }
  }
}
