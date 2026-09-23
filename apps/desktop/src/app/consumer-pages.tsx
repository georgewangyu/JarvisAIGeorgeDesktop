import type { SessionGoalSetCompletedResult, SessionGoalsListResult } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $cronJobs } from '@/store/cron'
import { $gateway } from '@/store/gateway'
import { $goalsBySession, setSessionGoal } from '@/store/goals'
import { $activeGatewayProfile, requestFreshSession } from '@/store/profile'
import { $sessions } from '@/store/session'

import { ConsumerFeedUpdates } from './consumer-feed-updates'
import { NEW_CHAT_ROUTE, sessionRoute } from './routes'

export function ConsumerPage({
  children,
  description,
  title
}: {
  children: ReactNode
  description?: string
  title: string
}) {
  return (
    <div className="consumer-page h-full overflow-y-auto bg-(--ui-chat-surface-background) pt-(--titlebar-height)">
      <main className="mx-auto w-full max-w-3xl px-8 pb-20 pt-10">
        <h1 className="text-3xl font-semibold tracking-[-0.035em]">{title}</h1>
        {description && <p className="mt-3 max-w-2xl text-sm leading-6 text-(--ui-text-secondary)">{description}</p>}
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

export function ConsumerFeedView() {
  const navigate = useNavigate()
  const sessions = useStore($sessions)
  const jobs = useStore($cronJobs)

  const recentSessions = [...sessions]
    .filter(session => !session.archived)
    .sort((a, b) => b.last_active - a.last_active)
    .slice(0, 8)

  return (
    <ConsumerPage description="Saved updates from Jarvis, with your recent activity close by." title="Feed">
      {recentSessions.length === 0 && jobs.length === 0 ? (
        <EmptyState icon="list-flat" title="Nothing new yet">
          Saved automation updates will appear here after they produce an answer.
        </EmptyState>
      ) : (
        <div className="space-y-8">
          <ConsumerFeedUpdates />
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

        </div>
      )}
    </ConsumerPage>
  )
}

const IDEA_GROUPS = [
  {
    title: 'Featured ideas',
    ideas: [
      {
        title: 'Plan my day',
        description: 'Turn today’s priorities into a realistic plan.',
        prompt: 'Help me plan today around my calendar, priorities, and energy.'
      },
      {
        title: 'Catch me up',
        description: 'Find the important things to pick up next.',
        prompt: 'Give me a concise catch-up on what needs my attention today.'
      }
    ]
  },
  {
    title: 'Shopping',
    ideas: [
      {
        title: 'Compare a purchase',
        description: 'Set the criteria before deciding what to buy.',
        prompt: 'Help me compare a purchase. First ask what I am considering, what matters to me, and my budget. Do not buy anything.'
      },
      {
        title: 'Find the tradeoffs',
        description: 'Sort through competing options in one conversation.',
        prompt: 'Help me compare the options I am considering and surface the tradeoffs. Ask what I value before recommending anything.'
      }
    ]
  },
  {
    title: 'Productivity',
    ideas: [
      {
        title: 'Prepare for a meeting',
        description: 'Walk in knowing the context and decisions to make.',
        prompt: 'Help me prepare for an upcoming meeting and identify the decisions I need to make.'
      },
      {
        title: 'Organize a project',
        description: 'Break an idea into milestones and next actions.',
        prompt: 'Turn a project I have in mind into a clear plan with milestones and next actions.'
      },
      {
        title: 'Build a routine',
        description: 'Design a repeatable rhythm before automating it.',
        prompt: 'Help me create a realistic recurring routine and decide what Jarvis should automate.'
      }
    ]
  },
  {
    title: 'Relationships',
    ideas: [
      {
        title: 'Draft a thoughtful message',
        description: 'Find the right words without sending anything yet.',
        prompt: 'Help me draft a thoughtful message. Ask who it is for and what I want to say. Do not send it.'
      },
      {
        title: 'Make time to reconnect',
        description: 'Plan a simple way to catch up with someone.',
        prompt: 'Help me plan a low-pressure way to reconnect with someone. Ask about our relationship and what would feel natural.'
      }
    ]
  },
  {
    title: 'Financial planning',
    ideas: [
      {
        title: 'Map a savings goal',
        description: 'Define a target and the questions needed for a plan.',
        prompt: 'Help me clarify a savings goal. Ask about the target, timeline, and constraints before suggesting a plan. Do not move money or open accounts.'
      }
    ]
  },
  {
    title: 'Health & fitness',
    ideas: [
      {
        title: 'Set an activity goal',
        description: 'Start with an outcome and a pace you can sustain.',
        prompt: 'Help me clarify a general activity goal and a realistic pace. Ask about my current routine and constraints before suggesting a plan.'
      },
      {
        title: 'Plan a workout',
        description: 'Shape a session around your time and available gear.',
        prompt: 'Help me plan a general workout. Ask about my time, available equipment, experience, and any limitations first.'
      }
    ]
  },
  {
    title: 'Explore',
    ideas: [
      {
        title: 'Research a decision',
        description: 'Get clear on the options before choosing a path.',
        prompt: 'Help me research a decision, compare the options, and surface the tradeoffs.'
      }
    ]
  }
] as const

function startConsumerDraft(prompt: string, navigate: ReturnType<typeof useNavigate>): void {
  const current = takeSessionDraft(null)
  const text = current.text.trim() ? `${current.text.trimEnd()}\n\n${prompt}` : prompt
  stashSessionDraft(null, text, current.attachments)
  requestFreshSession()
  navigate(NEW_CHAT_ROUTE)
}

export function ConsumerIdeasView() {
  const navigate = useNavigate()

  const startIdea = (prompt: string) => {
    startConsumerDraft(prompt, navigate)
  }

  return (
    <ConsumerPage description="Starting points for a chat. Nothing is sent until you choose to send it." title="Ideas">
      <div className="space-y-10">
        {IDEA_GROUPS.map(group => (
          <section key={group.title}>
            <h2 className="mb-3 text-xl font-semibold tracking-tight">{group.title}</h2>
            <div className="space-y-1">
              {group.ideas.map(idea => (
                <button
                  className="block w-full rounded-2xl px-4 py-3 text-left transition-colors hover:bg-(--ui-control-hover-background)"
                  key={idea.title}
                  onClick={() => startIdea(idea.prompt)}
                  type="button"
                >
                  <span className="block font-medium">{idea.title}</span>
                  <span className="mt-1 block text-sm leading-6 text-(--ui-text-tertiary)">{idea.description}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </ConsumerPage>
  )
}

type SavedGoalRow = SessionGoalsListResult['goals'][number]

const GOAL_STARTERS = [
  ['Health', 'Help me clarify a health-related goal. Ask what outcome I want and what constraints matter before making a plan.'],
  ['Relationships', 'Help me clarify a relationship goal. Ask what outcome I want and what matters to the people involved.'],
  ['Finance', 'Help me clarify a financial goal. Ask what outcome I want and what limits matter before making a plan.'],
  ['Career', 'Help me clarify a career goal. Ask what outcome I want and what constraints matter.'],
  ['Interests', 'Help me clarify a goal around an interest. Ask what I want to make time for and how I will know I am making progress.'],
  ['Productivity', 'Help me clarify a productivity goal. Ask what outcome matters and what is getting in the way.'],
  ['Something else', 'Help me clarify a goal. Ask what outcome I want before making a plan.']
] as const

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
  const [selectedStarter, setSelectedStarter] = useState<(typeof GOAL_STARTERS)[number] | null>(null)

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
      description="Track the things you're working toward with Jarvis."
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
      ) : (
        <div className="space-y-10">
          {items.length > 0 ? <section className="space-y-3">
            <h2 className="text-xl font-semibold tracking-tight">Tracking</h2>
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
          </section> : null}
          <section className="max-w-2xl">
            <h2 className="text-xl font-semibold tracking-tight">Create a goal</h2>
            <p className="mt-2 text-sm leading-6 text-(--ui-text-secondary)">
              Choose a topic. You and Jarvis can clarify the outcome in chat before tracking it here.
            </p>
            <div className="mt-6 space-y-1">
              {GOAL_STARTERS.map(starter => (
                <button
                  className="block w-full rounded-2xl px-4 py-3 text-left transition-colors hover:bg-(--ui-control-hover-background)"
                  key={starter[0]}
                  onClick={() => setSelectedStarter(starter)}
                  type="button"
                >
                  <span className="block font-medium">{starter[0]}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      <Dialog onOpenChange={open => !open && setSelectedStarter(null)} open={selectedStarter !== null}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{selectedStarter?.[0] === 'Something else' ? 'Create a goal' : `Create a ${selectedStarter?.[0]?.toLowerCase()} goal`}</DialogTitle>
            <DialogDescription>
              First, clarify what you want with Jarvis in chat. This step prepares a draft; it does not save or schedule a goal.
            </DialogDescription>
          </DialogHeader>
          <Button onClick={() => {
            if (selectedStarter) {
              startConsumerDraft(selectedStarter[1], navigate)
              setSelectedStarter(null)
            }
          }}>Continue to chat</Button>
        </DialogContent>
      </Dialog>
    </ConsumerPage>
  )
}
