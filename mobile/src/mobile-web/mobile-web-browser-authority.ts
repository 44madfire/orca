import { MobileWebBrokerError } from './mobile-web-broker-error'
import { MobileWebResourceCache } from './mobile-web-resource-cache'

type BrowserPageBinding = {
  hostWorkspaceId: string
  hostPageId: string
}

export class MobileWebBrowserAuthority {
  private readonly bindingByPageId = new MobileWebResourceCache<BrowserPageBinding>()

  private generation = 0

  captureGeneration(): number {
    return this.generation
  }

  assertGeneration(generation: number): void {
    if (this.generation !== generation) {
      throw new MobileWebBrokerError('not_found')
    }
  }

  bind(pageId: string, binding: BrowserPageBinding): void {
    this.bindingByPageId.set(pageId, binding)
  }

  retain(pageId: string): () => void {
    return this.bindingByPageId.retain(pageId)
  }

  hostPageId(hostWorkspaceId: string, pageId: string): string {
    const binding = this.bindingByPageId.get(pageId)
    if (!binding || binding.hostWorkspaceId !== hostWorkspaceId) {
      throw new MobileWebBrokerError('not_found')
    }
    return binding.hostPageId
  }

  hostTabId(hostWorkspaceId: string, pageTabId: string): string {
    const binding = this.bindingByPageId.get(pageTabId)
    if (!binding) {
      if (pageTabId.startsWith('resource_')) {
        throw new MobileWebBrokerError('not_found')
      }
      return pageTabId
    }
    if (binding.hostWorkspaceId !== hostWorkspaceId) {
      throw new MobileWebBrokerError('not_found')
    }
    return binding.hostPageId
  }

  clear(): void {
    this.generation += 1
    this.bindingByPageId.clear()
  }
}
