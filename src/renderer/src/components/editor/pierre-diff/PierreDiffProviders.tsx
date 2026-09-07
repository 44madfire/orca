import { useCallback, useEffect, useState, type RefObject } from 'react'
import { Virtualizer } from '@pierre/diffs'
import { EditProvider, WorkerPoolContext, VirtualizerContext } from '@pierre/diffs/react'
import type { EditorFactory } from '@pierre/diffs/react'
import { Editor } from '@pierre/diffs/edit'
import type { PierreDiffAnnotationData } from './pierre-diff-comment-annotations'
import { createDiffHighlightPool } from './pierre-diff-highlight-pool'

/**
 * Shares one Shiki worker pool and one editor factory across every mounted diff
 * surface.
 *
 * Requires @pierre/diffs >= 1.4.0. In 1.3.6 nothing rendered under React
 * StrictMode: the shadow DOM was never committed on the remount, so every diff
 * was blank in dev. Do not downgrade below 1.4.
 */
export function PierreDiffProviders({
  children,
  scrollContainerRef
}: {
  children: React.ReactNode
  scrollContainerRef: RefObject<HTMLElement | null>
}): React.JSX.Element {
  // Why: lazy initializer keeps worker startup off app launch until a diff opens.
  const [pool] = useState(createDiffHighlightPool)
  const [virtualizer] = useState(() => new Virtualizer())
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }
    virtualizer.setup(container, container.lastElementChild ?? undefined)
    return () => virtualizer.cleanUp()
  }, [scrollContainerRef, virtualizer])
  const createEditor = useCallback<EditorFactory<PierreDiffAnnotationData, undefined>>(
    (editorType, options, editStateKey) => new Editor(editorType, options, editStateKey),
    []
  )

  return (
    <WorkerPoolContext.Provider value={pool}>
      <VirtualizerContext.Provider value={virtualizer}>
        <EditProvider<PierreDiffAnnotationData, undefined> createEditor={createEditor}>
          {children}
        </EditProvider>
      </VirtualizerContext.Provider>
    </WorkerPoolContext.Provider>
  )
}
