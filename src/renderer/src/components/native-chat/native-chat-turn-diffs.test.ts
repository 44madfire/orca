import { describe, expect, it } from 'vitest'
import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import { foldToolMessages } from './native-chat-tool-fold'
import { buildEditCards } from './native-chat-edit-cards'
import { nativeChatTurnDiffs } from './native-chat-turn-diffs'

function diff(id: string, path: string, patch = '@@ -1 +1 @@\n-old\n+new'): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [
      { type: 'tool-call', name: 'Diff', input: { path } },
      { type: 'tool-result', output: patch }
    ]
  }
}

describe('turn diff rollups', () => {
  it('counts unique files, sums recorded edits, and targets the last existing card', () => {
    const messages = foldToolMessages([
      diff('first', 'a.ts'),
      diff('second', 'a.ts'),
      diff('third', 'b.ts')
    ])
    const turn = nativeChatTurnDiffs(messages, ['turn']).get('turn')!
    expect(turn.files).toHaveLength(2)
    expect(turn).toMatchObject({ added: 3, removed: 3, truncated: false })
    expect(turn.files[0]).toMatchObject({
      path: 'a.ts',
      added: 2,
      target: { messageId: 'first', editKey: 'Diff:1', fileIndex: 0 }
    })
  })

  it('folds edits through chained renames into the destination and counts a deletion once', () => {
    const messages = [
      diff('edit', 'old.ts'),
      diff(
        'rename',
        'old.ts',
        'diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts'
      ),
      diff(
        'rename-again',
        'new.ts',
        'diff --git a/new.ts b/final.ts\nrename from new.ts\nrename to final.ts'
      ),
      diff(
        'delete',
        'gone.ts',
        'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone'
      )
    ]
    const turn = nativeChatTurnDiffs(
      messages,
      messages.map(() => 'turn')
    ).get('turn')!
    expect(turn.files.map((file) => file.path)).toEqual(['final.ts', 'gone.ts'])
    expect(turn).toMatchObject({ added: 1, removed: 2 })
    expect(turn.files[0]?.target.messageId).toBe('rename-again')
  })

  it('keeps turns separate and excludes history without a known boundary', () => {
    const result = nativeChatTurnDiffs(
      [diff('orphan', 'orphan.ts'), diff('a', 'a.ts'), diff('b', 'a.ts')],
      [undefined, 'one', 'two']
    )
    expect([...result.keys()]).toEqual(['one', 'two'])
    expect(result.get('one')?.added).toBe(1)
    expect(result.get('two')?.files).toHaveLength(1)
  })

  it('uses the existing multi-file parser and preserves truncated counts', () => {
    const patch =
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n… (9999 bytes)'
    const turn = nativeChatTurnDiffs([diff('multi', 'changes', patch)], ['turn']).get('turn')!
    expect(turn.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts'])
    expect(turn).toMatchObject({ added: 2, removed: 2, truncated: true })
    expect(turn.files[1]?.target.fileIndex).toBe(1)
  })

  it('does not count generic output, failed edits, running edits, or unparseable patches', () => {
    const messages = ['shell', 'Edit'].map((name) => ({
      ...diff(name, 'x'),
      blocks: [
        { type: 'tool-call', name, input: { path: 'x' } },
        { type: 'tool-result', output: '@@ -1 +1 @@\n-old\n+new' }
      ] as NativeChatBlock[]
    }))
    messages.push(diff('invalid', 'x', 'no patch'))
    for (const state of ['running', 'failed'] as const) {
      const message = diff(state, 'x')
      message.blocks[0] = { type: 'tool-call', name: 'Diff', input: { path: 'x' }, state }
      messages.push(message)
    }
    expect(
      nativeChatTurnDiffs(
        messages,
        messages.map(() => 'turn')
      ).size
    ).toBe(0)
  })

  it('reuses parsed file identity across rollup/card consumers and refreshes new results', () => {
    const message = diff('a', 'a.ts')
    const first = [...buildEditCards(message.blocks, true).editCards.values()][0]!.files
    expect([...buildEditCards([...message.blocks]).editCards.values()][0]!.files).toBe(first)
    message.blocks = [
      message.blocks[0]!,
      { type: 'tool-result', output: '@@ -0,0 +1,2 @@\n+one\n+two' }
    ]
    const updated = [...buildEditCards(message.blocks).editCards.values()][0]!.files
    expect(updated).not.toBe(first)
    expect(updated[0]?.added).toBe(2)
  })
})
