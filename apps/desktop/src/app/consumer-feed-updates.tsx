import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { getCronJobRuns } from '@/api/cron'
import { getSessionMessages } from '@/api/sessions'
import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { Button } from '@/components/ui/button'
import { stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $cronJobs, setCronFocusJobId } from '@/store/cron'
import { $cronChangeTick } from '@/store/live-sync'
import { $activeGatewayProfile, requestFreshSession } from '@/store/profile'
import { $connection } from '@/store/session'
import type { CronJob } from '@/types/hermes'

import { automationAnswer } from './cron/run-result'
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
  | { items: FeedUpdate[]; kind: 'ready' }

const FEED_JOB_LIMIT = 4

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
  const navigate = useNavigate()
  const jobs = useStore($cronJobs)
  const profile = useStore($activeGatewayProfile)
  const connection = useStore($connection)
  const changeTick = useStore($cronChangeTick)
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<FeedUpdateState>({ kind: 'loading' })
  const selectedJobs = recentFeedJobs(jobs)
  const jobSignature = selectedJobs.map(job => `${job.id}:${job.last_run_at ?? ''}`).join('\u0000')

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
      setState({ items: [], kind: 'ready' })

      return
    }

    setState({ kind: 'loading' })
    void Promise.all(selectedJobs.map(async job => {
      const runs = await getCronJobRuns(job.id, 1)
      const run = runs[0]

      if (!run || run.is_active) {
        return null
      }

      const owner = { profile: run.profile || profile, connectionId: connection?.connectionId }
      const result = await getSessionMessages(run.id, owner, { limit: 100, order: 'latest' }, { passive: true })
      const answer = automationAnswer(result.messages)

      return answer ? { answer, job, runId: run.id, time: run.last_active || run.started_at } : null
    }).map(promise => promise.then(value => ({ value, failed: false })).catch(() => ({ value: null, failed: true }))))
      .then(results => {
        if (cancelled) {
          return
        }

        const items = results.flatMap(result => result.value ? [result.value] : [])
          .sort((a, b) => b.time - a.time)

        setState(items.length === 0 && results.every(result => result.failed)
          ? { kind: 'error' }
          : { items, kind: 'ready' })
      })

    return () => {
      cancelled = true
    }
    // ID and run time identify the lookup; cron.changed also refreshes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobSignature, profile, connection?.connectionId, changeTick, retry])

  if (jobs.length === 0) {
    return null
  }

  return (
    <section aria-label="Automation updates">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-(--ui-text-tertiary)">
          Automation updates
        </h2>
        <Button onClick={() => navigate(CRON_ROUTE)} size="sm" variant="text">
          View automations
        </Button>
      </div>
      {state.kind === 'loading' ? (
        <p className="mt-4 text-sm text-(--ui-text-tertiary)" role="status">Loading saved updates…</p>
      ) : state.kind === 'error' ? (
        <div className="mt-4 flex items-center gap-4 text-sm text-(--ui-text-secondary)" role="alert">
          <span>Couldn't load automation updates.</span>
          <Button onClick={() => setRetry(value => value + 1)} size="sm" variant="text">Retry</Button>
        </div>
      ) : state.items.length === 0 ? (
        <p className="mt-4 text-sm text-(--ui-text-tertiary)">
          Completed automations will appear here after they produce an answer.
        </p>
      ) : (
        <div className="mt-3 divide-y divide-(--ui-stroke-tertiary)">
          {state.items.map(item => (
            <article className="py-6 first:pt-2" key={item.runId}>
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="font-semibold">{item.job.name || 'Scheduled task'}</h3>
                <time className="shrink-0 text-xs text-(--ui-text-tertiary)" dateTime={new Date(item.time * 1000).toISOString()}>
                  {new Date(item.time * 1000).toLocaleDateString()}
                </time>
              </div>
              <div className="mt-3 max-h-52 overflow-hidden text-sm leading-6">
                <MarkdownTextContent isRunning={false} previewOnly text={item.answer} />
              </div>
              <div className="mt-3 flex items-center gap-5">
                <Button onClick={() => discuss(item)} size="sm" variant="textStrong">Discuss</Button>
                <Button
                  onClick={() => {
                    setCronFocusJobId(item.job.id)
                    navigate(CRON_ROUTE)
                  }}
                  size="sm"
                  variant="text"
                >
                  Open automation
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
