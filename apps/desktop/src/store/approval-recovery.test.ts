import { beforeEach, describe, expect, it, vi } from 'vitest'

const ownerA = { connectionId: 'local', profile: 'default' }
const ownerB = { connectionId: 'remote', profile: 'default' }

beforeEach(() => {
  window.localStorage.removeItem('hermes.desktop.approvalRecovery.v1')
  vi.resetModules()
})

describe('approval recovery receipt', () => {
  it('persists only opaque scope metadata and restores it after renderer restart', async () => {
    const first = await import('./approval-recovery')
    first.noteApprovalPending(ownerA, 'stored-1', 'runtime-1', 'request-1')

    const persisted = window.localStorage.getItem('hermes.desktop.approvalRecovery.v1') ?? ''
    expect(persisted).toContain('request-1')
    expect(persisted).not.toContain('dangerous command')

    vi.resetModules()
    const restored = await import('./approval-recovery')
    expect(restored.$approvalRecoveryReceipts.get()).toEqual(first.$approvalRecoveryReceipts.get())
    restored.reconcileApprovalRecovery(ownerA, 'stored-1', new Set())
    expect(restored.$approvalRecoveryReceipts.get()[0].state).toBe('interrupted')
  })

  it('keeps a live pending approval and removes an answered one', async () => {
    const receipts = await import('./approval-recovery')
    receipts.noteApprovalPending(ownerA, 'stored-1', 'runtime-1', 'request-1')
    receipts.reconcileApprovalRecovery(ownerA, 'stored-1', new Set(['request-1']))
    expect(receipts.$approvalRecoveryReceipts.get()[0].state).toBe('pending')

    receipts.noteApprovalAnswered(ownerA, 'stored-1', 'request-1')
    expect(receipts.$approvalRecoveryReceipts.get()).toEqual([])
    expect(window.localStorage.getItem('hermes.desktop.approvalRecovery.v1')).toBeNull()
  })

  it('never crosses connection or profile boundaries for identical ids', async () => {
    const receipts = await import('./approval-recovery')
    receipts.noteApprovalPending(ownerA, 'same-session', 'runtime-a', 'same-request')
    receipts.noteApprovalPending(ownerB, 'same-session', 'runtime-b', 'same-request')
    receipts.reconcileApprovalRecovery(ownerA, 'same-session', new Set())

    expect(receipts.$approvalRecoveryReceipts.get().map(row => [row.connectionId, row.state])).toEqual([
      ['local', 'interrupted'],
      ['remote', 'pending']
    ])
    receipts.dismissApprovalRecovery(ownerB, 'same-session')
    expect(receipts.$approvalRecoveryReceipts.get()).toHaveLength(2)
    receipts.dismissApprovalRecovery(ownerA, 'same-session')
    expect(receipts.$approvalRecoveryReceipts.get()).toHaveLength(1)
  })

  it('removes only same-session accepted decisions and leaves lost requests visible', async () => {
    const receipts = await import('./approval-recovery')
    receipts.noteApprovalPending(ownerA, 'stored-1', 'runtime-1', 'answered')
    receipts.noteApprovalPending(ownerA, 'stored-1', 'runtime-1', 'unknown')
    receipts.noteApprovalPending(ownerB, 'stored-1', 'runtime-2', 'answered')
    receipts.reconcileApprovalRecovery(ownerA, 'stored-1', new Set(), new Set(['answered']))
    expect(receipts.$approvalRecoveryReceipts.get().map(row => [row.connectionId, row.requestId, row.state])).toEqual([
      ['local', 'unknown', 'interrupted'],
      ['remote', 'answered', 'pending']
    ])
  })

  it('migrates and drops only a local profile after rename/delete', async () => {
    const receipts = await import('./approval-recovery')
    receipts.noteApprovalPending(ownerA, 's', 'r', 'a')
    receipts.noteApprovalPending(ownerB, 's', 'r', 'b')
    receipts.migrateApprovalRecoveryForProfile('default', 'renamed')
    expect(receipts.$approvalRecoveryReceipts.get().map(row => row.profile)).toEqual(['renamed', 'default'])
    receipts.dropApprovalRecoveryForProfile('renamed')
    expect(receipts.$approvalRecoveryReceipts.get().map(row => row.connectionId)).toEqual(['remote'])
  })

  it('rejects corrupted persisted data without an executable fallback', async () => {
    window.localStorage.setItem('hermes.desktop.approvalRecovery.v1', '{broken')
    const receipts = await import('./approval-recovery')
    expect(receipts.$approvalRecoveryReceipts.get()).toEqual([])
  })
})
