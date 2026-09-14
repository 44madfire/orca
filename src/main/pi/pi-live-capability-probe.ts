// Live RPC verification for the running Pi child (SNC1.10 Orca slice).
// `set_model` is proven via a safe bogus-id verb (definite rejection without
// mutation); thinking/autoCompaction/switch are declared presence-only because
// probing them would mutate or redirect. History tries entries then tree.
// Every probe is bounded; failures name evidence, never text/paths/bytes.
import { splitProbedCapabilities } from './pi-structured-compat'
import { shortPiError } from './pi-driver-errors'
import { PiRpcError } from './rpc/pi-rpc-errors'
import type { PiModel } from './rpc/pi-wire-protocol'
export type PiLiveProbeConnection = {
  getAvailableModels?(opts?: { timeoutMs?: number }): Promise<{ models: readonly unknown[] }>
  setModel?(provider: string, modelId: string, opts?: { timeoutMs?: number }): Promise<unknown>
  getAvailableThinkingLevels?(opts?: { timeoutMs?: number }): Promise<{ levels: readonly string[] }>
  setThinkingLevel?(level: string, opts?: { timeoutMs?: number }): Promise<void>
  setAutoCompaction?(enabled: boolean, opts?: { timeoutMs?: number }): Promise<void>
  getEntries?(
    since?: string,
    opts?: { timeoutMs?: number }
  ): Promise<{ entries: readonly unknown[] }>
  getTree?(opts?: { timeoutMs?: number }): Promise<{ tree: readonly unknown[] }>
  switchSession?(
    sessionPath: string,
    opts?: { timeoutMs?: number }
  ): Promise<{ cancelled: boolean }>
}
const PI_LIVE_PROBE_TIMEOUT_MS = 5_000
async function probeSetModelVerb(
  conn: PiLiveProbeConnection,
  currentModel: PiModel | undefined,
  timeoutMs: number
): Promise<string | null> {
  try {
    await conn.setModel!('__snc110_probe__', '__snc110_probe__', { timeoutMs })
  } catch (error) {
    if (
      error instanceof PiRpcError &&
      error.code === 'rejected' &&
      /model not found|unknown model/i.test(`${error.piError ?? ''} ${error.message}`)
    ) {
      return null
    }
    return `live probe failed: set_model verb unproven (${shortPiError(error)})`
  }
  if (!currentModel) {
    return 'live probe failed: set_model accepted a bogus id with no model to restore'
  }
  try {
    await conn.setModel!(currentModel.provider, currentModel.id, { timeoutMs })
    return null
  } catch (error) {
    return `live probe failed: set_model restore failed (${shortPiError(error)})`
  }
}
async function probeOptions(
  conn: PiLiveProbeConnection,
  timeoutMs: number,
  currentModel: PiModel | undefined
): Promise<string | null> {
  if (
    typeof conn.getAvailableModels !== 'function' ||
    typeof conn.getAvailableThinkingLevels !== 'function'
  ) {
    return 'live probe failed: options catalog RPCs unavailable on the running Pi (update Pi)'
  }
  for (const setter of ['setModel', 'setThinkingLevel', 'setAutoCompaction'] as const) {
    if (typeof conn[setter] !== 'function') {
      return `live probe failed: options setter ${setter} unavailable on the running Pi (update Pi)`
    }
  }
  try {
    const [models, levels] = await Promise.all([
      conn.getAvailableModels({ timeoutMs }),
      conn.getAvailableThinkingLevels({ timeoutMs })
    ])
    if (!Array.isArray(models?.models) || !Array.isArray(levels?.levels)) {
      return 'live probe failed: options RPCs returned malformed catalogs'
    }
  } catch (error) {
    return `live probe failed: options (${shortPiError(error)})`
  }
  return probeSetModelVerb(conn, currentModel, timeoutMs)
}
async function probeImages(conn: PiLiveProbeConnection, timeoutMs: number): Promise<string | null> {
  if (typeof conn.getAvailableModels !== 'function') {
    return 'live probe failed: model catalog RPC unavailable on the running Pi (update Pi)'
  }
  try {
    const models = await conn.getAvailableModels({ timeoutMs })
    const list = (models?.models ?? []) as { input?: unknown }[]
    if (!Array.isArray(models?.models)) {
      return 'live probe failed: model catalog RPC returned a malformed catalog'
    }
    if (!list.some((m) => Array.isArray(m.input) && (m.input as unknown[]).includes('image'))) {
      return 'live probe failed: running Pi advertises no image-capable model'
    }
    return null
  } catch (error) {
    return `live probe failed: images (${shortPiError(error)})`
  }
}
async function probeHistory(
  conn: PiLiveProbeConnection,
  timeoutMs: number
): Promise<string | null> {
  const canEntries = typeof conn.getEntries === 'function'
  const canTree = typeof conn.getTree === 'function'
  if (!canEntries && !canTree) {
    return 'live probe failed: history RPCs unavailable on the running Pi (update Pi)'
  }
  const errors: string[] = []
  if (canEntries) {
    try {
      const data = await conn.getEntries!(undefined, { timeoutMs })
      if (Array.isArray(data?.entries)) {
        return null
      }
      errors.push('get_entries returned malformed entries')
    } catch (error) {
      errors.push(`get_entries (${shortPiError(error)})`)
    }
  }
  if (canTree) {
    try {
      const data = await conn.getTree!({ timeoutMs })
      if (Array.isArray(data?.tree)) {
        return null
      }
      errors.push('get_tree returned a malformed tree')
    } catch (error) {
      errors.push(`get_tree (${shortPiError(error)})`)
    }
  }
  return `live probe failed: history (${errors.join('; ')})`
}
function probeResume(conn: PiLiveProbeConnection): string | null {
  if (typeof conn.switchSession !== 'function') {
    return 'live probe failed: switchSession unavailable on the running Pi (update Pi)'
  }
  return null
}
// Returns a machine-readable failure reason, or null when live-proven.
export async function verifyPiLiveCapabilities(
  conn: PiLiveProbeConnection,
  required: readonly string[],
  timeoutMs: number = PI_LIVE_PROBE_TIMEOUT_MS,
  currentModel?: PiModel
): Promise<string | null> {
  const { live } = splitProbedCapabilities(required)
  if (live.length === 0) {
    return null
  }
  const probes: Promise<string | null>[] = []
  if (live.includes('options')) {
    probes.push(probeOptions(conn, timeoutMs, currentModel))
  }
  if (live.includes('images')) {
    probes.push(probeImages(conn, timeoutMs))
  }
  if (live.includes('history') || live.includes('resume')) {
    probes.push(probeHistory(conn, timeoutMs))
  }
  if (live.includes('resume')) {
    probes.push(Promise.resolve(probeResume(conn)))
  }
  const results = await Promise.all(probes)
  return results.find((r) => r !== null) ?? null
}
