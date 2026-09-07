import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { FAKE_AGENT_WINDOWS_SHELL } from './helpers/fake-agent-command-override'
import {
  cleanupCompletedWorkerFixture,
  clearCompletedWorkerLedger,
  completedWorkerFakeCodexCommand,
  completedWorkerLaunchEnv,
  listRuntimeTerminals,
  readCompletedWorkerDispatchCapability,
  readCompletedWorkerLedger,
  readPersistedWorkerRecoveryRecord,
  seedCurrentCodexTranscript
} from './helpers/completed-worker-retirement-fixture'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalSummary } from '../../src/shared/runtime-types'
import { splitWorktreeIdForFilesystem } from '../../src/shared/worktree/id'

const PROVIDER_SESSION_ID = '019feb51-2269-71c2-89c6-faa8dc65c8dd'

test.describe.configure({ mode: 'serial' })

test.afterAll(() => {
  cleanupCompletedWorkerFixture()
})

async function findSecondaryWorktree(
  page: Page,
  client: RuntimeClient,
  coordinatorWorktreeId: string
): Promise<string> {
  let targetWorktreeId: string | null = null
  await expect
    .poll(
      async () => {
        const listed = await client.call<{ worktrees: { id: string }[] }>('worktree.list', {})
        // The restart fixture only waits for the primary; refetch until the seeded secondary lands.
        const rendererWorktreeIds = await page.evaluate(async () => {
          const store = window.__store
          if (!store) {
            return []
          }
          await Promise.all(
            store.getState().repos.map((repo) => store.getState().fetchWorktrees(repo.id))
          )
          return Object.values(store.getState().worktreesByRepo)
            .flat()
            .map((worktree) => worktree.id)
        })
        targetWorktreeId =
          listed.result.worktrees.find(
            (worktree) =>
              worktree.id !== coordinatorWorktreeId && rendererWorktreeIds.includes(worktree.id)
          )?.id ?? null
        return targetWorktreeId
      },
      { timeout: 60_000, message: 'runtime never registered the secondary worktree' }
    )
    .not.toBeNull()
  if (!targetWorktreeId) {
    throw new Error('The seeded repository did not expose its secondary worktree')
  }
  return targetWorktreeId
}

async function backgroundMountTab(page: Page, worktreeId: string, tabId: string): Promise<void> {
  await page.evaluate(
    ({ tabId, worktreeId }) => {
      window.dispatchEvent(
        new CustomEvent('orca-background-mount-terminal-worktree', {
          detail: { worktreeId, tabIds: [tabId] }
        })
      )
    },
    { tabId, worktreeId }
  )
  await expect
    .poll(() => page.evaluate((tabId) => Boolean(window.__paneManagers?.get(tabId)), tabId))
    .toBe(true)
}

