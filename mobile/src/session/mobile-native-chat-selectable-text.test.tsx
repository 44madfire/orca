import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'

vi.mock('react-native', () => ({
  Animated: {
    Text: 'AnimatedText',
    Value: class {
      constructor(public value: number) {}
    },
    loop: () => ({ start: () => {}, stop: () => {} }),
    sequence: () => ({}),
    timing: () => ({})
  },
  Image: 'Image',
  Linking: { openURL: () => Promise.resolve() },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronDown: 'ChevronDown',
  Copy: 'Copy',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench'
}))

vi.mock('../components/pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))

type TestNode = {
  type: string
  props: Record<string, unknown>
  children: (TestNode | string)[] | null
}

function flattenText(node: TestNode | string): string {
  if (typeof node === 'string') {
    return node
  }
  return (node.children ?? []).map(flattenText).join('')
}

function outermostTextNodes(
  node: TestNode | string,
  insideText = false
): { text: string; selectable: boolean }[] {
  if (typeof node === 'string') {
    return []
  }
  if (node.type === 'Text' && !insideText) {
    return [{ text: flattenText(node), selectable: node.props.selectable === true }]
  }
  return (node.children ?? []).flatMap((child) =>
    outermostTextNodes(child, insideText || node.type === 'Text')
  )
}

function renderMessage(message: NativeChatMessage, toolsExpanded = false): TestNode[] {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(MobileNativeChatMessage, { message, toolsExpanded }))
  })
  const tree = renderer!.toJSON()
  act(() => renderer!.unmount())
  return (Array.isArray(tree) ? tree : [tree]) as unknown as TestNode[]
}

function selectableFor(trees: TestNode[], needle: string): boolean {
  const match = trees
    .flatMap((tree) => outermostTextNodes(tree))
    .find((entry) => entry.text.includes(needle))
  if (!match) {
    throw new Error(`no Text rendered "${needle}"`)
  }
  return match.selectable
}

function message(overrides: Partial<NativeChatMessage>): NativeChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    blocks: [],
    timestamp: 0,
    source: 'transcript',
    ...overrides
  } as NativeChatMessage
}

describe('mobile native chat text selection', () => {
  afterEach(() => vi.clearAllMocks())

  it('makes a message the user sent selectable', () => {
    const trees = renderMessage(
      message({ role: 'user', blocks: [{ type: 'text', text: 'Prompt I typed' }] })
    )
    expect(selectableFor(trees, 'Prompt I typed')).toBe(true)
  })

  it('makes agent prose selectable', () => {
    const trees = renderMessage(message({ blocks: [{ type: 'text', text: 'Agent reply prose' }] }))
    expect(selectableFor(trees, 'Agent reply prose')).toBe(true)
  })

  // A host path the device cannot load falls back to text; that text names the
  // file, which is the part worth copying.
  it('makes the unloadable image placeholder selectable', () => {
    const trees = renderMessage(
      message({ role: 'user', blocks: [{ type: 'image-ref', path: '/host/only/shot.png' }] })
    )
    expect(selectableFor(trees, 'shot.png')).toBe(true)
  })

  it('makes tool result output selectable', () => {
    const trees = renderMessage(
      message({
        blocks: [
          { type: 'tool-call', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool-result', output: 'result output line' }
        ]
      }),
      true
    )
    expect(selectableFor(trees, 'result output line')).toBe(true)
  })

  it('makes diff rows selectable', () => {
    const trees = renderMessage(
      message({
        blocks: [
          {
            type: 'tool-call',
            name: 'Edit',
            input: {
              file_path: '/repo/file.ts',
              old_string: 'const before = 1',
              new_string: 'const after = 2'
            }
          }
        ]
      }),
      true
    )
    expect(selectableFor(trees, 'const after = 2')).toBe(true)
  })
})
