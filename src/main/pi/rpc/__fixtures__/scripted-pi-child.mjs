// Deterministic scripted `pi --mode rpc` child for tests (SNC1.9).
//
// Speaks the Pi RPC wire over stdio (LF-only JSONL) with canned vectors so
// driver tests prove create/dispatch/streaming/settlement/close/history
// without a real Pi binary. Behavior is driven by the prompt text and env:
//
// - `get_state` → current session (id/file/model/thinking/counts).
// - `prompt <text>` → `{success:true}`, then streams a scripted turn:
//   `TOOL` in text adds thinking + tool_call + tool_result rows;
//   `THINK` adds thinking rows; `ERROR-TURN` ends the turn with an error;
//   `PROMPT-ME` emits an `extension_ui_request` dialog first and waits for
//   the matching `extension_ui_response` before responding;
//   `SLOW` delays settlement (cancel tests); `HANG` never settles;
//   `EXIT` exits(1) without responding (ambiguous dispatch).
// - `abort` → ends the live turn aborted.
// - `switch_session <path>` → loads the session file (header + entries).
// - `get_entries`/`get_tree` → served from the loaded file + live rows.
// - `get_session_stats` → counts + session file.
// - `get_available_models`/`set_model`, `get_available_thinking_levels`/
//   `set_thinking_level`, `set_auto_compaction` → canned catalog + state.
// - `EXIT-AT-START` env → exit(1) immediately (startup failure).
//
// Live prompt turns append user/assistant entries to memory so resumed
// history converges. Never logs prompt text; diagnostics go to stderr.

import { appendFileSync, readFileSync } from 'node:fs'

const SESSION_FILE = process.env.PI_SCRIPT_SESSION_FILE ?? ''
const EXIT_AT_START = process.env.PI_SCRIPT_EXIT_AT_START === '1'

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

function nowIso() {
  return new Date().toISOString()
}

let seq = 0
const nextId = (prefix) => `${prefix}${(seq += 1)}`

const session = {
  sessionId: process.env.PI_SCRIPT_SESSION_ID ?? 'pi-script-ses-1',
  sessionFile: SESSION_FILE,
  model: { id: 'script-model', provider: 'script-provider' },
  thinkingLevel: 'medium',
  entries: [],
  leafId: null
}

function loadSessionFile(path) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  let header = null
  const entries = []
  for (const line of lines) {
    const record = JSON.parse(line)
    if (record && record.type === 'session') {
      header = record
    } else if (record && typeof record.id === 'string') {
      entries.push(record)
    }
  }
  session.entries = entries
  if (header) {
    if (typeof header.sessionId === 'string' && header.sessionId !== '') {
      session.sessionId = header.sessionId
    }
    if (typeof header.leafId === 'string' && header.leafId !== '') {
      session.leafId = header.leafId
    }
    session.sessionFile = path
  } else if (entries.length > 0) {
    session.leafId = entries.at(-1).id
    session.sessionFile = path
  }
}

function liveAppend(role, text) {
  const id = nextId('live-')
  const parentId = session.leafId ?? (session.entries.length > 0 ? session.entries.at(-1).id : null)
  const entry = {
    type: 'message',
    id,
    parentId,
    timestamp: nowIso(),
    message: { role, content: [{ type: 'text', text }] }
  }
  session.entries.push(entry)
  session.leafId = id
  return entry
}

let liveTurn = null

function appendNonUserHistory() {
  const toolId = nextId('live-')
  const toolParent = session.leafId ?? (session.entries.length > 0 ? session.entries.at(-1).id : null)
  session.entries.push({
    type: 'message',
    id: toolId,
    parentId: toolParent,
    timestamp: nowIso(),
    message: { role: 'toolResult', content: [{ type: 'text', text: 'scripted tool output' }] }
  })
  session.leafId = toolId
  const summaryId = nextId('live-')
  session.entries.push({ type: 'summary', id: summaryId, parentId: toolId, timestamp: nowIso() })
  session.leafId = summaryId
}

function endTurn(op, { aborted = false, error = false } = {}) {
  const stopReason = error ? 'error' : aborted ? 'aborted' : 'stop'
  send({
    type: 'turn_end',
    message: { stopReason },
    ...(error ? { errorMessage: 'scripted turn error' } : {})
  })
  liveTurn = null
  send({ type: 'agent_settled', willRetry: false })
  if (typeof op === 'string' && op.includes('DUP-SETTLE')) {
    send({ type: 'agent_settled', willRetry: false })
  }
  void op
}

