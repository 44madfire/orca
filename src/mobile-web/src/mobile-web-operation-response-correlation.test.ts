import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgeCapability,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}
const REQUEST_ID = 'R'.repeat(22)
const WORKSPACE_ID = 'workspace-1'
const OTHER_WORKSPACE_ID = 'workspace-2'
const TARGET_ID = 'task-target-1'
const OTHER_TARGET_ID = 'task-target-2'

type CorrelationCase = {
  name: string
  capability: MobileWebBridgeCapability
  operation: string
  invoke: (client: MobileWebBridgeClient) => Promise<unknown>
  result: unknown
}

const CORRELATION_CASES: CorrelationCase[] = [
  {
    name: 'Source Control history request limit',
    capability: 'sourceControl',
    operation: 'history',
    invoke: (client) => client.sourceControlHistory({ workspaceId: WORKSPACE_ID, limit: 1 }),
    result: {
      workspaceId: WORKSPACE_ID,
      items: [],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 2
    }
  },
  {
    name: 'session snapshot workspace',
    capability: 'workspace',
    operation: 'hostRequest',
    invoke: (client) => client.sessionSnapshot({ workspaceId: WORKSPACE_ID }),
    result: sessionSnapshot({ workspaceId: OTHER_WORKSPACE_ID })
  },
  {
    name: 'session activation tab',
    capability: 'workspace',
    operation: 'hostRequest',
    invoke: (client) => client.sessionActivate({ workspaceId: WORKSPACE_ID, tabId: 'tab-1' }),
    result: sessionSnapshot({ activeTabId: 'tab-2', activeTabType: 'terminal' })
  },
  {
    name: 'closed session tab',
    capability: 'workspace',
    operation: 'hostRequest',
    invoke: (client) => client.sessionClose({ workspaceId: WORKSPACE_ID, tabId: 'tab-1' }),
    result: {
      workspaceId: WORKSPACE_ID,
      tabId: 'tab-2',
      outcome: 'closed',
      refusalReason: null
    }
  },
  {
    name: 'task project host',
    capability: 'task',
    operation: 'listProjects',
    invoke: (client) => client.task.listProjects({ host: 'github.com' }),
    result: {
      projects: [
        {
          id: 'project-1',
          host: 'enterprise.example',
          owner: 'orca',
          ownerType: 'organization',
          number: 1,
          title: 'Roadmap',
          url: 'https://enterprise.example/orca/projects/1',
          source: 'viewer'
        }
      ],
      partialFailures: []
    }
  },
  {
    name: 'task project resolution host',
    capability: 'task',
    operation: 'resolveProjectRef',
    invoke: (client) => client.task.resolveProjectRef({ input: 'orca/1', host: 'github.com' }),
    result: {
      owner: 'orca',
      ownerType: 'organization',
      number: 1,
      title: 'Roadmap',
      host: 'enterprise.example'
    }
  },
  {
    name: 'Linear task target',
    capability: 'task',
    operation: 'loadLinearIssue',
    invoke: (client) => client.task.loadLinearIssue({ targetId: TARGET_ID }),
    result: { issue: linearIssue(OTHER_TARGET_ID) }
  },
  {
    name: 'Linear task detail target',
    capability: 'task',
    operation: 'loadLinearDetail',
    invoke: (client) => client.task.loadLinearDetail({ targetId: TARGET_ID }),
    result: { issue: linearIssue(OTHER_TARGET_ID), comments: [] }
  },
  {
    name: 'Linear task list request limit',
    capability: 'task',
    operation: 'listLinear',
    invoke: (client) => client.task.listLinear({ filter: 'all', limit: 1 }),
    result: {
      items: [
        linearIssue('task-target-1'),
        { ...linearIssue('task-target-2'), id: 'linear-issue-2', identifier: 'ORCA-2' }
      ]
    }
  },
  {
    name: 'account reset scope',
    capability: 'account',
    operation: 'consumeResetCredit',
    invoke: (client) =>
      client.account.consumeResetCredit({
        expectedScope: resetScope({ accountId: 'account-1' })
      }),
    result: {
      outcome: 'nothingToReset',
      scope: resetScope({ accountId: 'account-2' }),
      snapshot: accountSnapshot(),
      attemptJournalRetained: false
    }
  }
]

describe('mobile web operation response correlation', () => {
  for (const testCase of CORRELATION_CASES) {
    it(`rejects a schema-valid mismatched ${testCase.name}`, async () => {
      const harness = createHarness(testCase.capability, testCase.operation)
      const request = testCase.invoke(harness.client)
      harness.client.receive(response(testCase.result))

      await expect(request).rejects.toMatchObject({
        code: 'invalid_message',
        retryable: false
      })
    })
  }
})

function createHarness(capability: MobileWebBridgeCapability, operation: string) {
  const messages: MobileWebBridgePageMessage[] = []
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: [
      {
        capability,
        operation,
        limits: {
          maxRequestBytes: 192 * 1024,
          maxResponseBytes: 640 * 1024,
          maxConcurrent: 1,
          rateCapacity: 4,
          rateRefillPerSecond: 1
        }
      }
    ],
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => REQUEST_ID
  })
  return { client, messages }
}

function response(payload: unknown): MobileWebBridgeShellMessage {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'response',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    requestId: REQUEST_ID,
    status: 'success',
    payload
  }
}

function sessionSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    truncated: false,
    ...overrides
  }
}

function linearIssue(targetId: string) {
  return {
    id: 'linear-issue-1',
    targetId,
    identifier: 'ORCA-1',
    title: 'Issue',
    url: 'https://linear.app/orca/issue/ORCA-1',
    state: { name: 'Open', type: 'started', color: '#888888' },
    team: { id: 'team-1', name: 'Orca', key: 'ORCA' },
    labels: [],
    priority: 1,
    updatedAt: '2026-07-28T00:00:00Z'
  }
}

function resetScope(overrides: Record<string, unknown> = {}) {
  return {
    target: { runtime: 'host' as const, wslDistro: null },
    accountId: 'account-1',
    accountRevision: 1,
    offerRevision: 'v1:offer',
    ...overrides
  }
}

function accountSnapshot() {
  const target = { runtime: 'host' as const, wslDistro: null }
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: null,
      codex: null,
      claudeTarget: target,
      codexTarget: target,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
}
