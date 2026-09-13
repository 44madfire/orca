import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'

// Only proven local execution may own a native Pi structured session. WSL is a
// distinct filesystem/process namespace and remote hosts are adjudicated by
// their own runtime, so both fail closed to ordinary Pi TUI. Windows also
// requires start-time proof: without it a PID match cannot distinguish a live
// child from a same-pid stranger, and the lease would latch indeterminate.
export function supportsPiStructuredLocation(
  location: AgentSessionExecutionLocation,
  hasWindowsProcessStartTimeProof: () => boolean = isWindowsProcessStartTimeAvailable
): boolean {
  return (
    location.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    location.wslDistro === null &&
    (process.platform !== 'win32' || hasWindowsProcessStartTimeProof())
  )
}