function streamTextDeltas(text) {
  const mid = Math.max(1, Math.floor(text.length / 2))
  send({ type: 'message_update', assistantMessageEvent: { kind: 'text_start', contentIndex: 0 } })
  send({
    type: 'message_update',
    assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: text.slice(0, mid) }
  })
  send({
    type: 'message_update',
    assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: text.slice(mid) }
  })
  send({
    type: 'message_update',
    assistantMessageEvent: { kind: 'text_end', contentIndex: 0, content: text }
  })
}

function streamThinking(thinking) {
  send({
    type: 'message_update',
    assistantMessageEvent: { kind: 'thinking_start', contentIndex: 1 }
  })
  send({
    type: 'message_update',
    assistantMessageEvent: { kind: 'thinking_delta', contentIndex: 1, delta: thinking }
  })
  send({
    type: 'message_update',
    assistantMessageEvent: { kind: 'thinking_end', contentIndex: 1, content: thinking }
  })
}

function streamTool(callId, name, output, isError = false) {
  send({
    type: 'message_update',
    assistantMessageEvent: { kind: 'toolcall_start', id: callId, toolName: name }
  })
  send({
    type: 'message_update',
    assistantMessageEvent: {
      kind: 'toolcall_end',
      toolCall: { id: callId, name, arguments: { path: 'scripted' } }
    }
  })
  send({
    type: 'tool_execution_start',
    toolCallId: callId,
    toolName: name,
    args: { path: 'scripted' }
  })
  send({
    type: 'tool_execution_update',
    toolCallId: callId,
    toolName: name,
    partialResult: output.slice(0, 4)
  })
  send({ type: 'tool_execution_end', toolCallId: callId, toolName: name, result: output, isError })
}

const pendingDialogs = new Map()

