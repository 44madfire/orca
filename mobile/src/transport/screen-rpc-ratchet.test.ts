import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Screen directories whose RPC access is being moved behind the host operation adapters. */
const SCREEN_DIRECTORIES = [
  'tasks',
  'session',
  'files',
  'accounts',
  'worktree',
  'host-screen',
  'components',
  'hooks'
] as const

/** Adapters are where `sendRequest` is supposed to live; specs and fixtures are not product code. */
const NOT_SCREEN_CODE = /(^|\/)(native-host-|default-host-)|\.test\.tsx?$|test-support/

/** Routed in this PR, and each one must stay at zero. A screen that regrows an inline call has
 *  reopened the seam the operations adapters exist to close. */
const ROUTED_SCREENS = [
  'components/use-new-workspace-execution-target.ts',
  'components/use-new-workspace-repositories.ts',
  'components/use-new-workspace-runtime-context.ts',
  'components/use-new-workspace-setup-script.ts',
  'files/MobileFileExplorerPanel.tsx',
  'session/mobile-file-tap-open.ts',
  'session/use-mobile-native-chat-file-search.ts',
  'session/use-mobile-native-chat-readability.ts',
  'session/use-mobile-native-chat-session.ts',
  'session/use-mobile-native-chat-stop.ts',
  'session/use-mobile-session-document-readers.ts',
  'session/use-mobile-session-markdown-actions.ts',
  'session/use-mobile-session-terminal-input.ts',
  'session/use-mobile-session-terminal-stream-display.ts',
  'session/use-quick-commands.ts',
  'tasks/mobile-tasks-filter-pickers.tsx',
  'tasks/smart-source-paste-intent.ts',
  'tasks/use-mobile-tasks-client-settings-actions.tsx',
  'tasks/use-mobile-tasks-github-check-file-actions.tsx',
  'tasks/use-mobile-tasks-github-reply-merge-actions.tsx',
  'tasks/use-mobile-tasks-gitlab-github-status-actions.tsx',
  'tasks/use-mobile-tasks-item-detail-loading.tsx',
  'tasks/use-mobile-tasks-item-detail-metadata-effects.tsx',
  'tasks/use-mobile-tasks-linear-item-actions.tsx',
  'tasks/use-mobile-tasks-list-and-detail-effects.tsx',
  'tasks/use-mobile-tasks-project-detail-loading.tsx',
  'tasks/use-mobile-tasks-project-file-merge-actions.tsx',
  'tasks/use-mobile-tasks-project-loading-actions.tsx',
  'tasks/use-mobile-tasks-project-metadata-actions.tsx',
  'tasks/use-mobile-tasks-project-metadata-loading.tsx',
  'tasks/use-mobile-tasks-project-repository-resolution.tsx',
  'tasks/use-mobile-tasks-project-review-check-actions.tsx',
  'tasks/use-mobile-tasks-project-thread-reply-actions.tsx',
  'tasks/use-mobile-tasks-project-workspace-comment-actions.tsx',
  'tasks/use-mobile-tasks-provider-load-actions.tsx',
  'tasks/use-mobile-tasks-route-and-item-state.tsx',
  'tasks/use-mobile-tasks-runtime-hydration.tsx',
  'tasks/use-mobile-tasks-task-create-actions.tsx',
  'tasks/use-mobile-tasks-task-list-loading.tsx',
  'tasks/use-mobile-tasks-task-pagination-actions.tsx',
  'tasks/use-mobile-tasks-workspace-source-effects.tsx',
  'tasks/use-mobile-tasks-workspace-sparse-actions.tsx',
  'tasks/use-mobile-tasks-workspace-ssh-state.tsx',
  'worktree/use-retired-worktree-names.ts'
] as const

/** Four calls stay inline on purpose. Each has no adapter method that means the same thing, so
 *  routing it would change what reaches the host. The count is pinned so a fifth cannot appear. */
const DELIBERATE_INLINE_CALLS: Record<string, number> = {
  // `terminal.close` — closing the terminal, not the tab; the tab adapter's close is a tab close.
  'session/use-mobile-session-close-actions.ts': 1,
  // `files.createFile` then `files.open` — note creation has no operations counterpart.
  'session/use-mobile-session-content-create-actions.ts': 2,
  // The buffered submit; it needs the raw response to classify a partial write.
  'session/use-mobile-session-terminal-send-actions.ts': 1,
  // `worktree.create` from a task item; the creation adapter builds the composer's params instead.
  'tasks/use-mobile-tasks-workspace-create-actions.tsx': 1
}

/** Every remaining inline call site under the screen directories. Lower is the only allowed
 *  direction: later PRs move the rest, and nothing may add a new one. */
const REMAINING_INLINE_CALL_SITES = 112

const SOURCE_ROOT = join(__dirname, '..')
const APP_ROOT = join(__dirname, '../..', 'app')

/** Route files live outside `src/`, so the account screen is checked by its own path. */
const ROUTED_APP_SCREENS = ['h/[hostId]/accounts.tsx'] as const

function screenSources(): Array<{ path: string; source: string }> {
  const found: Array<{ path: string; source: string }> = []
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), `${relative}/`)
        continue
      }
      if (!/\.tsx?$/.test(entry.name) || NOT_SCREEN_CODE.test(relative)) {
        continue
      }
      found.push({ path: relative, source: readFileSync(join(directory, entry.name), 'utf8') })
    }
  }
  for (const directory of SCREEN_DIRECTORIES) {
    walk(join(SOURCE_ROOT, directory), `${directory}/`)
  }
  return found
}

const countCalls = (source: string): number => (source.match(/sendRequest\(/g) ?? []).length

describe('screen RPC ratchet', () => {
  it('keeps every routed screen free of inline sendRequest', () => {
    const regrown = [
      ...ROUTED_SCREENS.map((path) => [path, join(SOURCE_ROOT, path)] as const),
      ...ROUTED_APP_SCREENS.map((path) => [path, join(APP_ROOT, path)] as const)
    ]
      .filter(([, absolute]) => countCalls(readFileSync(absolute, 'utf8')) > 0)
      .map(([path]) => path)
    expect(regrown).toEqual([])
  })

  it('pins the calls left inline on purpose', () => {
    const actual = Object.fromEntries(
      Object.keys(DELIBERATE_INLINE_CALLS).map((path) => [
        path,
        countCalls(readFileSync(join(SOURCE_ROOT, path), 'utf8'))
      ])
    )
    expect(actual).toEqual(DELIBERATE_INLINE_CALLS)
  })

  it('never grows the screen-side RPC surface', () => {
    const total = screenSources().reduce((sum, file) => sum + countCalls(file.source), 0)
    expect(total).toBeLessThanOrEqual(REMAINING_INLINE_CALL_SITES)
  })
})
