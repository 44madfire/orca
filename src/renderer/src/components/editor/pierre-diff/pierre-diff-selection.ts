import type { IRange } from 'monaco-editor'

function selectionBoundary(node: Node, offset: number): { line: number; column: number } | null {
  const element = node instanceof Element ? node : node.parentElement
  const row = element?.closest('[data-line]')
  const line = Number(row?.getAttribute('data-line'))
  if (!row || !Number.isInteger(line) || line < 1) {
    return null
  }
  const prefix = document.createRange()
  prefix.selectNodeContents(row)
  prefix.setEnd(node, offset)
  return { line, column: prefix.toString().length + 1 }
}

// DOM ranges are ordered even when the user drags backwards.
export function getPierreSelectionRange(selection: Selection | null): IRange | null {
  if (!selection?.rangeCount) {
    return null
  }
  const range = selection.getRangeAt(0)
  const start = selectionBoundary(range.startContainer, range.startOffset)
  const end = selectionBoundary(range.endContainer, range.endOffset)
  if (!start || !end) {
    return null
  }
  return {
    startLineNumber: start.line,
    startColumn: start.column,
    endLineNumber: end.line,
    endColumn: end.column
  }
}
