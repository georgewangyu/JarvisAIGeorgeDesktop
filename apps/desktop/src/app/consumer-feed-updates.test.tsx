import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { getCronJobRuns } from '@/api/cron'
import { getSessionMessages } from '@/api/sessions'
import { clearSessionDraft, takeSessionDraft } from '@/store/composer'
import { $cronFocusJobId, $cronJobs, setCronFocusJobId } from '@/store/cron'
import { $activeGatewayProfile, $freshSessionRequest } from '@/store/profile'
import { $connection } from '@/store/session'
import { makeSessionInfo } from '@/test/session-info'

import { ConsumerFeedUpdates } from './consumer-feed-updates'

vi.mock('@/api/cron', () => ({ getCronJobRuns: vi.fn() }))
vi.mock('@/api/sessions', () => ({ getSessionMessages: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  $cronJobs.set([])
  setCronFocusJobId(null)
  $activeGatewayProfile.set('default')
  $freshSessionRequest.set(0)
  $connection.set(null)
  clearSessionDraft(null)
})

it('renders a saved automation answer and opens its owning job', async () => {
  $activeGatewayProfile.set('work')
  $cronJobs.set([{ id: 'briefing', name: 'Morning briefing', enabled: true }])
  vi.mocked(getCronJobRuns).mockResolvedValue([
    makeSessionInfo({ id: 'cron-briefing-1', is_active: false, profile: 'work', last_active: 100 })
  ])
  vi.mocked(getSessionMessages).mockResolvedValue({
    messages: [{ role: 'assistant', content: 'Your saved briefing is ready.' }]
  } as never)

  render(
    <MemoryRouter initialEntries={['/feed']}>
      <Routes>
        <Route element={<ConsumerFeedUpdates />} path="/feed" />
        <Route element={<p>Opened automations</p>} path="/cron" />
      </Routes>
    </MemoryRouter>
  )

  expect(await screen.findByText('Your saved briefing is ready.')).toBeTruthy()
  expect(getCronJobRuns).toHaveBeenCalledWith('briefing', 1)
  expect(getSessionMessages).toHaveBeenCalledWith(
    'cron-briefing-1',
    { profile: 'work', connectionId: undefined },
    { limit: 100, order: 'latest' },
    { passive: true }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Open automation' }))
  expect(screen.getByText('Opened automations')).toBeTruthy()
  expect($cronFocusJobId.get()).toBe('briefing')
})

it('does not invent a Feed update when an automation has no completed answer', async () => {
  $cronJobs.set([{ id: 'quiet', name: 'Quiet task', enabled: true }])
  vi.mocked(getCronJobRuns).mockResolvedValue([])

  render(<MemoryRouter><ConsumerFeedUpdates /></MemoryRouter>)

  expect(await screen.findByText('Completed automations will appear here after they produce an answer.')).toBeTruthy()
  expect(getSessionMessages).not.toHaveBeenCalled()
})

it('checks recently run automations even when they appear after older jobs in the list', async () => {
  $cronJobs.set([
    ...['old-1', 'old-2', 'old-3', 'old-4'].map(id => ({ id, name: id, enabled: true, last_run_at: '2026-09-01T00:00:00Z' })),
    { id: 'recent', name: 'Recent update', enabled: true, last_run_at: '2026-09-22T00:00:00Z' }
  ])
  vi.mocked(getCronJobRuns).mockImplementation(async id => id === 'recent'
    ? [makeSessionInfo({ id: 'recent-run', is_active: false, last_active: 100 })]
    : [])
  vi.mocked(getSessionMessages).mockResolvedValue({
    messages: [{ role: 'assistant', content: 'The newest saved answer.' }]
  } as never)

  render(<MemoryRouter><ConsumerFeedUpdates /></MemoryRouter>)

  expect(await screen.findByText('The newest saved answer.')).toBeTruthy()
  expect(getCronJobRuns).toHaveBeenCalledWith('recent', 1)
  expect(getCronJobRuns).not.toHaveBeenCalledWith('old-4', 1)
})

it('refreshes a saved update when the same automation runs again', async () => {
  $cronJobs.set([{ id: 'routine', name: 'Routine', enabled: true, last_run_at: '2026-09-21T00:00:00Z' }])
  vi.mocked(getCronJobRuns).mockResolvedValue([])

  render(<MemoryRouter><ConsumerFeedUpdates /></MemoryRouter>)

  await waitFor(() => expect(getCronJobRuns).toHaveBeenCalledTimes(1))
  $cronJobs.set([{ id: 'routine', name: 'Routine', enabled: true, last_run_at: '2026-09-22T00:00:00Z' }])
  await waitFor(() => expect(getCronJobRuns).toHaveBeenCalledTimes(2))
})

it('opens an editable side-chat draft to discuss a saved update without sending', async () => {
  $cronJobs.set([{ id: 'briefing', name: 'Morning briefing', enabled: true }])
  vi.mocked(getCronJobRuns).mockResolvedValue([
    makeSessionInfo({ id: 'cron-briefing-1', is_active: false, last_active: 100 })
  ])
  vi.mocked(getSessionMessages).mockResolvedValue({
    messages: [{ role: 'assistant', content: 'A useful update.' }]
  } as never)

  render(
    <MemoryRouter initialEntries={['/feed']}>
      <Routes>
        <Route element={<ConsumerFeedUpdates />} path="/feed" />
        <Route element={<p>Editable side chat</p>} path="/" />
      </Routes>
    </MemoryRouter>
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Discuss' }))
  expect(screen.getByText('Editable side chat')).toBeTruthy()
  expect($freshSessionRequest.get()).toBe(1)
  expect(takeSessionDraft(null).text).toBe('Help me think through this update from Morning briefing:\n\nA useful update.')
})

it('offers a retry when saved automation reads fail', async () => {
  $cronJobs.set([{ id: 'briefing', name: 'Morning briefing', enabled: true }])
  vi.mocked(getCronJobRuns).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([])

  render(<MemoryRouter><ConsumerFeedUpdates /></MemoryRouter>)

  expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load automation updates.")
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(getCronJobRuns).toHaveBeenCalledTimes(2))
  expect(await screen.findByText('Completed automations will appear here after they produce an answer.')).toBeTruthy()
})

it('keeps a saved update visible while exposing a failed sibling and recovering on retry', async () => {
  $cronJobs.set([
    { id: 'briefing', name: 'Morning briefing', enabled: true },
    { id: 'offline', name: 'Offline briefing', enabled: true }
  ])
  vi.mocked(getCronJobRuns).mockImplementation(async id => {
    if (id === 'offline') {
      throw new Error('offline')
    }

    return [makeSessionInfo({ id: 'cron-briefing-1', is_active: false, last_active: 100 })]
  })
  vi.mocked(getSessionMessages).mockResolvedValue({
    messages: [{ role: 'assistant', content: 'The saved briefing.' }]
  } as never)

  render(<MemoryRouter><ConsumerFeedUpdates /></MemoryRouter>)

  expect(await screen.findByText('The saved briefing.')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('Some updates couldn’t load.')
  vi.mocked(getCronJobRuns).mockImplementation(async id => id === 'offline' ? [] : [
    makeSessionInfo({ id: 'cron-briefing-1', is_active: false, last_active: 100 })
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(getCronJobRuns).toHaveBeenCalledTimes(4))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(screen.getByText('The saved briefing.')).toBeTruthy()
})
