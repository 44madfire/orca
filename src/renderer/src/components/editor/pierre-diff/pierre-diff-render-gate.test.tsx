// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import DiffViewer from '../DiffViewer'
import { buildPierreFileDiff } from './pierre-diff-metadata'
import { getLargeDiffRenderLimit } from '../large-diff-render-limit'

vi.mock('@/store', () => ({ useAppStore: (selector: (s: object) => unknown) => selector({}) }))
vi.mock('../editor-shortcuts', () => ({ installEditorSaveShortcut: () => () => {} }))
vi.mock('../diff-navigation-context', () => ({
  useDiffNavigatorRegistration: () => ({
    registerDiffNavigator: () => {},
    unregisterDiffNavigator: () => {}
  })
}))
vi.mock('./pierre-diff-metadata', () => ({
  buildPierreFileDiff: vi.fn(() => {
    throw new Error('limited content reached parser')
  })
}))
vi.mock('./PierreDiffProviders', () => ({ PierreDiffProviders: () => null }))
vi.mock('./PierreDiffSurface', () => ({ PierreDiffSurface: () => null }))
vi.mock('../LargeDiffFallback', () => ({ LargeDiffFallback: () => <div>Large diff fallback</div> }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('renders a large-file fallback without synchronously computing the diff', () => {
  const modifiedContent = 'x'.repeat(6_000_001)
  render(
    <DiffViewer
      modelKey="large"
      originalContent=""
      modifiedContent={modifiedContent}
      relativePath="large.txt"
      filePath="large.txt"
      language="plaintext"
      sideBySide={false}
    />
  )
  expect(screen.getByText('Large diff fallback')).toBeTruthy()
  expect(buildPierreFileDiff).not.toHaveBeenCalled()
})

it('honors a host-provided render limit when the RPC bodies are omitted', () => {
  render(
    <DiffViewer
      modelKey="remote"
      originalContent=""
      modifiedContent=""
      relativePath="large.txt"
      filePath="large.txt"
      language="plaintext"
      sideBySide={false}
      largeDiffRenderLimit={getLargeDiffRenderLimit({
        originalContent: '',
        modifiedContent: 'x'.repeat(6_000_001)
      })}
    />
  )
  expect(screen.getByText('Large diff fallback')).toBeTruthy()
  expect(buildPierreFileDiff).not.toHaveBeenCalled()
})
