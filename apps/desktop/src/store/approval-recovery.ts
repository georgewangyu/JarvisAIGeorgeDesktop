import { atom } from 'nanostores'

import type { SessionOwnerRoute } from './session-request-router'

// This is a local, non-executable receipt, not an approval queue. The backend
// alone decides whether an approval is still actionable. Never persist the
// command, description, choice, or server-request id here.
const STORAGE_KEY = 'hermes.desktop.approvalRecovery.v1'
const MAX_RECEIPTS = 50

export interface ApprovalRecoveryReceipt {
  connectionId: string
  profile: string
  storedSessionId: string
  runtimeSessionId: string
  requestId: string
  state: 'pending' | 'interrupted'
  seenAt: number
}

type ApprovalOwner = Pick<SessionOwnerRoute, 'connectionId' | 'profile'>

const sameOwner = (receipt: ApprovalRecoveryReceipt, owner: ApprovalOwner) =>
  receipt.connectionId === owner.connectionId && receipt.profile === owner.profile

const valid = (value: unknown): value is ApprovalRecoveryReceipt => {
  if (!value || typeof value !== 'object') {return false}
  const row = value as Partial<ApprovalRecoveryReceipt>

  return ['connectionId', 'profile', 'storedSessionId', 'runtimeSessionId', 'requestId']
    .every(key => typeof row[key as keyof ApprovalRecoveryReceipt] === 'string' && Boolean(row[key as keyof ApprovalRecoveryReceipt])) &&
    (row.state === 'pending' || row.state === 'interrupted') &&
    typeof row.seenAt === 'number' && Number.isFinite(row.seenAt)
}

const load = (): ApprovalRecoveryReceipt[] => {
  if (typeof window === 'undefined') {return []}

  try {
    const rows: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')

    return Array.isArray(rows) ? rows.filter(valid).slice(-MAX_RECEIPTS) : []
  } catch {
    return []
  }
}

export const $approvalRecoveryReceipts = atom<ApprovalRecoveryReceipt[]>(load())

function write(rows: ApprovalRecoveryReceipt[]): void {
  const limited = rows.slice(-MAX_RECEIPTS)
  $approvalRecoveryReceipts.set(limited)

  if (typeof window === 'undefined') {return}

  try {
    if (limited.length) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(limited))
    } else {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // A storage failure must not turn an approval into an automatic action.
  }
}

export function noteApprovalPending(
  owner: ApprovalOwner,
  storedSessionId: string,
  runtimeSessionId: string,
  requestId: string
): void {
  const rows = $approvalRecoveryReceipts.get()
  const prior = rows.find(row => sameOwner(row, owner) && row.storedSessionId === storedSessionId && row.requestId === requestId)

  // Replaying a still-live request clears a stale interruption indication.
  write([
    ...rows.filter(row => row !== prior),
    {
      connectionId: owner.connectionId,
      profile: owner.profile,
      storedSessionId,
      runtimeSessionId,
      requestId,
      state: 'pending',
      seenAt: prior?.seenAt ?? Date.now()
    }
  ])
}

export function noteApprovalAnswered(owner: ApprovalOwner, storedSessionId: string, requestId: string): void {
  const rows = $approvalRecoveryReceipts.get()
  const next = rows.filter(row => !(sameOwner(row, owner) && row.storedSessionId === storedSessionId && row.requestId === requestId))

  if (next.length !== rows.length) {write(next)}
}

/** Call only after a successful, authoritative approval.pending response. */
export function reconcileApprovalRecovery(
  owner: ApprovalOwner,
  storedSessionId: string,
  pendingIds: ReadonlySet<string>,
  settledIds: ReadonlySet<string> = new Set()
): void {
  const rows = $approvalRecoveryReceipts.get()
  let changed = false

  const next = rows.flatMap(row => {
    if (!sameOwner(row, owner) || row.storedSessionId !== storedSessionId) {return [row]}

    if (settledIds.has(row.requestId) && !pendingIds.has(row.requestId)) {
      changed = true

      return []
    }

    if (row.state !== 'pending' || pendingIds.has(row.requestId)) {return [row]}

    changed = true

    return [{ ...row, state: 'interrupted' as const }]
  })

  if (changed) {write(next)}
}

export function dismissApprovalRecovery(owner: ApprovalOwner, storedSessionId: string): void {
  write($approvalRecoveryReceipts.get().filter(row =>
    !(sameOwner(row, owner) && row.storedSessionId === storedSessionId && row.state === 'interrupted')
  ))
}

export function dropApprovalRecoveryForProfile(profile: string, connectionId = 'local'): void {
  write($approvalRecoveryReceipts.get().filter(row => row.connectionId !== connectionId || row.profile !== profile))
}

export function migrateApprovalRecoveryForProfile(from: string, to: string, connectionId = 'local'): void {
  write($approvalRecoveryReceipts.get().map(row =>
    row.connectionId === connectionId && row.profile === from ? { ...row, profile: to } : row
  ))
}
