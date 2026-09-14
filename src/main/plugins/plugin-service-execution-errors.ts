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
  return (
    detail
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 220) || 'failed'
  )
}

export function serviceExecutionError(
  code: ServiceExecutionErrorCode,
  serviceId: string,
  detail?: string
): ServiceExecutionError {
  return new ServiceExecutionError(code, serviceId, detail)
}

// Normalize any transport/process failure into the stable code set. Unknown
// failures become start-failed/crashed without leaking the cause text.
export function normalizeServiceExecutionError(
  error: unknown,
  serviceId: string,
  fallback: ServiceExecutionErrorCode = 'crashed'
): ServiceExecutionError {
  if (error instanceof ServiceExecutionError) {
    return error
  }
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
    return new ServiceExecutionError('service-unavailable', serviceId)
  }
  return new ServiceExecutionError(fallback, serviceId)
}
