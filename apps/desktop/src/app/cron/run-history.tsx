import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { type CronExecution, getCronJobExecutions, getCronJobRuns, type SessionInfo } from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { $changeEventsAvailable, $cronChangeTick } from '@/store/live-sync'

import { PanelSectionLabel } from '../overlays/panel'

import { AutomationRunResult } from './run-result'

// Runs are produced by the background scheduler tick. cron.changed /
// sessions.changed broadcasts re-load immediately on event-capable backends
// (the tick dep below), so the poll drops to a slow backstop there; older
// backends keep the legacy cadence.
const RUNS_POLL_INTERVAL_MS = 8000
const RUNS_BACKSTOP_INTERVAL_MS = 60_000

function formatRunTime(seconds?: null | number): string {
  if (!seconds) {
    return '—'
  }

  const date = new Date(seconds * 1000)

  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString()
}

interface SessionHistoryItem {
  kind: 'session'
  run: SessionInfo
}

interface ExecutionHistoryItem {
  kind: 'execution'
  run: CronExecution
}

type HistoryItem = ExecutionHistoryItem | SessionHistoryItem

function executionLabel(status: CronExecution['status'], c: Translations['cron'], unknown: string): string {
  if (status === 'failed') {
    return c.states.error
  }

  if (status === 'claimed' || status === 'running') {
    return c.states.running
  }

  if (status === 'completed') {
    return c.states.completed
  }

  return unknown
}

export function CronJobRuns({ c, jobId, noAgent = false }: { c: Translations['cron']; jobId: string; noAgent?: boolean }) {
  const { t } = useI18n()
  const [runs, setRuns] = useState<HistoryItem[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const changeEventsAvailable = useStore($changeEventsAvailable)
  const cronChangeTick = useStore($cronChangeTick)

  useEffect(() => {
    let cancelled = false
    let requestSequence = 0

    const load = () => {
      const request = ++requestSequence

      const requestRuns: Promise<HistoryItem[]> = noAgent
        ? getCronJobExecutions(jobId).then(result => result.map(run => ({ kind: 'execution', run })))
        : getCronJobRuns(jobId).then(result => result.map(run => ({ kind: 'session', run })))

      return requestRuns
        .then(result => {
          if (!cancelled && request === requestSequence) {
            setRuns(result)
            setLoadFailed(false)
          }
        })
        .catch(() => {
          if (!cancelled && request === requestSequence) {
            setLoadFailed(true)
          }
        })
    }

    void load()

    const intervalId = window.setInterval(
      () => {
        if (document.visibilityState === 'visible') {
          void load()
        }
      },
      changeEventsAvailable ? RUNS_BACKSTOP_INTERVAL_MS : RUNS_POLL_INTERVAL_MS
    )

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void load()
      }
    }

    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      requestSequence += 1
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // cronChangeTick: a fired run moves jobs.json bookkeeping → reload now.
  }, [changeEventsAvailable, cronChangeTick, jobId, noAgent, retryTick])

  const retry = () => {
    // Keep any previously loaded runs visible while the effect retries.
    // Only the first load has no cached history to show.
    setLoadFailed(false)
    setRetryTick(tick => tick + 1)
  }

  return (
    <div>
      <PanelSectionLabel className="mb-1.5">
        {c.runHistory}
        {runs && runs.length > 0 ? ` · ${runs.length}` : ''}
      </PanelSectionLabel>
      {loadFailed && (
        <div className="flex items-center justify-between gap-3 rounded-md bg-destructive/8 px-2 py-1.5 text-xs text-destructive">
          <span>{c.failedLoad}</span>
          <Button onClick={retry} size="xs" variant="ghost">
            {t.common.retry}
          </Button>
        </div>
      )}
      {runs === null ? (
        loadFailed ? null : (
          <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
            <Codicon name="loading" size="0.75rem" spinning />
          </div>
        )
      ) : runs.length === 0 ? (
        loadFailed ? null : (
          <div className="py-1 text-xs text-muted-foreground">{c.noRuns}</div>
        )
      ) : (
        <div className="flex flex-col gap-px">
          {runs.map(item => (
            <div key={item.run.id}>
              <button
                aria-expanded={selectedRunId === item.run.id}
                className="row-hover flex items-center justify-between gap-3 rounded-md px-2 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                onClick={() => setSelectedRunId(current => (current === item.run.id ? null : item.run.id))}
                type="button"
              >
                <span className="truncate text-foreground/85">
                  {item.kind === 'session'
                    ? item.run.title?.trim() || item.run.preview?.trim() || item.run.id
                    : executionLabel(item.run.status, c, t.messaging.unknown)}
                </span>
                <span className="shrink-0 text-[0.62rem] text-muted-foreground/55 tabular-nums">
                  {item.kind === 'session'
                    ? formatRunTime(item.run.last_active || item.run.started_at)
                    : new Date(item.run.claimed_at).toLocaleString()}
                </span>
              </button>
              {selectedRunId === item.run.id && (item.kind === 'session'
                ? <AutomationRunResult key={item.run.id} run={item.run} />
                : <div className="px-2 py-2 text-xs text-muted-foreground">{executionLabel(item.run.status, c, t.messaging.unknown)}</div>)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
