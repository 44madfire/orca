import { describe, expect, it } from 'vitest'
import {
  isServiceExecutionErrorCode,
  normalizeServiceExecutionError,
  ServiceExecutionError,
  serviceExecutionError
} from './plugin-service-execution-errors'

describe('serviceExecutionError', () => {
  it('formats a stable redacted message', () => {
    const error = serviceExecutionError('timeout', 'svc.echo', 'slow')
    expect(error).toBeInstanceOf(ServiceExecutionError)
    expect(error.code).toBe('timeout')
    expect(error.serviceId).toBe('svc.echo')
    expect(error.message).toBe('service svc.echo timeout: slow')
  })

  it('bounds detail to one line and masks unsafe service ids', () => {
    const error = serviceExecutionError('crashed', '../../etc/passwd', 'a\nb\r\nc')
    expect(error.message).toBe('service <invalid-service-id> crashed: a b c')
  })

  it('recognizes every stable code', () => {
    for (const code of [
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
    ]) {
      expect(isServiceExecutionErrorCode(code)).toBe(true)
    }
    expect(isServiceExecutionErrorCode('exploded')).toBe(false)
  })
})

describe('normalizeServiceExecutionError', () => {
  it('passes stable errors through and maps aborts to cancelled', () => {
    const stable = serviceExecutionError('timeout', 'svc.echo')
    expect(normalizeServiceExecutionError(stable, 'svc.echo', 'crashed')).toBe(stable)
    const abort = new DOMException('aborted', 'AbortError')
    expect(normalizeServiceExecutionError(abort, 'svc.echo', 'crashed').code).toBe('cancelled')
  })

  it('collapses unknown throws without leaking their text', () => {
    const normalized = normalizeServiceExecutionError(
      new Error('spawn C:\\secret\\svc.exe ENOENT'),
      'svc.echo',
      'start-failed'
    )
    expect(normalized.code).toBe('start-failed')
    expect(normalized.message).not.toContain('secret')
  })
})
