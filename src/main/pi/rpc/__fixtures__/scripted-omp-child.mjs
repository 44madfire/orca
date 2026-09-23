// Deterministic scripted `omp --mode rpc` child for Pi-family tests.
//
// Speaks the OMP RPC wire per canonical can1357/oh-my-pi merge
// `6f2233877756b5553ce520756dd90315d2ff6ee3` (upstream PR #12900): a `ready`
// frame with protocol versions first, then `available_commands_update`,
// id-echoed responses (including unknown-command failures), and optional
// protocol-v2 `rpc_chunk` sequences. Driven by env:
//
// - `OMP_SCRIPT_SESSION_ID` / `OMP_SCRIPT_SESSION_FILE` → `get_state` identity.
// - `OMP_SCRIPT_EXIT_AT_START=1` → exit(1) immediately (startup failure).
// - `OMP_SCRIPT_READY_ONLY=1` → emit `ready`, never answer (probe timeout).
// - `OMP_SCRIPT_NO_STARTUP_FRAMES=1` → skip `ready`/catalog (Pi-shaped OMP).
// - `OMP_SCRIPT_NOISE=1` → extra async frames after startup (host tools,
//   subagents, notices, unknown future records).
//
// Test-only commands (never part of either provider's RPC API):
// - `test_delay {ms, marker}` → success after `ms` (out-of-order proof).
// - `test_hang` → never responds (deadline proof).
// - `test_emit {chunks: base64[], delayMs?}` → raw stdout bytes per tick
//   (split records, multi-record chunks, U+2028, malformed, bad chunks).
// - `test_chunked {padBytes}` → success response sent as `rpc_chunk` frames.

import { appendFileSync, readFileSync } from 'node:fs'

const SESSION_FILE = process.env.OMP_SCRIPT_SESSION_FILE ?? ''
const EXIT_AT_START = process.env.OMP_SCRIPT_EXIT_AT_START === '1'
const READY_ONLY = process.env.OMP_SCRIPT_READY_ONLY === '1'
const NO_STARTUP_FRAMES = process.env.OMP_SCRIPT_NO_STARTUP_FRAMES === '1'
const NOISE = process.env.OMP_SCRIPT_NOISE === '1'

const session = {
  sessionId: process.env.OMP_SCRIPT_SESSION_ID ?? 'omp-script-ses-1',
  sessionFile: SESSION_FILE,
  model: { id: 'script-model', provider: 'script-provider' },
  thinkingLevel: 'medium',
  entries: [],
  leafId: null
}

// Minimal session-file load so resume tests converge: the shared history
// layer only reads the structural subset (id/parentId), never OMP payloads.
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

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

