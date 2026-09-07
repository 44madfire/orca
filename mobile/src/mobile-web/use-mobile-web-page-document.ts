import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { MobileWebHealthDeadline } from './mobile-web-health-deadline'

// In-place reloads must retire page authority even when the native view and session survive.
export function useMobileWebPageDocument({
  sessionId,
  viewEpoch,
  healthDeadlineRef
}: {
  sessionId: string | undefined
  viewEpoch: number
  healthDeadlineRef: MutableRefObject<MobileWebHealthDeadline>
}): {
  epoch: number
  initializedSessionRef: MutableRefObject<string | undefined>
  readySessionId: string | undefined
  setReadySessionId: (sessionId: string | undefined) => void
  onLoadStart: () => void
  onLoaded: () => void
} {
  const initializedSessionRef = useRef<string | undefined>(undefined)
  const loadedRef = useRef(false)
  const [epoch, setEpoch] = useState(0)
  const [readySessionId, setReadySessionId] = useState<string>()

  const resetDocument = useCallback(() => {
    initializedSessionRef.current = undefined
    loadedRef.current = false
    setReadySessionId(undefined)
    healthDeadlineRef.current.clear()
  }, [healthDeadlineRef])

  useEffect(() => {
    resetDocument()
    return () => healthDeadlineRef.current.clear()
  }, [healthDeadlineRef, resetDocument, sessionId, viewEpoch])

  const onLoadStart = useCallback(() => {
    // Duplicate loading notifications do not represent another document.
    if (!loadedRef.current) {
      return
    }
    // Reset before loaded can arrive in the same batch, rather than in the epoch's effect.
    resetDocument()
    setEpoch((current) => current + 1)
  }, [resetDocument])

  const onLoaded = useCallback(() => {
    loadedRef.current = true
  }, [])

  return {
    epoch,
    initializedSessionRef,
    readySessionId,
    setReadySessionId,
    onLoadStart,
    onLoaded
  }
}
