import {
  detectAgentStatusFromTitle,
  isShellProcess,
  type AgentStatus
} from '../../shared/agent-detection'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { RuntimeTerminalAgentStatus } from '../../shared/runtime-types'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  terminalTitleBlocksExplicitAgentStatus,
  getLatestAgentCandidateTitleInfo
} from './runtime-worktree-status-projection'
import { selectTerminalAgentStatusEvidence } from './runtime-terminal-agent-status-evidence'
import { getTerminalState } from './terminal-wait-results'
import { buildTerminalWaitText } from './terminal-wait-tail-state'

export type RuntimeTerminalAgentStatusSnapshot = {
  waitText: string
  waitBlockedAt: number | null
  title: string | null
  titleStatus: AgentStatus | null
  titleStatusIsLive: boolean
  /** Local receipt time, absent when the selected title has no matching OSC observation. */
  titleUpdatedAt?: number | null
}

type Dependencies = {
  getController(): RuntimePtyController | null
  getLivePty(handle: string): { pty: RuntimePtyWorktreeRecord } | null
  getLiveLeaf(handle: string): { leaf: RuntimeLeafRecord }
  getPrimaryLeaf(ptyId: string): RuntimeLeafRecord | null
  getTabTitle(tabId: string): string | null
  getExplicitStatus(
    handle: string,
    ptyId: string
  ): {
    status: NonNullable<RuntimeTerminalAgentStatus['status']>
    updatedAt: number
    stateStartedAt?: number | null
  } | null
  getLifecycleStatus(
    ptyId: string
  ): { status: AgentStatus | null; updatedAt: number } | null | undefined
  getLifecycleGeneration?(ptyId: string): number
  isRunning(handle: string): Promise<boolean>
}

export class RuntimeTerminalAgentStatusQuery {
  private readonly inFlight = new Map<
    string,
    { ptyId: string; generation: number | undefined; request: Promise<RuntimeTerminalAgentStatus> }
  >()

  constructor(private readonly deps: Dependencies) {}

