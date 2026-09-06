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
  // The staging row is hidden; the producer replaces this placeholder before closing the channel.
  const update: SessionSearchIndexUpdate = {
    ...base,
    messages: channel,
    byteOffset: 0,
    session: {
      id: 'pending',
      executionHostId: 'local',
      agent: base.candidate.agent,
      sessionId: 'pending',
      title: '',
      cwd: null,
      branch: null,
      model: null,
      filePath: base.candidate.file.path,
      codexHome: base.candidate.codexHome,
      createdAt: null,
      updatedAt: null,
      modifiedAt: base.candidate.file.modifiedAt,
      messageCount: 0,
      totalTokens: 0,
      previewMessages: [],
      queuedMessageCount: 0,
      subagentTranscriptCount: 0,
      resumeCommand: '',
      subagent: null
    }
  }
  const indexing = Promise.resolve(sink.apply(update)).finally(() => channel.stop())
  void indexing.catch(() => undefined)
  try {
    const parsed = await withStreamingSessionSearchCapture(channel, parse)
    update.session = parsed.session
    update.byteOffset = parsed.byteOffset
    channel.close()
    await indexing
    return parsed.value
  } catch (error) {
    channel.close(error)
    await indexing.catch(() => undefined)
    throw error
  }
}
