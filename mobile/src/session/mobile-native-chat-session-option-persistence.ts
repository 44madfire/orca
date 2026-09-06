import type { AgentType } from '../../../src/shared/agent-status-types'
import { applyNativeChatSessionOptionPicks } from '../../../src/shared/native-chat-session-option-defaults'
import type { PersistedNativeChatSessionOptions } from '../../../src/shared/native-chat-session-options'
import type { StructuredSessionOptionPick } from '../../../src/shared/structured-agent-session-options'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'

/**
 * Why serialized: the host shallow-merges `settings.update`, so the whole
 * `nativeChatSessionOptions` object goes over the wire and two picks racing on it would
 * drop the earlier one. Read-modify-write per pick batch, one batch at a time.
 */
let write: Promise<unknown> = Promise.resolve()

async function readPersistedSessionOptions(
  client: RpcClient
): Promise<PersistedNativeChatSessionOptions | undefined> {
  const response = await client.sendRequest('settings.get')
  if (!response.ok) {
    return undefined
  }
  const result = (response as RpcSuccess).result as {
    settings?: { nativeChatSessionOptions?: PersistedNativeChatSessionOptions }
  } | null
  return result?.settings?.nativeChatSessionOptions
}

/** The host owns the record a later launch seeds from, so a phone-side pick writes there
 *  rather than to any client-local store. Best-effort: a failed write only costs the
 *  next session its remembered start. */
export function persistMobileStructuredOptionPicks(args: {
  client: RpcClient | null
  agent: AgentType
  picks: readonly StructuredSessionOptionPick[]
}): Promise<void> {
  const { agent, client, picks } = args
  if (!client || picks.length === 0) {
    return Promise.resolve()
  }
  write = write
    .catch(() => undefined)
    .then(async () => {
      const persisted = await readPersistedSessionOptions(client)
      await client.sendRequest('settings.update', {
        nativeChatSessionOptions: applyNativeChatSessionOptionPicks({ persisted, agent, picks })
      })
    })
    .catch(() => undefined)
  return write.then(() => undefined)
}
