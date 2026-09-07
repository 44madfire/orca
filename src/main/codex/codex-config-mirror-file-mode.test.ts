import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'

// A config shaped like the one in the report: an MCP server whose bearer token
// lives literally in the file. Whether a given user's config carries one is up
// to them, which is exactly why the mirror cannot decide the mode per-content.
const CONFIG_WITH_SECRET = [
  'model = "gpt-5"',
  '',
  '[mcp_servers.example.http_headers]',
  'Authorization = "Bearer super-secret-token"',
  ''
].join('\n')

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

const systemHome = (): string => join(fakeHomeDir, '.codex')
const systemConfigPath = (): string => join(systemHome(), 'config.toml')
const runtimeConfigPath = (): string =>
  join(userDataDir, 'codex-runtime-home', 'home', 'config.toml')
const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8)

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-mode-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-mode-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  mkdirSync(systemHome(), { recursive: true })
  writeFileSync(systemConfigPath(), CONFIG_WITH_SECRET, 'utf-8')
  chmodSync(systemConfigPath(), 0o600)
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
})

describe.skipIf(process.platform === 'win32')('runtime config.toml file mode (STA-6706)', () => {
  it('creates the mirrored copy owner-only, not world-readable', () => {
    syncSystemConfigIntoManagedCodexHome()

    // 0644 on a file that can hold an MCP bearer token is the reported defect.
    expect(modeOf(runtimeConfigPath())).toBe('600')
  })

  it('repairs a copy that is already world-readable, even with identical bytes', () => {
    syncSystemConfigIntoManagedCodexHome()
    chmodSync(runtimeConfigPath(), 0o644)
    expect(modeOf(runtimeConfigPath())).toBe('644')

    // The mirror skips the write when content matches, so repair cannot depend
    // on a rewrite — the user most needing this has a file that never changes.
    syncSystemConfigIntoManagedCodexHome()

    expect(modeOf(runtimeConfigPath())).toBe('600')
  })

  it('keeps the copy owner-only when the source itself is loose', () => {
    chmodSync(systemConfigPath(), 0o644)

    syncSystemConfigIntoManagedCodexHome()

    // Mirroring the source mode would leave this user — the likeliest to need
    // the fix — exposed, so the mode is forced rather than copied.
    expect(modeOf(runtimeConfigPath())).toBe('600')
  })

  it('does not loosen the source config', () => {
    syncSystemConfigIntoManagedCodexHome()

    expect(modeOf(systemConfigPath())).toBe('600')
  })
})

describe('runtime config.toml mirror idempotence (STA-6706)', () => {
  it('does not rewrite the file when nothing changed', () => {
    syncSystemConfigIntoManagedCodexHome()
    const path = runtimeConfigPath()
    // Backdate so any rewrite is unambiguous rather than lost in mtime
    // granularity.
    const past = new Date(Date.now() - 60_000)
    utimesSync(path, past, past)
    const before = statSync(path).mtimeMs

    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()

    expect(statSync(path).mtimeMs).toBe(before)
  })
})
