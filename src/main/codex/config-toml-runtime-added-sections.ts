import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath } from './config-toml-key-path'
import {
  getTomlSectionHeaderKey,
  getTomlSections,
  type TomlSection
} from './config-toml-runtime-owned-sections'

/**
 * The section keys the last mirror copied in from the system config.
 *
 * `null` is not an empty set. An empty set claims the source contributed no
 * sections; `null` says no mirror has recorded an answer yet, and no runtime
 * section may be deleted on its authority.
 */
export type MirroredCodexSectionKeys = ReadonlySet<string> | null

export function getCodexConfigSectionKeys(config: string): ReadonlySet<string> {
  return new Set([
    ...getTomlSections(config).map((section) => getTomlSectionHeaderKey(section.header)),
    ...getPreambleTableKeys(config)
  ])
}

/**
 * Table names a top-level assignment claims before the first `[table]` header.
 *
 * TOML spells the same table two ways, so `tui = { animations = false }` claims
 * `[tui]` just as a header would. Without this the source's inline shape would
 * not out-rank a `[tui]` table in the runtime home, and a setting the promotion
 * pass deliberately reverted would come back looking runtime-added.
 */
function getPreambleTableKeys(config: string): string[] {
  const lines = config.split('\n')
  const preambleEnd = getTomlSections(config)[0]?.start ?? lines.length
  const keys: string[] = []
  let scanState = createTomlLineScanState()
  for (let index = 0; index < preambleEnd; index += 1) {
    const line = lines[index] ?? ''
    const parsed = isTomlStructuralLine(scanState) ? parseTomlKeyPath(line) : null
    // Why: only an assignment claims a name; a bare word on its own does not.
    const assigned = parsed ? line.slice(parsed.end).trimStart() : ''
    if (parsed && assigned.startsWith('=')) {
      // Why: a scalar names no table, so `model = "x"` must not claim `[model]`
      // and leave a phantom key in the record of what the source contributed.
      // A dotted key and an inline table both do define one.
      const definesTable =
        parsed.segments.length > 1 || assigned.slice(1).trimStart().startsWith('{')
      if (definesTable) {
        keys.push(`[${parsed.segments[0]}]`)
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
  }
  return keys
}

/**
 * Separates a runtime section the user added inside Orca's managed CODEX_HOME
 * from one the mirror copied in and the user has since deleted at the source.
 *
 * Without this the mirror rebuilds every ordinary section from the system config
 * and keeps only a fixed allowlist of runtime-owned tables, so anything written
 * through an Orca-launched Codex — `[mcp_servers.*]` above all — is dropped on
 * the next pass.
 */
export function createRuntimeAddedSectionFilter({
  systemConfig,
  mirroredSectionKeys
}: {
  systemConfig: string
  mirroredSectionKeys: MirroredCodexSectionKeys
}): (section: TomlSection) => boolean {
  const systemSectionKeys = getCodexConfigSectionKeys(systemConfig)
  return (section) => {
    const key = getTomlSectionHeaderKey(section.header)
    // Why: the system half of the merge already carries every section it
    // defines, so the source wins for a name present on both sides.
    if (systemSectionKeys.has(key)) {
      return false
    }
    // Why: recorded as mirrored in and now absent at the source means the user
    // deleted it there, and re-appending it would undo that deletion. With no
    // recorded set the section is kept instead: the managed home is the only
    // copy of anything added inside it, so deleting on a guess is unrecoverable.
    return mirroredSectionKeys === null || !mirroredSectionKeys.has(key)
  }
}
