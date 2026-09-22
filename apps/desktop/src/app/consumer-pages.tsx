import type { SessionGoalSetCompletedResult, SessionGoalsListResult } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import { stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $cronJobs, setCronFocusJobId } from '@/store/cron'
import { $gateway } from '@/store/gateway'
import { $goalsBySession, setSessionGoal } from '@/store/goals'
import { $activeGatewayProfile } from '@/store/profile'
import { $sessions } from '@/store/session'
import type { CronJob } from '@/types/hermes'

import { jobState, nextRunOverdueMs, STATE_DOT } from './cron/job-state'
import { CRON_ROUTE, NEW_CHAT_ROUTE, sessionRoute } from './routes'

export function ConsumerPage({
  children,
  description,
  title
}: {
  children: ReactNode
  description: string
  title: string
}) {
  return (
    <div className="consumer-page h-full overflow-y-auto bg-(--ui-chat-surface-background) pt-(--titlebar-height)">
      <main className="mx-auto w-full max-w-3xl px-8 pb-20 pt-10">
        <h1 className="text-3xl font-semibold tracking-[-0.035em]">{title}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-(--ui-text-secondary)">{description}</p>
        <div className="mt-9">{children}</div>
      </main>
    </div>
  )
}

function EmptyState({ children, icon, title }: { children: ReactNode; icon: string; title: string }) {
  return (
    <div className="grid min-h-72 place-items-center rounded-3xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) p-8 text-center">
      <div>
        <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-(--ui-bg-tertiary)">
          <Codicon className="text-(--ui-text-secondary)" name={icon} size="1.25rem" />
        </div>
        <h2 className="mt-5 text-lg font-semibold">{title}</h2>
        <div className="mx-auto mt-2 max-w-md text-sm leading-6 text-(--ui-text-tertiary)">{children}</div>
      </div>
    </div>
  )
}

function formatRelativeTime(seconds: number): string {
  const elapsed = Math.max(0, Date.now() - seconds * 1000)
  const minutes = Math.floor(elapsed / 60_000)

  if (minutes < 1) {
    return 'Just now'
  }

  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) {
    return `${hours}h ago`
  }

  const days = Math.floor(hours / 24)

  return `${days}d ago`
}

function feedJobDescription(job: CronJob): string {
  const state = jobState(job)

  if (state === 'completed') {
    return 'Completed'
  }

  if (state === 'running') {
    return 'Running now'
  }

  if (state === 'paused' || state === 'disabled') {
    return 'Paused'
  }

  if (state === 'error' || nextRunOverdueMs(job) !== null) {
    return 'Needs attention'
  }

  return job.schedule_display || job.schedule?.display || 'Scheduled'
}