function handleCommand(cmd) {
  const { type, id } = cmd
  const respond = (success, data, error) => {
    const record = { type: 'response', command: type, success }
    if (id !== undefined) {
      record.id = id
    }
    if (success) {
      if (data !== undefined) {
        record.data = data
      }
    } else {
      record.error = error ?? 'scripted rejection'
    }
    send(record)
  }
  switch (type) {
    case 'get_state':
      respond(true, {
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        model: session.model,
        thinkingLevel: session.thinkingLevel,
        isStreaming: liveTurn !== null,
        isCompacting: false,
        messageCount: session.entries.length
      })
      return
    case 'get_session_stats':
      respond(true, {
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        userMessages: session.entries.filter((e) => e.message?.role === 'user').length,
        assistantMessages: session.entries.filter((e) => e.message?.role === 'assistant').length,
        totalMessages: session.entries.length
      })
      return
    case 'get_entries':
      respond(true, { entries: session.entries, leafId: session.leafId ?? 'leaf-empty' })
      return
    case 'get_tree': {
      const byParent = new Map()
      for (const entry of session.entries) {
        const key = entry.parentId ?? ''
        if (!byParent.has(key)) {
          byParent.set(key, [])
        }
        byParent.get(key).push(entry)
      }
      const build = (parentId) =>
        (byParent.get(parentId ?? '') ?? []).map((entry) => ({ entry, children: build(entry.id) }))
      respond(true, { tree: build(null), leafId: session.leafId ?? 'leaf-empty' })
      return
    }
    case 'get_available_models':
      if (process.env.PI_SCRIPT_LOG) {
        try {
          appendFileSync(process.env.PI_SCRIPT_LOG, `catalog:get_available_models\n`)
        } catch {}
      }
      respond(true, {
        models: [
          {
            id: 'script-model',
            name: 'Script Model',
            provider: 'script-provider',
            reasoning: true,
            supportsImages: true,
            api: 'openai',
            baseUrl: 'https://example.invalid',
            cost: { input: 1 },
            secret: 'must-not-leak'
          },
          {
            id: 'text-model',
            name: 'Text Model',
            provider: 'script-provider',
            reasoning: false,
            supportsImages: false
          },
          { id: 'dup-model', name: 'Dup A', provider: 'provider-a', reasoning: false },
          { id: 'dup-model', name: 'Dup B', provider: 'provider-b', reasoning: false }
        ]
      })
      return
    case 'get_commands':
      if (process.env.PI_SCRIPT_LOG) {
        try {
          appendFileSync(process.env.PI_SCRIPT_LOG, `catalog:get_commands\n`)
        } catch {}
      }
      respond(true, {
        commands: [
          {
            name: 'review',
            description: 'Review the diff',
            source: 'builtin',
            sourceInfo: { path: '/secret' },
            aliases: ['r'],
            cost: 1
          },
          { name: 'deploy', description: 'Deploy the app', source: 'skill' }
        ]
      })
      return
    case 'set_model': {
      if (process.env.PI_SCRIPT_LOG) {
        try {
          appendFileSync(process.env.PI_SCRIPT_LOG, `set_model:${cmd.provider}/${cmd.modelId}\n`)
        } catch {}
      }
      const found = [
        { id: 'script-model', provider: 'script-provider' },
        { id: 'text-model', provider: 'script-provider' },
        { id: 'dup-model', provider: 'provider-a' },
        { id: 'dup-model', provider: 'provider-b' }
      ].find((m) => m.provider === cmd.provider && m.id === cmd.modelId)
      if (!found) {
        respond(false, undefined, 'unknown model')
        return
      }
      session.model = { id: found.id, provider: found.provider }
      // Non-reasoning model reports the off-only contract; reasoning keeps levels.
      session.thinkingLevel = found.id === 'text-model' ? 'off' : 'medium'
      respond(true, session.model)
      return
    }
    case 'get_available_thinking_levels': {
      const levels = session.model.id === 'text-model' ? ['off'] : ['low', 'medium', 'high']
      respond(true, { levels })
      return
    }
    case 'set_thinking_level': {
      if (process.env.PI_SCRIPT_LOG) {
        try {
          appendFileSync(process.env.PI_SCRIPT_LOG, `set_thinking_level:${cmd.level}\n`)
        } catch {}
      }
      const allowed = session.model.id === 'text-model' ? ['off'] : ['low', 'medium', 'high']
      if (!allowed.includes(cmd.level)) {
        respond(false, undefined, 'unknown thinking level')
        return
      }
      session.thinkingLevel = cmd.level
      send({ type: 'thinking_level_changed', level: cmd.level })
      respond(true, {})
      return
    }
    case 'set_auto_compaction':
      respond(true, {})
      return
    case 'compact':
      if (process.env.PI_SCRIPT_COMPACT_FAIL === '1') {
        respond(false, undefined, 'Nothing to compact')
        return
      }
      respond(true, {})
      return
    case 'switch_session':
      try {
        loadSessionFile(cmd.sessionPath ?? cmd.resumePath ?? '')
      } catch (error) {
        respond(false, undefined, `cannot load session file: ${error.message}`)
        return
      }
      respond(true, { cancelled: false })
      return
    case 'prompt': {
      const text = typeof cmd.message === 'string' ? cmd.message : ''
      if (process.env.PI_SCRIPT_LOG) {
        try {
          appendFileSync(process.env.PI_SCRIPT_LOG, `prompt:${text}\n`)
        } catch {
          // Logging is test-only diagnostics; never break the protocol.
        }
      }
      if (text.includes('EXIT')) {
        process.exit(1)
      }
      if (text.includes('HANG')) {
        return
      }
      if (text.includes('REJECT')) {
        respond(false, undefined, 'scripted rejection')
        return
      }
      if (
        text.includes('PROMPT-ME') ||
        text.includes('PROMPT-SELECT') ||
        text.includes('PROMPT-INPUT')
      ) {
        const dialogId = nextId('dlg-')
        pendingDialogs.set(dialogId, id)
        if (text.includes('PROMPT-SELECT')) {
          send({
            type: 'extension_ui_request',
            id: dialogId,
            method: 'select',
            title: 'Pick one',
            options: ['alpha', 'beta']
          })
          return
        }
        if (text.includes('PROMPT-INPUT')) {
          send({
            type: 'extension_ui_request',
            id: dialogId,
            method: 'input',
            title: 'Name it',
            placeholder: 'scripted placeholder'
          })
          return
        }
        send({
          type: 'extension_ui_request',
          id: dialogId,
          method: 'confirm',
          title: 'Scripted?',
          message: 'Proceed?'
        })
        return
      }
      respond(true, {})
      runTurn(text)
      return
    }
    case 'test_delay': {
      const ms = typeof cmd.ms === 'number' ? cmd.ms : 0
      const marker = cmd.marker ?? null
      setTimeout(() => respond(true, { marker }), ms).unref?.()
      break
    }
    case 'test_hang':
      break
    case 'test_emit': {
      const chunks = Array.isArray(cmd.chunks) ? cmd.chunks : []
      const delayMs = typeof cmd.delayMs === 'number' ? cmd.delayMs : 5
      let index = 0
      const tick = () => {
        // The ack goes last so a split record never glues onto it mid-stream.
        if (index >= chunks.length) {
          respond(true, {})
          return
        }
        process.stdout.write(Buffer.from(chunks[index], 'base64'))
        index += 1
        setTimeout(tick, delayMs).unref?.()
      }
      tick()
      return
    }
    case 'abort':
      respond(true, {})
      // A blocked dialog ends with the turn: fail its prompt so the hanging
      // `prompt` callers observe the abort instead of waiting forever.
      for (const [dialogId, promptOp] of pendingDialogs) {
        pendingDialogs.delete(dialogId)
        send({
          type: 'response',
          command: 'prompt',
          id: promptOp,
          success: false,
          error: 'aborted'
        })
      }
      liveTurn = null
      send({ type: 'turn_end', message: { stopReason: 'aborted' } })
      send({ type: 'agent_settled', willRetry: false })
      return
    default:
      respond(false, undefined, `unknown command ${type}`)
  }
}

