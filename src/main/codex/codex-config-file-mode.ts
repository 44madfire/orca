import { chmodSync, statSync } from 'node:fs'

/**
 * `config.toml` can carry secrets depending on how the user configured Codex —
 * an MCP server declared with `http_headers` holds its bearer token literally in
 * this file. Orca cannot tell from the outside whether a given user's config
 * does, so the mirror writes every copy at owner-only rather than inspecting the
 * content and guessing.
 */
export const CODEX_CONFIG_FILE_MODE = 0o600

/**
 * Brings an existing config file up to the owner-only mode.
 *
 * The mirror only rewrites when content changes, so a copy already sitting at a
 * looser mode would otherwise keep it forever. Repairing is the point: the user
 * most in need of this is the one whose file is already world-readable.
 *
 * POSIX only — on Windows `chmod` just toggles the read-only bit, so applying it
 * there would claim a protection the platform is not giving.
 */
export function enforceCodexConfigFileMode(path: string): void {
  if (process.platform === 'win32') {
    return
  }
  try {
    if ((statSync(path).mode & 0o777) === CODEX_CONFIG_FILE_MODE) {
      return
    }
    chmodSync(path, CODEX_CONFIG_FILE_MODE)
  } catch {
    // A missing or unreadable config is the caller's concern, not this repair's:
    // it must never be the reason a Codex launch fails.
  }
}
