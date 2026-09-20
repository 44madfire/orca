import { getPluginActivationState } from '../../shared/plugins/plugin-consent-state'
import type { PluginKillListEntry } from '../../shared/plugins/plugin-kill-list'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'

// Narrow read surface for discovered-plugin queries; PluginServiceOptions
// satisfies it structurally so callers pass their options object directly.
export type PluginDiscoveryQuerySource = {
  isPluginSystemEnabled(): boolean
  getPluginConsents(): Record<string, string>
  getDisabledPlugins(): string[]
  getPluginKillListEntry?: (pluginKey: string) => PluginKillListEntry | null
}

export type PluginContentPackErrors = {
  error(pluginKey: string): string | null
}

export type PluginWorkerActivationErrors = {
  activationError(pluginKey: string): string | null
}

export function findValidDiscoveredPlugin(
  discovered: readonly DiscoveredPlugin[],
  pluginKey: string
): ValidDiscoveredPlugin | null {
  for (const plugin of discovered) {
    if (!isInvalidDiscoveredPlugin(plugin) && plugin.pluginKey === pluginKey) {
      return plugin
    }
  }
  return null
}

export function pluginActivationState(
  source: PluginDiscoveryQuerySource,
  plugin: ValidDiscoveredPlugin
): ReturnType<typeof getPluginActivationState> {
  // The feature flag is an authority boundary, not only a discovery hint:
  // callers fail closed immediately even before async reconciliation ends.
  if (!source.isPluginSystemEnabled()) {
    return 'disabled'
  }
  return getPluginActivationState(plugin.pluginKey, plugin.consentFingerprint, {
    pluginConsents: source.getPluginConsents(),
    disabledPlugins: source.getDisabledPlugins()
  })
}

export function isPluginRuntimeApproved(
  source: PluginDiscoveryQuerySource,
  contentPacks: PluginContentPackErrors,
  contentPacksReady: boolean,
  plugin: ValidDiscoveredPlugin
): boolean {
  return (
    contentPacksReady &&
    pluginActivationState(source, plugin) === 'approved' &&
    !contentPacks.error(plugin.pluginKey) &&
    !source.getPluginKillListEntry?.(plugin.pluginKey)
  )
}

export function pluginActivationError(
  source: PluginDiscoveryQuerySource,
  contentPacks: PluginContentPackErrors,
  workerErrors: PluginWorkerActivationErrors,
  pluginKey: string
): string | null {
  const blocked = source.getPluginKillListEntry?.(pluginKey)
  return (
    (blocked ? `Blocked by Orca's plugin safety list: ${blocked.reason}` : null) ??
    contentPacks.error(pluginKey) ??
    workerErrors.activationError(pluginKey)
  )
}
