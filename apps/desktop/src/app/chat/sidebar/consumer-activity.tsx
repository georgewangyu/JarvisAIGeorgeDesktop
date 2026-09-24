import type { JarvisEventRetryResult, JarvisEventReviewResult, JarvisInterruptedEventsResult } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useJarvisCopy } from '@/i18n/jarvis'
import { sessionTitle } from '@/lib/chat-runtime'
import { Activity, iconSize } from '@/lib/icons'
import { isMessagingSource, normalizeSessionSource } from '@/lib/session-source'
import { cn } from '@/lib/utils'
import { $approvalRecoveryReceipts, type ApprovalRecoveryReceipt } from '@/store/approval-recovery'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { sessionMatchesStoredId } from '@/store/session'
import {
  $sessionDotStateById,
  type SessionDotState,
  sessionStatusBucket,
  type SessionStatusBucket
} from '@/store/session-dot-state'
import { isSessionOwnerRoute, sessionOwnerRouteFromRow } from '@/store/session-request-router'
import { knownOwnerForSession } from '@/store/session-states'
import type { CronJob, SessionInfo } from '@/types/hermes'

export interface ConsumerActivityRow {
  id: string
  kind: 'automation' | 'chat'
  status: Exclude<SessionStatusBucket, 'draft' | 'idle'>
  title: string
}

export interface UnavailableApprovalRow {
  id: string
  title: string
}

/** A lost approval has no executable control. Surface it only beside a
 *  visible consumer chat whose exact owner matches the persisted receipt. */
export function buildUnavailableApprovalRows(
  sessions: readonly SessionInfo[],
  receipts: readonly ApprovalRecoveryReceipt[]
): UnavailableApprovalRow[] {
  const latestBySession = new Map<string, { row: UnavailableApprovalRow; seenAt: number }>()

  for (const receipt of receipts) {
    if (receipt.state !== 'interrupted') {continue}

    const session = sessions.find(candidate => {
      const source = normalizeSessionSource(candidate.source)

      return !isMessagingSource(source) &&
        !['cron', 'kanban', 'oneshot', 'subagent', 'tool'].includes(source ?? '') &&
        sessionMatchesStoredId(candidate, receipt.storedSessionId)
    })

    if (!session) {continue}
    const owner = sessionOwnerRouteFromRow(session) ?? knownOwnerForSession(session.id)

    if (!isSessionOwnerRoute(owner) || owner.connectionId !== receipt.connectionId || owner.profile !== receipt.profile) {
      continue
    }

    const previous = latestBySession.get(session.id)

    if (!previous || previous.seenAt < receipt.seenAt) {
      latestBySession.set(session.id, { row: { id: session.id, title: sessionTitle(session) }, seenAt: receipt.seenAt })
    }
  }

  return [...latestBySession.values()]
    .sort((a, b) => b.seenAt - a.seenAt)
    .slice(0, 6)
    .map(item => item.row)
}

export function openConsumerActivityRow(
  row: ConsumerActivityRow,
  session: SessionInfo | undefined,
  onOpenChat: (sessionId: string, session?: SessionInfo) => void,
  onOpenAutomations: (jobId: null | string) => void,
  automationJobs: readonly CronJob[] = []
): void {
  if (row.kind === 'automation') {
    // Cron run ids carry their originating job id, but compression or a
    // legacy backend may produce a different id. Focus only an exact,
    // unambiguous known job; otherwise open the general Automations page.
    const matches = automationJobs.filter(job =>
      new RegExp(`^cron_${job.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d{8}_\\d{6}$`).test(row.id)
    )

    onOpenAutomations(matches.length === 1 ? matches[0].id : null)

    return
  }

  onOpenChat(row.id, session)
}

const STATUS_RANK: Record<ConsumerActivityRow['status'], number> = {
  'needs-input': 0,
  working: 1,
  unread: 2
}

