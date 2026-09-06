import { useLayoutEffect, useState, type ReactNode } from 'react'

export function DeferredBrowserContent({
  mountEligible,
  children
}: {
  mountEligible: boolean
  children: ReactNode
}): React.JSX.Element | null {
  const [hasCommittedMount, setHasCommittedMount] = useState(false)
  // Discarded renders must not retain a guest; committed content stays mounted until closed.
  useLayoutEffect(() => {
    if (mountEligible && !hasCommittedMount) {
      setHasCommittedMount(true)
    }
  }, [hasCommittedMount, mountEligible])
  return mountEligible || hasCommittedMount ? <>{children}</> : null
}
