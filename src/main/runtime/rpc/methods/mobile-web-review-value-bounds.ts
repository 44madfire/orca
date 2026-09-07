/** Bounds shared by every review projection: the page contract caps each field, and a provider
 *  answer that overruns or mistypes one is clipped rather than failing the whole review. */

export function reviewBoundedString(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

export function reviewNonemptyString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : undefined
}

export function reviewNullableText(value: unknown, limit: number): string | null {
  return typeof value === 'string' ? value.slice(0, limit) : null
}

export function reviewPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

export function reviewNonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function reviewPositiveIntegerString(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) {
    return null
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function reviewObjectId(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
    ? value
    : undefined
}

export function reviewRelativePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    return undefined
  }
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return undefined
  }
  return value.split('/').every((part) => part && part !== '.' && part !== '..') ? value : undefined
}

export function isReviewRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
