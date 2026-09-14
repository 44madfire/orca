// Host-owned Pi compat gate unit tests (SNC1.10, deterministic, offline).
import { describe, expect, it } from 'vitest'
import {
  MIN_KNOWN_GOOD_PI_VERSION,
  PI_STRUCTURED_ADVERTISED_CAPABILITIES,
  PI_STRUCTURED_REQUIRED_CAPABILITIES,
  checkAcquireCompat,
  checkPiLocationSupport,
  checkPiVersionSupport,
  comparePiVersions,
  formatPiVersion,
  gatePiStructuredSession,
  negotiatePiCapabilities,
  parsePiVersion,
  splitProbedCapabilities
} from './pi-structured-compat'
describe('Pi version floor', () => {
  it('parses SemVer with prerelease precedence and drops build metadata', () => {
    expect(parsePiVersion('0.85.1')).toMatchObject({ major: 0, minor: 85, patch: 1 })
    expect(parsePiVersion('v0.85.1-beta.1+build.5')).toMatchObject({
      major: 0,
      minor: 85,
      patch: 1
    })
    expect(formatPiVersion(parsePiVersion('0.85.1-beta.1+build')!)).toBe('0.85.1-beta.1')
    expect(
      comparePiVersions(parsePiVersion('0.85.1-beta.1')!, parsePiVersion('0.85.1')!)
    ).toBeLessThan(0)
    expect(parsePiVersion('not-a-version')).toBeNull()
  })
  it('floors at the single known-good version and never claims newer per-feature support', () => {
    expect(checkPiVersionSupport(MIN_KNOWN_GOOD_PI_VERSION).supported).toBe(true)
    expect(checkPiVersionSupport('0.86.0').supported).toBe(true)
    expect(checkPiVersionSupport('0.85.1-beta.1').supported).toBe(false)
    expect(checkPiVersionSupport('0.1.0').supported).toBe(false)
    expect(checkPiVersionSupport('garbage').supported).toBe(false)
  })
})
describe('Pi location gate', () => {
  it('admits only local host without WSL and never claims Codex/Claude', () => {
    expect(
      checkPiLocationSupport({ executionHostId: 'local', wslDistro: null }, 'pi').supported
    ).toBe(true)
    expect(
      checkPiLocationSupport({ executionHostId: 'local', wslDistro: 'Ubuntu' }, 'pi').supported
    ).toBe(false)
    expect(
      checkPiLocationSupport({ executionHostId: 'ssh:host-1', wslDistro: null }, 'pi').supported
    ).toBe(false)
    expect(
      checkPiLocationSupport({ executionHostId: 'local', wslDistro: null }, 'codex').supported
    ).toBe(false)
  })
})
describe('Pi capability negotiation', () => {
  it('counts absent capabilities as unsupported and names them', () => {
    expect(negotiatePiCapabilities(['options'], { options: true }).structured).toBe(true)
    const refused = negotiatePiCapabilities(['options', 'teleportation'], { options: true })
    expect(refused.structured).toBe(false)
    expect(refused.unsupported).toEqual(['teleportation'])
  })
  it('splits live-probed from adapter-declared capabilities', () => {
    const split = splitProbedCapabilities([
      'options',
      'images',
      'history',
      'resume',
      'textStreaming'
    ])
    expect(split.live).toEqual(expect.arrayContaining(['options', 'images', 'history', 'resume']))
    expect(split.declared).toEqual(['textStreaming'])
  })
})
describe('Pi acquire gate', () => {
  it('passes full evidence and refuses each dimension with a TUI fallback', () => {
    expect(
      checkAcquireCompat(
        { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ['options'] },
        PI_STRUCTURED_ADVERTISED_CAPABILITIES
      ).allowed
    ).toBe(true)
    expect(
      checkAcquireCompat(
        { piVersion: '0.1.0', requiredCapabilities: ['options'] },
        PI_STRUCTURED_ADVERTISED_CAPABILITIES
      )
    ).toMatchObject({ allowed: false, code: 'PI_COMPAT_VERSION', fallback: 'pi-tui' })
    expect(
      checkAcquireCompat(
        {
          piVersion: MIN_KNOWN_GOOD_PI_VERSION,
          executionHostId: 'remote',
          requiredCapabilities: ['options']
        },
        PI_STRUCTURED_ADVERTISED_CAPABILITIES
      )
    ).toMatchObject({ allowed: false, code: 'PI_COMPAT_LOCATION' })
    expect(
      checkAcquireCompat(
        { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ['teleportation'] },
        PI_STRUCTURED_ADVERTISED_CAPABILITIES
      )
    ).toMatchObject({ allowed: false, code: 'PI_COMPAT_CAPABILITY' })
  })
  it('combines location, version, and capability gates in one entry', () => {
    expect(
      gatePiStructuredSession({
        location: { executionHostId: 'local', wslDistro: null },
        agent: 'pi',
        piVersion: MIN_KNOWN_GOOD_PI_VERSION
      }).structured
    ).toBe(true)
    expect(
      gatePiStructuredSession({
        location: { executionHostId: 'local', wslDistro: 'Ubuntu' },
        agent: 'pi',
        piVersion: MIN_KNOWN_GOOD_PI_VERSION
      }).structured
    ).toBe(false)
    expect(PI_STRUCTURED_REQUIRED_CAPABILITIES.length).toBeGreaterThan(0)
    expect(PI_STRUCTURED_REQUIRED_CAPABILITIES).not.toContain('images')
  })
})
