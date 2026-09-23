import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useJarvisCopy } from '@/i18n/jarvis'
import { sessionTitle } from '@/lib/chat-runtime'
import { Activity, iconSize } from '@/lib/icons'
import { isMessagingSource, normalizeSessionSource } from '@/lib/session-source'
import { cn } from '@/lib/utils'
import {
  $sessionDotStateById,
  type SessionDotState,
  sessionStatusBucket,
  type SessionStatusBucket
} from '@/store/session-dot-state'
import type { SessionInfo } from '@/types/hermes'

export interface ConsumerActivityRow {
  id: string
  kind: 'automation' | 'chat'
  status: Exclude<SessionStatusBucket, 'draft' | 'idle'>
  title: string
}

export function openConsumerActivityRow(
  row: ConsumerActivityRow,
  session: SessionInfo | undefined,
  onOpenChat: (sessionId: string, session?: SessionInfo) => void,
  onOpenAutomations: () => void
): void {
  if (row.kind === 'automation') {
    onOpenAutomations()

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

export function ConsumerActivity({
  automationSessions = [],
  onOpenChat,
  onOpenAutomations,
  sessions
}: {
  automationSessions?: readonly SessionInfo[]
  onOpenChat: (sessionId: string, session?: SessionInfo) => void
  onOpenAutomations: () => void
  sessions: readonly SessionInfo[]
}) {
  const copy = useJarvisCopy()
  const states = useStore($sessionDotStateById)
  const rows = buildConsumerActivityRows(sessions, states, automationSessions)
  const sessionById = new Map([...sessions, ...automationSessions].map(session => [session.id, session]))
  const attentionCount = rows.filter(row => row.status === 'needs-input').length

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button aria-label={copy.activity} className="relative" size="icon-sm" variant="ghost">
          <Activity className={iconSize.sm} />
          {rows.length > 0 ? (
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
            {rows.length > 0 ? copy.activityDetail : copy.activityReadyDetail}
          </p>
        </div>
        {rows.length === 0 ? (
          <div className="border-t border-(--ui-stroke-tertiary) px-3 py-3 text-sm text-(--ui-text-secondary)">
            {copy.activityReady}
          </div>
        ) : (
          <div className="border-t border-(--ui-stroke-tertiary) py-1">
            {rows.map(row => (
              <button
                className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-(--ui-control-hover-background)"
                key={row.id}
                onClick={() => openConsumerActivityRow(row, sessionById.get(row.id), onOpenChat, onOpenAutomations)}
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
        )}
      </PopoverContent>
    </Popover>
  )
}
