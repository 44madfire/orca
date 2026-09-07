// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { getPierreSelectionRange } from './pierre-diff-selection'
import { formatCopiedSelectionWithContext } from '../selection-copy'

function selection(endOffset: number): Selection {
  const root = document.createElement('div')
  root.innerHTML =
    '<div data-line="10"><span>first</span> line</div><div data-line="11"><span>last</span> line</div>'
  const range = document.createRange()
  range.setStart(root.children[0].firstChild!.firstChild!, 1)
  range.setEnd(root.children[1].firstChild!.firstChild!, endOffset)
  return { rangeCount: 1, getRangeAt: () => range } as unknown as Selection
}

describe('Pierre contextual copy boundaries', () => {
  it('includes a partially selected final line in the label', () => {
    const range = getPierreSelectionRange(selection(2))!
    expect(range).toEqual({ startLineNumber: 10, startColumn: 2, endLineNumber: 11, endColumn: 3 })
    expect(
      formatCopiedSelectionWithContext({
        relativePath: 'file.ts',
        language: 'typescript',
        selectedText: 'irst line\nla',
        selection: range
      })
    ).toContain('Lines: 10-11')
  })

  it('excludes a final line selected only at its first column', () => {
    const range = getPierreSelectionRange(selection(0))!
    expect(
      formatCopiedSelectionWithContext({
        relativePath: 'file.ts',
        language: 'typescript',
        selectedText: 'irst line\n',
        selection: range
      })
    ).toContain('Line: 10\n')
  })

  it('ignores absent selections', () => {
    expect(getPierreSelectionRange(null)).toBeNull()
  })
})
