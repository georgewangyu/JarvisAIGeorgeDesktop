import type { SessionGoalCreateResult, SessionGoalSetCompletedResult, SessionGoalsListResult } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { isMessagingSource, normalizeSessionSource } from '@/lib/session-source'
import { cn } from '@/lib/utils'
import { type ComposerAttachment, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $cronJobs } from '@/store/cron'
import { $gateway } from '@/store/gateway'
import { $goalsBySession, setSessionGoal } from '@/store/goals'
import { notify } from '@/store/notifications'
import { $activeGatewayProfile, requestFreshSession } from '@/store/profile'
import { $connection, $sessions } from '@/store/session'

import { ConsumerFeedEditions } from './consumer-feed-editions'
import { ConsumerFeedUpdates } from './consumer-feed-updates'
import { IDEA_GROUPS } from './ideas/catalog'
import { type IdeaFeedback, type IdeaFeedbackById, ideaFeedbackKey, readIdeaFeedback, setIdeaFeedback } from './ideas/feedback'
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
    .filter(session => {
      const source = normalizeSessionSource(session.source)

      // The recents fetch excludes these sources, but an optimistic row can
      // temporarily enter the shared store before the next server refresh.
      return !session.archived && !isMessagingSource(source) &&
        !['cron', 'kanban', 'oneshot', 'subagent', 'tool'].includes(source ?? '')
    })
    .sort((a, b) => b.last_active - a.last_active)
    .slice(0, 8)

  return (
    <ConsumerPage description="Briefings you ask Jarvis to make, plus saved automation updates and recent activity." title="Feed">
      <div className="mb-10"><ConsumerFeedEditions /></div>
      {recentSessions.length === 0 && jobs.length === 0 ? (
        <p className="text-sm text-(--ui-text-tertiary)">Automation updates and recent chats will appear here when available.</p>
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

export function startConsumerDraft(
  prompt: string,
  navigate: ReturnType<typeof useNavigate>,
  attachments: ComposerAttachment[] = []
): void {
  const addToDraft = () => {
    const current = takeSessionDraft(null)
    const text = current.text.trim() ? `${current.text.trimEnd()}\n\n${prompt}` : prompt

    stashSessionDraft(null, text, [...current.attachments, ...attachments])
    requestFreshSession()
    navigate(NEW_CHAT_ROUTE)
  }

  if (takeSessionDraft(null).text.trim()) {
    notify({
      id: 'consumer-draft-already-open',
      kind: 'info',
      message: 'You have an unfinished chat draft. Nothing was added to it.',
      action: { label: 'Add to draft', onClick: addToDraft },
      durationMs: 0
    })

    return
  }

  addToDraft()
}

const IDEA_ICONS: Record<string, string> = {
  'activity-goal': '🚶',
  'build-routine': '🔁',
  'catch-up': '✉️',
  'compare-purchase': '🛍️',
  'draft-message': '💌',
  'find-tradeoffs': '⚖️',
  'organize-project': '🧩',
  'plan-day': '📅',
  'plan-workout': '🏋️',
  'prepare-meeting': '📋',
  'reconnect': '☕',
  'research-decision': '🔎',
  'savings-goal': '🪙'
}

export function ConsumerIdeasView() {
  const navigate = useNavigate()
  const profile = useStore($activeGatewayProfile)
  const gateway = useStore($gateway)
  const connection = useStore($connection)
  const connectionId = connection?.mode === 'remote' ? (connection.connectionId || connection.baseUrl) : null
  const scope = ideaFeedbackKey(profile, connectionId)

  const [feedbackSnapshot, setFeedbackSnapshot] = useState<{ scope: string; values: IdeaFeedbackById }>(() => ({
    scope,
    values: readIdeaFeedback(profile, connectionId)
  }))

  const [showNotInterested, setShowNotInterested] = useState(false)

  const [goalSnapshot, setGoalSnapshot] = useState<{
    connectionId: string | null
    gateway: typeof gateway
    goals: SessionGoalsListResult['goals']
    profile: string
  } | null>(null)

  const [goalLoadError, setGoalLoadError] = useState(false)
  const [goalRefresh, setGoalRefresh] = useState(0)

  useEffect(() => {
    let cancelled = false

    setGoalSnapshot(null)
    setGoalLoadError(false)

    if (gateway) {
      void gateway.request<SessionGoalsListResult>('session.goals.list', { profile }).then(
        result => {
          if (!cancelled) {
            setGoalSnapshot({ connectionId, gateway, goals: result.goals, profile })
          }
        },
        () => {
          if (!cancelled) {
            setGoalLoadError(true)
          }
        }
      )
    }

    return () => {
      cancelled = true
    }
  }, [connectionId, gateway, profile, goalRefresh])

  const feedback = feedbackSnapshot.scope === scope ? feedbackSnapshot.values : readIdeaFeedback(profile, connectionId)

  const startIdea = (prompt: string) => {
    startConsumerDraft(prompt, navigate)
  }

  const chooseFeedback = (ideaId: string, value: IdeaFeedback | null) => {
    if (setIdeaFeedback(profile, connectionId, ideaId, value)) {
      const next = { ...feedback }

      if (value === null) {
        delete next[ideaId]
      } else {
        next[ideaId] = value
      }

      setFeedbackSnapshot({ scope, values: next })

      return
    }

    notify({ id: 'idea-feedback-save-failed', kind: 'error', message: 'Could not save that choice on this Mac. Please try again.' })
  }

  const feedbackLabel: Record<IdeaFeedback, string> = {
    saved: 'Saved for later',
    done: 'Marked done',
    'not-interested': 'Not interested'
  }

  type IdeaRow = { description: string; id: string; prompt: string; title: string }

  const scopedGoals = goalSnapshot?.gateway === gateway && goalSnapshot.profile === profile && goalSnapshot.connectionId === connectionId
    ? goalSnapshot.goals
    : []

  const goalIdeas: IdeaRow[] = scopedGoals
    .filter(row => row.goal.status !== 'done' && row.goal.title.trim())
    .sort((a, b) => (b.goal.updated_at ?? 0) - (a.goal.updated_at ?? 0))
    .slice(0, 3)
    .map(row => ({
      id: `goal:${row.session_id}`,
      title: `Make progress on ${row.goal.title}`,
      description: 'Explore a next step for this saved goal.',
      prompt: `Help me make progress on my saved goal: ${row.goal.title}. Ask what has changed and suggest one manageable next step. Do not take action without checking with me.`
    }))

  const completedGoalIdeas: IdeaRow[] = scopedGoals
    .filter(row => row.goal.status === 'done' && row.goal.title.trim())
    .sort((a, b) => (b.goal.updated_at ?? 0) - (a.goal.updated_at ?? 0))
    .slice(0, 3)
    .map(row => ({
      id: `goal-review:${row.session_id}`,
      title: `Reflect on ${row.goal.title}`,
      description: 'Review a goal you marked done in Jarvis.',
      prompt: `I marked this goal done in Jarvis: ${row.goal.title}. Help me reflect on what actually happened and what I learned. Do not assume I achieved it.`
    }))

  const allIdeas = [...goalIdeas, ...completedGoalIdeas, ...IDEA_GROUPS.reduce<IdeaRow[]>((items, group) => [...items, ...group.ideas], [])]
  const savedIdeas = allIdeas.filter(idea => feedback[idea.id] === 'saved')
  const completedIdeas = allIdeas.filter(idea => feedback[idea.id] === 'done')
  const notInterestedIdeas = allIdeas.filter(idea => feedback[idea.id] === 'not-interested')
  const freshGoalIdeas = goalIdeas.filter(idea => !feedback[idea.id])
  const freshCompletedGoalIdeas = completedGoalIdeas.filter(idea => !feedback[idea.id])

  const sections: { ideas: IdeaRow[]; title: string }[] = [
    ...(savedIdeas.length ? [{ title: 'Saved for later', ideas: savedIdeas }] : []),
    ...(freshGoalIdeas.length ? [{ title: 'For your goals', ideas: freshGoalIdeas }] : []),
    ...(freshCompletedGoalIdeas.length ? [{ title: 'Looking back', ideas: freshCompletedGoalIdeas }] : []),
    ...IDEA_GROUPS.map(group => ({
      title: group.title,
      ideas: group.ideas.filter(idea => !feedback[idea.id])
    })).filter(group => group.ideas.length),
    ...(completedIdeas.length ? [{ title: 'Completed', ideas: completedIdeas }] : []),
    ...(showNotInterested && notInterestedIdeas.length ? [{ title: 'Not interested', ideas: notInterestedIdeas }] : [])
  ]


  return (
    <ConsumerPage description="Choose a starting point for an editable chat. Nothing is sent until you send it." title="Ideas">
      <div className="space-y-10">
        {goalLoadError && gateway ? (
          <div className="flex items-center justify-between gap-4 rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) px-4 py-3 text-sm">
            <span>Your saved goals are unavailable. Other ideas still work.</span>
            <Button onClick={() => setGoalRefresh(value => value + 1)} size="sm" variant="text">Try again</Button>
          </div>
        ) : null}
        {sections.map(group => (
          <section key={group.title}>
            <h2 className="mb-3 text-xl font-semibold tracking-tight">{group.title}</h2>
            <div className="space-y-3">
              {group.ideas.map(idea => (
                <div className="flex items-start gap-4 rounded-2xl transition-colors hover:bg-(--ui-control-hover-background)" key={idea.id}>
                  <span aria-hidden="true" className="ml-3 mt-4 grid size-11 shrink-0 place-items-center rounded-2xl bg-[#f1eefe] text-xl text-[#6f55b5] dark:bg-[#2a2440]">
                    {idea.id.startsWith('goal:') || idea.id.startsWith('goal-review:') ? '✦' : IDEA_ICONS[idea.id] || '✦'}
                  </span>
                  <button className="min-w-0 flex-1 px-1 py-4 text-left" onClick={() => startIdea(idea.prompt)} type="button">
                    <span className="block text-base font-medium leading-6">{idea.title}</span>
                    <span className="mt-1 block text-sm leading-6 text-(--ui-text-tertiary)">{idea.description}</span>
                    {feedback[idea.id] && <span className="mt-1 block text-xs text-(--ui-text-secondary)">{feedbackLabel[feedback[idea.id]]}</span>}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button aria-label={`Feedback for ${idea.title}`} className="mr-2 mt-3 grid size-9 shrink-0 place-items-center rounded-full text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background)" type="button">
                        <Codicon name="ellipsis" size="1rem" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => chooseFeedback(idea.id, 'saved')}>Save for later</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => chooseFeedback(idea.id, 'done')}>Mark done</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => chooseFeedback(idea.id, 'not-interested')}>Not interested</DropdownMenuItem>
                      {feedback[idea.id] && <DropdownMenuItem onSelect={() => chooseFeedback(idea.id, null)}>Clear choice</DropdownMenuItem>}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          </section>
        ))}
        {notInterestedIdeas.length > 0 ? (
          <Button onClick={() => setShowNotInterested(value => !value)} size="sm" variant="text">
            {showNotInterested ? 'Hide' : 'Show'} not interested ({notInterestedIdeas.length})
          </Button>
        ) : null}
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
  const [newGoalTitle, setNewGoalTitle] = useState('')
  const [savingGoal, setSavingGoal] = useState(false)
  const [saveGoalError, setSaveGoalError] = useState(false)
  const goalDialogRef = useRef<HTMLElement>(null)
  const goalChatButtonRef = useRef<HTMLButtonElement>(null)
  const goalTriggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (selectedStarter) {
      goalChatButtonRef.current?.focus()
    }
  }, [selectedStarter])

  const closeGoalSetup = () => {
    if (savingGoal) {
      return
    }

    setSelectedStarter(null)
    setNewGoalTitle('')
    setSaveGoalError(false)
    goalTriggerRef.current?.focus()
  }

  const onGoalDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeGoalSetup()
    } else if (event.key === 'Tab') {
      const focusable = [...(goalDialogRef.current?.querySelectorAll<HTMLElement>('button, input') ?? [])]
        .filter(element => !element.hasAttribute('disabled'))

      if (!focusable.length) {
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
  }

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

  const itemsById = new Map<string, { detail?: string; passive?: boolean; status: string; title: string; updatedAt: number }>(
    savedGoals.map(row => [row.session_id, {
      detail: row.session_title === row.goal.title ? undefined : row.session_title,
      passive: row.goal.paused_reason === 'consumer_tracking',
      status: row.goal.status,
      title: row.goal.title,
      updatedAt: row.goal.updated_at ?? 0
    }])
  )

  for (const [sessionId, goal] of Object.entries(goals)) {
    if (sessionById.has(sessionId)) {
      itemsById.set(sessionId, { ...itemsById.get(sessionId), ...goal })
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
        status: result.goal.goal.status === 'done' ? 'done' : result.goal.goal.status === 'paused' ? 'paused' : 'active',
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

  const saveGoal = async () => {
    const title = newGoalTitle.trim()

    if (!gateway || !title || savingGoal) {
      return
    }

    setSavingGoal(true)
    setSaveGoalError(false)

    try {
      const result = await gateway.request<SessionGoalCreateResult>('session.goals.create', { profile, title })

      if ($gateway.get() !== gateway || $activeGatewayProfile.get() !== profile) {
        return
      }

      setSavedGoalsSnapshot(current => current?.gateway === gateway && current.profile === profile
        ? { ...current, goals: [result.goal, ...current.goals] }
        : current)
      setSelectedStarter(null)
      setNewGoalTitle('')
      goalTriggerRef.current?.focus()
    } catch {
      if ($gateway.get() === gateway && $activeGatewayProfile.get() === profile) {
        setSaveGoalError(true)
      }
    } finally {
      setSavingGoal(false)
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
                  {goal.status === 'paused' && goal.passive ? 'Tracking' : goal.status}
                </span>
              </div>
            )
            })}
          </section> : null}
          <section className="max-w-2xl">
            <h2 className="text-xl font-semibold tracking-tight">Create a goal</h2>
            <p className="mt-2 text-sm leading-6 text-(--ui-text-secondary)">
              Choose a topic. After you clarify it with Jarvis, use Track goal in that chat to keep the conversation with your goal.
            </p>
            <div className="mt-6 space-y-1">
              {GOAL_STARTERS.map(starter => (
                <button
                  aria-pressed={selectedStarter?.[0] === starter[0]}
                  className={cn(
                    'block w-full rounded-2xl px-4 py-3 text-left transition-colors hover:bg-(--ui-control-hover-background)',
                    selectedStarter?.[0] === starter[0] && 'bg-(--ui-bg-secondary) text-(--ui-accent)'
                  )}
                  key={starter[0]}
                  onClick={event => {
                    goalTriggerRef.current = event.currentTarget
                    setSelectedStarter(starter)
                    setNewGoalTitle('')
                    setSaveGoalError(false)
                  }}
                  type="button"
                >
                  <span className="block font-medium">{starter[0]}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      {selectedStarter ? (
        <div className="fixed inset-0 z-(--z-modal) grid place-items-center bg-black/22 p-4 backdrop-blur-[0.125rem]">
          <section
            aria-describedby="goal-setup-description"
            aria-label={selectedStarter[0] === 'Something else' ? 'Create a goal' : `Create a ${selectedStarter[0].toLowerCase()} goal`}
            aria-modal="true"
            className="w-full max-w-lg space-y-5 rounded-xl border border-(--stroke-nous) bg-(--ui-chat-bubble-background) p-6 shadow-nous"
            onKeyDown={onGoalDialogKeyDown}
            ref={goalDialogRef}
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">
                  {selectedStarter[0] === 'Something else' ? 'Create a goal' : `Create a ${selectedStarter[0].toLowerCase()} goal`}
                </h2>
                <p className="mt-2 text-sm leading-6 text-(--ui-text-secondary)" id="goal-setup-description">
                  Jarvis can help you shape this goal in chat. The message stays editable until you send it; Track goal there to save the conversation.
                </p>
              </div>
              <Button aria-label="Close goal setup" disabled={savingGoal} onClick={closeGoalSetup} size="sm" variant="ghost">Close</Button>
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium" htmlFor="consumer-goal-name">Already have a name for it? (optional)</label>
              <Input autoCapitalize="sentences" id="consumer-goal-name" maxLength={200} onChange={event => setNewGoalTitle(event.target.value)} placeholder="What would you like to work toward?" value={newGoalTitle} />
            </div>
            {saveGoalError ? <p className="text-sm text-(--ui-text-danger)" role="alert">The goal could not be saved. Try again.</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={savingGoal} onClick={() => {
                const title = newGoalTitle.trim()

                const prompt = title
                  ? `I want to work toward: ${title}\n\n${selectedStarter[1]}`
                  : selectedStarter[1]

                startConsumerDraft(prompt, navigate)
                setSelectedStarter(null)
              }} ref={goalChatButtonRef}>Talk it through</Button>
              <Button disabled={!newGoalTitle.trim() || savingGoal} onClick={() => void saveGoal()} variant="secondary">Save goal</Button>
            </div>
            <p className="text-xs leading-5 text-(--ui-text-tertiary)">
              Saving a name adds it to Tracking without starting a chat or background work.
            </p>
          </section>
        </div>
      ) : null}
    </ConsumerPage>
  )
}