function respond(cmd, success, data, error) {
  const record = { type: 'response', command: cmd.type, success }
  if (cmd.id !== undefined) {
    record.id = cmd.id
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

function stateData() {
  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'all',
    messageCount: 0
  }
}

let chunkSeq = 0

function sendChunked(record) {
  const json = JSON.stringify(record)
  const bytes = Buffer.from(json, 'utf8')
  const payload = 256 * 1024
  const count = Math.max(2, Math.ceil(bytes.byteLength / payload))
  const chunkId = `test-chunk-${(chunkSeq += 1)}`
  for (let index = 0; index < count; index += 1) {
    const slice = bytes.subarray(index * payload, (index + 1) * payload)
    send({
      type: 'rpc_chunk',
      chunkId,
      index,
      count,
      byteLength: bytes.byteLength,
      data: slice.toString('base64')
    })
  }
}

function handleCommand(cmd) {
  if (READY_ONLY) {
    return
  }
  switch (cmd.type) {
    case 'negotiate_protocol':
      respond(cmd, true, { protocolVersion: 2 })
      return
    case 'get_state':
      respond(cmd, true, stateData())
      return
    case 'get_entries':
      respond(cmd, true, {
        entries: session.entries,
        leafId: session.leafId ?? 'leaf-empty'
      })
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
        (byParent.get(parentId ?? '') ?? []).map((entry) => ({
          entry,
          children: build(entry.id)
        }))
      respond(cmd, true, {
        tree: build(null),
        leafId: session.leafId ?? 'leaf-empty'
      })
      return
    }
    case 'get_available_models':
      if (process.env.OMP_SCRIPT_LOG) {
        try {
          appendFileSync(process.env.OMP_SCRIPT_LOG, 'catalog:get_available_models\n')
        } catch {}
      }
      respond(cmd, true, {
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
    case 'get_available_commands':
      if (process.env.OMP_SCRIPT_LOG) {
        try {
          appendFileSync(process.env.OMP_SCRIPT_LOG, 'catalog:get_available_commands\n')
        } catch {}
      }
      respond(cmd, true, {
        commands: [
          {
            name: 'omp-review',
            description: 'OMP review',
            source: 'builtin',
            aliases: ['or'],
            input: { schema: 1 },
            subcommands: [{ name: 'deep' }],
            secret: 'must-not-leak'
          },
          { name: 'omp-deploy', description: 'OMP deploy', source: 'skill' }
        ]
      })
      return
    case 'set_model': {
      if (process.env.OMP_SCRIPT_LOG) {
        try {
          appendFileSync(process.env.OMP_SCRIPT_LOG, `set_model:${cmd.provider}/${cmd.modelId}\n`)
        } catch {}
      }
      const found = [
        { id: 'script-model', provider: 'script-provider' },
        { id: 'text-model', provider: 'script-provider' },
        { id: 'dup-model', provider: 'provider-a' },
        { id: 'dup-model', provider: 'provider-b' }
      ].find((m) => m.provider === cmd.provider && m.id === cmd.modelId)
      if (!found) {
        respond(cmd, false, undefined, 'unknown model')
        return
      }
      session.model = { id: found.id, provider: found.provider }
      session.thinkingLevel = found.id === 'text-model' ? 'off' : 'medium'
      respond(cmd, true, session.model)
      return
    }
    case 'get_available_thinking_levels': {
      const levels =
        session.model.id === 'text-model'
          ? ['off']
          : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
      respond(cmd, true, { levels })
      return
    }
    case 'set_thinking_level': {
      if (process.env.OMP_SCRIPT_LOG) {
        try {
          appendFileSync(process.env.OMP_SCRIPT_LOG, `set_thinking_level:${cmd.level}\n`)
        } catch {}
      }
      const allowed =
        session.model.id === 'text-model'
          ? ['off']
          : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
      if (!allowed.includes(cmd.level)) {
        respond(cmd, false, undefined, 'unknown thinking level')
        return
      }
      session.thinkingLevel = cmd.level
      send({ type: 'thinking_level_changed', level: cmd.level })
      respond(cmd, true, {})
      return
    }
    case 'set_auto_compaction':
      respond(cmd, true, {})
      return
    case 'compact':
      if (process.env.OMP_SCRIPT_COMPACT_FAIL === '1') {
        respond(cmd, false, undefined, 'Nothing to compact')
        return
      }
      respond(cmd, true, {})
      return
    case 'switch_session':
      try {
        loadSessionFile(cmd.sessionPath ?? cmd.resumePath ?? '')
      } catch (error) {
        respond(cmd, false, undefined, `cannot load session file: ${error.message}`)
        return
      }
      respond(cmd, true, { cancelled: false })
      return
    case 'prompt': {
      const text = typeof cmd.message === 'string' ? cmd.message : ''
      if (text.includes('EXIT')) {
        process.exit(1)
      }
      respond(cmd, true, { agentInvoked: true })
      const settle = () => {
        send({ type: 'prompt_result', id: cmd.id, agentInvoked: true })
        send({
          type: 'agent_end',
          isTerminal: true,
          messages: [],
          willRetry: false
        })
      }
      // SLOW keeps the turn open so cancel/settle races stay deterministic.
      // A non-terminal agent_end precedes settlement: the runtime continues
      // and the turn must stay active through it.
      if (text.includes('SLOW')) {
        setTimeout(
          () => send({ type: 'agent_end', isTerminal: false, messages: [], willRetry: false }),
          200
        ).unref?.()
        setTimeout(settle, 1500).unref?.()
        return
      }
      settle()
      return
    }
    case 'abort':
      respond(cmd, true, {})
      return
    case 'test_delay': {
      const ms = typeof cmd.ms === 'number' ? cmd.ms : 0
      setTimeout(() => respond(cmd, true, { marker: cmd.marker ?? null }), ms).unref?.()
      break
    }
    case 'test_hang':
      break
    case 'test_noise':
      emitNoise()
      respond(cmd, true, {})
      return
    case 'test_chunked': {
      const padBytes = typeof cmd.padBytes === 'number' ? cmd.padBytes : 1_100_000
      const record = {
        type: 'response',
        command: 'test_chunked',
        success: true,
        data: { pad: 'x'.repeat(padBytes) }
      }
      if (cmd.id !== undefined) {
        record.id = cmd.id
      }
      sendChunked(record)
      return
    }
    case 'test_emit': {
      const chunks = Array.isArray(cmd.chunks) ? cmd.chunks : []
      const delayMs = typeof cmd.delayMs === 'number' ? cmd.delayMs : 5
      let index = 0
      const tick = () => {
        // The ack goes last so a split record never glues onto it mid-stream.
        if (index >= chunks.length) {
          respond(cmd, true, {})
          return
        }
        process.stdout.write(Buffer.from(chunks[index], 'base64'))
        index += 1
        setTimeout(tick, delayMs).unref?.()
      }
      tick()
      return
    }
    default:
      if (cmd.type === 'get_commands' && process.env.OMP_SCRIPT_LOG) {
        try {
          appendFileSync(process.env.OMP_SCRIPT_LOG, 'catalog:get_commands\n')
        } catch {}
      }
      respond(cmd, false, undefined, `Unknown command: ${cmd.type}`)
  }
}

function handleLine(line) {
  if (line.trim() === '') {
    return
  }
  let cmd
  try {
    cmd = JSON.parse(line)
  } catch {
    send({
      type: 'response',
      command: 'parse',
      success: false,
      error: 'malformed JSON'
    })
    return
  }
  if (cmd && cmd.type === 'extension_ui_response') {
    return
  }
  try {
    handleCommand(cmd)
  } catch (error) {
    respond(cmd, false, undefined, error.message)
  }
}

if (EXIT_AT_START) {
  process.stderr.write('scripted omp unavailable\n')
  process.exit(1)
}

if (!NO_STARTUP_FRAMES) {
  send({
    type: 'ready',
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: 1048576,
    maxReassembledFrameBytes: 67108864
  })
  send({
    type: 'available_commands_update',
    commands: [
      {
        name: 'omp-review',
        description: 'OMP review',
        source: 'builtin',
        aliases: ['or'],
        input: { schema: 1 },
        subcommands: [{ name: 'deep' }]
      },
      { name: 'omp-deploy', description: 'OMP deploy', source: 'skill' }
    ]
  })
}

function emitNoise() {
  send({
    type: 'available_commands_update',
    commands: [{ name: 'script-cmd', description: 'scripted', source: 'builtin' }]
  })
  send({
    type: 'host_tool_call',
    toolCallId: 'ht-1',
    toolName: 'script-host-tool'
  })
  send({
    type: 'subagent_lifecycle',
    payload: { id: 'child-1', status: 'started' }
  })
  send({ type: 'notice', message: 'scripted notice' })
  send({ type: 'omp_future_xyz', future: true })
}

if (NOISE) {
  emitNoise()
}

if (process.env.SCRIPT_STDERR_FLOOD === '1') {
  const secret = 'token sk-proj-abcdef1234567890 home /home/fixtureuser/secret'
  process.stderr.write(`${secret}\n`.repeat(2000))
}

if (SESSION_FILE !== '') {
  try {
    loadSessionFile(SESSION_FILE)
  } catch {
    // Start empty; the transport only needs get_state identity.
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
