import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { getCronJobRuns } from '@/api/cron'
import { getSessionMessages } from '@/api/sessions'
import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { useJarvisCopy } from '@/i18n/jarvis'
import { stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $cronJobs, setCronFocusJobId } from '@/store/cron'
import { $cronChangeTick } from '@/store/live-sync'
import { notify } from '@/store/notifications'
import { $activeGatewayProfile, requestFreshSession } from '@/store/profile'
import { $connection } from '@/store/session'
import type { CronJob } from '@/types/hermes'

import { automationAnswer } from './cron/run-result'
import { feedLovedKey, readLovedFeedRuns, setFeedRunLoved } from './feed/feedback'
import { CRON_ROUTE, NEW_CHAT_ROUTE } from './routes'

interface FeedUpdate {
  answer: string
  job: CronJob
  runId: string
  time: number
}

type FeedUpdateState =
  | { kind: 'error' }
  | { kind: 'loading' }
  | { items: FeedUpdate[]; kind: 'ready'; partialFailure: boolean }

const FEED_JOB_LIMIT = 4
const FEED_RUN_LIMIT = 3

function recentFeedJobs(jobs: CronJob[]): CronJob[] {
  const runTime = (job: CronJob) => {
    const parsed = job.last_run_at ? Date.parse(job.last_run_at) : NaN

    return Number.isFinite(parsed) ? parsed : 0
  }

  // The server list is not guaranteed to be ordered by last run. Bound the
  // transcript reads to the most recently active routines, not the first rows.
  return [...jobs].sort((a, b) => runTime(b) - runTime(a)).slice(0, FEED_JOB_LIMIT)
}

