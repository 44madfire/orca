import { describe, expect, it } from 'vitest'
import type { ServiceExecutionError } from './plugin-service-execution-errors'
import {
  createGeneration,
  pushGenerationMessage,
  pushGenerationStdout,
  type Generation,
  type GenerationStreamHooks
} from './plugin-service-sidecar-generation'

function testHooks(): GenerationStreamHooks {
  return {
    isCurrent: () => true,
    markReady: (gen, pid) => {
      gen.guestSupervisorPid = pid
      gen.state = 'ready'
    }
  }
}

function wslExchange(limit: number): {
  gen: Generation
  forwarded: string[]
  overlongs: number
  route: (chunk: string) => void
} {
  const gen = createGeneration(1, 'n1')
  const forwarded: string[] = []
  let overlongs = 0
  gen.framer = {
    push: (chunk: Buffer) => forwarded.push(String(chunk)),
    finish: () => undefined
  }
  return {
    gen,
    forwarded,
    get overlongs() {
      return overlongs
    },
    route: (chunk: string) =>
      pushGenerationStdout(gen, Buffer.from(chunk, 'utf8'), true, limit, testHooks(), () => {
        overlongs += 1
      })
  }
}

describe('pushGenerationStdout WSL routing', () => {
  it('routes control lines and forwards service lines', () => {
    const exchange = wslExchange(1024)
    exchange.route('ORCA_SIDECAR_READY pid=7 nonce=n1\n')
    expect(exchange.gen.guestSupervisorPid).toBe(7)
    exchange.route('{"id":"a"}\n')
    expect(exchange.forwarded).toEqual(['{"id":"a"}\n'])
  })
})

describe('pushGenerationStdout WSL bound', () => {
  it('an LF-less flood stays bounded and later lines resync', () => {
    const exchange = wslExchange(128)
    // 100 chunks of an unterminated line: the splitter must not accumulate.
    for (let i = 0; i < 100; i += 1) {
      exchange.route('x'.repeat(64))
    }
    expect(Buffer.byteLength(exchange.gen.wslText, 'utf8')).toBeLessThanOrEqual(128)
    expect(exchange.overlongs).toBeGreaterThan(0)
    // A later valid line still resyncs through the same stream.
    exchange.route('\n{"id":"ok","result":1}\n')
    expect(exchange.forwarded).toEqual(['{"id":"ok","result":1}\n'])
  })

  it('drops one overlong complete line without killing the stream', () => {
    const exchange = wslExchange(64)
    exchange.route(`{"id":"${'y'.repeat(200)}"}\n{"id":"fine"}\n`)
    // Complete overlong service lines fall through to the bounded framer,
    // which drops them; the following line still arrives.
    expect(exchange.forwarded).toEqual(['{"id":"fine"}\n'])
  })
})

describe('pushGenerationMessage', () => {
  it('rejects shapeless envelopes as malformed', () => {
    const gen = createGeneration(1, 'n1')
    let failure: unknown
    const timer = setTimeout(() => undefined, 1000)
    timer.unref?.()
    gen.pending.set('x', {
      resolve: () => undefined,
      reject: (error: Error) => {
        failure = error
      },
      timer
    })
    pushGenerationMessage(gen, { nope: true }, 'svc.t', 1024, true)
    expect((failure as ServiceExecutionError).message).toContain('malformed-response')
  })
})
