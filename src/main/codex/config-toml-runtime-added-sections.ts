import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import { getTomlSections, type TomlSection } from './config-toml-runtime-owned-sections'

/**
 * The section keys the last mirror copied in from the system config.
 *
 * `null` is not an empty set. An empty set claims the source contributed no
 * sections; `null` says no mirror has recorded an answer yet, and no runtime
 * section may be deleted on its authority.
 */
export type MirroredCodexSectionKeys = ReadonlySet<string> | null

/**
 * One key per table, whatever spelling declared it.
 *
 * `[a.b]`, `[ a.b ]`, `[a."b"]` and `[[a.b]]` are all one table to Codex, so
 * they must be one key here. Comparing raw header text instead lets a spelling
 * difference read as "the source does not declare this", and the mirror then
 * emits both — a duplicate table, and a config.toml Codex cannot parse. The
 * array-of-tables marker is dropped deliberately: a table and an array of
 * tables cannot share a name either.
 */
function canonicalTablePath(segments: readonly string[]): string {
  return JSON.stringify(segments)
}

function isPrefixOf(prefix: readonly string[], segments: readonly string[]): boolean {
  return prefix.length <= segments.length && prefix.every((part, index) => segments[index] === part)
}

/** Canonical keys for the tables a config declares with a `[header]`. */
export function getCodexConfigSectionKeys(config: string): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const section of getTomlSections(config)) {
    const parsed = parseTomlTableHeaderPath(section.header)
    if (parsed) {
      keys.add(canonicalTablePath(parsed.segments))
    }
  }
  return keys
}

type PreambleTableClaims = {
  /** Tables the preamble declares, including every ancestor it closes. */
  tables: ReadonlySet<string>
  /** Tables assigned as an inline table, which no sub-table may extend. */
  inlineTables: readonly (readonly string[])[]
}

/**
 * Tables a top-level assignment declares before the first `[table]` header.
 *
 * TOML spells one table several ways: `tui = { animations = false }` and
 * `tui.theme = "x"` both declare `tui` just as `[tui]` would, and once declared
 * that way a later `[tui]` header is invalid rather than additive. Ancestors
 * count for the same reason — `a.b.c = 1` closes `a` and `a.b` as well.
 */
function readPreambleTableClaims(config: string): PreambleTableClaims {
  const lines = config.split('\n')
  const preambleEnd = getTomlSections(config)[0]?.start ?? lines.length
  const tables = new Set<string>()
  const inlineTables: string[][] = []
  let scanState = createTomlLineScanState()
  for (let index = 0; index < preambleEnd; index += 1) {
    const line = lines[index] ?? ''
    const parsed = isTomlStructuralLine(scanState) ? parseTomlKeyPath(line) : null
    const assigned = parsed ? line.slice(parsed.end).trimStart() : ''
    if (parsed && assigned.startsWith('=')) {
      const isInlineTable = assigned.slice(1).trimStart().startsWith('{')
      // Why: `a.b.c = 1` declares table `a.b`; `a = { .. }` declares `a`. A
      // plain scalar declares none, so `model = "x"` claims no `[model]`.
      const tablePath = isInlineTable ? parsed.segments : parsed.segments.slice(0, -1)
      for (let depth = 1; depth <= tablePath.length; depth += 1) {
        tables.add(canonicalTablePath(tablePath.slice(0, depth)))
      }
      if (isInlineTable && tablePath.length > 0) {
        inlineTables.push([...tablePath])
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
  }
  return { tables, inlineTables }
}

/**
 * Separates a runtime section the user added inside Orca's managed CODEX_HOME
 * from one the mirror copied in and the user has since deleted at the source.
 *
 * Without this the mirror rebuilds every ordinary section from the system
 * config and keeps only a fixed allowlist of runtime-owned tables, so anything
 * written through an Orca-launched Codex — `[mcp_servers.*]` above all — is
 * dropped on the next pass.
 */
export function createRuntimeAddedSectionFilter({
  systemConfig,
  mirroredSectionKeys
}: {
  systemConfig: string
  mirroredSectionKeys: MirroredCodexSectionKeys
}): (section: TomlSection) => boolean {
  const sourceSectionKeys = getCodexConfigSectionKeys(systemConfig)
  const preamble = readPreambleTableClaims(systemConfig)
  return (section) => {
    const parsed = parseTomlTableHeaderPath(section.header)
    // Why: a header that does not parse cannot be compared against the source,
    // and emitting it beside a source table of the same name is what produces
    // an unparseable config. Dropping is also what the mirror did with every
    // ordinary runtime section before this filter existed, so it is no worse.
    if (!parsed) {
      return false
    }
    const key = canonicalTablePath(parsed.segments)
    // Why: the system half of the merge already carries every table it
    // declares, so the source wins for a name present on both sides.
    if (sourceSectionKeys.has(key) || preamble.tables.has(key)) {
      return false
    }
    // Why: TOML forbids extending an inline table with a sub-table, so a
    // runtime `[a.b.env]` under a source `a = { b = .. }` cannot be emitted.
    if (preamble.inlineTables.some((path) => isPrefixOf(path, parsed.segments))) {
      return false
    }
    // Why: recorded as mirrored in and now absent at the source means the user
    // deleted it there, and re-appending it would undo that deletion. With no
    // recorded set the section is kept instead: the managed home is the only
    // copy of anything added inside it, so deleting on a guess is unrecoverable.
    return mirroredSectionKeys === null || !mirroredSectionKeys.has(key)
  }
}