export function ConsumerFeedUpdates() {
  const { feedUpdates } = useJarvisCopy()
  const { locale } = useI18n()
  const navigate = useNavigate()
  const jobs = useStore($cronJobs)
  const profile = useStore($activeGatewayProfile)
  const connection = useStore($connection)
  const changeTick = useStore($cronChangeTick)
  const [retry, setRetry] = useState(0)
  const connectionId = connection?.mode === 'remote' ? (connection.connectionId || connection.baseUrl) : null
  const feedbackScope = feedLovedKey(profile, connectionId)

  const [snapshot, setSnapshot] = useState<{ scope: string; state: FeedUpdateState }>({
    scope: feedbackScope,
    state: { kind: 'loading' }
  })

  const state: FeedUpdateState = snapshot.scope === feedbackScope ? snapshot.state : { kind: 'loading' }

  const [lovedSnapshot, setLovedSnapshot] = useState<{ scope: string; ids: string[] }>(() => ({
    scope: feedbackScope,
    ids: readLovedFeedRuns(profile, connectionId)
  }))

  const lovedRuns = lovedSnapshot.scope === feedbackScope ? lovedSnapshot.ids : readLovedFeedRuns(profile, connectionId)
  const selectedJobs = recentFeedJobs(jobs)
  const jobSignature = selectedJobs.map(job => `${job.id}:${job.last_run_at ?? ''}`).join('\u0000')

  const toggleLove = (runId: string) => {
    const loved = !lovedRuns.includes(runId)

    if (!setFeedRunLoved(profile, connectionId, runId, loved)) {
      notify({ id: 'feed-feedback-save-failed', kind: 'error', message: feedUpdates.saveError })

      return
    }

    setLovedSnapshot({ scope: feedbackScope, ids: readLovedFeedRuns(profile, connectionId) })
  }

  const discuss = (item: FeedUpdate) => {
    const current = takeSessionDraft(null)
    const context = item.answer.slice(0, 4000)
    const prompt = `Help me think through this update from ${item.job.name || 'an automation'}:\n\n${context}`
    const text = current.text.trim() ? `${current.text.trimEnd()}\n\n${prompt}` : prompt

    stashSessionDraft(null, text, current.attachments)
    requestFreshSession()
    navigate(NEW_CHAT_ROUTE)
  }

  useEffect(() => {
    let cancelled = false

    if (selectedJobs.length === 0) {
      setSnapshot({ scope: feedbackScope, state: { items: [], kind: 'ready', partialFailure: false } })

      return
    }

    setSnapshot({ scope: feedbackScope, state: { kind: 'loading' } })
    void Promise.all(selectedJobs.map(async job => {
      const runs = await getCronJobRuns(job.id, FEED_RUN_LIMIT)

      const outcomes = await Promise.all(runs.filter(run => !run.is_active && (!run.profile || run.profile === profile)).map(async run => {
        try {
          const owner = { profile: run.profile || profile, connectionId: connection?.connectionId }
          const result = await getSessionMessages(run.id, owner, { limit: 100, order: 'latest' }, { passive: true })
          const answer = automationAnswer(result.messages)

          return { item: answer ? { answer, job, runId: run.id, time: run.last_active || run.started_at } : null, failed: false }
        } catch {
          return { item: null, failed: true }
        }
      }))

      return { items: outcomes.flatMap(outcome => outcome.item ? [outcome.item] : []), failed: outcomes.some(outcome => outcome.failed) }
    }).map(promise => promise.catch(() => ({ items: [] as FeedUpdate[], failed: true }))))
      .then(results => {
        if (cancelled) {
          return
        }

        const items = results.flatMap(result => result.items)
          .sort((a, b) => b.time - a.time)

        const partialFailure = results.some(result => result.failed)
        setSnapshot({
          scope: feedbackScope,
          state: items.length === 0 && partialFailure
            ? { kind: 'error' }
            : { items, kind: 'ready', partialFailure }
        })
      })

    return () => {
      cancelled = true
    }
    // ID and run time identify the lookup; cron.changed also refreshes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobSignature, profile, connectionId, changeTick, retry])

  if (jobs.length === 0) {
    return null
  }

  return (
    <section aria-label={feedUpdates.title}>
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-(--ui-text-tertiary)">
          {feedUpdates.title}
        </h2>
        <Button onClick={() => navigate(CRON_ROUTE)} size="sm" variant="text">
          {feedUpdates.viewAutomations}
        </Button>
      </div>
      <p className="mt-1 text-xs text-(--ui-text-tertiary)">{feedUpdates.loveNotice}</p>
      {state.kind === 'loading' ? (
        <p className="mt-4 text-sm text-(--ui-text-tertiary)" role="status">{feedUpdates.loading}</p>
      ) : state.kind === 'error' ? (
        <div className="mt-4 flex items-center gap-4 text-sm text-(--ui-text-secondary)" role="alert">
          <span>{feedUpdates.loadError}</span>
          <Button onClick={() => setRetry(value => value + 1)} size="sm" variant="text">{feedUpdates.retry}</Button>
        </div>
      ) : state.items.length === 0 ? (
        <div className="mt-4 text-sm text-(--ui-text-tertiary)">
          {state.partialFailure ? (
            <div className="flex items-center gap-4" role="alert">
              <span>{feedUpdates.partialError}</span>
              <Button onClick={() => setRetry(value => value + 1)} size="sm" variant="text">{feedUpdates.retry}</Button>
            </div>
          ) : <p>{feedUpdates.empty}</p>}
        </div>
      ) : (
        <div className="mt-3">
          {state.partialFailure ? (
            <div className="flex items-center gap-4 text-sm text-(--ui-text-secondary)" role="alert">
              <span>{feedUpdates.partialError}</span>
              <Button onClick={() => setRetry(value => value + 1)} size="sm" variant="text">{feedUpdates.retry}</Button>
            </div>
          ) : null}
          <div className="divide-y divide-(--ui-stroke-tertiary)">
            {state.items.map(item => (
              <article className="py-6 first:pt-2" key={item.runId}>
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="font-semibold">{item.job.name || feedUpdates.scheduledTask}</h3>
                <time className="shrink-0 text-xs text-(--ui-text-tertiary)" dateTime={new Date(item.time * 1000).toISOString()}>
                  {new Date(item.time * 1000).toLocaleDateString(locale)}
                </time>
              </div>
              <div className="mt-3 max-h-52 overflow-hidden text-sm leading-6">
                <MarkdownTextContent isRunning={false} previewOnly text={item.answer} />
              </div>
              <div className="mt-3 flex items-center gap-5">
                <Button aria-pressed={lovedRuns.includes(item.runId)} onClick={() => toggleLove(item.runId)} size="sm" variant="text">
                  {lovedRuns.includes(item.runId) ? feedUpdates.loved : feedUpdates.love}
                </Button>
                <Button onClick={() => discuss(item)} size="sm" variant="textStrong">{feedUpdates.discuss}</Button>
                <Button
                  onClick={() => {
                    setCronFocusJobId(item.job.id)
                    navigate(CRON_ROUTE)
                  }}
                  size="sm"
                  variant="text"
                >
                  {feedUpdates.openAutomation}
                </Button>
              </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