// A worker that reported done while its terminal stays open is fenced from automatic resume. The
// fence used to live only in the renderer's volatile blocked-pane map, so the first status write
// after any restart erased it and worktree activation relaunched the settled worker over its own
// still-live PTY (#16904 regression).
test('a settled orchestration worker keeps its resume fence across restart and reload', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }
  clearCompletedWorkerLedger()

  const session = createRestartSession(testInfo, completedWorkerLaunchEnv)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  try {
    const first = await session.launch()
    firstApp = first.app
    const coordinatorWorktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    await waitForSessionReady(first.page)
    await waitForActiveWorktree(first.page)
    await ensureTerminalVisible(first.page)
    await waitForActiveTerminalManager(first.page)
    await waitForActivePanePtyId(first.page)
    await first.page.evaluate(
      async ({ agentCommand, terminalWindowsShell }) => {
        await window.__store?.getState().updateSettings({
          agentCmdOverrides: { codex: agentCommand },
          terminalWindowsShell,
          disabledTuiAgents: [],
          terminalHiddenViewParking: false
        })
      },
      {
        agentCommand: completedWorkerFakeCodexCommand,
        terminalWindowsShell: FAKE_AGENT_WINDOWS_SHELL
      }
    )
    const isolatedHome = await firstApp.evaluate(({ app }) => app.getPath('home'))
    const client = new RuntimeClient(session.userDataDir, 30_000, null, null)
    const coordinatorPane = await waitForActivePaneHookDescriptor(first.page)
    const coordinatorHandle = (
      await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
        paneKey: coordinatorPane.paneKey
      })
    ).result.terminal.handle
    const targetWorktreeId = await findSecondaryWorktree(first.page, client, coordinatorWorktreeId)
    const targetWorktreePath = splitWorktreeIdForFilesystem(targetWorktreeId)?.worktreePath
    if (!targetWorktreePath) {
      throw new Error('The secondary worktree did not expose a filesystem path')
    }

    const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
      objective: 'Keep one settled worker tab across restart',
      from: coordinatorHandle
    })
    const task = await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
      spec: 'Report completion and stay open',
      run: run.result.run.id,
      callerTerminalHandle: coordinatorHandle
    })
    const started = await client.call<{
      dispatchId: string
      state: string
      effects: { kind: string; role?: string; id?: string }[]
    }>('orchestration.workerStart', {
      task: task.result.task.id,
      from: coordinatorHandle,
      worktree: `id:${targetWorktreeId}`,
      agent: 'codex',
      timeoutMs: 30_000
    })
    expect(started.result.state).toBe('ready')
    const workerHandle = started.result.effects.find(
      (effect) => effect.kind === 'terminal' && effect.role === 'agent'
    )?.id
    if (!workerHandle) {
      throw new Error('worker-start did not return its agent terminal')
    }
    let worker: RuntimeTerminalSummary | undefined
    await expect
      .poll(
        async () => {
          worker = (await listRuntimeTerminals(client)).find(
            (terminal) => terminal.handle === workerHandle
          )
          return worker?.ptyId ?? null
        },
        { timeout: 30_000, message: 'background worker never published its PTY identity' }
      )
      .not.toBeNull()
    if (!worker?.ptyId) {
      throw new Error('Background worker did not publish its PTY')
    }
    const workerPtyId = worker.ptyId
    const workerTabId = worker.tabId
    const workerPaneKey = `${worker.tabId}:${worker.leafId}`
    await backgroundMountTab(first.page, targetWorktreeId, workerTabId)
    let dispatchCapability: string | null = null
    await expect
      .poll(() => {
        dispatchCapability = readCompletedWorkerDispatchCapability()
        return dispatchCapability
      })
      .not.toBeNull()
    if (!dispatchCapability) {
      throw new Error('Background worker did not receive its dispatch capability')
    }
    const transcriptPath = seedCurrentCodexTranscript(
      isolatedHome,
      PROVIDER_SESSION_ID,
      targetWorktreePath
    )
    await first.page.evaluate(
      ({
        agentCommand,
        paneKey,
        providerSessionId,
        tabId,
        terminalHandle,
        transcriptPath,
        worktreeId
      }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Renderer store unavailable')
        }
        const metadata = { tabId, worktreeId, terminalHandle }
        const recovery = {
          providerSession: { key: 'session_id' as const, id: providerSessionId, transcriptPath },
          launchConfig: {
            agentCommand,
            agentArgs: '--dangerously-bypass-approvals-and-sandbox',
            agentEnv: {}
          }
        }
        for (const agentState of ['working', 'done'] as const) {
          state.setAgentStatus(
            paneKey,
            { state: agentState, prompt: 'Report completion and stay open', agentType: 'codex' },
            'Settled background worker',
            undefined,
            metadata,
            recovery
          )
        }
      },
      {
        agentCommand: completedWorkerFakeCodexCommand,
        paneKey: workerPaneKey,
        providerSessionId: PROVIDER_SESSION_ID,
        tabId: workerTabId,
        terminalHandle: workerHandle,
        transcriptPath,
        worktreeId: targetWorktreeId
      }
    )
    const completed = await client.call<{ message: { type: string } }>(
      'orchestration.send',
      {
        from: workerHandle,
        subject: 'Completed',
        body: 'The fixture completed and stays open for inspection.',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.result.task.id,
          dispatchId: started.result.dispatchId,
          outcome: 'succeeded'
        })
      },
      { orchestrationCapability: dispatchCapability }
    )
    expect(completed.result.message.type).toBe('worker_done')
    // The settlement sweep stamps the resume fence on the renderer's record before the tab closes.
    await expect
      .poll(
        () =>
          first.page.evaluate(
            (paneKey) =>
              window.__store?.getState().sleepingAgentSessionsByPaneKey[paneKey]
                ?.automaticResumeBlockedBy ?? null,
            workerPaneKey
          ),
        { timeout: 30_000, message: 'settled worker pane was never fenced' }
      )
      .toBe('legacy-orchestration-worker')

    await session.close(firstApp)
    firstApp = null
    await expect
      .poll(() => readPersistedWorkerRecoveryRecord(session.userDataDir, workerPaneKey), {
        message: 'the settled worker record never reached disk carrying its fence'
      })
      .toMatchObject({ automaticResumeBlockedBy: 'legacy-orchestration-worker' })
    expect(readCompletedWorkerLedger().filter((event) => event.event === 'normal-exit')).toEqual([])

    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    // The daemon kept the worker alive across the app restart; the new main process never attached it.
    await expect
      .poll(
        async () =>
          (await listRuntimeTerminals(client)).find((terminal) => terminal.ptyId === workerPtyId)
            ?.connected ?? null,
        { timeout: 60_000, message: 'restarted runtime never rediscovered the worker PTY' }
      )
      .toBe(true)
    expect(
      await second.page.evaluate(
        ({ tabId, worktreeId }) =>
          Boolean(
            window.__store?.getState().tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)
          ),
        { tabId: workerTabId, worktreeId: targetWorktreeId }
      )
    ).toBe(true)

    // The record is the fence's durable home. Deriving it from the renderer's volatile blocked-pane
    // map alone let the first status write after any restart erase it, and worktree activation then
    // relaunched the settled worker with `--resume` over its still-live PTY (#16904 regression).
    await second.page.evaluate(
      ({ paneKey, providerSessionId, tabId, terminalHandle, transcriptPath, worktreeId }) => {
        window.__store?.getState().setAgentStatus(
          paneKey,
          { state: 'done', prompt: 'Report completion and stay open', agentType: 'codex' },
          'Settled background worker',
          undefined,
          { tabId, worktreeId, terminalHandle },
          {
            providerSession: {
              key: 'session_id' as const,
              id: providerSessionId,
              transcriptPath
            }
          }
        )
      },
      {
        paneKey: workerPaneKey,
        providerSessionId: PROVIDER_SESSION_ID,
        tabId: workerTabId,
        terminalHandle: workerHandle,
        transcriptPath,
        worktreeId: targetWorktreeId
      }
    )
    expect(
      await second.page.evaluate(
        (paneKey) =>
          window.__store?.getState().sleepingAgentSessionsByPaneKey[paneKey]
            ?.automaticResumeBlockedBy ?? null,
        workerPaneKey
      ),
      'a status write after restart must not erase the fence'
    ).toBe('legacy-orchestration-worker')

    // A renderer reload starts `automaticResumeBlockedPaneKeys` empty, so main must hand the fenced
    // pane set back on the startup handshake; a once-per-process push never survives the reload.
    await second.page.reload()
    await waitForSessionReady(second.page)
    await expect
      .poll(
        () =>
          second.page.evaluate(
            (paneKey) =>
              window.__store?.getState().automaticResumeBlockedPaneKeys[paneKey] === true,
            workerPaneKey
          ),
        { timeout: 60_000, message: 'the reloaded renderer never re-seeded the resume fence' }
      )
      .toBe(true)
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await session.close(firstApp)
    }
    await session.dispose()
  }
})
