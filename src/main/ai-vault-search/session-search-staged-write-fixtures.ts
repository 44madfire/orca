import type { SessionSearchIndexUpdate } from '../ai-vault/session-search-capture'

export function stagedWriteUpdate(
  text: string,
  count: number,
  mode: 'append' | 'replace' = 'replace'
): SessionSearchIndexUpdate {
  const at = new Date().toISOString()
  return {
    candidate: {
      agent: 'claude',
      codexHome: null,
      file: { path: 'synthetic-transcript', mtimeMs: Date.now(), modifiedAt: at, sizeBytes: 2 }
    },
    session: {
      id: 'fixture',
      executionHostId: 'local',
      agent: 'claude',
      sessionId: 'fixture',
      title: text,
      cwd: '/fixture',
      branch: null,
      model: null,
      filePath: 'synthetic-transcript',
      codexHome: null,
      createdAt: at,
      updatedAt: at,
      modifiedAt: at,
      messageCount: count,
      totalTokens: 0,
      previewMessages: [],
      queuedMessageCount: 0,
      subagentTranscriptCount: 0,
      resumeCommand: '',
      subagent: null
    },
    mode,
    messages: Array.from({ length: count }, () => ({ role: 'user', text, timestamp: null })),
    previousByteOffset: mode === 'append' ? 1 : 0,
    byteOffset: mode === 'append' ? 2 : 1
  }
}
