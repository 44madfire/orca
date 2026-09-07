import {
  MobileWebHostCatalogPayloadSchema,
  MobileWebHostCatalogResultSchema,
  mobileWebHostPayloadWithinBounds,
  type MobileWebHostGrant
} from '../../../src/shared/mobile-web/host-rpc-contract'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { MOBILE_WEB_HOST_REQUEST_TIMEOUT_MS } from './mobile-web-host-requests'

/** A grant the desktop advertised, or `null` for a method it refused to advertise. */
type CatalogEntry = MobileWebHostGrant | null

/**
 * The desktop's catalog is a module constant, so its grants can only change when the desktop
 * process restarts, which tears the socket down and makes the broker replace this client. One
 * catalog read per method per connection therefore answers every forwarded request.
 */
export class MobileWebHostCatalogCache {
  private client: RpcClient | null = null
  private readonly entries = new Map<string, CatalogEntry>()
  private readonly inFlight = new Map<string, Promise<CatalogEntry>>()

  clear(): void {
    this.client = null
    this.entries.clear()
    this.inFlight.clear()
  }

  async read(
    client: RpcClient,
    input: unknown,
    options?: SendRequestOptions
  ): Promise<{ grants: MobileWebHostGrant[] }> {
    const payload = MobileWebHostCatalogPayloadSchema.parse(input)
    const entries = await this.resolve(client, [...new Set(payload.methods)], options)
    return { grants: entries.filter((entry) => entry !== null) }
  }

  async grant(
    client: RpcClient,
    method: string,
    options?: SendRequestOptions
  ): Promise<CatalogEntry> {
    return (await this.resolve(client, [method], options))[0] ?? null
  }

  private resolve(
    client: RpcClient,
    methods: readonly string[],
    options: SendRequestOptions | undefined
  ): Promise<CatalogEntry[]> {
    if (this.client !== client) {
      this.clear()
      this.client = client
    }
    const missing = methods.filter(
      (method) => !this.entries.has(method) && !this.inFlight.has(method)
    )
    if (missing.length > 0) {
      this.track(missing, this.send(client, missing, options))
    }
    const owned = new Set(missing)
    return Promise.all(
      methods.map((method) => this.settle(client, method, options, owned.has(method)))
    )
  }

  private settle(
    client: RpcClient,
    method: string,
    options: SendRequestOptions | undefined,
    owned: boolean
  ): CatalogEntry | Promise<CatalogEntry> {
    const cached = this.entries.get(method)
    if (cached !== undefined) {
      return cached
    }
    const shared = this.inFlight.get(method)!
    if (owned) {
      return shared
    }
    // A sibling request cancelling or timing out its own catalog read must not fail this one.
    return shared.catch(async () => {
      const settled = this.entries.get(method)
      return settled !== undefined
        ? settled
        : ((await this.send(client, [method], options)).get(method) ?? null)
    })
  }

  private track(methods: readonly string[], request: Promise<Map<string, CatalogEntry>>): void {
    for (const method of methods) {
      const entry = request.then((found) => found.get(method) ?? null)
      this.inFlight.set(method, entry)
      const forget = (): void => {
        if (this.inFlight.get(method) === entry) {
          this.inFlight.delete(method)
        }
      }
      void entry.then(forget, forget)
    }
  }

  private async send(
    client: RpcClient,
    methods: readonly string[],
    options: SendRequestOptions | undefined
  ): Promise<Map<string, CatalogEntry>> {
    const response = await client.sendRequest(
      'mobileWeb.host.catalog',
      { methods },
      options ?? { timeoutMs: MOBILE_WEB_HOST_REQUEST_TIMEOUT_MS, budgetSpansConnect: true }
    )
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    if (!mobileWebHostPayloadWithinBounds(response.result)) {
      throw new MobileWebBrokerError('too_large')
    }
    const { grants } = MobileWebHostCatalogResultSchema.parse(response.result)
    const found = new Map(
      methods.map((method) => [method, grants.find((grant) => grant.method === method) ?? null])
    )
    if (this.client === client) {
      for (const [method, entry] of found) {
        this.entries.set(method, entry)
      }
    }
    return found
  }
}
