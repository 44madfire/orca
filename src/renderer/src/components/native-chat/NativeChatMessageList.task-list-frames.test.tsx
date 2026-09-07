// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unhandledProviderFrameJournalItem } from '../../../../main/native-chat/agent-session-wire/unhandled-provider-frame'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatMessageList } from './NativeChatMessageList'
import { projectNativeChatTaskListFrames } from './native-chat-task-list-frames'

afterEach(cleanup)

function frame(id: number, status: string, overrides: { kind?: string; truncated?: boolean } = {}) {
  const row = unhandledProviderFrameJournalItem(
    'codex',
    overrides.kind ?? 'notification:turn/plan/updated',
    {
      threadId: 'thread',
      turnId: 'turn',
      explanation: 'Keep verification visible',
      plan: [{ step: 'Verify', status }]
    }
  )
  if (!row?.body.providerFrame) {
    throw new Error('Expected a journalled provider frame')
  }
  row.body.providerFrame.payload.truncated = overrides.truncated ?? false
  const message = projectStructuredItemToNativeChat({
    itemId: `frame-${id}`,
    revision: 1,
    sequence: id,
    observedAt: id,
    body: row.body
  })
  if (!message) {
    throw new Error('Expected a projected message')
  }
  return message
}

function transcript(messages: NativeChatMessage[]) {
  return (
    <NativeChatMessageList
      session={{
        messages,
        status: 'ready',
        sessionId: 'live-codex',
        agent: 'codex',
        hasMore: false,
        loadingEarlier: false,
        loadEarlier: vi.fn(),
        readPhase: 'ready'
      }}
      isWorking={false}
      expandSignal
      fontScale={1}
      showTurnStatus={false}
    />
  )
}

describe('live Codex checklist frames', () => {
  it('renders journalled notifications through checklist diffing and updates on pagination', () => {
    const first = frame(1, 'pending')
    const active = frame(2, 'inProgress')
    const last = frame(3, 'completed')
    const { rerender } = render(transcript([last]))
    expect(screen.getByText('Verify')).toHaveClass('line-through')
    expect(screen.getByText('Keep verification visible')).toBeInTheDocument()
    expect(screen.queryByText('notification:turn/plan/updated')).toBeNull()

    rerender(transcript([first, active, last]))
    expect(screen.getByText('Started Verify')).toBeInTheDocument()
    expect(screen.getByText('Completed Verify')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Full task list' })[1])
    expect(screen.getAllByText('Verify')).toHaveLength(2)
    expect(screen.getByLabelText('1 of 1 tasks completed')).toBeInTheDocument()
    expect(projectNativeChatTaskListFrames([last])[0]).toBe(
      projectNativeChatTaskListFrames([last])[0]
    )
  })

  it('shares the Codex tool-call baseline while keeping Claude lists independent', () => {
    const tool: NativeChatMessage = {
      id: 'tool',
      role: 'assistant',
      timestamp: 1,
      source: 'transcript',
      blocks: [
        {
          type: 'tool-call',
          name: 'update_plan',
          input: { plan: [{ step: 'Verify', status: 'pending' }] }
        }
      ]
    }
    const claude: NativeChatMessage = {
      ...tool,
      id: 'claude',
      timestamp: 2,
      blocks: [
        {
          type: 'tool-call',
          name: 'TodoWrite',
          input: { todos: [{ content: 'Unrelated', status: 'pending' }] }
        }
      ]
    }
    render(transcript([tool, claude, frame(3, 'completed')]))
    expect(screen.getByText('Completed Verify')).toBeInTheDocument()
    expect(screen.queryByText('Removed Unrelated')).toBeNull()
  })

  it('keeps malformed, truncated, other-provider, and plan-document frames unchanged', () => {
    const truncated = frame(1, 'pending', { truncated: true })
    const document = frame(2, 'pending', { kind: 'item:plan' })
    const malformed = frame(3, 'pending')
    const otherProvider = frame(4, 'pending')
    const malformedBlock = malformed.blocks[0]
    const otherBlock = otherProvider.blocks[0]
    if (malformedBlock.type === 'text' && malformedBlock.providerFrame) {
      malformedBlock.providerFrame.payload.head = '{"plan":null}'
    }
    if (otherBlock.type === 'text' && otherBlock.providerFrame) {
      otherBlock.providerFrame.provider = 'claude'
    }
    const messages = [truncated, document, malformed, otherProvider]
    const projected = projectNativeChatTaskListFrames(messages)
    projected.forEach((message, index) => expect(message).toBe(messages[index]))
    render(transcript([truncated]))
    expect(screen.getByText('notification:turn/plan/updated')).toBeInTheDocument()
    expect(screen.queryByText('Tasks')).toBeNull()
  })

  it('does not consume a neighboring tool failure as a notification result', () => {
    const command: NativeChatMessage = {
      id: 'command',
      role: 'assistant',
      timestamp: 2,
      source: 'transcript',
      blocks: [
        { type: 'tool-call', name: 'shell', input: { command: 'verify' }, state: 'failed' },
        { type: 'tool-result', output: 'Verification failed', isError: true }
      ]
    }
    render(transcript([frame(1, 'pending'), command]))
    expect(screen.getByText('Verify')).toBeInTheDocument()
    expect(screen.getByText('Verification failed', { selector: 'pre' })).toHaveClass(
      'text-destructive'
    )
  })
})
