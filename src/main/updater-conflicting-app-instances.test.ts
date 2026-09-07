import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  describeConflictingAppInstances,
  findConflictingAppInstancePids,
  parseRunningApplicationPids,
  runningApplicationQueryOutput
} from './updater-conflicting-app-instances'

const APP_EXECUTABLE = '/Applications/Orca.app/Contents/MacOS/Orca'

function darwinDeps(overrides: Parameters<typeof findConflictingAppInstancePids>[0] = {}) {
  return {
    platform: 'darwin' as NodeJS.Platform,
    executablePath: APP_EXECUTABLE,
    currentPid: 100,
    ...overrides
  }
}

describe('parseRunningApplicationPids', () => {
  it('keeps pids and drops the querying process', () => {
    expect(parseRunningApplicationPids('270\n100\n811\n', 100)).toEqual([270, 811])
  })

  it('ignores blank and non-numeric lines', () => {
    expect(parseRunningApplicationPids('\n270\nnot-a-pid\n  \n', 100)).toEqual([270])
  })
})

describe('findConflictingAppInstancePids', () => {
  it('reports other instances of this same executable', async () => {
    const read = vi.fn().mockResolvedValue('270\n811\n')

    expect(
      await findConflictingAppInstancePids(darwinDeps({ readRunningApplicationPids: read }))
    ).toEqual([270, 811])
    expect(read).toHaveBeenCalledWith(APP_EXECUTABLE, 100)
  })

  it('reports nothing when this is the only instance', async () => {
    const read = vi.fn().mockResolvedValue('')

    expect(
      await findConflictingAppInstancePids(darwinDeps({ readRunningApplicationPids: read }))
    ).toEqual([])
  })

  it('fails open when the query throws', async () => {
    const read = vi.fn().mockRejectedValue(new Error('osascript unavailable'))

    expect(
      await findConflictingAppInstancePids(darwinDeps({ readRunningApplicationPids: read }))
    ).toEqual([])
  })

  it('does not query off darwin, where the installers manage running instances', async () => {
    const read = vi.fn().mockResolvedValue('270\n')

    for (const platform of ['win32', 'linux'] as const) {
      expect(
        await findConflictingAppInstancePids(
          darwinDeps({ platform, readRunningApplicationPids: read })
        )
      ).toEqual([])
    }
    expect(read).not.toHaveBeenCalled()
  })
})

describe('runningApplicationQueryOutput', () => {
  // Fail-open is the property that keeps a broken probe from blocking updates,
  // and the runner reports these as data rather than throwing — so each one is a
  // path that would otherwise look like a successful "no blockers" answer, or
  // worse, like a partial list of them.
  it('passes through the output of a query that exited cleanly', () => {
    expect(runningApplicationQueryOutput({ timedOut: false, code: 0, stdout: '270\n' })).toBe(
      '270\n'
    )
  })

  it('discards partial output from a timed-out query', () => {
    expect(runningApplicationQueryOutput({ timedOut: true, code: null, stdout: '270\n' })).toBe('')
  })

  it('discards output from a query that exited non-zero', () => {
    expect(runningApplicationQueryOutput({ timedOut: false, code: 1, stdout: '270\n' })).toBe('')
  })

  it('discards output from a query killed by a signal', () => {
    expect(runningApplicationQueryOutput({ timedOut: false, code: null, stdout: '270\n' })).toBe('')
  })

  it('discards a clipped list even though the query exited cleanly', () => {
    // The only partial answer that arrives with code 0: the bounded sink hit
    // maxOutputBytes. A truncated pid list would name some blockers and hide
    // others, so it is not an answer this probe may act on.
    expect(
      runningApplicationQueryOutput({
        timedOut: false,
        code: 0,
        stdout: '270\n811\n',
        outputTruncated: true
      })
    ).toBe('')
  })

  it('accepts output that the sink explicitly did not clip', () => {
    expect(
      runningApplicationQueryOutput({
        timedOut: false,
        code: 0,
        stdout: '270\n',
        outputTruncated: false
      })
    ).toBe('270\n')
  })
})

describe('describeConflictingAppInstances', () => {
  it('names a single blocking pid, and reads as singular throughout', () => {
    expect(describeConflictingAppInstances([270])).toBe(
      'Another copy of Orca is running (PID 270). macOS cannot replace the app while it is open — quit it, then try again.'
    )
  })

  it('reads as plural for more than one', () => {
    expect(describeConflictingAppInstances([270, 811])).toBe(
      '2 other copies of Orca are running (PIDs 270, 811). macOS cannot replace the app while they are open — quit them, then try again.'
    )
  })

  it('caps how many pids it lists', () => {
    expect(describeConflictingAppInstances([1, 2, 3, 4, 5, 6])).toContain(
      '6 other copies of Orca are running (PIDs 1, 2, 3, 4, 5, …)'
    )
  })
})

// Why this is a source assertion and not a behavioural one: the behaviour under
// test lives inside the AppKit query, so any test that injects a pid reader
// bypasses exactly the logic that must not regress.
describe('conflicting-instance detection strategy', () => {
  const source = readFileSync(
    path.join(import.meta.dirname, 'updater-conflicting-app-instances.ts'),
    'utf8'
  )
  // Why the query and not the file: the prose above it names AppKit and
  // bundleIdentifier too, so asserting on the file passes even after the query
  // has been rewritten to scan the process table — measured, that is exactly
  // what an earlier version of this ratchet did.
  const query = source.match(/String\.raw`([\s\S]*?)`/)?.[1] ?? ''
  /** The condition deciding which running applications count as blockers. */
  const blockerCondition = query.match(/if\s*\(([\s\S]*?)\)\s*\{/)?.[1] ?? ''

  it('reads its blocker set from AppKit, not the process table', () => {
    expect(query).not.toBe('')
    expect(query).toContain('NSWorkspace.sharedWorkspace.runningApplications')
  })

  it('identifies blockers by bundle identity, so Orca CLI processes are not counted', () => {
    // The Orca CLI runs from the SAME bundle executable under
    // ELECTRON_RUN_AS_NODE, so `ps`-style matching on the executable path
    // reports every CLI invocation as a blocking app instance and refuses the
    // update outright on any machine that uses the CLI. AppKit gives those
    // processes no bundle identity and Squirrel does not wait for them, so the
    // non-null bundleIdentifier requirement is what makes this set match
    // Squirrel's. Measured on a live machine: three processes shared the bundle
    // executable path (the app plus two `ELECTRON_RUN_AS_NODE` CLI processes)
    // and this query returned only the app.
    expect(blockerCondition).not.toBe('')
    // Order- and whitespace-independent, so reformatting cannot redden this.
    expect(blockerCondition).toContain('bundleIdentifier')
    expect(blockerCondition).toContain('executableUrl')
    expect(blockerCondition).toContain('executablePath')
  })

  it('never enumerates blockers from the process table', () => {
    expect(source).not.toMatch(/['"`]\/bin\/ps['"`]/)
    expect(source).not.toMatch(/\bpgrep\b/)
  })

  it('spawns through the shared runner, not node:child_process', () => {
    // The tree-level guard in src/shared/child-process owns this rule; asserting
    // it here too keeps the reason next to the code that has to obey it.
    expect(source).not.toContain('node:child_process')
    expect(source).toContain("from '../shared/child-process/run-process'")
  })
})
