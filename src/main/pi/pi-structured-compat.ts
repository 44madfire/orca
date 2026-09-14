// Host-owned Pi structured compatibility gates (SNC1.10 Orca slice).
// Pure version/location/capability logic, no spawn, no config, no secrets.
// Proven only on win32 local against Pi 0.85.1; darwin/linux local is
// expected-compatible but unproven; WSL/remote/SSH/mobile/paired fail closed.
export const PI_TUI_FALLBACK = 'pi-tui' as const
export const MIN_KNOWN_GOOD_PI_VERSION = '0.85.1' as const
export const PI_COMPAT_LOCAL_HOST_ID = 'local' as const
export const PI_COMPAT_AGENT = 'pi' as const
export type PiCompatLocation = {
  readonly executionHostId: string
  readonly wslDistro: string | null
}
export type PiVersionSupport = {
  readonly supported: boolean
  readonly reason: string
  readonly fallback: typeof PI_TUI_FALLBACK
}
export type ParsedPiVersion = {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease?: readonly string[]
}
export function parsePiVersion(raw: string): ParsedPiVersion | null {
  if (typeof raw !== 'string') {
    return null
  }
  const match = raw
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) {
    return null
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null
  }
  const prerelease =
    match[4] !== undefined && match[4] !== '' ? Object.freeze(match[4].split('.')) : undefined
  return prerelease === undefined ? { major, minor, patch } : { major, minor, patch, prerelease }
}
function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a) ? Number(a) : null
  const bNum = /^\d+$/.test(b) ? Number(b) : null
  if (aNum !== null && bNum !== null) {
    return aNum < bNum ? -1 : aNum > bNum ? 1 : 0
  }
  if (aNum !== null) {
    return -1
  }
  if (bNum !== null) {
    return 1
  }
  return a < b ? -1 : a > b ? 1 : 0
}
export function comparePiVersions(a: ParsedPiVersion, b: ParsedPiVersion): number {
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1
  }
  const aPre = a.prerelease
  const bPre = b.prerelease
  if (aPre === undefined && bPre === undefined) {
    return 0
  }
  if (aPre !== undefined && bPre === undefined) {
    return -1
  }
  if (aPre === undefined && bPre !== undefined) {
    return 1
  }
  const len = Math.min(aPre!.length, bPre!.length)
  for (let i = 0; i < len; i += 1) {
    const cmp = compareIdentifiers(aPre![i]!, bPre![i]!)
    if (cmp !== 0) {
      return cmp
    }
  }
  if (aPre!.length === bPre!.length) {
    return 0
  }
  return aPre!.length < bPre!.length ? -1 : 1
}
export function formatPiVersion(v: ParsedPiVersion): string {
  const base = `${v.major}.${v.minor}.${v.patch}`
  return v.prerelease === undefined ? base : `${base}-${v.prerelease.join('.')}`
}
// Coarse floor only; per-feature support is decided by live probing.
export function checkPiVersionSupport(rawVersion: string): PiVersionSupport {
  const parsed = parsePiVersion(rawVersion)
  if (!parsed) {
    return {
      supported: false,
      reason: `unsupported-pi-version: unparseable version (minimum known-good ${MIN_KNOWN_GOOD_PI_VERSION})`,
      fallback: PI_TUI_FALLBACK
    }
  }
  const floor = parsePiVersion(MIN_KNOWN_GOOD_PI_VERSION)
  if (!floor) {
    return {
      supported: false,
      reason: 'unsupported-pi-version: internal version floor misconfigured',
      fallback: PI_TUI_FALLBACK
    }
  }
  if (comparePiVersions(parsed, floor) < 0) {
    return {
      supported: false,
      reason: `unsupported-pi-version: ${formatPiVersion(parsed)} < minimum known-good ${MIN_KNOWN_GOOD_PI_VERSION} (update Pi or use Pi TUI)`,
      fallback: PI_TUI_FALLBACK
    }
  }
  return {
    supported: true,
    reason: `pi-version-ok: ${formatPiVersion(parsed)} >= ${MIN_KNOWN_GOOD_PI_VERSION} (confirm per-feature support by capability probing)`,
    fallback: PI_TUI_FALLBACK
  }
}
export type PiLocationSupport = {
  readonly supported: boolean
  readonly reason: string
  readonly fallback: typeof PI_TUI_FALLBACK
}
// Only local host without WSL may create structured Pi; all else uses Pi TUI.
export function checkPiLocationSupport(
  location: PiCompatLocation,
  agent: string
): PiLocationSupport {
  if (agent !== PI_COMPAT_AGENT) {
    return {
      supported: false,
      reason: `agent-not-owned: ${agent} is not served by the Pi adapter (Codex/Claude selection unchanged)`,
      fallback: PI_TUI_FALLBACK
    }
  }
  if (location.executionHostId !== PI_COMPAT_LOCAL_HOST_ID) {
    return {
      supported: false,
      reason: `unsupported-location: execution host "${location.executionHostId}" is not proven for structured Pi (local host only; use Pi TUI)`,
      fallback: PI_TUI_FALLBACK
    }
  }
  if (location.wslDistro !== null) {
    return {
      supported: false,
      reason: `unsupported-location: WSL distro "${location.wslDistro}" is not proven for structured Pi (use Pi TUI)`,
      fallback: PI_TUI_FALLBACK
    }
  }
  return {
    supported: true,
    reason: 'location-ok: local host structured Pi',
    fallback: PI_TUI_FALLBACK
  }
}
export type PiProbedCapabilities = {
  readonly textStreaming?: boolean
  readonly thinking?: boolean
  readonly tools?: boolean
  readonly images?: boolean
  readonly extensionDialogs?: boolean
  readonly history?: boolean
  readonly options?: boolean
  readonly cancel?: boolean
  readonly resume?: boolean
}
export type PiCapabilityNegotiation = {
  readonly structured: boolean
  readonly reason: string
  readonly fallback: typeof PI_TUI_FALLBACK
  readonly unsupported: readonly string[]
}
// Unknown (absent) capabilities count as unsupported; the host hides them.
export function negotiatePiCapabilities(
  required: readonly string[],
  probed: PiProbedCapabilities
): PiCapabilityNegotiation {
  const unsupported = required.filter(
    (name) => (probed as unknown as Record<string, unknown>)[name] !== true
  )
  if (unsupported.length === 0) {
    return {
      structured: true,
      reason: 'capabilities-ok: all required features probed',
      fallback: PI_TUI_FALLBACK,
      unsupported: []
    }
  }
  return {
    structured: false,
    reason: `unsupported-capabilities: ${unsupported.join(',')} (use Pi TUI)`,
    fallback: PI_TUI_FALLBACK,
    unsupported
  }
}
export type PiAcquireCompat = {
  readonly piVersion?: string
  readonly executionHostId?: string
  readonly wslDistro?: string | null
  readonly requiredCapabilities?: readonly string[]
}
export type PiAcquireCompatVerdict = {
  readonly allowed: boolean
  readonly code: string
  readonly reason: string
  readonly fallback: typeof PI_TUI_FALLBACK
}
// Pre-spawn gate: every present dimension is enforced before any Pi child.
export function checkAcquireCompat(
  compat: PiAcquireCompat,
  advertised: PiProbedCapabilities
): PiAcquireCompatVerdict {
  if (compat.executionHostId !== undefined || compat.wslDistro !== undefined) {
    const verdict = checkPiLocationSupport(
      {
        executionHostId: compat.executionHostId ?? PI_COMPAT_LOCAL_HOST_ID,
        wslDistro: compat.wslDistro ?? null
      },
      PI_COMPAT_AGENT
    )
    if (!verdict.supported) {
      return {
        allowed: false,
        code: 'PI_COMPAT_LOCATION',
        reason: verdict.reason,
        fallback: PI_TUI_FALLBACK
      }
    }
  }
  if (compat.piVersion !== undefined) {
    const verdict = checkPiVersionSupport(compat.piVersion)
    if (!verdict.supported) {
      return {
        allowed: false,
        code: 'PI_COMPAT_VERSION',
        reason: verdict.reason,
        fallback: PI_TUI_FALLBACK
      }
    }
  }
  const required = compat.requiredCapabilities ?? []
  if (required.length > 0) {
    const negotiated = negotiatePiCapabilities(required, advertised)
    if (!negotiated.structured) {
      return {
        allowed: false,
        code: 'PI_COMPAT_CAPABILITY',
        reason: negotiated.reason,
        fallback: PI_TUI_FALLBACK
      }
    }
  }
  return {
    allowed: true,
    code: 'PI_COMPAT_OK',
    reason: 'compat-ok: acquire-time gate passed',
    fallback: PI_TUI_FALLBACK
  }
}
// Capabilities with a dedicated pre-turn live RPC probe.
export const LIVE_PROBE_CAPABILITIES: readonly string[] = Object.freeze([
  'options',
  'images',
  'history',
  'resume'
])
export function splitProbedCapabilities(required: readonly string[]): {
  readonly live: readonly string[]
  readonly declared: readonly string[]
} {
  const live = required.filter((name) =>
    (LIVE_PROBE_CAPABILITIES as readonly string[]).includes(name)
  )
  const declared = required.filter(
    (name) => !(LIVE_PROBE_CAPABILITIES as readonly string[]).includes(name)
  )
  return { live: Object.freeze([...live]), declared: Object.freeze([...declared]) }
}
// Static advertisement: what structured Pi would offer when live probes pass.
export const PI_STRUCTURED_ADVERTISED_CAPABILITIES: PiProbedCapabilities = Object.freeze({
  textStreaming: true,
  thinking: true,
  tools: true,
  images: true,
  extensionDialogs: true,
  history: true,
  options: true,
  cancel: true,
  resume: true
})
// Production relies on these every session; images join only when requested.
export const PI_STRUCTURED_REQUIRED_CAPABILITIES: readonly string[] = Object.freeze([
  'textStreaming',
  'thinking',
  'tools',
  'options',
  'history',
  'cancel',
  'resume',
  'extensionDialogs'
])
export type PiStructuredGateInput = {
  readonly location: PiCompatLocation
  readonly agent: string
  readonly piVersion: string
  readonly requiredCapabilities?: readonly string[]
  readonly probedCapabilities?: PiProbedCapabilities
}
export type PiStructuredGate = {
  readonly structured: boolean
  readonly reason: string
  readonly fallback: typeof PI_TUI_FALLBACK
}
// Single entry combining location, version floor, and capability gates.
export function gatePiStructuredSession(input: PiStructuredGateInput): PiStructuredGate {
  const location = checkPiLocationSupport(input.location, input.agent)
  if (!location.supported) {
    return { structured: false, reason: location.reason, fallback: PI_TUI_FALLBACK }
  }
  const version = checkPiVersionSupport(input.piVersion)
  if (!version.supported) {
    return { structured: false, reason: version.reason, fallback: PI_TUI_FALLBACK }
  }
  const required = input.requiredCapabilities ?? []
  if (required.length > 0) {
    const negotiated = negotiatePiCapabilities(required, input.probedCapabilities ?? {})
    if (!negotiated.structured) {
      return { structured: false, reason: negotiated.reason, fallback: PI_TUI_FALLBACK }
    }
  }
  return {
    structured: true,
    reason: `${location.reason}; ${version.reason}`,
    fallback: PI_TUI_FALLBACK
  }
}
