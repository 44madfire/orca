import { describe, expect, it, vi } from 'vitest'
import { setTimeout } from 'node:timers'
import { OrchestrationDb } from './db'
import { mailboxReservations } from './db/messages/mailbox-reservation-projection'
import { MailboxPointerRecovery } from './mailbox-pointer-recovery'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'

describe('mailbox reservation SQL mutation boundary', () => {
  it('clears flights and timers on replacement and close without letting the old DB clear new work', () => {
    vi.useFakeTimers()
    const original = new OrchestrationDb(':memory:')
    const replacement = new OrchestrationDb(':memory:')
    let current = original
    try {
      const state = new OrchestrationMailboxPointerState()
      const recovery = new MailboxPointerRecovery({ getDb: () => current } as never, state)
      recovery.attach(original)
      state.beginFlight('pty').enterTimer = setTimeout(vi.fn(), 1000) as unknown as NodeJS.Timeout
      current = replacement
      recovery.attach(replacement)
      expect(state.hasFlight('pty')).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      state.beginFlight('pty').enterTimer = setTimeout(vi.fn(), 1000) as unknown as NodeJS.Timeout
      original.close()
      expect(state.hasFlight('pty')).toBe(true)
      replacement.close()
      expect(state.hasFlight('pty')).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      for (const db of [original, replacement]) {
        if (mailboxReservations(db).active) {
          db.close()
        }
      }
      vi.useRealTimers()
    }
  })
  it('covers direct exec, explicit conflict policies, and replacement clearing a reservation', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const registry = mailboxReservations(db)
      const listener = vi.fn()
      registry.subscribe(listener)
      listener.mockClear()
      db.db.exec(`INSERT INTO messages (id, from_handle, to_handle, subject,
        pointer_enter_pending, pointer_pty_id, pointer_process_incarnation)
        VALUES ('direct', 'a', 'run:r', 'mail', 1, 'pty', 'inc');
        UPDATE OR ABORT messages SET pointer_enter_pending = 2 WHERE id = 'direct';`)
      expect(listener).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ id: 'direct', pointer_enter_pending: 2 })
      ])
      listener.mockClear()
      db.db.exec(`INSERT OR REPLACE INTO messages (id, from_handle, to_handle, subject)
        VALUES ('direct', 'a', 'run:r', 'replacement')`)
      expect(listener).toHaveBeenCalledExactlyOnceWith([])
      expect(registry.forPty('pty')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('retries observer failure without another title or SQL call and preserves the successful commit', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const registry = mailboxReservations(db)
      const listener = vi.fn()
      registry.subscribe(listener)
      listener.mockClear()
      const prepare = vi.spyOn(db.db, 'prepare').mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY')
      })
      expect(() =>
        db.db.exec(`INSERT INTO messages (id, from_handle, to_handle, subject,
        pointer_enter_pending, pointer_pty_id, pointer_process_incarnation)
        VALUES ('durable', 'a', 'run:r', 'mail', 2, 'pty', 'inc')`)
      ).not.toThrow()
      expect(registry.mayHave('pty')).toBe(true)
      expect(listener).not.toHaveBeenCalled()
      prepare.mockRestore()
      await Promise.resolve()
      expect(listener).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ id: 'durable', pointer_enter_pending: 2 })
      ])
      db.close()
      expect(registry.active).toBe(false)
      expect(registry.forPty('pty')).toEqual([])
    } finally {
      if (mailboxReservations(db).active) {
        db.close()
      }
    }
  })
})