function runTurn(text) {
  if (liveTurn) {
    return
  }
  liveTurn = true
  send({ type: 'turn_start' })
  if (!text.includes('NO-USER')) {
    liveAppend('user', text)
  }
  if (text.includes('TWO-USER')) {
    liveAppend('user', text)
  }
  if (text.includes('WITH-NOISE')) {
    appendNonUserHistory()
  }
  const reply = `scripted reply for turn ${session.entries.length}`
  if (text.includes('THINK')) {
    streamThinking('scripted thinking trace')
  }
  if (text.includes('TOOL')) {
    const callId = nextId('call-')
    streamTool(callId, 'script-tool', 'scripted tool output')
    liveAppend('assistant', '')
  }
  if (text.includes('ERROR-TURN')) {
    endTurn(text, { error: true })
    return
  }
  if (text.includes('SLOW')) {
    // Stream one delta immediately (proves the turn is admitted and active),
    // then pause before the remainder so cancel lands mid-turn deterministically.
    send({ type: 'turn_start' })
    send({ type: 'message_update', assistantMessageEvent: { kind: 'text_start', contentIndex: 0 } })
    send({
      type: 'message_update',
      assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: reply.slice(0, 8) }
    })
    setTimeout(() => {
      if (!liveTurn) {
        return
      }
      send({
        type: 'message_update',
        assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: reply.slice(8) }
      })
      send({
        type: 'message_update',
        assistantMessageEvent: { kind: 'text_end', contentIndex: 0, content: reply }
      })
      liveAppend('assistant', reply)
      endTurn(null)
    }, 1500)
    return
  }
  streamTextDeltas(reply)
  liveAppend('assistant', reply)
  endTurn(text)
}

function handleLine(line) {
  if (line.trim() === '') {
    return
  }
  let cmd
  try {
    cmd = JSON.parse(line)
  } catch {
    send({ type: 'response', command: 'parse', success: false, error: 'malformed JSON' })
    return
  }
  if (cmd && cmd.type === 'extension_ui_response') {
    const dialogId = cmd.id
    const promptOp = pendingDialogs.get(dialogId)
    pendingDialogs.delete(dialogId)
    if (promptOp !== undefined) {
      send({ type: 'response', command: 'prompt', id: promptOp, success: true, data: {} })
      runTurn('prompt-me follow-up')
    }
    return
  }
  try {
    handleCommand(cmd)
  } catch (error) {
    send({
      type: 'response',
      command: cmd?.type ?? 'unknown',
      success: false,
      error: error.message
    })
  }
}

if (EXIT_AT_START) {
  process.stderr.write('scripted pi unavailable\n')
  process.exit(1)
}

if (process.env.SCRIPT_STDERR_FLOOD === '1') {
  const secret = 'token sk-proj-abcdef1234567890 home /home/fixtureuser/secret'
  process.stderr.write(`${secret}\n`.repeat(2000))
}

if (SESSION_FILE !== '') {
  try {
    loadSessionFile(SESSION_FILE)
  } catch {
    // Start empty; the driver acquires fresh.
  }
}

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const idx = buffer.indexOf('\n')
    if (idx === -1) {
      return
    }
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    handleLine(line.endsWith('\r') ? line.slice(0, -1) : line)
  }
})
process.stdin.on('end', () => {
  process.exit(0)
})
