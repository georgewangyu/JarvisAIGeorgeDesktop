// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarProvider } from '@/components/ui/sidebar'
import { registry } from '@/contrib/registry'
import { $sessions } from '@/store/session'
import { $removedSessionIds } from '@/store/session-removal'
import { makeSessionInfo } from '@/test/session-info'

import { type AppView, ROUTES_AREA, SIDEBAR_NAV_AREA } from '../../routes'

import { ChatSidebar, OPEN_CONSUMER_CHATS_EVENT, OPEN_CONSUMER_SEARCH_EVENT } from './index'

const noop = () => {}

const noopAsync = async () => {}

const sessions = [
  makeSessionInfo({ id: 'side-one', last_active: 2, profile: 'default', started_at: 1, title: 'Side chat one' }),
  makeSessionInfo({ id: 'side-two', last_active: 3, profile: 'default', started_at: 1, title: 'Side chat two' })
]

function renderSidebar(pathname = '/', currentView: AppView = 'chat', onResumeSession = vi.fn(), onNavigate = vi.fn()) {
  const result = render(
    <MemoryRouter initialEntries={[pathname]}>
      <SidebarProvider>
        <ChatSidebar
          currentView={currentView}
          onArchiveSession={noop}
          onBranchSession={noop}
          onDeleteSession={noop}
          onLoadMoreSessions={noop}
          onManageCronJob={noop}
          onNavigate={onNavigate}
          onNewSessionInWorkspace={noop}
          onNewSessionSplit={noop}
          onResumeSession={onResumeSession}
          onTriggerCronJob={noopAsync}
        />
      </SidebarProvider>
    </MemoryRouter>
  )

  return { ...result, onResumeSession, onNavigate }
}

describe('consumer chat navigation', () => {
  beforeEach(() => {
    $sessions.set(sessions)
    $removedSessionIds.set(new Set())
  })

  afterEach(() => {
    cleanup()
    $sessions.set([])
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
      expect(screen.getByRole('textbox', { name: 'Search chats' }) === window.document.activeElement).toBe(true)
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Search chats' }), { target: { value: 'side' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull())

    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_SEARCH_EVENT)))
    expect(await screen.findByRole('textbox', { name: 'Search chats' })).toHaveProperty('value', '')
  })

  it('keeps Search usable with no side chats and returns to the permanent main chat', async () => {
    $sessions.set([])
    const { onNavigate } = renderSidebar()

    act(() => window.dispatchEvent(new Event(OPEN_CONSUMER_SEARCH_EVENT)))

    expect(await screen.findByRole('textbox', { name: 'Search chats' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Main chat' }))

    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-session' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull())
  })
})