export function ConsumerFeedView() {
  const navigate = useNavigate()
  const sessions = useStore($sessions)
  const jobs = useStore($cronJobs)

  const recentSessions = [...sessions]
    .filter(session => !session.archived)
    .sort((a, b) => b.last_active - a.last_active)
    .slice(0, 8)

  return (
    <ConsumerPage description="Recent conversations and scheduled work, collected in one calm timeline." title="Feed">
      {recentSessions.length === 0 && jobs.length === 0 ? (
        <EmptyState icon="list-flat" title="Nothing new yet">
          Jarvis will collect recent conversations and automation activity here as you use the app.
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {recentSessions.length > 0 ? (
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-(--ui-text-tertiary)">
                Recent chats
              </h2>
              <div className="mt-3 overflow-hidden rounded-3xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)">
                {recentSessions.map(session => (
                  <button
                    className="flex w-full items-center gap-4 border-t border-(--ui-stroke-tertiary) px-5 py-4 text-left transition-colors first:border-t-0 hover:bg-(--ui-control-hover-background)"
                    key={session.id}
                    onClick={() => navigate(sessionRoute(session.id))}
                    type="button"
                  >
                    <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-(--ui-bg-tertiary)">
                      <Codicon name="comment-discussion" size="1rem" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{session.title || 'Untitled chat'}</span>
                      <span className="mt-1 block truncate text-sm text-(--ui-text-tertiary)">
                        {session.preview || 'Open this conversation'}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-(--ui-text-tertiary)">
                      {formatRelativeTime(session.last_active)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {jobs.length > 0 ? (
            <section>
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-(--ui-text-tertiary)">
                  Automations
                </h2>
                <Button onClick={() => navigate(CRON_ROUTE)} size="sm" variant="text">
                  View automations
                </Button>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {jobs.slice(0, 4).map(job => (
                  <button
                    className="rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) p-5 text-left transition-colors hover:bg-(--ui-control-hover-background)"
                    key={job.id}
                    onClick={() => {
                      setCronFocusJobId(job.id)
                      navigate(CRON_ROUTE)
                    }}
                    type="button"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{job.name || 'Scheduled task'}</span>
                      <span className={cn('size-2 rounded-full', STATE_DOT[jobState(job)] ?? STATE_DOT.disabled)} />
                    </div>
                    <p className="mt-2 text-sm text-(--ui-text-tertiary)">
                      {feedJobDescription(job)}
                    </p>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </ConsumerPage>
  )
}

const IDEAS = [
  ['Plan my day', 'Help me plan today around my calendar, priorities, and energy.'],
  ['Catch me up', 'Give me a concise catch-up on what needs my attention today.'],
  ['Prepare for a meeting', 'Help me prepare for an upcoming meeting and identify the decisions I need to make.'],
  ['Organize a project', 'Turn a project I have in mind into a clear plan with milestones and next actions.'],
  ['Research a decision', 'Help me research a decision, compare the options, and surface the tradeoffs.'],
  ['Build a routine', 'Help me create a realistic recurring routine and decide what Jarvis should automate.']
] as const

function startConsumerDraft(prompt: string, navigate: ReturnType<typeof useNavigate>): void {
  const current = takeSessionDraft(null)
  const text = current.text.trim() ? `${current.text.trimEnd()}\n\n${prompt}` : prompt
  stashSessionDraft(null, text, current.attachments)
  navigate(NEW_CHAT_ROUTE)
}

export function ConsumerIdeasView() {
  const navigate = useNavigate()

  const startIdea = (prompt: string) => {
    startConsumerDraft(prompt, navigate)
  }

  return (
    <ConsumerPage description="Useful starting points for everyday work. Pick one and make it yours." title="Ideas">
      <div className="grid gap-4 sm:grid-cols-2">
        {IDEAS.map(([title, prompt], index) => (
          <button
            className="group min-h-40 rounded-3xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) p-6 text-left transition-all hover:-translate-y-0.5 hover:bg-(--ui-control-hover-background) hover:shadow-sm"
            key={title}
            onClick={() => startIdea(prompt)}
            type="button"
          >
            <span className="grid size-10 place-items-center rounded-2xl bg-(--ui-bg-tertiary) text-(--ui-accent)">
              <Codicon name={['calendar', 'bell', 'organization', 'map', 'search', 'history'][index]} size="1rem" />
            </span>
            <span className="mt-5 block font-semibold">{title}</span>
            <span className="mt-2 block text-sm leading-5 text-(--ui-text-tertiary)">{prompt}</span>
          </button>
        ))}
      </div>
    </ConsumerPage>
  )
}

type SavedGoalRow = SessionGoalsListResult['goals'][number]

export function ConsumerGoalsView() {
  const navigate = useNavigate()
  const goals = useStore($goalsBySession)
  const sessions = useStore($sessions)
  const gateway = useStore($gateway)
  const profile = useStore($activeGatewayProfile)

  const [savedGoalsSnapshot, setSavedGoalsSnapshot] = useState<{
    gateway: typeof gateway
    goals: SavedGoalRow[]
    profile: string
  } | null>(null)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [refreshIndex, setRefreshIndex] = useState(0)
  const [pendingGoalId, setPendingGoalId] = useState<string | null>(null)
  const [goalUpdateError, setGoalUpdateError] = useState(false)

  useEffect(() => {
    let cancelled = false

    setSavedGoalsSnapshot(null)
    setLoading(Boolean(gateway))
    setLoadError(false)

    if (gateway) {
      void gateway.request<SessionGoalsListResult>('session.goals.list', { profile }).then(
        result => {
          if (!cancelled) {
            setSavedGoalsSnapshot({ gateway, goals: result.goals, profile })
            setLoading(false)
          }
        },
        () => {
          if (!cancelled) {
            setLoadError(true)
            setLoading(false)
          }
        }
      )
    }

    return () => {
      cancelled = true
    }
  }, [gateway, profile, refreshIndex])

  const sessionById = new Map(sessions.map(session => [session.id, session]))

  const savedGoals = savedGoalsSnapshot?.gateway === gateway && savedGoalsSnapshot.profile === profile
    ? savedGoalsSnapshot.goals
    : []

  const itemsById = new Map<string, { detail?: string; status: string; title: string; updatedAt: number }>(
    savedGoals.map(row => [row.session_id, {
      detail: row.session_title,
      status: row.goal.status,
      title: row.goal.title,
      updatedAt: row.goal.updated_at ?? 0
    }])
  )

  for (const [sessionId, goal] of Object.entries(goals)) {
    if (sessionById.has(sessionId)) {
      itemsById.set(sessionId, goal)
    }
  }

  const items = [...itemsById.entries()].sort(([, a], [, b]) => b.updatedAt - a.updatedAt)

  const startGoal = () => {
    startConsumerDraft('Help me set a goal and turn it into a realistic plan: ', navigate)
  }

  const toggleGoalCompletion = async (sessionId: string, completed: boolean) => {
    if (!gateway || pendingGoalId) {
      return
    }

    setPendingGoalId(sessionId)
    setGoalUpdateError(false)

    try {
      const result = await gateway.request<SessionGoalSetCompletedResult>('session.goals.set_completed', {
        completed: !completed,
        profile,
        session_id: sessionId
      })

      if ($gateway.get() !== gateway || $activeGatewayProfile.get() !== profile) {
        return
      }

      setSavedGoalsSnapshot(current => current?.gateway === gateway && current.profile === profile
        ? {
            ...current,
            goals: [result.goal, ...current.goals.filter(row => row.session_id !== sessionId)]
          }
        : current)
      setSessionGoal(sessionId, {
        status: completed ? 'active' : 'done',
        title: result.goal.goal.title,
        updatedAt: Date.now()
      })
    } catch {
      if ($gateway.get() === gateway && $activeGatewayProfile.get() === profile) {
        setGoalUpdateError(true)
      }
    } finally {
      setPendingGoalId(null)
    }
  }

  return (
    <ConsumerPage
      description="Saved goals from your recent conversations, without exposing worker agents."
      title="Goals"
    >
      {!gateway ? (
        <EmptyState icon="debug-disconnect" title="Connect to see goals">
          Your saved goals will appear when Jarvis reconnects.
        </EmptyState>
      ) : loadError ? (
        <EmptyState icon="warning" title="Goals couldn't load">
          Your saved goals are still in Jarvis. Check the connection and try again.
          <Button className="mt-5" onClick={() => setRefreshIndex(index => index + 1)}>Try again</Button>
        </EmptyState>
      ) : loading && items.length === 0 ? (
        <EmptyState icon="loading" title="Loading goals">
          Reading saved goals…
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState icon="pass" title="No saved goals">
          <p>Start with an outcome you care about. Jarvis can turn it into a plan and keep the work moving.</p>
          <Button className="mt-5" onClick={startGoal}>
            Start a goal
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {goalUpdateError ? (
            <p className="text-sm text-(--ui-text-danger)" role="alert">
              The goal could not be updated. Try again.
            </p>
          ) : null}
          {items.map(([sessionId, goal]) => {
            const session = sessionById.get(sessionId)
            const completed = goal.status === 'done'

            return (
              <div
                className="flex w-full items-start gap-4 rounded-3xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) p-5 text-left transition-colors hover:bg-(--ui-control-hover-background)"
                key={sessionId}
              >
                <button
                  aria-checked={completed}
                  aria-label={`${completed ? 'Reopen' : 'Complete'} ${goal.title}`}
                  className={cn(
                    'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border-2 transition-colors',
                    completed ? 'border-(--ui-accent) bg-(--ui-accent) text-white' : 'border-(--ui-text-tertiary)'
                  )}
                  disabled={Boolean(pendingGoalId)}
                  onClick={() => void toggleGoalCompletion(sessionId, completed)}
                  role="checkbox"
                  type="button"
                >
                  {completed ? <Codicon name="check" size="0.75rem" /> : null}
                </button>
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => navigate(sessionRoute(sessionId))}
                  type="button"
                >
                  <span className="block font-semibold">{goal.title}</span>
                  <span className="mt-1 block text-sm text-(--ui-text-tertiary)">
                    {goal.detail || session?.title || 'Open the conversation'}
                  </span>
                </button>
                <span className="rounded-full bg-(--ui-bg-tertiary) px-2.5 py-1 text-xs capitalize text-(--ui-text-secondary)">
                  {goal.status}
                </span>
              </div>
            )
          })}
          <Button className="mt-3" onClick={startGoal} variant="secondary">
            Start another goal
          </Button>
        </div>
      )}
    </ConsumerPage>
  )
}
