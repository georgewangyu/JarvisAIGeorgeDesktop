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
