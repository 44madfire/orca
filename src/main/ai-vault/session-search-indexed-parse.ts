import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionSearchIndexSink, SessionSearchIndexUpdate } from './session-search-capture'
import {
  withSessionSearchCapture,
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
  if (!sink.streamingCapture) {
    const captured = await withSessionSearchCapture(parse)
    await sink.apply({
      ...base,
      session: captured.value.session,
      byteOffset: captured.value.byteOffset,
      messages: captured.messages
    })
    return captured.value.value
  }
  const channel = new SessionSearchMessageChannel()
  const parsed = withStreamingSessionSearchCapture(channel, parse)
  const indexing = Promise.resolve(
    sink.apply({ ...base, messages: channel, result: parsed })
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
  }
}
