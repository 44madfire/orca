import { useLayoutEffect, useState } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  nativeChatTurnHasResponse,
  reduceNativeChatTurnTiming,
  selectNativeChatTurnStatuses,
  selectPersistedNativeChatTurnStatuses,
  type NativeChatTurnStatus,
  type NativeChatTurnTimingByTurn
} from '../../../../shared/native-chat-turn-status'

export type { NativeChatTurnStatus }

export function useNativeChatTurnStatus({
  messages,
  latestUserIndex,
  isWorking,
  workingStartedAt,
  completedAt
}: {
  messages: readonly NativeChatMessage[]
  latestUserIndex: number
  isWorking: boolean
  workingStartedAt?: number | null
  completedAt?: number | null
}): {
  active: NativeChatTurnStatus | null
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
} {
  const hasCurrentTurnResponse = nativeChatTurnHasResponse(messages, latestUserIndex)
  const latestUserId = latestUserIndex !== -1 ? (messages[latestUserIndex]?.id ?? null) : null
  const activeTurnKey = latestUserId ?? '__unanchored__'
  const [timingByTurn, setTimingByTurn] = useState<NativeChatTurnTimingByTurn>({})

  useLayoutEffect(() => {
    const validTurnKeys = new Set(
      messages.filter((message) => message.role === 'user').map((message) => message.id)
    )
    setTimingByTurn((current) =>
      reduceNativeChatTurnTiming(current, {
        activeTurnKey,
        validTurnKeys,
        isWorking,
        workingStartedAt,
        completedAt,
        now: Date.now()
      })
    )
  }, [activeTurnKey, completedAt, isWorking, messages, workingStartedAt])

  return selectPersistedNativeChatTurnStatuses(
    messages,
    activeTurnKey,
    isWorking,
    selectNativeChatTurnStatuses(timingByTurn, {
      activeTurnKey,
      isWorking,
      workingStartedAt,
      hasCurrentTurnResponse
    })
  )
}
