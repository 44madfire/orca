import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import type { Worker } from 'node:worker_threads'
import type {
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'
import { AsyncResource } from 'node:async_hooks'
import {
  captureSessionSearchMessage,
  checkpointSessionSearchCapture,
  getSessionSearchCaptureSignal,
  type SessionSearchCapturedMessage
} from './session-search-capture'

export type OpenCodeCaptureConsumer = (messages: SessionSearchCapturedMessage[]) => Promise<void>

export function bindOpenCodeCaptureConsumer(): OpenCodeCaptureConsumer {
  return AsyncResource.bind(async (messages: SessionSearchCapturedMessage[]) => {
    for (const message of messages) {
      captureSessionSearchMessage(message)
    }
    await checkpointSessionSearchCapture()
  })
}

export function receiveOpenCodeCaptureBatch(args: {
  call: { capture?: OpenCodeCaptureConsumer; timer: NodeJS.Timeout | null; timeoutMs: number }
  response: Extract<OpenCodeSqliteWorkerResponse, { ok: true }>
  worker: Worker | null
  isActive: () => boolean
  onTimeout: () => void
  onError: (error: Error) => void
}): void {
  const { call } = args
  if (!call.capture) {
    args.onError(new Error('Unexpected OpenCode capture batch.'))
    return
  }
  // Backpressure belongs to the writer; the worker deadline covers time spent producing.
  if (call.timer) {
    clearTimeout(call.timer)
    call.timer = null
  }
  void call
    .capture(args.response.value as SessionSearchCapturedMessage[])
    .then(() => {
      if (!args.isActive()) {
        return
      }
      call.timer = setTimeout(args.onTimeout, call.timeoutMs)
      call.timer.unref?.()
      args.worker?.postMessage({
        id: args.response.id,
        kind: 'captureAck',
        batch: args.response.captureBatch
      })
    })
    .catch((error) => {
      if (args.isActive()) {
        args.onError(error instanceof Error ? error : new Error(String(error)))
      }
    })
}

/** The request owns its abort listener until either queued or active work settles. */
export function bindOpenCodeCaptureCancellation(
  resolve: (value: unknown) => void,
  reject: (error: Error) => void,
  cancel: () => void
): { resolve: typeof resolve; reject: typeof reject } {
  const signal = getSessionSearchCaptureSignal()
  throwIfAiVaultScanCancelled(signal)
  signal?.addEventListener('abort', cancel, { once: true })
  const cleanup = (): void => signal?.removeEventListener('abort', cancel)
  return {
    resolve: (value) => {
      cleanup()
      resolve(value)
    },
    reject: (error) => {
      cleanup()
      reject(error)
    }
  }
}

export type OpenCodePendingCall = {
  request: OpenCodeSqliteWorkerRequest
  timeoutMs: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
  capture?: OpenCodeCaptureConsumer
}
