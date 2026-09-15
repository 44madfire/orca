import { isSafePluginServiceId } from '../../shared/plugins/plugin-capabilities'

export type ServiceExecutionErrorCode =
  | 'runtime-unavailable'
  | 'wsl-unavailable'
  | 'distro-unavailable'
  | 'service-unavailable'
  | 'start-failed'
  | 'timeout'
  | 'cancelled'
  | 'crashed'
  | 'teardown-unverified'
  | 'overloaded'
  | 'malformed-response'

const CODE_ORDER: readonly ServiceExecutionErrorCode[] = [
  'runtime-unavailable',
  'wsl-unavailable',
  'distro-unavailable',
  'service-unavailable',
  'start-failed',
  'timeout',
  'cancelled',
  'crashed',
  'teardown-unverified',
  'overloaded',
  'malformed-response'
]

export function isServiceExecutionErrorCode(value: unknown): value is ServiceExecutionErrorCode {
  return typeof value === 'string' && (CODE_ORDER as readonly string[]).includes(value)
}

// Stable, redacted execution failure. Carries only the service id + code;
// never paths, argv, env, distro output, or stderr bytes.
export class ServiceExecutionError extends Error {
  readonly code: ServiceExecutionErrorCode
  readonly serviceId: string

  constructor(code: ServiceExecutionErrorCode, serviceId: string, detail?: string) {
    super(formatServiceExecutionMessage(code, serviceId, detail))
    this.name = 'ServiceExecutionError'
    this.code = code
    this.serviceId = serviceId
  }
}

function formatServiceExecutionMessage(
  code: ServiceExecutionErrorCode,
  serviceId: string,
  detail?: string
): string {
  const safeId = isSafePluginServiceId(serviceId) ? serviceId : '<invalid-service-id>'
  const tail = detail ? `: ${boundDetail(detail)}` : ''
  return `service ${safeId} ${code}${tail}`
}

// Single-line, bounded detail without host facts. Callers must not pass
// paths, env values, or subprocess output here.
function boundDetail(detail: string): string {
  const flat = detail.replace(/[\r\n]+/g, ' ').slice(0, 160)
  return flat.length > 0 ? flat : 'failed'
}

export function serviceExecutionError(
  code: ServiceExecutionErrorCode,
  serviceId: string,
  detail?: string
): ServiceExecutionError {
  return new ServiceExecutionError(code, serviceId, detail)
}

// Map any failure into a stable code. Unknown throws collapse to the
// caller's fallback code; only ServiceExecutionError details pass through,
// so a subprocess error string can never reach the plugin.
export function normalizeServiceExecutionError(
  error: unknown,
  serviceId: string,
  fallback: ServiceExecutionErrorCode
): ServiceExecutionError {
  if (error instanceof ServiceExecutionError) {
    return error
  }
  if (isAbortError(error)) {
    return serviceExecutionError('cancelled', serviceId)
  }
  return serviceExecutionError(fallback, serviceId)
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}
