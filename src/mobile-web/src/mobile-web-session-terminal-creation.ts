import {
  MobileWebSessionAgentOptionsResultSchema,
  MobileWebSessionCreateResultSchema,
  type MobileWebSessionAgentOptionsPayload,
  type MobileWebSessionCreateAgentPayload,
  type MobileWebSessionCreateResult,
  type MobileWebSessionCreatePayload
} from '../../shared/mobile-web/session-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { secureMobileWebBridgeRequestId } from './mobile-web-bridge-request-encoding'
import { readMobileWebHostMethods, requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebSessionTerminalCreation {
  constructor(
    private readonly requests: MobileWebOneShotRequestClient,
    private readonly hostRequestDispatch: boolean
  ) {}

  agentOptions(
    payload: MobileWebSessionAgentOptionsPayload,
    legacy: (timeoutMs?: number) => Promise<{ agents: string[] }>
  ) {
    return this.run('mobileWeb.session.agentOptions', false, legacy, async (timeoutMs) =>
      MobileWebSessionAgentOptionsResultSchema.parse(
        await requestMobileWebHost(
          this.requests,
          'mobileWeb.session.agentOptions',
          payload.workspaceId,
          {},
          { timeoutMs }
        )
      )
    )
  }

  create(
    payload: MobileWebSessionCreatePayload | MobileWebSessionCreateAgentPayload,
    legacy: (timeoutMs?: number) => Promise<MobileWebSessionCreateResult>
  ) {
    return this.run('mobileWeb.session.createTerminal', true, legacy, async (timeoutMs) => {
      const result = await requestMobileWebHost(
        this.requests,
        'mobileWeb.session.createTerminal',
        payload.workspaceId,
        {
          ...('agent' in payload ? { agent: payload.agent } : {}),
          clientMutationId: secureMobileWebBridgeRequestId(),
          timeoutMs
        },
        { timeoutMs }
      )
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return MobileWebSessionCreateResultSchema.parse({
        ...result,
        workspaceId: payload.workspaceId
      })
    })
  }

  private async run<T>(
    method: string,
    mutation: boolean,
    legacy: (timeoutMs?: number) => Promise<T>,
    dispatch: (timeoutMs: number) => Promise<T>
  ): Promise<T> {
    if (
      (mutation && !this.hostRequestDispatch) ||
      !this.requests.supports('workspace', 'hostRequest') ||
      !this.requests.supports('workspace', 'hostCatalog')
    ) {
      return legacy()
    }
    const deadline = Date.now() + 15_000
    const remaining = () => {
      const timeoutMs = deadline - Date.now()
      if (timeoutMs <= 0) {
        throw new MobileWebBridgeClientError('timeout', true)
      }
      return timeoutMs
    }
    let supported: boolean
    try {
      const catalog = await readMobileWebHostMethods(this.requests, [method], {
        timeoutMs: remaining()
      })
      supported = catalog.grants.some((grant) => grant.method === method)
    } catch (error) {
      if (
        !(error instanceof MobileWebBridgeClientError) ||
        error.code !== 'unsupported_capability'
      ) {
        throw error
      }
      supported = false
    }
    if (!supported) {
      return legacy(remaining())
    }
    // No fallback after dispatch: a lost reply can hide a successfully created terminal.
    return dispatch(remaining())
  }
}
