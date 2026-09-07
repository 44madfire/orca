import { MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS } from '../../shared/mobile-web/bridge-contract'
import {
  MobileWebHostCatalogPayloadSchema,
  MobileWebHostCatalogResultSchema,
  type MobileWebHostGrant
} from '../../shared/mobile-web/host-rpc-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

type Catalog = { grants: MobileWebHostGrant[] }
type Reader = {
  methods: string[]
  deadline: number
  resolve: (result: Catalog) => void
  reject: (error: unknown) => void
  release: () => void
}

// Discovery from sibling mounts shares one bounded read, never a cached grant.
export class MobileWebHostCatalogQueue {
  private readonly readers = new Set<Reader>()
  private readonly queued = new Set<Reader>()
  private active: { readers: Set<Reader>; controller: AbortController } | undefined
  private scheduled = false

  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  read(methods: string[], options: MobileWebBridgeRequestOptions = {}): Promise<Catalog> {
    if (options.signal?.aborted) {
      return Promise.reject(new MobileWebBridgeClientError('cancelled', false))
    }
    const parsed = MobileWebHostCatalogPayloadSchema.safeParse({ methods })
    if (!parsed.success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    if (this.readers.size >= MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS) {
      return Promise.reject(new MobileWebBridgeClientError('rate_limited', true))
    }
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.requests.defaultTimeoutMs
      const cancel = () => finish(new MobileWebBridgeClientError('cancelled', false))
      const timer = setTimeout(
        () => finish(new MobileWebBridgeClientError('timeout', true)),
        timeoutMs
      )
      const reader: Reader = {
        methods: parsed.data.methods,
        deadline: Date.now() + timeoutMs,
        resolve,
        reject,
        release: () => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', cancel)
          this.readers.delete(reader)
          this.queued.delete(reader)
          if (this.active?.readers.delete(reader) && this.active.readers.size === 0) {
            this.active.controller.abort()
          }
        }
      }
      const finish = (error: MobileWebBridgeClientError) => {
        reader.release()
        reject(error)
      }
      this.readers.add(reader)
      this.queued.add(reader)
      options.signal?.addEventListener('abort', cancel, { once: true })
      this.schedule()
    })
  }

  private schedule(): void {
    if (this.scheduled || this.active || this.queued.size === 0) {
      return
    }
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.flush()
    })
  }

  private flush(): void {
    if (this.active || this.queued.size === 0) {
      return
    }
    const methods = new Set<string>()
    const readers = new Set<Reader>()
    for (const reader of this.queued) {
      const combined = new Set([...methods, ...reader.methods])
      if (combined.size > 32) {
        break
      }
      for (const method of combined) {
        methods.add(method)
      }
      readers.add(reader)
      this.queued.delete(reader)
    }
    const controller = new AbortController()
    this.active = { readers, controller }
    const deadline = Math.max(...Array.from(readers, (reader) => reader.deadline))
    void this.requests
      .request(
        'workspace',
        'hostCatalog',
        { methods: [...methods] },
        MobileWebHostCatalogPayloadSchema,
        MobileWebHostCatalogResultSchema,
        { signal: controller.signal, timeoutMs: Math.max(0, deadline - Date.now()) }
      )
      .then(
        (result) => {
          this.active = undefined
          for (const reader of readers) {
            reader.release()
            reader.resolve({
              grants: result.grants.filter((grant) => reader.methods.includes(grant.method))
            })
          }
        },
        (error: unknown) => {
          this.active = undefined
          for (const reader of readers) {
            reader.release()
            reader.reject(error)
          }
        }
      )
      .finally(() => this.schedule())
  }
}

const queues = new WeakMap<MobileWebOneShotRequestClient, MobileWebHostCatalogQueue>()

export function readMobileWebHostCatalog(
  requests: MobileWebOneShotRequestClient,
  methods: string[],
  options?: MobileWebBridgeRequestOptions
): Promise<Catalog> {
  let queue = queues.get(requests)
  if (!queue) {
    queue = new MobileWebHostCatalogQueue(requests)
    queues.set(requests, queue)
  }
  return queue.read(methods, options)
}
