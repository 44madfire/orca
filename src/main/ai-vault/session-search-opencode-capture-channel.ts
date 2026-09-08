import type { Worker } from 'node:worker_threads'
import type { OpenCodeSqliteCaptureBatch } from './session-scanner-opencode-sqlite-worker-protocol'
import { AsyncResource } from 'node:async_hooks'
import {
  captureSessionSearchMessage,
  checkpointSessionSearchCapture,
  type SessionSearchCapturedMessage
} from './session-search-capture'

// The main-thread end of the worker's capture batch/ack loop: one batch in
// flight, acknowledged only once the caller's sink has taken it.

export type OpenCodeCaptureConsumer = (messages: SessionSearchCapturedMessage[]) => Promise<void>

/** Binds the current capture scope: AsyncLocalStorage does not survive the worker hop. */
export function bindOpenCodeCaptureConsumer(): OpenCodeCaptureConsumer {
  return AsyncResource.bind(async (messages: SessionSearchCapturedMessage[]) => {
    for (const message of messages) {
      captureSessionSearchMessage(message)
    }
    await checkpointSessionSearchCapture()
  })
}

type DeadlinedCall = {
  capture?: OpenCodeCaptureConsumer
  timer: NodeJS.Timeout | null
  timeoutMs: number
}

// Reset rather than cleared: total production time stays unbounded (that is the
// point of the credit loop), but each individual stall is still capped, so a
// backlogged index writer costs one scan issue instead of wedging the client.
function restartDeadline(call: DeadlinedCall, onTimeout: () => void): void {
  if (call.timer) {
    clearTimeout(call.timer)
  }
  call.timer = setTimeout(onTimeout, call.timeoutMs)
  call.timer.unref?.()
}

export function receiveOpenCodeCaptureBatch(args: {
  call: DeadlinedCall
  batch: OpenCodeSqliteCaptureBatch
  worker: Worker | null
  isActive: () => boolean
  onTimeout: () => void
  onProtocolViolation: (error: Error) => void
  onConsumerError: (error: Error) => void
}): void {
  const { call } = args
  if (!call.capture) {
    args.onProtocolViolation(new Error('Unexpected OpenCode capture batch.'))
    return
  }
  restartDeadline(call, args.onTimeout)
  void call
    .capture(args.batch.messages)
    .then(() => {
      if (!args.isActive()) {
        return
      }
      restartDeadline(call, args.onTimeout)
      args.worker?.postMessage({
        id: args.batch.id,
        kind: 'captureAck',
        batch: args.batch.batch
      })
    })
    .catch((error) => {
      if (args.isActive()) {
        args.onConsumerError(error instanceof Error ? error : new Error(String(error)))
      }
    })
}
