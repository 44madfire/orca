import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

describe.skipIf(process.platform === 'win32')('runtime config.toml backup mode (STA-6706)', () => {
  const backupPath = (): string => `${runtimeConfigPath()}.bak`

  it('repairs the rolling backup, which holds the same secret', () => {
    syncSystemConfigIntoManagedCodexHome()
    // The trust writer copies the whole file to <config>.bak before replacing
    // it, so the backup carries the same bearer token as the config.
    writeFileSync(backupPath(), CONFIG_WITH_SECRET, 'utf-8')
    chmodSync(backupPath(), 0o644)

    syncSystemConfigIntoManagedCodexHome()

    expect(modeOf(backupPath())).toBe('600')
    expect(modeOf(runtimeConfigPath())).toBe('600')
  })

  it('does not fail when no backup exists', () => {
    expect(() => syncSystemConfigIntoManagedCodexHome()).not.toThrow()
    expect(existsSync(backupPath())).toBe(false)
  })
})

// The home-local rewrite is reached only through the mirror. Proving the helper
// works in isolation never proves it is wired in — dropping the argument at the
// two call sites left the whole unit-test suite green.
describe('home-local rewrite reaches the mirrored file (STA-6706)', () => {
  const BUNDLED = '.tmp/bundled-marketplaces/openai-bundled'
  const writeMarketplaceConfig = (): void =>
    writeFileSync(
      systemConfigPath(),
      [
        'model = "gpt-5"',
        '',
        '[marketplaces.openai-bundled]',
        `source = "${systemHome()}/${BUNDLED}"`,
        ''
      ].join('\n'),
      'utf-8'
    )

  it('re-roots a bundled marketplace source in the written runtime config', () => {
    writeMarketplaceConfig()
    // Codex materialises this per home; the rewrite is conditional on it.
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home', BUNDLED), { recursive: true })

    syncSystemConfigIntoManagedCodexHome()

    const written = readFileSync(runtimeConfigPath(), 'utf-8')
    // The runtime home, not the standalone one: pointing at ~/.codex is what
    // stops Codex recognising it as bundled and silently drops the plugin.
    expect(written).toContain(`codex-runtime-home/home/${BUNDLED}`)
    expect(written).not.toContain(`${systemHome()}/.tmp/bundled-marketplaces`)
  })

  it('leaves the source path alone when the runtime home has no bundled directory', () => {
    writeMarketplaceConfig()

    syncSystemConfigIntoManagedCodexHome()

    // The shared runtime home in the field is exactly this case. Today's value
    // at least resolves; replacing it with a nonexistent path would be worse.
    const written = readFileSync(runtimeConfigPath(), 'utf-8')
    expect(written).toContain(`${systemHome()}/${BUNDLED}`)
    expect(written).not.toContain(`codex-runtime-home/home/${BUNDLED}`)
  })
})
