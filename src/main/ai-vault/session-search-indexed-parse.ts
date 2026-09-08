import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionSearchIndexSink, SessionSearchIndexUpdate } from './session-search-capture'
import {
  getSessionSearchCaptureSignal,
  withStreamingSessionSearchCapture
} from './session-search-capture'
import { SessionSearchMessageChannel } from './session-search-message-channel'

type Parsed<T> = { value: T; session: AiVaultSession | null; byteOffset: number }

/** Final metadata and cursor become visible only after the producer closes the stream. */
export async function captureIndexedSessionParse<T>(
  sink: SessionSearchIndexSink,
  base: Pick<SessionSearchIndexUpdate, 'candidate' | 'mode' | 'previousByteOffset'>,
  parse: () => Promise<Parsed<T>>
): Promise<T> {
  const signal = getSessionSearchCaptureSignal()
  const read = async (): Promise<Parsed<T>> => {
    throwIfAiVaultScanCancelled(signal)
    const result = await parse()
    throwIfAiVaultScanCancelled(signal)
    return result
  }
  const channel = new SessionSearchMessageChannel()
  const stop = (): void => channel.stop()
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) {
    stop()
  }
  const parsed = withStreamingSessionSearchCapture(channel, read)
  const indexing = Promise.resolve(
    sink.apply({ ...base, signal, messages: channel, result: parsed })
  ).finally(() => channel.stop())
  void indexing.catch(() => undefined)
  try {
    const completed = await parsed
    channel.close()
    await indexing
    return completed.value
  } catch (error) {
    channel.close(error)
    await indexing.catch(() => undefined)
    throw error
  } finally {
    signal?.removeEventListener('abort', stop)
  }
}
