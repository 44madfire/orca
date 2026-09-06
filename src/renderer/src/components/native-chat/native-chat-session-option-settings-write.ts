import type { PersistedNativeChatSessionOptions } from '../../../../shared/native-chat-session-options'
import { useAppStore } from '../../store'

/**
 * Why: every nativeChatSessionOptions writer — a pick from any pane, a probe
 * retirement — serializes on this one chain and re-reads live settings at apply
 * time. updateSettings shallow-merges the whole object, so an interleaved write
 * from a snapshot captured earlier would silently clobber a concurrent pick.
 * The update runs against the settled base and may return null to skip writing.
 *
 * Lives outside the PTY hook because the structured surface writes the same key
 * from a different pane, and two chains would not order against each other.
 */
let settingsWrite: Promise<unknown> = Promise.resolve()

export function enqueueSessionOptionSettingsWrite(
  update: (
    base: PersistedNativeChatSessionOptions | undefined
  ) => PersistedNativeChatSessionOptions | null
): Promise<void> {
  const write = settingsWrite
    .catch(() => undefined)
    .then(() => {
      const next = update(useAppStore.getState().settings?.nativeChatSessionOptions)
      return next
        ? useAppStore.getState().updateSettings({ nativeChatSessionOptions: next })
        : undefined
    })
  settingsWrite = write
  return write.then(() => undefined)
}
