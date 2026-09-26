import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { type FeedEdition, generateFeedEdition, getFeedEditions } from '@/api/feed'
import { clearSessionDraft, takeSessionDraft } from '@/store/composer'
import { $activeGatewayProfile, $freshSessionRequest } from '@/store/profile'
import { $connection } from '@/store/session'

import { ConsumerFeedEditions } from './consumer-feed-editions'
import { readLovedFeedEditions, readLovedFeedStories } from './feed/edition-feedback'
import { DEFAULT_FEED_PROMPT, readFeedPrompt } from './feed/prompt'

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
  vi.restoreAllMocks()
  vi.resetAllMocks()
  window.localStorage.clear()
  clearSessionDraft(null)
  $activeGatewayProfile.set('default')
  $connection.set(null)
  $freshSessionRequest.set(0)
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

it('sends only an explicit Generate request and saves a real returned edition', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([])
  vi.mocked(generateFeedEdition).mockResolvedValue(edition)
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  expect(generateFeedEdition).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'What should your Feed cover?' }), { target: { value: 'What matters today?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  expect(await screen.findByText('A saved briefing with a real answer.')).toBeTruthy()
  expect(generateFeedEdition).toHaveBeenCalledWith('default', 'What matters today?', undefined, [])
})

it('saves Feed instructions per profile and never generates while editing', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([])
  const view = render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'What should your Feed cover?' }), {
    target: { value: 'Focus on reliable AI news.' }
  })
  expect(generateFeedEdition).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(readFeedPrompt('default', null)).toBe('Focus on reliable AI news.')

  view.unmount()
  $activeGatewayProfile.set('other')
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)
  expect(screen.getByText(DEFAULT_FEED_PROMPT)).toBeTruthy()
  expect(readFeedPrompt('other', null)).toBe(DEFAULT_FEED_PROMPT)
  expect(generateFeedEdition).not.toHaveBeenCalled()
})

it('cancels an unsaved Feed edit without changing the next Generate request', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([])
  vi.mocked(generateFeedEdition).mockResolvedValue(edition)
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'What should your Feed cover?' }), {
    target: { value: 'Unsaved instructions' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(readFeedPrompt('default', null)).toBe(DEFAULT_FEED_PROMPT)
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(generateFeedEdition).toHaveBeenCalledWith('default', DEFAULT_FEED_PROMPT, undefined, []))
})

it('keeps the editor open when this Mac cannot save Feed instructions', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([])
  vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'What should your Feed cover?' }), {
    target: { value: 'A careful briefing' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  expect(screen.getByRole('alert').textContent).toContain('Could not save Feed instructions')
  expect(screen.getByRole('textbox', { name: 'What should your Feed cover?' })).toBeTruthy()
  expect(readFeedPrompt('default', null)).toBe(DEFAULT_FEED_PROMPT)
  expect(generateFeedEdition).not.toHaveBeenCalled()
})

it('ignores a late generation result after switching to another profile', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([])
  let resolveFirst!: (value: FeedEdition) => void
  vi.mocked(generateFeedEdition)
    .mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve }))
    .mockResolvedValueOnce({ ...edition, content: 'The second profile briefing.', id: 'edition-2' })
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(generateFeedEdition).toHaveBeenCalledTimes(1))
  act(() => { $activeGatewayProfile.set('other') })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  expect(await screen.findByText('The second profile briefing.')).toBeTruthy()

  await act(async () => { resolveFirst({ ...edition, content: 'The first profile briefing.' }) })
  expect(screen.getByText('The second profile briefing.')).toBeTruthy()
  expect(screen.queryByText('The first profile briefing.')).toBeNull()
  expect(generateFeedEdition).toHaveBeenNthCalledWith(2, 'other', DEFAULT_FEED_PROMPT, undefined, [])
})