  async getStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    const ptyId = this.getPtyId(handle)
    const generation = this.deps.getLifecycleGeneration?.(ptyId)
    const existing = this.inFlight.get(handle)
    if (existing?.ptyId === ptyId && existing.generation === generation) {
      return existing.request
    }
    const request = this.readStatus(handle)
    this.inFlight.set(handle, { ptyId, generation, request })
    try {
      return await request
    } finally {
      if (this.inFlight.get(handle)?.request === request) {
        this.inFlight.delete(handle)
      }
    }
  }

  private async readStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    const ptyId = this.getPtyId(handle)
    const generation = this.deps.getLifecycleGeneration?.(ptyId)
    const terminal = this.getSnapshot(handle, ptyId)
    const explicitStatus = this.deps.getExplicitStatus(handle, ptyId)
    const lifecycle = this.deps.getLifecycleStatus(ptyId)
    const evidence = selectTerminalAgentStatusEvidence(terminal, explicitStatus, lifecycle)
    let isRunningAgent = true
    if (evidence.corroboration === 'shell') {
      isRunningAgent =
        !terminalTitleBlocksExplicitAgentStatus(terminal.title) &&
        !(await this.terminalHasShellForegroundProcess(handle, ptyId))
    } else if (evidence.corroboration === 'agent') {
      isRunningAgent = await this.deps.isRunning(handle)
    }
    this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    if (this.deps.getLifecycleGeneration?.(ptyId) !== generation) {
      throw new Error('terminal_handle_stale')
    }
    return { handle, isRunningAgent, status: isRunningAgent ? evidence.status : null }
  }

  getPtyId(handle: string): string {
    const pty = this.deps.getLivePty(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_gone')
      }
      return pty.pty.ptyId
    }
    const { leaf } = this.deps.getLiveLeaf(handle)
    if (getTerminalState(leaf) !== 'running') {
      throw new Error('terminal_exited')
    }
    if (!leaf.ptyId) {
      throw new Error('terminal_gone')
    }
    return leaf.ptyId
  }

  private assertTerminalAgentStatusPtyBinding(handle: string, expectedPtyId: string): void {
    if (this.getPtyId(handle) === expectedPtyId) {
      return
    }
    // Why: delayed process evidence belongs only to the PTY that started the
    // read, while callers still rely on the established stale-handle contract.
    throw new Error('terminal_handle_stale')
  }

  getSnapshot(handle: string, expectedPtyId: string): RuntimeTerminalAgentStatusSnapshot {
    const pty = this.deps.getLivePty(handle)
    if (pty) {
      if (!pty.pty.connected || pty.pty.ptyId !== expectedPtyId) {
        throw new Error('terminal_not_writable')
      }
      const leaf = this.deps.getPrimaryLeaf(pty.pty.ptyId)
      const leafTitle = leaf
        ? getLatestTitleEvidence(
            { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
            {
              title: leaf.lastOscTitle,
              updatedAt: leaf.lastOscTitleAt,
              receivedAt: leaf.lastOscTitleEpochMs
            }
          )
        : null
      const ptyTitle =
        leafTitle ??
        getLatestTitleEvidence(
          { title: pty.pty.title, updatedAt: pty.pty.titleUpdatedAt },
          {
            title: pty.pty.lastOscTitle,
            updatedAt: pty.pty.lastOscTitleAt,
            receivedAt: pty.pty.lastOscTitleEpochMs
          }
        )
      const waitText = buildTerminalWaitText(
        pty.pty.tailBuffer,
        pty.pty.tailPartialLine,
        pty.pty.preview
      )
      return {
        waitText,
        waitBlockedAt: pty.pty.waitBlockedAt,
        title: ptyTitle?.title ?? null,
        titleUpdatedAt: ptyTitle?.receivedAt ?? null,
        titleStatus: ptyTitle
          ? detectAgentStatusFromTitle(ptyTitle.title)
          : pty.pty.lastAgentStatus,
        titleStatusIsLive: ptyTitle !== null
      }
    }

    const { leaf } = this.deps.getLiveLeaf(handle)
    if (getTerminalState(leaf) !== 'running') {
      throw new Error('terminal_exited')
    }
    if (!leaf.ptyId) {
      throw new Error('terminal_gone')
    }
    if (leaf.ptyId !== expectedPtyId) {
      throw new Error('terminal_not_writable')
    }
    const title = getLatestTitleEvidence(
      { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
      {
        title: leaf.lastOscTitle,
        updatedAt: leaf.lastOscTitleAt,
        receivedAt: leaf.lastOscTitleEpochMs
      },
      { title: this.deps.getTabTitle(leaf.tabId), updatedAt: 0 }
    )
    return {
      waitText: buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview),
      waitBlockedAt: leaf.waitBlockedAt,
      title: title?.title ?? null,
      titleUpdatedAt: title?.receivedAt ?? null,
      titleStatus: title ? detectAgentStatusFromTitle(title.title) : leaf.lastAgentStatus,
      titleStatusIsLive: (title?.updatedAt ?? 0) > 0
    }
  }

  private async terminalHasShellForegroundProcess(handle: string, ptyId: string): Promise<boolean> {
    const controller = this.deps.getController()
    if (!controller) {
      return false
    }
    let foregroundProcess: string | null
    try {
      foregroundProcess = await controller.getForegroundProcess(ptyId)
    } catch {
      this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
      return false
    }
    this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    if (!foregroundProcess || !isShellProcess(foregroundProcess)) {
      return false
    }
    const confirmationController = this.deps.getController()
    if (!confirmationController?.confirmForegroundProcess) {
      return true
    }
    let confirmedProcess: string | null
    try {
      confirmedProcess = await confirmationController.confirmForegroundProcess(ptyId)
    } catch {
      this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
      return true
    }
    this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    // Why: hook identity is generic; strong provider evidence only needs to
    // prove that some recognized agent still owns this exact PTY.
    return recognizeAgentProcess(confirmedProcess) === null
  }
}

function getLatestTitleEvidence(
  ...candidates: {
    title: string | null | undefined
    updatedAt: number | null | undefined
    receivedAt?: number | null
  }[]
): { title: string; updatedAt: number; receivedAt: number | null } | null {
  const latest = getLatestAgentCandidateTitleInfo(...candidates)
  if (!latest) {
    return null
  }
  // Preserve the selected observation's clock; identical title text is not observation identity.
  const selected = candidates.find(
    (candidate) => candidate.title?.trim() && (candidate.updatedAt ?? 0) === latest.updatedAt
  )
  return { ...latest, receivedAt: selected?.receivedAt ?? null }
}
