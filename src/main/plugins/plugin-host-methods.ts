import { getBoundPluginHostMethod, type PluginHostServices } from './plugin-host-method-bindings'
import { isQualifiedPluginKey } from '../../shared/plugins/plugin-manifest'
import { gatePluginHostCall as decidePluginHostCall } from '../../shared/plugins/plugin-capability-gate'
import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import {
  PLUGIN_SERVICE_REQUEST_MAX_BYTES,
  PLUGIN_SERVICE_RESPONSE_MAX_BYTES
} from '../../shared/plugins/plugin-host-api'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import type { PluginAuditLog } from './plugin-audit-log'

/**
 * Host API v0 handler bindings — the one place plugin-originated calls
 * (panel bridge, worker hostCall, serve RPC relay) execute. Handlers
 * delegate to runtime services through the structural `PluginHostServices`
 * interface, so this module stays electron-free and the relay conformance
 * suite can run the identical chokepoint against a fake service set.
 */

export type { PluginHostServices } from './plugin-host-method-bindings'

export type ExecutePluginHostCallInput = {
  /** Qualified plugin key, bound host-side from authenticated identity. */
  pluginId: string
  method: string
  params: unknown
  /** True when the call arrives over the sandboxed panel bridge. */
  viaPanel: boolean
  /** Consented capability kinds; null = unknown/disabled/consent-stale. */
  grantedCapabilities: readonly PluginCapabilityKind[] | null
  /** Explicitly authorized service ids; null = stale consent, undefined fails closed. */
  grantedServiceIds?: readonly string[] | null
  services: PluginHostServices | null
  audit?: Pick<PluginAuditLog, 'record'>
}

// Deterministic JSON byte count for bounded envelopes. Returns null when the
// value is not JSON-serializable so callers fail closed without throwing.
function jsonByteLength(value: unknown): number | null {
  try {
    const text = JSON.stringify(value ?? null)
    if (typeof text !== 'string') {
      return null
    }
    return Buffer.byteLength(text, 'utf8')
  } catch {
    return null
  }
}