it('shows safe load failure copy and recovers on explicit Retry load', async () => {
  vi.mocked(getFeedEditions)
    .mockRejectedValueOnce(new Error('token=private-value sensitive-path'))
    .mockResolvedValueOnce([edition])
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('Could not load Feed editions')
  expect(alert.textContent).not.toContain('private-value')
  fireEvent.click(screen.getByRole('button', { name: 'Retry load' }))
  expect(await screen.findByText('A saved briefing with a real answer.')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('retries a failed start rather than reloading editions, using the original prompt', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([])
  vi.mocked(generateFeedEdition)
    .mockRejectedValueOnce(new Error('token=private-value sensitive-path'))
    .mockResolvedValueOnce(edition)
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('Could not start this Feed edition')
  expect(alert.textContent).not.toContain('private-value')
  expect(screen.queryByRole('button', { name: 'Retry load' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

  expect(await screen.findByText('A saved briefing with a real answer.')).toBeTruthy()
  expect(generateFeedEdition).toHaveBeenCalledTimes(2)
  expect(generateFeedEdition).toHaveBeenNthCalledWith(2, 'default', DEFAULT_FEED_PROMPT, undefined, [])
  expect(getFeedEditions).toHaveBeenCalledTimes(1)
})

it('labels generated links as unverified on completed editions only', async () => {
  const fetchLinkTitle = vi.fn().mockResolvedValue('Unexpected network title')
  const desktopWindow = window as unknown as { hermesDesktop: unknown }

  desktopWindow.hermesDesktop = { fetchLinkTitle }

  const linked = {
    ...edition,
    content: 'Read [release notes](https://example.test/release).',
    source_urls: ['https://example.test/release']
  }

  vi.mocked(getFeedEditions).mockResolvedValue([linked])

  const view = render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  expect(await screen.findByText('Sources have not been verified. Links in this generated briefing may be inaccurate.')).toBeTruthy()
  expect(screen.queryByRole('link', { name: 'release notes' })).toBeNull()
  expect(screen.getByRole('link', { name: 'https://example.test/release' }).getAttribute('href')).toBe('https://example.test/release')
  expect(fetchLinkTitle).not.toHaveBeenCalled()
  expect(screen.getByRole('list', { name: 'Generated briefing links and retrieval status' }).textContent)
    .toContain('https://example.test/release — Page content not verified as retrieved')

  vi.mocked(getFeedEditions).mockResolvedValue([{ ...linked, retrieved_source_urls: ['https://example.test/release'] }])
  view.unmount()
  const legacyView = render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)
  expect(await screen.findByText('Links mentioned in this generated briefing:')).toBeTruthy()
  expect(screen.getByRole('list', { name: 'Generated briefing links and retrieval status' }).textContent)
    .toContain('https://example.test/release — Page content not verified as retrieved')

  vi.mocked(getFeedEditions).mockResolvedValue([{
    ...linked,
    content: 'Read [release notes](https://example.test/release) and [another link](https://example.test/other).',
    source_urls: ['https://example.test/release', 'https://example.test/other'],
    retrieved_source_urls: ['https://example.test/release'],
    source_events: [{
      tool_call_id: 'call-1', tool: 'web_extract',
      requested_url: 'https://example.test/release', result_url: 'https://example.test/release'
    }]
  }])
  legacyView.unmount()
  const retrievedView = render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)
  expect(await screen.findByText('Links mentioned in this generated briefing:')).toBeTruthy()
  const sourceList = screen.getByRole('list', { name: 'Generated briefing links and retrieval status' })
  expect(sourceList.textContent).toContain('https://example.test/release — Page content retrieved; claims not verified')
  expect(sourceList.textContent).toContain('https://example.test/other — Page content not verified as retrieved')
  expect(screen.getByText('Sources have not been verified. Links in this generated briefing may be inaccurate.')).toBeTruthy()
  expect(fetchLinkTitle).not.toHaveBeenCalled()

  vi.mocked(getFeedEditions).mockResolvedValue([{
    ...linked,
    source_events: [{
      tool_call_id: 'other-call', tool: 'web_extract',
      requested_url: 'https://example.test/other', result_url: 'https://example.test/release'
    }]
  }])
  retrievedView.unmount()
  const mismatchView = render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)
  expect(await screen.findByText('Links mentioned in this generated briefing:')).toBeTruthy()
  expect(screen.getByRole('list', { name: 'Generated briefing links and retrieval status' }).textContent)
    .toContain('https://example.test/release — Page content not verified as retrieved')

  vi.mocked(getFeedEditions).mockResolvedValue([{
    ...linked, content: null, error: 'Provider unavailable', status: 'failed'
  }])
  mismatchView.unmount()
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)
  expect(await screen.findByText('This briefing did not finish. Check your connection and try again.')).toBeTruthy()
  expect(screen.queryByText('Sources have not been verified. Links in this generated briefing may be inaccurate.')).toBeNull()
})

it('shows durable failed editions and retries only by explicit choice with the original prompt', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([{ ...edition, content: null, error: 'Provider unavailable', status: 'failed' }])
  vi.mocked(generateFeedEdition).mockResolvedValue({ ...edition, content: null, error: null, status: 'generating', attempt: 2 })
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  expect(await screen.findByText('This briefing did not finish. Check your connection and try again.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('Jarvis is preparing this briefing…')).toBeTruthy()
  expect(screen.queryByText('Sources have not been verified. Links in this generated briefing may be inaccurate.')).toBeNull()
  expect(generateFeedEdition).toHaveBeenCalledWith('default', 'What matters today?', 'edition-1', [])
})

it('hides backend paths and routes providerless generation to Connections', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([{
    ...edition,
    content: null,
    error: 'RuntimeError: [blocked_config] provider credential missing in /private/synthetic/profile/.env',
    status: 'denied'
  }])
  render(<MemoryRouter initialEntries={['/feed']}><Routes>
    <Route element={<ConsumerFeedEditions />} path="/feed" />
    <Route element={<p>Connections destination</p>} path="/connections" />
  </Routes></MemoryRouter>)

  expect(await screen.findByText('Connect an AI account in Connections before generating a briefing.')).toBeTruthy()
  expect(screen.queryByText(/RuntimeError|synthetic\/profile/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Connections' }))
  expect(screen.getByText('Connections destination')).toBeTruthy()
})

it('saves and reverses Love on a completed edition without generating a new one', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([edition])
  const view = render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  fireEvent.click(await screen.findByRole('button', { name: 'Love' }))
  expect(screen.getByRole('button', { name: 'Loved' }).getAttribute('aria-pressed')).toBe('true')
  expect(readLovedFeedEditions('default', null)).toEqual(['edition-1'])
  expect(generateFeedEdition).not.toHaveBeenCalled()

  view.unmount()
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)
  expect(await screen.findByRole('button', { name: 'Loved' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Loved' }))
  expect(readLovedFeedEditions('default', null)).toEqual([])
  expect(screen.getByRole('button', { name: 'Love' }).getAttribute('aria-pressed')).toBe('false')
})

it('sends loved edition IDs only with deliberate new generation and shows applied feedback', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([edition])
  vi.mocked(generateFeedEdition).mockResolvedValue({
    ...edition, id: 'edition-2', feedback_applied_count: 1,
  })
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  fireEvent.click(await screen.findByRole('button', { name: 'Love' }))
  expect(generateFeedEdition).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  expect(await screen.findByText('Guided by 1 loved briefing')).toBeTruthy()
  expect(generateFeedEdition).toHaveBeenCalledWith('default', DEFAULT_FEED_PROMPT, undefined, ['edition-1'])
})

it('does not carry edition Love to another profile', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([edition])
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  fireEvent.click(await screen.findByRole('button', { name: 'Love' }))
  act(() => { $activeGatewayProfile.set('other') })
  expect((await screen.findByRole('button', { name: 'Love' })).getAttribute('aria-pressed')).toBe('false')
  expect(readLovedFeedEditions('other', null)).toEqual([])
})

it('does not reuse a local edition when a remote connection is literally named local', async () => {
  let resolveLocal!: (value: FeedEdition[]) => void
  vi.mocked(getFeedEditions)
    .mockReturnValueOnce(new Promise(resolve => { resolveLocal = resolve }))
    .mockResolvedValueOnce([{ ...edition, content: 'Remote briefing.', id: 'remote-edition' }])
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  await waitFor(() => expect(getFeedEditions).toHaveBeenCalledTimes(1))
  act(() => { $connection.set({ mode: 'remote', connectionId: 'local' } as never) })
  expect(await screen.findByText('Remote briefing.')).toBeTruthy()

  await act(async () => { resolveLocal([edition]) })
  expect(screen.getByText('Remote briefing.')).toBeTruthy()
  expect(screen.queryByText('A saved briefing with a real answer.')).toBeNull()
})

it('shows a refusal when edition Love cannot be saved', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([edition])
  vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  fireEvent.click(await screen.findByRole('button', { name: 'Love' }))
  expect(screen.getByRole('alert').textContent).toContain('Could not save that choice')
  expect(screen.getByRole('button', { name: 'Love' }).getAttribute('aria-pressed')).toBe('false')
  expect(readLovedFeedEditions('default', null)).toEqual([])
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

it('renders only explicit complete stories as distinct cards and discusses one without sending', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([{
    ...edition,
    content: 'An introduction.\n\n## First story\nFirst details.\n\n## Second story\nSecond details.'
  }])
  render(
    <MemoryRouter initialEntries={['/feed']}>
      <Routes>
        <Route element={<ConsumerFeedEditions />} path="/feed" />
        <Route element={<p>Editable draft</p>} path="/" />
      </Routes>
    </MemoryRouter>
  )

  expect(await screen.findByRole('list', { name: 'Stories in this briefing' })).toBeTruthy()
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(screen.getByRole('region', { name: 'First story' }).textContent).toContain('First details.')
  expect(screen.getByRole('region', { name: 'Second story' }).textContent).toContain('Second details.')
  expect(screen.getByRole('button', { name: 'Love' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Discuss Second story' }))
  expect(screen.getByText('Editable draft')).toBeTruthy()
  expect(takeSessionDraft(null).text).toContain('## Second story\n\nSecond details.')
  expect(takeSessionDraft(null).text).not.toContain('First details.')
  expect(generateFeedEdition).not.toHaveBeenCalled()
})

it('saves reversible per-story Love without changing edition feedback or triggering generation', async () => {
  const stories = {
    ...edition,
    content: '## First story\nFirst details.\n\n## Second story\nSecond details.'
  }

  vi.mocked(getFeedEditions).mockResolvedValue([stories])
  vi.mocked(generateFeedEdition).mockResolvedValue({ ...edition, id: 'edition-2', feedback_applied_count: 0 })
  const view = render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  expect(await screen.findByRole('button', { name: 'Love First story' })).toBeTruthy()
  expect(screen.getByText('Story Love is saved on this Mac only; it does not guide future briefings.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Love Second story' }))
  expect(screen.getByRole('button', { name: 'Loved Second story' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'Love First story' }).getAttribute('aria-pressed')).toBe('false')
  expect(readLovedFeedStories('default', null)).toEqual(['edition-1:1'])
  expect(readLovedFeedEditions('default', null)).toEqual([])
  expect(generateFeedEdition).not.toHaveBeenCalled()

  view.unmount()
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)
  expect(await screen.findByRole('button', { name: 'Loved Second story' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(generateFeedEdition).toHaveBeenCalledWith('default', DEFAULT_FEED_PROMPT, undefined, []))
  fireEvent.click(screen.getByRole('button', { name: 'Loved Second story' }))
  expect(readLovedFeedStories('default', null)).toEqual([])
})

it('keeps story Love in its profile and shows failed persistence without a false pressed state', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([{
    ...edition, content: '## First story\nFirst details.\n\n## Second story\nSecond details.'
  }])
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  fireEvent.click(await screen.findByRole('button', { name: 'Love First story' }))
  act(() => { $activeGatewayProfile.set('other') })
  expect((await screen.findByRole('button', { name: 'Love First story' })).getAttribute('aria-pressed')).toBe('false')
  expect(readLovedFeedStories('other', null)).toEqual([])

  vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })
  fireEvent.click(screen.getByRole('button', { name: 'Love Second story' }))
  expect(screen.getByRole('alert').textContent).toContain('Could not save that choice')
  expect(screen.getByRole('button', { name: 'Love Second story' }).getAttribute('aria-pressed')).toBe('false')
  expect(readLovedFeedStories('other', null)).toEqual([])
})

it('keeps an unstructured or incomplete generated edition in the legacy view', async () => {
  vi.mocked(getFeedEditions).mockResolvedValue([{
    ...edition,
    content: '## First story\nDetails.\n\n## Empty second story'
  }])
  render(<MemoryRouter><ConsumerFeedEditions /></MemoryRouter>)

  expect(await screen.findByText('Details.')).toBeTruthy()
  expect(screen.queryByRole('list', { name: 'Stories in this briefing' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Discuss' })).toBeTruthy()
})
