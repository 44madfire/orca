// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { preserveDeleteSiblingPosition } from './worktree-context-menu-policy'

it('measures each mounted sidebar row once when choosing a delete-position anchor', () => {
  const sidebar = document.createElement('div')
  sidebar.setAttribute('data-worktree-sidebar', '')
  let measurements = 0
  const rows = Array.from({ length: 200 }, (_, index) => {
    const row = document.createElement('div')
    row.setAttribute('data-worktree-virtual-row', '')
    row.setAttribute('data-worktree-virtual-row-key', String(index))
    row.getBoundingClientRect = () => {
      measurements += 1
      return { top: (index * 73) % 200 } as DOMRect
    }
    sidebar.append(row)
    return row
  })
  expect(typeof preserveDeleteSiblingPosition(rows[100])).toBe('function')
  expect(measurements).toBeLessThanOrEqual(201)
})