export async function executePluginHostCall(
  input: ExecutePluginHostCallInput
): Promise<PluginPanelActionOutcome> {
  if (!isQualifiedPluginKey(input.pluginId)) {
    return { ok: false, code: 'invalid_request', error: 'invalid qualified plugin key' }
  }
  // service.invoke validates params before gating so malformed envelopes
  // report invalid_params while authorization still uses the live grant.
  if (input.method === 'service.invoke') {
    return executeServiceInvokeCall(input)
  }
  const gate = decidePluginHostCall(
    { grantedCapabilities: input.grantedCapabilities, viaPanel: input.viaPanel },
    input.method
  )
  if (!gate.granted) {
    return { ok: false, code: gate.code, error: gate.error }
  }
  const bound = getBoundPluginHostMethod(input.method)
  if (!bound) {
    return { ok: false, code: 'unknown_method', error: `unknown host method: ${input.method}` }
  }
  const parsedParams = bound.spec.params.safeParse(input.params)
  if (!parsedParams.success) {
    const issue = parsedParams.error.issues[0]
    const path = issue?.path.join('.') || '(root)'
    return {
      ok: false,
      code: 'invalid_params',
      error: `${path}: ${issue?.message ?? 'invalid params'}`
    }
  }
  if (!input.services) {
    return { ok: false, code: 'unavailable', error: 'runtime is not available' }
  }
  const auditMutation = async (outcome: 'attempt' | 'ok' | 'error'): Promise<void> => {
    if (bound.spec.mutation && input.audit) {
      await input.audit.record({
        ts: Date.now(),
        actor: `plugin:${input.pluginId}`,
        method: input.method,
        summary: summarizeParams(input.method, parsedParams.data),
        outcome
      })
    }
  }
  if (bound.spec.mutation) {
    if (!input.audit) {
      return {
        ok: false,
        code: 'unavailable',
        error: 'mutation audit log is not available'
      }
    }
    try {
      // The intent is appended before the handler. If this write fails, the
      // mutation is never attempted.
      await auditMutation('attempt')
    } catch {
      return {
        ok: false,
        code: 'action_failed',
        error: 'mutation audit log could not be written'
      }
    }
  }
  try {
    const value = await bound.handler(parsedParams.data, {
      pluginId: input.pluginId,
      services: input.services
    })
    const validated = bound.spec.result.safeParse(value)
    if (!validated.success) {
      await auditMutation('error').catch(() => undefined)
      // A result-schema mismatch is a host bug; fail the call rather than
      // leaking an unvalidated shape into plugin-facing transports.
      return {
        ok: false,
        code: 'action_failed',
        error: `internal: malformed ${input.method} result`
      }
    }
    await auditMutation('ok').catch(() => undefined)
    return { ok: true, value: validated.data }
  } catch (error) {
    await auditMutation('error').catch(() => undefined)
    return {
      ok: false,
      code: 'action_failed',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Bounded, content-free summaries for the audit log. */
function summarizeParams(method: string, params: unknown): string {
  const record = (typeof params === 'object' && params !== null ? params : {}) as Record<
    string,
    unknown
  >
  switch (method) {
    case 'terminal.sendText': {
      const text = typeof record.text === 'string' ? record.text : ''
      return `terminal=${String(record.terminalId)} bytes=${Buffer.byteLength(text, 'utf8')} enter=${record.enter === true}`
    }
    case 'notifications.show': {
      const title = typeof record.title === 'string' ? record.title : ''
      return `titleChars=${title.length}`
    }
    case 'storage.set':
    case 'storage.delete':
    case 'secrets.set':
    case 'secrets.delete':
    case 'settings.set':
      return `key=${String(record.key)}`
    case 'service.invoke': {
      const requestBytes = jsonByteLength(record.request ?? null) ?? 0
      return `service=${String(record.serviceId)} bytes=${requestBytes}`
    }
    default:
      return ''
  }
}

// Scoped service invocation: strict order is params shape, request size,
// live-grant authorization, registry execution, response size/shape.
async function executeServiceInvokeCall(
  input: ExecutePluginHostCallInput
): Promise<PluginPanelActionOutcome> {
  const bound = getBoundPluginHostMethod('service.invoke')
  if (!bound) {
    return { ok: false, code: 'unknown_method', error: 'unknown host method: service.invoke' }
  }
  const parsedParams = bound.spec.params.safeParse(input.params)
  if (!parsedParams.success) {
    const issue = parsedParams.error.issues[0]
    const path = issue?.path.join('.') || '(root)'
    return {
      ok: false,
      code: 'invalid_params',
      error: `${path}: ${issue?.message ?? 'invalid params'}`
    }
  }
  const serviceId = (parsedParams.data as { serviceId: string }).serviceId
  const request = (parsedParams.data as { request?: unknown }).request ?? null
  const requestBytes = jsonByteLength(request)
  if (requestBytes === null) {
    return { ok: false, code: 'invalid_params', error: 'request: not JSON-serializable' }
  }
  if (requestBytes > PLUGIN_SERVICE_REQUEST_MAX_BYTES) {
    return {
      ok: false,
      code: 'invalid_params',
      error: `request: exceeds ${PLUGIN_SERVICE_REQUEST_MAX_BYTES} bytes`
    }
  }
  const gate = decidePluginHostCall(
    {
      grantedCapabilities: input.grantedCapabilities,
      grantedServiceIds: input.grantedServiceIds,
      serviceId,
      viaPanel: input.viaPanel
    },
    'service.invoke'
  )
  if (!gate.granted) {
    return { ok: false, code: gate.code, error: gate.error }
  }
  if (!input.services) {
    return { ok: false, code: 'unavailable', error: 'runtime is not available' }
  }
  const auditMutation = async (outcome: 'attempt' | 'ok' | 'error'): Promise<void> => {
    if (input.audit) {
      await input.audit.record({
        ts: Date.now(),
        actor: `plugin:${input.pluginId}`,
        method: 'service.invoke',
        summary: summarizeParams('service.invoke', parsedParams.data),
        outcome
      })
    }
  }
  if (!input.audit) {
    return { ok: false, code: 'unavailable', error: 'mutation audit log is not available' }
  }
  try {
    await auditMutation('attempt')
  } catch {
    return { ok: false, code: 'action_failed', error: 'mutation audit log could not be written' }
  }
  let value: unknown
  try {
    value = await bound.handler(parsedParams.data, {
      pluginId: input.pluginId,
      services: input.services
    })
  } catch (error) {
    await auditMutation('error').catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 'action_failed', error: message.slice(0, 2048) }
  }
  const response = (value as { response?: unknown })?.response ?? null
  const responseBytes = jsonByteLength(response)
  if (responseBytes === null) {
    await auditMutation('error').catch(() => undefined)
    return { ok: false, code: 'action_failed', error: 'internal: malformed service.invoke result' }
  }
  if (responseBytes > PLUGIN_SERVICE_RESPONSE_MAX_BYTES) {
    await auditMutation('error').catch(() => undefined)
    return {
      ok: false,
      code: 'action_failed',
      error: `service response exceeds ${PLUGIN_SERVICE_RESPONSE_MAX_BYTES} bytes`
    }
  }
  const validated = bound.spec.result.safeParse(value)
  if (!validated.success) {
    await auditMutation('error').catch(() => undefined)
    return {
      ok: false,
      code: 'action_failed',
      error: 'internal: malformed service.invoke result'
    }
  }
  await auditMutation('ok').catch(() => undefined)
  return { ok: true, value: validated.data }
}
