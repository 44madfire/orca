import { MobileWebBrokerError } from './mobile-web-broker-error'

// Entries are hints revalidated by the host; only in-flight users and attachments pin them.
export class MobileWebResourceCache<T> extends Map<string, T> {
  private retained = new Map<string, number>()

  constructor(private readonly protectedEntry: (id: string) => boolean = () => false) {
    super()
  }

  override set(id: string, value: T): this {
    if (!this.has(id) && this.size >= 512) {
      const candidate = Array.from(this.keys()).find(
        (key) => !this.retained.has(key) && !this.protectedEntry(key)
      )
      if (candidate === undefined) {
        throw new MobileWebBrokerError('rate_limited')
      }
      this.delete(candidate)
    }
    super.delete(id)
    return super.set(id, value)
  }

  override clear(): void {
    super.clear()
    this.retained = new Map()
  }

  retain(id: string): () => void {
    const retained = this.retained
    retained.set(id, (retained.get(id) ?? 0) + 1)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const count = (retained.get(id) ?? 1) - 1
      if (count > 0) {
        retained.set(id, count)
      } else {
        retained.delete(id)
      }
    }
  }
}
