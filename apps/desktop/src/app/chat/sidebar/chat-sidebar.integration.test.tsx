// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarProvider } from '@/components/ui/sidebar'
import { registry } from '@/contrib/registry'
import { en } from '@/i18n/en'
import { $cronJobs } from '@/store/cron'
import { $sessions } from '@/store/session'
import { $removedSessionIds } from '@/store/session-removal'
import { makeSessionInfo } from '@/test/session-info'

import { type AppView, ROUTES_AREA, SIDEBAR_NAV_AREA } from '../../routes'

import { ChatSidebar, OPEN_CONSUMER_CHATS_EVENT, OPEN_CONSUMER_SEARCH_EVENT } from './index'

const searchSessionsMock = vi.hoisted(() => vi.fn())
const listLibrarySessionsMock = vi.hoisted(() => vi.fn())
const getLibraryMessagesMock = vi.hoisted(() => vi.fn())

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal() as object),
  searchSessions: searchSessionsMock,
  listAllProfileSessions: listLibrarySessionsMock,
  getAllSessionMessages: getLibraryMessagesMock
}))

const noop = () => {}

const noopAsync = async () => {}

const sessions = [
  makeSessionInfo({ id: 'side-one', last_active: 2, profile: 'default', started_at: 1, title: 'Side chat one' }),
  makeSessionInfo({ id: 'side-two', last_active: 3, profile: 'default', started_at: 1, title: 'Side chat two' })
]

function renderSidebar(
  pathname = '/', currentView: AppView = 'chat', onResumeSession = vi.fn(), onNavigate = vi.fn(), onManageCronJob = vi.fn()
) {
  const result = render(
    <MemoryRouter initialEntries={[pathname]}>
      <SidebarProvider>
        <ChatSidebar
          currentView={currentView}
          onArchiveSession={noop}
          onBranchSession={noop}
          onDeleteSession={noop}
          onLoadMoreSessions={noop}
          onManageCronJob={onManageCronJob}
          onNavigate={onNavigate}
          onNewSessionInWorkspace={noop}
          onNewSessionSplit={noop}
          onResumeSession={onResumeSession}
          onTriggerCronJob={noopAsync}
        />
      </SidebarProvider>
    </MemoryRouter>
  )

  return { ...result, onResumeSession, onNavigate, onManageCronJob }
}

