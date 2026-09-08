import { describe, expect, it } from 'vitest'
import {
  expandWindowsEnvironmentVariables,
  expandWindowsPathEnvironmentVariables
} from './windows-environment-expansion'

describe('expandWindowsEnvironmentVariables', () => {
  it('expands names case-insensitively and preserves unknown variables', () => {
    expect(
      expandWindowsEnvironmentVariables('%localappdata%\\agy\\bin;%MISSING%\\bin', {
        LOCALAPPDATA: 'C:\\Users\\orca\\AppData\\Local'
      })
    ).toBe('C:\\Users\\orca\\AppData\\Local\\agy\\bin;%MISSING%\\bin')
  })

  it('expands variables with empty values', () => {
    expect(expandWindowsEnvironmentVariables('before%EMPTY%after', { EMPTY: '' })).toBe(
      'beforeafter'
    )
  })
})

describe('expandWindowsPathEnvironmentVariables', () => {
  it('expands every Windows PATH casing without changing other variables', () => {
    const env = {
      ORCA_PATH_ROOT: 'C:\\Users\\orca',
      Path: '%ORCA_PATH_ROOT%\\bin',
      PATH: '%orca_path_root%\\tools',
      TEMPLATE: '%ORCA_PATH_ROOT%\\template'
    }

    expandWindowsPathEnvironmentVariables(env, 'win32')

    expect(env.Path).toBe('C:\\Users\\orca\\bin')
    expect(env.PATH).toBe('C:\\Users\\orca\\tools')
    expect(env.TEMPLATE).toBe('%ORCA_PATH_ROOT%\\template')
  })

  it('leaves non-Windows PATH values unchanged', () => {
    const env = { ROOT: '/opt/orca', PATH: '%ROOT%/bin:/usr/bin' }

    expandWindowsPathEnvironmentVariables(env, 'linux')

    expect(env.PATH).toBe('%ROOT%/bin:/usr/bin')
  })
})

it('enumerates fallback keys once for a PATH containing repeated mixed-case variables', () => {
  let enumerations = 0
  const env = new Proxy(
    { ROOT: 'C:\\root', OTHER: 'unused' },
    {
      ownKeys(target) {
        enumerations += 1
        return Reflect.ownKeys(target)
      }
    }
  )
  const value = Array.from({ length: 1000 }, () => '%root%').join(';')
  expect(expandWindowsEnvironmentVariables(value, env)).toBe(Array(1000).fill('C:\\root').join(';'))
  expect(enumerations).toBe(1)
})

it('preserves exact casing authority and first fallback keys including undefined values', () => {
  const env = { Root: undefined, ROOT: 'upper', root: 'lower' }
  expect(expandWindowsEnvironmentVariables('%ROOT%:%root%:%rOoT%', env)).toBe('upper:lower:%rOoT%')
})
