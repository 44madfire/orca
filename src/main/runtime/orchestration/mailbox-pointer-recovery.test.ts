import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'

function harness(initial: OrchestrationDb) {
  let db = initial
  let incarnation = 'inc-1'
  const leaf: OrchestrationMailboxLeaf = {
    tabId: 'tab',
    leafId: 'leaf',
    ptyId: 'pty',
    writable: true,
    lastAgentStatus: 'working',
    lastOscTitle: null,
    lastAgentStatusObservedLive: true
  }
  const deps = {
    getDb: () => db,
    deliveryTarget: { resolveTerminalHandle: () => 'term' },
    getLiveLeafForHandle: () => leaf,
    resolveSubmitTarget: () => ({ leaf, terminalHandle: 'term', processIncarnation: incarnation }),
    redriveMailbox: vi.fn()
  } as unknown as PointerDeliveryDependencies<never>
  const owner = new OrchestrationMailboxPointerDelivery(deps)
  owner.attachDatabase(db)
  return {
    owner,
    leaf,
    replace(next: OrchestrationDb) {
      db = next
      owner.attachDatabase(db)
    },
    setIncarnation(next: string) {
      incarnation = next
    }
  }
}

function pending(db: OrchestrationDb, phase = 1, incarnation = 'inc-1') {
  const message = db.insertMessage({ from: 'a', to: 'run:r', subject: 'mail' })
  db.db
    .prepare(`UPDATE messages SET pointer_enter_pending = ?, pointer_pty_id = 'pty',
    pointer_process_incarnation = ? WHERE id = ?`)
    .run(phase, incarnation, message.id)
  return message.id
}

describe('reservation-owned pointer recovery', () => {
  it.each([1, 2, 3])(
    'reconciles committed phase %s after the last working edge without another observation',
    (phase) => {
      const db = new OrchestrationDb(':memory:')
      try {
        const { owner } = harness(db)
        owner.observeAgentWorking('pty')
        const prepare = vi.spyOn(db.db, 'prepare')
        for (let i = 0; i < 5000; i++) {
          owner.observeAgentWorking('pty')
        }
        expect(prepare).not.toHaveBeenCalled()
        prepare.mockRestore()
        const id = pending(db, phase)
        expect(db.getMessageById(id)).toMatchObject({
          pointer_enter_pending: 0,
          read: 0,
          delivered_at: phase === 1 ? null : expect.any(String)
        })
      } finally {
        db.close()
      }
    }
  )

  it('waits for commit and never recovers a rolled-back reservation', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      harness(db)
      db.db.exec('BEGIN')
      const id = pending(db, 2)
      expect(db.getMessageById(id)?.pointer_enter_pending).toBe(2)
      db.db.exec('COMMIT')
      expect(db.getMessageById(id)?.pointer_enter_pending).toBe(0)
      db.db.exec('BEGIN')
      const rolledBack = pending(db)
      db.db.exec('ROLLBACK')
      expect(db.getMessageById(rolledBack)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('hydrates on attach and fences DB replacement and reused PTY incarnations', () => {
    const original = new OrchestrationDb(':memory:')
    const replacement = new OrchestrationDb(':memory:')
    try {
      const old = pending(original, 2)
      const next = pending(replacement, 3)
      const { owner, replace, setIncarnation } = harness(original)
      expect(original.getMessageById(old)?.pointer_enter_pending).toBe(0)
      replace(replacement)
      expect(replacement.getMessageById(next)?.pointer_enter_pending).toBe(0)
      const detached = pending(original, 2)
      expect(original.getMessageById(detached)?.pointer_enter_pending).toBe(2)
      setIncarnation('inc-2')
      const previousIncarnation = pending(replacement, 2)
      owner.observeAgentWorking('pty')
      expect(replacement.getMessageById(previousIncarnation)?.pointer_enter_pending).toBe(2)
      const current = pending(replacement, 2, 'inc-2')
      expect(replacement.getMessageById(current)?.pointer_enter_pending).toBe(0)
    } finally {
      original.close()
      replacement.close()
    }
  })
})
