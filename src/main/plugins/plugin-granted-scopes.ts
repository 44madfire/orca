import {
  capabilityKinds,
  collectGrantedServiceIds,
  type PluginCapabilityKind
} from '../../shared/plugins/plugin-capabilities'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

// Least-privilege scope resolution for the host chokepoint. Pure so the
// capability gate, worker spawn, and consent paths share one decision.
export function grantedCapabilityKindsFor(
  plugin: ValidDiscoveredPlugin | null,
  isApproved: boolean
): PluginCapabilityKind[] | null {
  if (!plugin || !isApproved) {
    return null
  }
  return capabilityKinds(plugin.manifest.capabilities)
}

export function grantedServiceIdsFor(
  plugin: ValidDiscoveredPlugin | null,
  isApproved: boolean
): string[] | null {
  if (!plugin || !isApproved) {
    return null
  }
  return collectGrantedServiceIds(plugin.manifest.capabilities)
}
