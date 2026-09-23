import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { type FeedEdition, generateFeedEdition, getFeedEditions } from '@/api/feed'
import { clearSessionDraft, takeSessionDraft } from '@/store/composer'
import { $activeGatewayProfile, $freshSessionRequest } from '@/store/profile'
import { $connection } from '@/store/session'

import { ConsumerFeedEditions } from './consumer-feed-editions'

vi.mock('@/api/feed', () => ({ getFeedEditions: vi.fn(), generateFeedEdition: vi.fn() }))

const edition: FeedEdition = {
  attempt: 1,
  content: 'A saved briefing with a real answer.',
  created_at: '2026-09-23T12:00:00Z',
  error: null,
  finished_at: '2026-09-23T12:01:00Z',
  id: 'edition-1',
  prompt: 'What matters today?',
  source_urls: [],
  source_urls_verified: false,
  status: 'completed'
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  clearSessionDraft(null)
  $activeGatewayProfile.set('default')
  $connection.set(null)
  $freshSessionRequest.set(0)
})

it('sends only an explicit Generate request and saves a real returned edition', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([])
  vi.mocked(generateFeedEdition).mockResolvedValue(edition)
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  expect(generateFeedEdition).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox', { name: 'What should this briefing cover?' }), { target: { value: 'What matters today?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  expect(await screen.findByText('A saved briefing with a real answer.')).toBeTruthy()
  expect(generateFeedEdition).toHaveBeenCalledWith('default', 'What matters today?', undefined)
})

it('shows durable failed editions and retries only by explicit choice with the original prompt', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([{ ...edition, content: null, error: 'Provider unavailable', status: 'failed' }])
  vi.mocked(generateFeedEdition).mockResolvedValue({ ...edition, content: null, error: null, status: 'generating', attempt: 2 })
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  expect(await screen.findByText('Provider unavailable')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('Jarvis is preparing this briefing…')).toBeTruthy()
  expect(generateFeedEdition).toHaveBeenCalledWith('default', 'What matters today?', 'edition-1')
})

it('Discuss prepares an editable unsent draft instead of sending another model call', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([edition])
  render(
    <MemoryRouter initialEntries={['/feed']}>
      <Routes>
        <Route element={<ConsumerFeedEditions />} path="/feed" />
        <Route element={<p>Editable draft</p>} path="/" />
      </Routes>
    </MemoryRouter>
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Discuss' }))
  expect(screen.getByText('Editable draft')).toBeTruthy()
  expect(takeSessionDraft(null).text).toContain('A saved briefing with a real answer.')
  expect($freshSessionRequest.get()).toBe(1)
  await waitFor(() => expect(generateFeedEdition).not.toHaveBeenCalled())
})
