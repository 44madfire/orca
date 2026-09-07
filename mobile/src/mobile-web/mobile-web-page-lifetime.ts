import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'

let documentSequence = 0

type Opening = {
  client: RpcClient
  ready: Promise<string>
  reject: (error: Error) => void
  unsubscribe?: () => void
  timer?: ReturnType<typeof setTimeout>
}

export class MobileWebPageLifetime {
  private readonly id: string
  private opening: Opening | undefined
  private disposed = false

  constructor(randomBytes: (length: number) => Uint8Array) {
    const bytes = randomBytes(16)
    if (bytes.length !== 16) {
      throw new MobileWebBrokerError('internal')
    }
    this.id = `document_${++documentSequence}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }

  get(client: RpcClient): Promise<string> {
    if (this.disposed) {
      return Promise.reject(new MobileWebBrokerError('cancelled'))
    }
    if (this.opening?.client !== client) {
      this.reset()
    }
    if (this.opening) {
      return this.opening.ready
    }
    let resolve!: (id: string) => void
    let reject!: (error: Error) => void
    const ready = new Promise<string>((done, fail) => {
      resolve = done
      reject = fail
    })
    const opening: Opening = { client, ready, reject }
    this.opening = opening
    opening.timer = setTimeout(() => this.reset(new MobileWebBrokerError('timeout')), 15_000)
    try {
      const unsubscribe = client.subscribe(
        'mobileWeb.page.subscribe',
        { pageSession: this.id },
        (event) => {
          if (this.opening !== opening) {
            return
          }
          if (
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            event.type === 'ready' &&
            'subscriptionId' in event &&
            event.subscriptionId === this.id
          ) {
            clearTimeout(opening.timer)
            opening.timer = undefined
            resolve(this.id)
          } else {
            this.reset(new MobileWebBrokerError('unavailable'))
          }
        },
        { serverUnsubscribeMethod: 'mobileWeb.page.unsubscribe' }
      )
      if (this.opening === opening) {
        opening.unsubscribe = unsubscribe
      } else {
        unsubscribe()
      }
    } catch {
      this.reset(new MobileWebBrokerError('unavailable'))
    }
    return ready
  }

  reset(error: Error = new MobileWebBrokerError('cancelled')): void {
    const opening = this.opening
    this.opening = undefined
    if (!opening) {
      return
    }
    clearTimeout(opening.timer)
    opening.reject(error)
    opening.unsubscribe?.()
  }

  dispose(): void {
    this.disposed = true
    this.reset()
  }
}