export function buildConsumerActivityRows(
  chatSessions: readonly SessionInfo[],
  states: Readonly<Record<string, SessionDotState>>,
  automationSessions: readonly SessionInfo[] = []
): ConsumerActivityRow[] {
  const sessions = [...chatSessions, ...automationSessions]
  const automationIds = new Set(automationSessions.map(session => session.id))
  const lastActiveById = new Map(sessions.map(session => [session.id, session.last_active]))

  return sessions
    .flatMap(session => {
      const source = normalizeSessionSource(session.source)

      // An optimistic/backend row can briefly enter the recents store even
      // when its normal fetch excludes worker and channel sources. Activity
      // must never turn those private execution titles into consumer rows.
      if (!automationIds.has(session.id) && (isMessagingSource(source) ||
        ['cron', 'kanban', 'oneshot', 'subagent', 'tool'].includes(source ?? ''))) {
        return []
      }

      const status = sessionStatusBucket(states[session.id])

      if (status === 'draft' || status === 'idle') {
        return []
      }

      return [
        {
          id: session.id,
          kind: automationIds.has(session.id) ? ('automation' as const) : ('chat' as const),
          status,
          title: sessionTitle(session)
        }
      ]
    })
    .sort((left, right) => {
      const statusOrder = STATUS_RANK[left.status] - STATUS_RANK[right.status]

      if (statusOrder !== 0) {
        return statusOrder
      }

      return (lastActiveById.get(right.id) ?? 0) - (lastActiveById.get(left.id) ?? 0)
    })
    .slice(0, 6)
}

/** Keep the always-visible Jarvis navigation cue scoped to the current
 *  connection/profile. An unowned row or hidden worker must not light it. */
export function consumerChatCue(
  sessions: readonly SessionInfo[],
  states: Readonly<Record<string, SessionDotState>>,
  receipts: readonly ApprovalRecoveryReceipt[],
  connectionId: null | string,
  profile: string
): 'needs-input' | 'unread' | null {
  if (!connectionId) {return null}

  const owned = sessions.filter(session => {
    const owner = sessionOwnerRouteFromRow(session) ?? knownOwnerForSession(session.id)

    return isSessionOwnerRoute(owner) && owner.connectionId === connectionId && owner.profile === profile
  })

  const activityRows = buildConsumerActivityRows(owned, states)

  if (activityRows.some(row => row.status === 'needs-input') ||
    buildUnavailableApprovalRows(owned, receipts.filter(row => row.connectionId === connectionId && row.profile === profile)).length > 0) {
    return 'needs-input'
  }

  return activityRows.some(row => row.status === 'unread') ? 'unread' : null
}

