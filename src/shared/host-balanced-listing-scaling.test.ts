import { expect, it, vi } from 'vitest'
import { selectHostBalancedPage } from './host-balanced-listing-page'

it('retires exhausted host buckets from subsequent listing rounds', () => {
  const rows = [
    ...Array.from({ length: 1000 }, (_, index) => ({ host: `host-${index}`, id: index })),
    ...Array.from({ length: 2000 }, (_, index) => ({ host: 'large-host', id: 1000 + index }))
  ]
  const original = Map.prototype.values
  let reads = 0
  const spy = vi
    .spyOn(Map.prototype, 'values')
    .mockImplementation(function (this: Map<string, number[]>) {
      const iterator = original.call(this)
      if (!this.has('large-host')) {
        return iterator
      }
      return iterator.map(
        (bucket: number[]) =>
          new Proxy(bucket, {
            get(target, key, receiver) {
              if (typeof key === 'string' && /^\d+$/.test(key)) {
                reads += 1
              }
              return Reflect.get(target, key, receiver)
            }
          })
      )
    })
  let result: typeof rows
  try {
    result = selectHostBalancedPage(rows, 2000, (row) => row.host)
  } finally {
    spy.mockRestore()
  }
  expect(result!.map((row) => row.id)).toEqual(Array.from({ length: 2000 }, (_, index) => index))
  expect(reads).toBeLessThanOrEqual(2000)
})