describe('consumer chat navigation', () => {
  beforeEach(() => {
    searchSessionsMock.mockReset()
    searchSessionsMock.mockResolvedValue({ results: [] })
    listLibrarySessionsMock.mockReset()
    listLibrarySessionsMock.mockResolvedValue({ sessions: [], total: 0 })
    getLibraryMessagesMock.mockReset()
    $sessions.set(sessions)
    $cronJobs.set([])
    $removedSessionIds.set(new Set())
  })

  afterEach(() => {
    cleanup()
    $sessions.set([])
    $cronJobs.set([])
    $removedSessionIds.set(new Set())
  })

  it('keeps the rail focused on consumer destinations even when plugins contribute developer pages', () => {
    const dispose = registry.registerMany([
      { area: ROUTES_AREA, id: 'kanban-page', data: { path: '/kanban' }, render: () => null },
      { area: SIDEBAR_NAV_AREA, id: 'kanban-nav', data: { codicon: 'project', label: 'Kanban', path: '/kanban' } }
    ])

    renderSidebar()

    expect(screen.getByRole('button', { name: 'Jarvis' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Feed' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ideas' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Goals' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Library' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Automations' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connections' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Kanban' })).toBeNull()

    dispose()
  })

  it('opens Chats as a drawer and closes it after a side chat is selected', async () => {
    const { onResumeSession } = renderSidebar()

    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_CHATS_EVENT)))
    expect(await screen.findByRole('dialog', { name: 'Chats' })).toBeTruthy()
    fireEvent.click(screen.getByText('Side chat two'))

    expect(onResumeSession).toHaveBeenCalledWith('side-two', expect.objectContaining({ title: 'Side chat two' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Chats' })).toBeNull())
  })

  it('opens focused Search over the chat and starts each search fresh', async () => {
    renderSidebar()

    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_SEARCH_EVENT)))

    expect(await screen.findByRole('dialog', { name: 'Search' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New side chat' })).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Search chats, pages, and automations' }) === window.document.activeElement).toBe(true)
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Search chats, pages, and automations' }), { target: { value: 'side' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull())

    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_SEARCH_EVENT)))
    expect(await screen.findByRole('textbox', { name: 'Search chats, pages, and automations' })).toHaveProperty('value', '')
  })

  it('keeps Search usable with no side chats and returns to the permanent main chat', async () => {
    $sessions.set([])
    const { onNavigate } = renderSidebar()

    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_SEARCH_EVENT)))

    expect(await screen.findByRole('textbox', { name: 'Search chats, pages, and automations' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Main chat' }))

    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-session' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull())
  })

  it('opens a matching consumer page from Search without sending a chat message', async () => {
    const { onNavigate, onResumeSession } = renderSidebar()

    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_SEARCH_EVENT)))
    const dialog = await screen.findByRole('dialog', { name: 'Search' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search chats, pages, and automations' }), { target: { value: 'goals' } })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Goals' }))
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'goals' }))
    expect(onResumeSession).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull())
  })

  it('opens a matching scheduled automation through its real focus action', async () => {
    $cronJobs.set([{ id: 'morning-check', enabled: true, name: 'Morning check-in' }])
    const onManageCronJob = vi.fn()
    const onResumeSession = vi.fn()
    renderSidebar('/', 'chat', onResumeSession, vi.fn(), onManageCronJob)

    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_SEARCH_EVENT)))
    const dialog = await screen.findByRole('dialog', { name: 'Search' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search chats, pages, and automations' }), {
      target: { value: 'morning' }
    })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Morning check-in' }))
    expect(onManageCronJob).toHaveBeenCalledWith('morning-check')
    expect(onResumeSession).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull())
  })

  it('finds a real saved Library artifact and resumes its owning profile', async () => {
    const owner = makeSessionInfo({ id: 'saved-artifact', profile: 'writer', connection_id: 'remote-1', title: 'Report work' })
    listLibrarySessionsMock.mockResolvedValue({ sessions: [owner], total: 1 })
    getLibraryMessagesMock.mockResolvedValue({ messages: [
      { role: 'assistant', timestamp: 1000, content: 'Saved /tmp/quarterly-report.pdf' }
    ] })
    const onResumeSession = vi.fn()
    renderSidebar('/', 'chat', onResumeSession)

    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_SEARCH_EVENT)))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search chats, pages, and automations' }), {
      target: { value: 'quarterly-report' }
    })

    fireEvent.click(await screen.findByRole('button', { name: /quarterly-report\.pdf/ }))
    expect(onResumeSession).toHaveBeenCalledWith('saved-artifact', owner)
    expect(getLibraryMessagesMock).toHaveBeenCalledWith('saved-artifact', 'writer')
  })

  it('does not index or reveal hidden worker artifacts in consumer Search', async () => {
    const worker = makeSessionInfo({ id: 'hidden-worker', source: 'subagent', title: 'Internal result' })
    listLibrarySessionsMock.mockResolvedValue({ sessions: [worker], total: 1 })
    getLibraryMessagesMock.mockResolvedValue({ messages: [
      { role: 'assistant', timestamp: 1000, content: 'Saved /tmp/hidden-worker-report.pdf' }
    ] })
    renderSidebar()

    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_SEARCH_EVENT)))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search chats, pages, and automations' }), {
      target: { value: 'hidden-worker-report' }
    })

    await waitFor(() => expect(listLibrarySessionsMock).toHaveBeenCalledOnce())
    expect(getLibraryMessagesMock).not.toHaveBeenCalled()
    expect(screen.queryByText('hidden-worker-report.pdf')).toBeNull()
  })

  it('continues the Library search into older saved sessions', async () => {
    listLibrarySessionsMock
      .mockResolvedValueOnce({
        sessions: Array.from({ length: 30 }, (_, index) => makeSessionInfo({ id: `recent-${index}`, profile: 'default' })),
        total: 31
      })
      .mockResolvedValueOnce({
        sessions: [makeSessionInfo({ id: 'older-artifact', profile: 'default', title: 'Older work' })],
        total: 31
      })
    getLibraryMessagesMock.mockImplementation(async (id: string) => ({
      messages: id === 'older-artifact'
        ? [{ role: 'assistant', timestamp: 1000, content: 'Saved /tmp/older-report.pdf' }]
        : []
    }))
    renderSidebar()
    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_SEARCH_EVENT)))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search chats, pages, and automations' }), {
      target: { value: 'older-report' }
    })

    expect(await screen.findByRole('button', { name: /older-report\.pdf/ })).toBeTruthy()
    expect(listLibrarySessionsMock.mock.calls[1][6]).toBe(30)
  })

  it('keeps a Library indexing failure distinct from no results and retries', async () => {
    $sessions.set([])
    listLibrarySessionsMock.mockRejectedValueOnce(new Error('offline'))
    renderSidebar()
    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_SEARCH_EVENT)))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search chats, pages, and automations' }), {
      target: { value: 'unknown-artifact' }
    })

    expect((await screen.findByRole('alert')).textContent).toContain('Library')
    expect(screen.queryByText('No results for “unknown-artifact”.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(listLibrarySessionsMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No results for “unknown-artifact”.')).toBeTruthy()
  })

  it('describes a no-match result without implying only chats were searched', () => {
    expect(en.sidebar.noMatch('zz-example-no-match')).toBe('No results for “zz-example-no-match”.')
  })

  it('does not call a failed full-text chat search an empty result and can retry it', async () => {
    $sessions.set([])
    searchSessionsMock.mockRejectedValueOnce(new Error('synthetic offline'))
    searchSessionsMock.mockResolvedValueOnce({ results: [] })
    renderSidebar()
    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_SEARCH_EVENT)))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search chats, pages, and automations' }), {
      target: { value: 'missing-side-chat' }
    })

    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t search all chats')
    expect(screen.queryByText('No results for “missing-side-chat”.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(searchSessionsMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No results for “missing-side-chat”.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the real permanent main chat preview in Search recents', async () => {
    $sessions.set([
      ...sessions,
      makeSessionInfo({
        id: 'main-chat',
        last_active: 4,
        preview: 'Recent main chat preview',
        profile: 'default',
        title: 'Jarvis'
      })
    ])

    renderSidebar()
    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_SEARCH_EVENT)))

    const preview = await screen.findByText('Recent main chat preview')
    expect(preview.closest('button')).toBe(screen.getByRole('button', { name: /Main chat/ }))
  })
})