export function ConsumerActivity({
  automationJobs = [],
  automationSessions = [],
  onOpenChat,
  onOpenAutomations,
  sessions
}: {
  automationJobs?: readonly CronJob[]
  automationSessions?: readonly SessionInfo[]
  onOpenChat: (sessionId: string, session?: SessionInfo) => void
  onOpenAutomations: (jobId: null | string) => void
  sessions: readonly SessionInfo[]
}) {
  const copy = useJarvisCopy()
  const states = useStore($sessionDotStateById)
  const approvalReceipts = useStore($approvalRecoveryReceipts)
  const gateway = useStore($gateway)
  const profile = useStore($activeGatewayProfile)
  const [refreshIndex, setRefreshIndex] = useState(0)

  const [interruptedSnapshot, setInterruptedSnapshot] = useState<{
    events: JarvisInterruptedEventsResult['events']
    gateway: typeof gateway
    profile: string
  } | null>(null)

  const [interruptedLoadError, setInterruptedLoadError] = useState(false)
  const [review, setReview] = useState<null | (JarvisEventReviewResult & { gateway: typeof gateway; profile: string })>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [retryStatus, setRetryStatus] = useState('')

  const currentReview = review?.gateway === gateway && review.profile === profile ? review : null

  useEffect(() => {
    setReview(null)
    setAcknowledged(false)
    setReviewError('')
    setRetryStatus('')
  }, [gateway, profile])

  async function openReview(deliveryId: string) {
    if (!gateway || reviewBusy) {return}
    setReviewBusy(true)
    setReviewError('')
    setRetryStatus('')

    try {
      const result = await gateway.request<JarvisEventReviewResult>('jarvis.events.review', {
        profile,
        delivery_id: deliveryId
      })

      if ($gateway.get() !== gateway || $activeGatewayProfile.get() !== profile) {return}
      setReview({ ...result, gateway, profile })
      setAcknowledged(false)
    } catch {
      setReviewError('Could not load the original request. Please try again.')
    } finally {
      setReviewBusy(false)
    }
  }

  async function retryReviewed() {
    if (!gateway || !currentReview || !acknowledged || reviewBusy) {return}
    setReviewBusy(true)
    setReviewError('')

    try {
      const result = await gateway.request<JarvisEventRetryResult>('jarvis.events.retry', {
        profile,
        delivery_id: currentReview.delivery_id,
        review_digest: currentReview.review_digest
      })

      if ($gateway.get() !== gateway || $activeGatewayProfile.get() !== profile) {return}
      setRetryStatus(result.status === 'queued' ? 'Retry queued. The outcome is not yet known.' : `Retry status: ${result.status}.`)
      setRefreshIndex(index => index + 1)
    } catch {
      setReviewError('Could not queue the retry. The original outcome is still unknown.')
    } finally {
      setReviewBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    setInterruptedLoadError(false)

    if (gateway) {
      void gateway.request<JarvisInterruptedEventsResult>('jarvis.events.interrupted', { profile }).then(
        result => {
          if (!cancelled) {
            setInterruptedSnapshot({ events: result.events, gateway, profile })
          }
        },
        () => {
          if (!cancelled) {
            setInterruptedLoadError(true)
          }
        }
      )
    }

    return () => {
      cancelled = true
    }
  }, [gateway, profile, refreshIndex])

  const interrupted = interruptedSnapshot?.gateway === gateway && interruptedSnapshot.profile === profile
    ? interruptedSnapshot.events
    : []

  const rows = buildConsumerActivityRows(sessions, states, automationSessions)
  const unavailableApprovals = buildUnavailableApprovalRows(sessions, approvalReceipts)
  const unavailableIds = new Set(unavailableApprovals.map(row => row.id))
  const visibleRows = rows.filter(row => !unavailableIds.has(row.id))
  const sessionById = new Map([...sessions, ...automationSessions].map(session => [session.id, session]))

  const attentionCount = interrupted.filter(event => event.retry_status !== 'settled').length +
    visibleRows.filter(row => row.status === 'needs-input').length + unavailableApprovals.length

  return (
    <>
    <Popover onOpenChange={open => {
      if (open) {
        setRefreshIndex(index => index + 1)
      }
    }}>
      <PopoverTrigger asChild>
        <Button aria-label={copy.activity} className="relative" size="icon-sm" variant="ghost">
          <Activity className={iconSize.sm} />
          {visibleRows.length > 0 || interrupted.length > 0 || unavailableApprovals.length > 0 ? (
            <span
              aria-hidden="true"
              className={cn(
                'absolute right-0.5 top-0.5 size-1.5 rounded-full',
                attentionCount > 0 ? 'bg-amber-500' : 'bg-(--ui-accent)'
              )}
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0" side="right" sideOffset={8}>
        <div className="px-3 pb-2 pt-3">
          <p className="text-sm font-medium">{copy.activity}</p>
          <p className="mt-0.5 text-xs text-(--ui-text-tertiary)">
            {visibleRows.length > 0 || interrupted.length > 0 || unavailableApprovals.length > 0 ? copy.activityDetail : copy.activityReadyDetail}
          </p>
        </div>
        {interrupted.map(event => (
          <div className="border-t border-(--ui-stroke-tertiary) px-3 py-3" key={event.delivery_id} role="status">
            <p className="text-sm font-medium text-foreground">
              {event.retry_status === 'settled' ? 'Reviewed retry finished'
                : event.retry_status === 'queued' || event.retry_status === 'claimed' ? 'Reviewed retry in progress'
                  : event.retry_status ? 'Reviewed retry could not finish' : 'Outcome unknown after restart'}
            </p>
            <p className="mt-1 text-xs leading-5 text-(--ui-text-secondary)">
              {event.retry_status === 'settled'
                ? 'The original outcome remains unknown. Your reviewed retry finished; see its reply in the Jarvis chat.'
                : event.retry_status === 'queued' || event.retry_status === 'claimed'
                  ? 'The original outcome remains unknown. Your reviewed retry has not finished yet.'
                  : event.retry_status
                    ? 'The original outcome remains unknown. The reviewed retry did not finish; check Jarvis before asking again.'
                    : 'One background request may have finished before Jarvis restarted. Check the result before asking Jarvis to try again; nothing was replayed automatically.'}
            </p>
            {!event.retry_status ? (
              <Button disabled={reviewBusy} onClick={() => void openReview(event.delivery_id)} size="inline" variant="textStrong">
                Review request
              </Button>
            ) : null}
            {reviewError && !currentReview ? <p className="text-xs text-destructive" role="alert">{reviewError}</p> : null}
          </div>
        ))}
        {unavailableApprovals.map(row => (
          <button
            className="flex w-full flex-col border-t border-(--ui-stroke-tertiary) px-3 py-3 text-left hover:bg-(--ui-control-hover-background)"
            key={row.id}
            onClick={() => onOpenChat(row.id, sessionById.get(row.id))}
            type="button"
          >
            <span className="text-sm font-medium text-foreground">{row.title}</span>
            <span className="mt-1 text-xs text-(--ui-text-secondary)">Approval no longer available · Review chat before retrying</span>
          </button>
        ))}
        {interruptedLoadError ? (
          <div className="border-t border-(--ui-stroke-tertiary) px-3 py-3 text-xs text-(--ui-text-secondary)">
            Could not check interrupted activity.{' '}
            <Button onClick={() => setRefreshIndex(index => index + 1)} size="inline" variant="textStrong">Retry</Button>
          </div>
        ) : null}
        {visibleRows.length === 0 && unavailableApprovals.length === 0 && interrupted.length === 0 && !interruptedLoadError ? (
          <div className="border-t border-(--ui-stroke-tertiary) px-3 py-3 text-sm text-(--ui-text-secondary)">
            {copy.activityReady}
          </div>
        ) : visibleRows.length > 0 ? (
          <div className="border-t border-(--ui-stroke-tertiary) py-1">
            {visibleRows.map(row => (
              <button
                className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-(--ui-control-hover-background)"
                key={row.id}
                onClick={() => openConsumerActivityRow(row, sessionById.get(row.id), onOpenChat, onOpenAutomations, automationJobs)}
                type="button"
              >
                {row.kind === 'automation' ? (
                  <Codicon
                    className={cn(
                      'mt-0.5 shrink-0',
                      row.status === 'needs-input'
                        ? 'text-amber-500'
                        : row.status === 'unread'
                          ? 'text-(--ui-success)'
                          : 'text-(--ui-accent)'
                    )}
                    name="watch"
                    size="0.875rem"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-1.5 size-1.5 shrink-0 rounded-full',
                      row.status === 'needs-input'
                        ? 'bg-amber-500'
                        : row.status === 'unread'
                          ? 'bg-(--ui-success)'
                          : 'bg-(--ui-accent)'
                    )}
                  />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">{row.title}</span>
                  <span className="block text-xs text-(--ui-text-tertiary)">
                    {row.kind === 'automation'
                      ? row.status === 'needs-input'
                        ? copy.activityAutomationNeedsInput
                        : row.status === 'unread'
                          ? copy.activityAutomationFinished
                          : copy.activityAutomationWorking
                      : row.status === 'needs-input'
                        ? copy.activityNeedsInput
                        : row.status === 'unread'
                          ? copy.activityFinished
                          : copy.activityWorking}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
    <Dialog onOpenChange={open => {if (!open) {setReview(null); setAcknowledged(false); setReviewError(''); setRetryStatus('')}}} open={Boolean(currentReview)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Review interrupted request</DialogTitle>
          <DialogDescription>Jarvis may have already acted on this request before restarting. Review it before choosing to retry.</DialogDescription>
        </DialogHeader>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-(--ui-control-hover-background) p-3 text-xs">{currentReview?.message}</pre>
        <label className="flex items-start gap-2 text-sm">
          <input checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} type="checkbox" />
          I understand retrying may repeat actions that already happened.
        </label>
        {reviewError ? <p className="text-sm text-destructive" role="alert">{reviewError}</p> : null}
        {retryStatus ? <p className="text-sm" role="status">{retryStatus}</p> : null}
        <DialogFooter>
          <Button onClick={() => setReview(null)} variant="outline">Close</Button>
          <Button disabled={!acknowledged || reviewBusy || Boolean(retryStatus)} onClick={() => void retryReviewed()}>
            {reviewBusy ? 'Queuing…' : 'Retry this request'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}
