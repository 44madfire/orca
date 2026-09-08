import { RuntimeClientError, RuntimeRpcFailureError } from './types'

export type ProcessObservation = 'live' | 'unverifiable' | 'exited'

export function observeLocalProcess(pid: number | null | undefined): ProcessObservation {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) {
    return 'unverifiable'
  }
  try {
    process.kill(pid, 0)
    return 'live'
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ESRCH' ? 'exited' : 'unverifiable'
  }
}

export function statusObservationError(
  process: ProcessObservation,
  error: unknown
): RuntimeClientError {
  return new RuntimeClientError(
    error instanceof RuntimeClientError ? error.code : 'runtime_unavailable',
    'Could not verify Orca runtime status. Process visibility does not establish startup or readiness. Check runtime access from this execution context before retrying.',
    {
      statusObservation: {
        version: 1,
        target: 'local',
        process,
        startup: 'unverifiable',
        runtime: 'unverifiable',
        ...(error instanceof RuntimeClientError ? { failure: { code: error.code } } : {})
      },
      ...(error instanceof RuntimeClientError &&
      !(error instanceof RuntimeRpcFailureError) &&
      error.data &&
      typeof error.data === 'object' &&
      'transportFailure' in error.data
        ? { transportFailure: error.data.transportFailure }
        : {})
    }
  )
}

export function isStatusObservationError(error: unknown): error is RuntimeClientError {
  if (!(error instanceof RuntimeClientError) || !error.data || typeof error.data !== 'object') {
    return false
  }
  const observation = 'statusObservation' in error.data ? error.data.statusObservation : null
  return (
    !!observation &&
    typeof observation === 'object' &&
    'version' in observation &&
    observation.version === 1 &&
    'target' in observation &&
    observation.target === 'local'
  )
}
