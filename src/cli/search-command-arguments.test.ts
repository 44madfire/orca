import { expect, it } from 'vitest'
import { parseArgs, REPEATED_FLAG_SEPARATOR } from './args'
import { parseSearchCommand } from './search-command-arguments'

it('preserves repeated filters through argv and validates before configuration', () => {
  const parsed = parseArgs([
    'search',
    '--agent-session',
    'needle',
    '--agent',
    'codex',
    '--agent',
    'claude',
    '--path',
    '/one',
    '--path',
    '/two'
  ])
  expect(parsed.flags.get('agent')).toBe(`codex${REPEATED_FLAG_SEPARATOR}claude`)
  expect(parseSearchCommand(parsed.flags).query).toMatchObject({
    agents: ['codex', 'claude'],
    scopePaths: ['/one', '/two']
  })
  expect(() =>
    parseSearchCommand(
      new Map<string, string | boolean>([
        ['enable', true],
        ['agent-session', 'needle'],
        ['limit', '101']
      ])
    )
  ).toThrow()
})

it('accepts queryless policy management and refuses aggregate mutations', () => {
  expect(
    parseSearchCommand(parseArgs(['search', '--agent-session', '--enable']).flags).configure
  ).toEqual({ enabled: true })
  expect(
    parseSearchCommand(
      parseArgs(['search', '--disable', '--clear-index', '--host', 'ssh:box']).flags
    ).configure
  ).toEqual({ enabled: false, clearIndex: true })
  expect(() =>
    parseSearchCommand(parseArgs(['search', '--enable', '--host', 'all']).flags)
  ).toThrow()
  expect(() => parseSearchCommand(parseArgs(['search', '--enable', '--disable']).flags)).toThrow()
})

it('handles command discovery, equals syntax, Windows paths and host-specific scope rules', () => {
  const parsed = parseArgs(
    [
      '--json',
      'search',
      '--agent-session=needle',
      '--agent=codex',
      '--agent=claude',
      '--path=C:\\work',
      '--path=\\\\server\\share',
      '--host=all'
    ],
    [['search']]
  )
  expect(parseSearchCommand(parsed.flags).query).toMatchObject({
    agents: ['codex', 'claude'],
    scopePaths: ['C:\\work', '\\\\server\\share']
  })
  for (const args of [
    ['--enable', '--path=/somewhere'],
    ['--enable', '--agent-session=needle', '--newest=false'],
    ['--agent-session=needle', '--host=ssh:box', '--path=relative'],
    ['--agent-session=needle', '--host=all', '--path=~/private'],
    ['--index-status', '--agent-session=needle']
  ]) {
    expect(() => parseSearchCommand(parseArgs(['search', ...args], [['search']]).flags)).toThrow()
  }
})
