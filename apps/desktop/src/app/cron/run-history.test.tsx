import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { getCronExecutionResult, getCronJobExecutions, getCronJobRuns } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { en } from '@/i18n/en'
import type { SessionInfo } from '@/types/hermes'

import { CronJobRuns } from './run-history'

vi.mock('@/hermes', () => ({ getCronExecutionResult: vi.fn(), getCronJobExecutions: vi.fn(), getCronJobRuns: vi.fn() }))
vi.mock('./run-result', () => ({ AutomationRunResult: () => null }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderRuns(jobId: string) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <CronJobRuns c={en.cron} jobId={jobId} />
    </I18nProvider>
  )
}

it('distinguishes a failed history read from an empty history and retries the same job', async () => {
  vi.mocked(getCronJobRuns).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([])

  renderRuns('job-one')

  await screen.findByText('Failed to load automations')
  expect(screen.queryByText('No runs yet')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('No runs yet')
  expect(getCronJobRuns).toHaveBeenNthCalledWith(1, 'job-one')
  expect(getCronJobRuns).toHaveBeenNthCalledWith(2, 'job-one')
})

it('does not claim no run happened when an attempt failed before a result was saved', async () => {
  vi.mocked(getCronJobRuns).mockResolvedValueOnce([])

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <CronJobRuns c={en.cron} hadAttempt jobId="failed-before-session" />
    </I18nProvider>
  )

  await screen.findByText('No saved result for the latest attempt.')
  expect(screen.queryByText('No runs yet')).toBeNull()
})

it('does not let an older job response overwrite the newly selected job', async () => {
  let resolveOld: (runs: SessionInfo[]) => void = () => undefined

  const oldRequest = new Promise<SessionInfo[]>(resolve => {
    resolveOld = resolve
  })

  vi.mocked(getCronJobRuns)
    .mockReturnValueOnce(oldRequest)
    .mockResolvedValueOnce([{ id: 'new-run', title: 'New job result' } as SessionInfo])

  const { rerender } = renderRuns('old-job')

  rerender(
    <I18nProvider configClient={null} initialLocale="en">
      <CronJobRuns c={en.cron} jobId="new-job" />
    </I18nProvider>
  )
  await screen.findByText('New job result')
  resolveOld([{ id: 'old-run', title: 'Stale old result' } as SessionInfo])
  await Promise.resolve()
  expect(screen.queryByText('Stale old result')).toBeNull()
})

it('keeps cached runs visible when a refresh fails and while retrying', async () => {
  const run = { id: 'earlier-run', title: 'Earlier result' } as SessionInfo

  let resolveRetry: (runs: SessionInfo[]) => void = () => undefined

  const retryRequest = new Promise<SessionInfo[]>(resolve => {
    resolveRetry = resolve
  })

  vi.mocked(getCronJobRuns)
    .mockResolvedValueOnce([run])
    .mockRejectedValueOnce(new Error('offline'))
    .mockReturnValueOnce(retryRequest)

  renderRuns('job-one')
  await screen.findByText('Earlier result')
  fireEvent(globalThis.document, new Event('visibilitychange'))
  await screen.findByText('Failed to load automations')
  expect(screen.getByText('Earlier result')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(screen.getByText('Earlier result')).toBeTruthy()
  resolveRetry([run])
  await screen.findByText('Earlier result')
  expect(screen.queryByText('Failed to load automations')).toBeNull()
  expect(getCronJobRuns).toHaveBeenCalledTimes(3)
})

it('shows script-only execution history without opening a nonexistent chat session', async () => {
  vi.mocked(getCronJobExecutions).mockResolvedValueOnce([{
    id: 'execution-one',
    status: 'completed',
    delivery_outcome: 'queued',
    claimed_at: '2026-09-23T06:00:00+00:00',
    finished_at: '2026-09-23T06:00:01+00:00'
  }])

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <CronJobRuns c={en.cron} jobId="script-job" noAgent />
    </I18nProvider>
  )

  await screen.findByRole('button', { name: /completed/i })
  fireEvent.click(screen.getByRole('button', { name: /completed/i }))
  expect(screen.getByText('Notification queued')).toBeTruthy()
  expect(screen.queryByText('No runs yet')).toBeNull()
  expect(getCronJobRuns).not.toHaveBeenCalled()
  expect(getCronJobExecutions).toHaveBeenCalledWith('script-job')
  expect(getCronExecutionResult).not.toHaveBeenCalled()
})

it('loads only the selected script execution result without rendering it as HTML', async () => {
  vi.mocked(getCronJobExecutions).mockResolvedValueOnce([{
    id: 'execution-two',
    status: 'completed',
    output_available: true,
    claimed_at: '2026-09-23T06:00:00+00:00',
    finished_at: '2026-09-23T06:00:01+00:00'
  }])
  vi.mocked(getCronExecutionResult).mockResolvedValueOnce('<script>not markup</script>')

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <CronJobRuns c={en.cron} jobId="script-job" noAgent />
    </I18nProvider>
  )

  fireEvent.click(await screen.findByRole('button', { name: /completed/i }))
  expect(await screen.findByText('<script>not markup</script>')).toBeTruthy()
  expect(globalThis.document.querySelector('script')).toBeNull()
  expect(getCronExecutionResult).toHaveBeenCalledWith('script-job', 'execution-two')
})

it('keeps a failed script result read retryable without exposing an error body', async () => {
  vi.mocked(getCronJobExecutions).mockResolvedValueOnce([{
    id: 'execution-three',
    status: 'completed',
    output_available: true,
    claimed_at: '2026-09-23T06:00:00+00:00',
    finished_at: '2026-09-23T06:00:01+00:00'
  }])
  vi.mocked(getCronExecutionResult)
    .mockRejectedValueOnce(new Error('private backend diagnostic'))
    .mockResolvedValueOnce('Safe result')

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <CronJobRuns c={en.cron} jobId="script-job" noAgent />
    </I18nProvider>
  )

  fireEvent.click(await screen.findByRole('button', { name: /completed/i }))
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load this result')
  expect(screen.queryByText('private backend diagnostic')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Safe result')).toBeTruthy()
  expect(getCronExecutionResult).toHaveBeenCalledTimes(2)
})

it('keeps failed script output and an untitled run preview out of consumer history', async () => {
  vi.mocked(getCronJobExecutions).mockResolvedValueOnce([{
    id: 'failed-execution',
    status: 'failed',
    output_available: true,
    claimed_at: '2026-09-23T06:00:00+00:00',
    finished_at: '2026-09-23T06:00:01+00:00'
  }])

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <CronJobRuns c={en.cron} jobId="script-job" noAgent />
    </I18nProvider>
  )

  fireEvent.click(await screen.findByRole('button', { name: /last run failed/i }))
  expect(screen.getAllByText('Last run failed').length).toBeGreaterThan(0)
  expect(getCronExecutionResult).not.toHaveBeenCalled()

  cleanup()
  vi.mocked(getCronJobRuns).mockResolvedValueOnce([{ id: 'run-untitled', preview: '/tmp/private/token: sk-test-secret' } as SessionInfo])
  renderRuns('agent-job')
  await screen.findByRole('button', { name: /automation result/i })
  expect(screen.queryByText(/sk-test-secret|\/tmp\/private/)).toBeNull()
})
