import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import {
  hasMailboxReservation,
  mailboxReservations
} from './db/messages/mailbox-reservation-projection'

const target = { ptyId: 'pty', processIncarnation: 'inc-1' }
function reserve(db: OrchestrationDb, incarnation = target.processIncarnation) {
  const message = db.insertMessage({ from: 'sender', to: 'run:r', subject: 'mail' })
  expect(
    db.stageMailboxPointerEnter([message.id], { ...target, processIncarnation: incarnation })
  ).toBe(true)
  return message.id
}

describe('database-owned mailbox reservation projection', () => {
  it('publishes direct SQL only after outer commit and discards rolled-back savepoints', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const listener = vi.fn()
      mailboxReservations(db).subscribe(listener)
      listener.mockClear()
      const message = db.insertMessage({ from: 'a', to: 'run:r', subject: 'mail' })
      db.db.exec('BEGIN')
      db.db
        .prepare(`UPDATE messages SET pointer_enter_pending = 2,
        pointer_pty_id = ?, pointer_process_incarnation = ? WHERE id = ?`)
        .run(target.ptyId, target.processIncarnation, message.id)
      expect(listener).not.toHaveBeenCalled()
      db.db.exec('SAVEPOINT nested')
      db.markAsRead([message.id])
      db.db.exec('ROLLBACK TO nested; RELEASE nested')
      expect(listener).not.toHaveBeenCalled()
      db.db.exec('COMMIT')
      expect(listener).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({
          id: message.id,
          pointer_enter_pending: 2,
          pointer_pty_id: target.ptyId,
          pointer_process_incarnation: target.processIncarnation
        })
      ])
      listener.mockClear()
      db.db.exec('BEGIN')
      db.markAsRead([message.id])
      db.db.exec('ROLLBACK')
      expect(listener).not.toHaveBeenCalled()
      expect(hasMailboxReservation(db, target.ptyId)).toBe(true)
      db.db.prepare('DELETE FROM messages WHERE id = ?').run(message.id)
      expect(listener).toHaveBeenCalledExactlyOnceWith([])
    } finally {
      db.close()
    }
  })

  it('publishes nothing for a partially staged batch rolled back by requireAll', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const listener = vi.fn()
      mailboxReservations(db).subscribe(listener)
      listener.mockClear()
      const message = db.insertMessage({ from: 'a', to: 'run:r', subject: 'mail' })
      expect(db.stageMailboxPointerEnter([message.id, 'missing'], target)).toBe(false)
      expect(listener).not.toHaveBeenCalled()
      expect(hasMailboxReservation(db, target.ptyId)).toBe(false)
    } finally {
      db.close()
    }
  })
  it.each(['resetAll', 'resetMessages'] as const)(
    'discards active ownership after %s',
    (method) => {
      const db = new OrchestrationDb(':memory:')
      try {
        reserve(db)
        expect(hasMailboxReservation(db, 'pty')).toBe(true)
        db[method]()
        expect(hasMailboxReservation(db, 'pty')).toBe(false)
        reserve(db)
        expect(hasMailboxReservation(db, 'pty')).toBe(true)
      } finally {
        db.close()
      }
    }
  )

  it('refreshes phase mutation and targeted release without losing another PTY', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const id = reserve(db)
      expect(hasMailboxReservation(db, 'pty')).toBe(true)
      expect(db.markMailboxPointerWriteAttempted([id], target)).toBe(true)
      expect(hasMailboxReservation(db, 'pty')).toBe(true)
      expect(db.markMailboxPointerEnterAttempted([id], target)).toBe(true)
      expect(hasMailboxReservation(db, 'pty')).toBe(true)
      db.settleMailboxPointerEnter([id], target, [3])
      expect(hasMailboxReservation(db, 'pty')).toBe(false)
      const next = reserve(db)
      const other = db.insertMessage({ from: 'a', to: 'run:r', subject: 'other' })
      db.stageMailboxPointerEnter([other.id], { ...target, ptyId: 'other' })
      expect(hasMailboxReservation(db, 'pty')).toBe(true)
      db.releaseMailboxPointerEnter([next], target, [1])
      expect(hasMailboxReservation(db, 'pty')).toBe(false)
      expect(hasMailboxReservation(db, 'other')).toBe(true)
    } finally {
      db.close()
    }
  })
  it('does no SQLite queries across 5000 observations after hydration or settlement', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      db.releasePendingMailboxPointerForPty('pty')
      const prepare = vi.spyOn(db.db, 'prepare')
      for (let i = 0; i < 5000; i++) {
        db.releasePendingMailboxPointerForPty('pty')
      }
      expect(prepare).not.toHaveBeenCalled()
      prepare.mockRestore()
      const id = reserve(db)
      db.releasePendingMailboxPointerForPty('pty')
      expect(db.getMessageById(id)?.pointer_enter_pending).toBe(0)
      db.releasePendingMailboxPointerForPty('pty')
      const settledPrepare = vi.spyOn(db.db, 'prepare')
      for (let i = 0; i < 5000; i++) {
        db.releasePendingMailboxPointerForPty('pty')
      }
      expect(settledPrepare).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it.each([
    'markAsRead',
    'markAsDelivered',
    'markAsUndelivered',
    'markAsReadAndDelivered'
  ] as const)('refreshes the projection after %s', (method) => {
    const db = new OrchestrationDb(':memory:')
    try {
      const id = reserve(db)
      expect(hasMailboxReservation(db, 'pty')).toBe(true)
      db[method]([id])
      expect(hasMailboxReservation(db, 'pty')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('retains eligibility through rollback and never caches transactional absence', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const id = reserve(db)
      expect(hasMailboxReservation(db, 'pty')).toBe(true)
      db.db.exec('BEGIN')
      db.markAsRead([id])
      db.releasePendingMailboxPointerForPty('pty')
      db.db.exec('ROLLBACK')
      expect(hasMailboxReservation(db, 'pty')).toBe(true)
      db.releasePendingMailboxPointerForPty('pty')
      expect(db.getMessageById(id)?.pointer_enter_pending).toBe(0)
    } finally {
      db.close()
    }
  })

  it('refreshes after durable consumer acknowledgment', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'acknowledgment',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab:leaf'
      })
      const mailboxHandle = `run:${run.id}`
      const message = db.insertMessage({
        from: 'sender',
        to: mailboxHandle,
        subject: 'mail',
        runId: run.id
      })
      db.stageMailboxPointerEnter([message.id], target)
      expect(hasMailboxReservation(db, 'pty')).toBe(true)
      const params = { runId: run.id, mailboxHandle, consumerGeneration: 1 }
      const batch = db.getOrCreateMailboxDelivery(params)!
      db.acknowledgeMailboxDelivery({ ...params, deliveryId: batch.delivery.id })
      expect(hasMailboxReservation(db, 'pty')).toBe(false)
      expect(db.getMessageById(message.id)?.read).toBe(1)
    } finally {
      db.close()
    }
  })

  it('hydrates only the active partial index among historical rows', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const insert = db.db.prepare(
        "INSERT INTO messages (id, from_handle, to_handle, subject, read) VALUES (?, 'a', 'b', 'history', 1)"
      )
      db.db.exec('BEGIN')
      for (let i = 0; i < 5000; i++) {
        insert.run(`history-${i}`)
      }
      db.db.exec('COMMIT')
      const prepare = vi.spyOn(db.db, 'prepare')
      expect(hasMailboxReservation(db, 'pty')).toBe(false)
      expect(prepare).not.toHaveBeenCalled()
      const query = `SELECT id, pointer_pty_id, pointer_process_incarnation,
        pointer_enter_pending, to_handle FROM messages WHERE pointer_enter_pending > 0`
      prepare.mockClear()
      for (let i = 0; i < 5000; i++) {
        expect(hasMailboxReservation(db, `pty-${i}`)).toBe(false)
      }
      expect(prepare).not.toHaveBeenCalled()
      prepare.mockRestore()
      const plan = db.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[]
      expect(plan.some(({ detail }) => detail.includes('idx_messages_pending_pointer_pty'))).toBe(
        true
      )
      expect(plan.some(({ detail }) => detail === 'SCAN messages')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('retries failed hydration and cleanup on the same observation', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const id = reserve(db)
      const prepare = vi.spyOn(db.db, 'prepare').mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY')
      })
      expect(() => db.releasePendingMailboxPointerForPty('pty')).toThrow('SQLITE_BUSY')
      expect(hasMailboxReservation(db, 'pty')).toBe(true)
      prepare.mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY')
      })
      expect(() => db.releasePendingMailboxPointerForPty('pty')).toThrow('SQLITE_BUSY')
      prepare.mockRestore()
      db.releasePendingMailboxPointerForPty('pty')
      expect(db.getMessageById(id)?.pointer_enter_pending).toBe(0)
    } finally {
      db.close()
    }
  })

  it('hydrates pending rows after restart and isolates database replacement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-reservations-'))
    const path = join(dir, 'mail.db')
    let db = new OrchestrationDb(path)
    try {
      const id = reserve(db)
      db.markMailboxPointerWriteAttempted([id], target)
      db.close()
      db = new OrchestrationDb(path)
      expect(hasMailboxReservation(db, 'pty')).toBe(true)
      db.releasePendingMailboxPointerForPty('pty')
      expect(db.getMessageById(id)).toMatchObject({
        pointer_enter_pending: 0,
        read: 0,
        delivered_at: expect.any(String)
      })
      const replacement = new OrchestrationDb(':memory:')
      try {
        expect(hasMailboxReservation(replacement, 'pty')).toBe(false)
        reserve(replacement)
        expect(hasMailboxReservation(replacement, 'pty')).toBe(true)
        expect(hasMailboxReservation(db, 'pty')).toBe(false)
      } finally {
        replacement.close()
      }
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scopes deferred working recovery to the flight incarnation', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const old = reserve(db)
      const current = reserve(db, 'inc-2')
      db.releasePendingMailboxPointerForPty('pty', 'inc-1')
      expect(db.getMessageById(old)?.pointer_enter_pending).toBe(0)
      expect(db.getMessageById(current)?.pointer_enter_pending).toBe(1)
      expect(hasMailboxReservation(db, 'pty')).toBe(true)
    } finally {
      db.close()
    }
  })
})
