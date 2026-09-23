import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/api/feed', () => ({ getFeedEditions: vi.fn(async () => []), generateFeedEdition: vi.fn() }))

import { clearSessionDraft, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $cronJobs } from '@/store/cron'
import { $gateway } from '@/store/gateway'
import { $goalsBySession } from '@/store/goals'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $activeGatewayProfile, $freshSessionRequest } from '@/store/profile'
import { $connection, $sessions } from '@/store/session'
import { makeSessionInfo } from '@/test/session-info'

import { ConsumerFeedView, ConsumerGoalsView, ConsumerIdeasView } from './consumer-pages'
import { readIdeaFeedback } from './ideas/feedback'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  clearSessionDraft(null)
  clearNotifications()
  $cronJobs.set([])
  $goalsBySession.set({})
  $gateway.set(null as never)
  $activeGatewayProfile.set('default')
  $connection.set(null)
  $freshSessionRequest.set(0)
  $sessions.set([])
})

it('opens a real recent conversation from Feed', () => {
  $sessions.set([
    makeSessionInfo({ id: 'recent-chat', last_active: Date.now() / 1000, title: 'Plan the weekend' })
  ])

  render(
    <MemoryRouter initialEntries={['/feed']}>
      <Routes>
        <Route element={<ConsumerFeedView />} path="/feed" />
        <Route element={<p>Opened recent chat</p>} path="/:sessionId" />
      </Routes>
    </MemoryRouter>
  )

  fireEvent.click(screen.getByRole('button', { name: /Plan the weekend/ }))
  expect(screen.getByText('Opened recent chat')).toBeTruthy()
})

it('never exposes background or messaging sessions as recent chats', () => {
  $sessions.set([
    makeSessionInfo({ id: 'main', source: 'desktop', title: 'My main chat', last_active: 1 }),
    makeSessionInfo({ id: 'side', source: 'desktop', parent_session_id: 'main', title: 'Trip planning', last_active: 2 }),
    makeSessionInfo({ id: 'worker', source: 'subagent', title: 'Hidden worker', last_active: 7 }),
    makeSessionInfo({ id: 'cron', source: 'cron', title: 'Background run', last_active: 6 }),
    makeSessionInfo({ id: 'message', source: 'telegram', title: 'Private message', last_active: 5 }),
    makeSessionInfo({ id: 'archived', source: 'desktop', title: 'Old chat', archived: true, last_active: 4 })
  ])

  render(<MemoryRouter><ConsumerFeedView /></MemoryRouter>)

  expect(screen.getByRole('button', { name: /My main chat/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Trip planning/ })).toBeTruthy()
  expect(screen.queryByText('Hidden worker')).toBeNull()
  expect(screen.queryByText('Background run')).toBeNull()
  expect(screen.queryByText('Private message')).toBeNull()
  expect(screen.queryByText('Old chat')).toBeNull()
})

it('keeps automation status cards on Automations rather than duplicating them in Feed', () => {
  $cronJobs.set([{ id: 'finished', name: 'Morning briefing', enabled: true, state: 'completed', schedule_display: 'once in 1 minute' }])

  render(
    <MemoryRouter>
      <ConsumerFeedView />
    </MemoryRouter>
  )

  expect(screen.getByRole('heading', { name: /Automation updates/i })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Automations' })).toBeNull()
  expect(screen.queryByText('once in 1 minute')).toBeNull()
})

it('turns an Idea into an editable chat draft without sending it', () => {
  render(
    <MemoryRouter>
      <ConsumerIdeasView />
    </MemoryRouter>
  )

  fireEvent.click(screen.getByRole('button', { name: /^Plan my day/ }))
  expect(takeSessionDraft(null).text).toBe('Help me plan today around my calendar, priorities, and energy.')
  expect($freshSessionRequest.get()).toBe(1)
  expect(screen.getByRole('heading', { name: 'Featured ideas' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Shopping' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Productivity' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Relationships' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Financial planning' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Health & fitness' })).toBeTruthy()
})

it('keeps a shopping idea as an editable draft without taking action', () => {
  render(<MemoryRouter><ConsumerIdeasView /></MemoryRouter>)

  fireEvent.click(screen.getByRole('button', { name: /^Compare a purchase/ }))
  expect(takeSessionDraft(null).text).toContain('Do not buy anything.')
  expect($freshSessionRequest.get()).toBe(1)
})

it('saves and clears Idea feedback without opening a chat or sending a prompt', async () => {
  const view = render(<MemoryRouter><ConsumerIdeasView /></MemoryRouter>)

  fireEvent.pointerDown(screen.getByRole('button', { name: 'Feedback for Plan my day' }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Save for later' }))
  expect(readIdeaFeedback('default', null)['plan-day']).toBe('saved')
  expect($notifications.get()).toEqual([])
  expect(screen.getByRole('button', { name: /^Plan my day/ }).textContent).toContain('Saved for later')
  expect($freshSessionRequest.get()).toBe(0)
  expect(takeSessionDraft(null).text).toBe('')

  view.unmount()
  render(<MemoryRouter><ConsumerIdeasView /></MemoryRouter>)
  expect(screen.getByText('Saved for later')).toBeTruthy()
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Feedback for Plan my day' }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear choice' }))
  expect(readIdeaFeedback('default', null)['plan-day']).toBeUndefined()
})

it('requires an explicit choice before adding a goal to an existing unsent draft', async () => {
  stashSessionDraft(null, 'Existing thought', [])
  $gateway.set({ request: async () => ({ goals: [] }) } as never)

  render(
    <MemoryRouter>
      <ConsumerGoalsView />
    </MemoryRouter>
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Health' }))
  expect(screen.getByRole('dialog', { name: 'Create a health goal' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Talk it through' }))
  expect(takeSessionDraft(null).text).toBe('Existing thought')
  expect($freshSessionRequest.get()).toBe(0)
  expect($notifications.get()[0]?.message).toContain('Nothing was added')

  $notifications.get()[0]?.action?.onClick()
  expect(takeSessionDraft(null).text).toBe(
    'Existing thought\n\nHelp me clarify a health-related goal. Ask what outcome I want and what constraints matter before making a plan.'
  )
  expect($freshSessionRequest.get()).toBe(1)
})

it('clarifies a goal category before creating an editable draft, without claiming a saved goal', async () => {
  $gateway.set({ request: async () => ({ goals: [] }) } as never)

  render(<MemoryRouter><ConsumerGoalsView /></MemoryRouter>)

  fireEvent.click(await screen.findByRole('button', { name: 'Productivity' }))
  expect(screen.getByRole('dialog', { name: 'Create a productivity goal' })).toBeTruthy()
  expect($freshSessionRequest.get()).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'Talk it through' }))
  expect(takeSessionDraft(null).text).toBe(
    'Help me clarify a productivity goal. Ask what outcome matters and what is getting in the way.'
  )
  expect($freshSessionRequest.get()).toBe(1)
  expect(screen.queryByRole('heading', { name: 'Tracking' })).toBeNull()
  expect(screen.getByRole('heading', { name: 'Create a goal' })).toBeTruthy()
})

it('carries the typed goal into an editable clarification draft without saving it', async () => {
  const request = vi.fn(async () => ({ goals: [] }))
  $gateway.set({ request } as never)

  render(<MemoryRouter><ConsumerGoalsView /></MemoryRouter>)

  fireEvent.click(await screen.findByRole('button', { name: 'Health' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Already have a name for it? (optional)' }), { target: { value: '  Walk three times a week  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Talk it through' }))

  expect(takeSessionDraft(null).text).toBe(
    'I want to work toward: Walk three times a week\n\nHelp me clarify a health-related goal. Ask what outcome I want and what constraints matter before making a plan.'
  )
  expect($freshSessionRequest.get()).toBe(1)
  expect(request).not.toHaveBeenCalledWith('session.goals.create', expect.anything())
})

it('saves a passive goal and shows it in Tracking without sending a prompt', async () => {
  const request = vi.fn(async (method: string) => method === 'session.goals.list'
    ? { goals: [] }
    : { goal: { session_id: 'new-goal', session_title: 'Walk three times a week', goal: { status: 'paused', paused_reason: 'consumer_tracking', title: 'Walk three times a week' } } })

  $gateway.set({ request } as never)

  render(<MemoryRouter><ConsumerGoalsView /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: 'Health' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Already have a name for it? (optional)' }), { target: { value: 'Walk three times a week' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))

  expect(await screen.findByRole('button', { name: /Walk three times a week/ })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Tracking' })).toBeTruthy()
  expect(request).toHaveBeenCalledWith('session.goals.create', { profile: 'default', title: 'Walk three times a week' })
  expect($freshSessionRequest.get()).toBe(0)
})

it('keeps the goal form open when saving fails', async () => {
  const request = vi.fn(async (method: string) => {
    if (method === 'session.goals.list') {
      return { goals: [] }
    }

    throw new Error('offline')
  })

  $gateway.set({ request } as never)

  render(<MemoryRouter><ConsumerGoalsView /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: 'Health' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Already have a name for it? (optional)' }), { target: { value: 'Keep in touch' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))

  expect((await screen.findByRole('alert')).textContent).toContain('could not be saved')
  expect(screen.getByRole('textbox', { name: 'Already have a name for it? (optional)' })).toHaveProperty('value', 'Keep in touch')
  expect(screen.queryByRole('button', { name: /Keep in touch/ })).toBeNull()
})

it('closes goal clarification without preparing a chat draft', async () => {
  $gateway.set({ request: async () => ({ goals: [] }) } as never)

  render(<MemoryRouter><ConsumerGoalsView /></MemoryRouter>)

  fireEvent.click(await screen.findByRole('button', { name: 'Health' }))
  expect(screen.getByRole('dialog', { name: 'Create a health goal' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close goal setup' }))

  expect(screen.queryByRole('dialog', { name: 'Create a health goal' })).toBeNull()
  expect($freshSessionRequest.get()).toBe(0)
})

it('keeps focus in goal clarification and restores the category after Escape', async () => {
  $gateway.set({ request: async () => ({ goals: [] }) } as never)
  render(<MemoryRouter><ConsumerGoalsView /></MemoryRouter>)

  const health = await screen.findByRole('button', { name: 'Health' })
  fireEvent.click(health)
  const dialog = screen.getByRole('dialog', { name: 'Create a health goal' })
  const chat = screen.getByRole('button', { name: 'Talk it through' })
  const save = screen.getByRole('button', { name: 'Save goal' })
  const close = screen.getByRole('button', { name: 'Close goal setup' })
  expect(globalThis.document.activeElement).toBe(chat)

  fireEvent.change(screen.getByRole('textbox', { name: 'Already have a name for it? (optional)' }), { target: { value: 'Walk more' } })
  close.focus()
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
  expect(globalThis.document.activeElement).toBe(save)
  fireEvent.keyDown(dialog, { key: 'Tab' })
  expect(globalThis.document.activeElement).toBe(close)
  fireEvent.keyDown(dialog, { key: 'Escape' })

  expect(screen.queryByRole('dialog')).toBeNull()
  expect(globalThis.document.activeElement).toBe(health)
  expect($freshSessionRequest.get()).toBe(0)
})

it('shows live goal state and opens its owning conversation', () => {
  $gateway.set({ request: async () => ({ goals: [] }) } as never)
  $sessions.set([makeSessionInfo({ id: 'goal-chat', last_active: 1, title: 'Launch plan' })])
  $goalsBySession.set({
    'goal-chat': { status: 'active', title: 'Ship the prototype', updatedAt: Date.now() }
  })

  render(
    <MemoryRouter initialEntries={['/goals']}>
      <Routes>
        <Route element={<ConsumerGoalsView />} path="/goals" />
        <Route element={<p>Opened goal chat</p>} path="/:sessionId" />
      </Routes>
    </MemoryRouter>
  )

  fireEvent.click(screen.getByRole('button', { name: /Ship the prototype/ }))
  expect(screen.getByText('Opened goal chat')).toBeTruthy()
})

it('lists persisted goals without opening a session or spending a model turn', async () => {
  const request = vi.fn(async () => ({ goals: [{
    session_id: 'saved-chat',
    session_title: 'Move plans',
    goal: { status: 'paused', title: 'Find a new place', updated_at: 100 }
  }] }))

  $gateway.set({ request } as never)

  render(
    <MemoryRouter initialEntries={['/goals']}>
      <Routes>
        <Route element={<ConsumerGoalsView />} path="/goals" />
        <Route element={<p>Opened saved chat</p>} path="/:sessionId" />
      </Routes>
    </MemoryRouter>
  )

  const goal = await screen.findByRole('button', { name: /Find a new place/ })
  expect(request).toHaveBeenCalledWith('session.goals.list', { profile: 'default' })
  expect(request).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Health' })).toBeTruthy()
  fireEvent.click(goal)
  expect(screen.getByText('Opened saved chat')).toBeTruthy()
})

it('shows a retry instead of an empty state when persisted goals fail to load', async () => {
  const request = vi.fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ goals: [] })

  $gateway.set({ request } as never)

  render(<MemoryRouter><ConsumerGoalsView /></MemoryRouter>)

  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Create a goal' })).toBeTruthy())
  expect(request).toHaveBeenCalledTimes(2)
})

it('persists completion and reopening from the goal checkbox without opening a chat', async () => {
  const goal = { session_id: 'saved-chat', session_title: 'Move plans', goal: { status: 'active', title: 'Find a new place' } }

  const request = vi.fn(async (method: string, params: { completed?: boolean }) => method === 'session.goals.list'
    ? { goals: [goal] }
    : { goal: { ...goal, goal: { ...goal.goal, status: params.completed ? 'done' : 'active' } } })

  $gateway.set({ request } as never)
  $sessions.set([makeSessionInfo({ id: 'saved-chat', title: 'Move plans' })])

  render(<MemoryRouter><ConsumerGoalsView /></MemoryRouter>)

  fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete Find a new place' }))
  expect((await screen.findByRole('checkbox', { name: 'Reopen Find a new place' })).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Reopen Find a new place' }))
  expect((await screen.findByRole('checkbox', { name: 'Complete Find a new place' })).getAttribute('aria-checked')).toBe('false')
  expect(request).toHaveBeenCalledWith('session.goals.set_completed', {
    completed: true, profile: 'default', session_id: 'saved-chat'
  })
  expect(request).toHaveBeenCalledWith('session.goals.set_completed', {
    completed: false, profile: 'default', session_id: 'saved-chat'
  })
})

it('reopens a consumer tracking goal without showing an autonomous active loop', async () => {
  const goal = { session_id: 'saved-chat', session_title: 'Walking', goal: { status: 'paused', paused_reason: 'consumer_tracking', title: 'Walk three times a week' } }

  const request = vi.fn(async (method: string, params: { completed?: boolean }) => method === 'session.goals.list'
    ? { goals: [goal] }
    : { goal: { ...goal, goal: { ...goal.goal, status: params.completed ? 'done' : 'paused' } } })

  $gateway.set({ request } as never)

  render(<MemoryRouter><ConsumerGoalsView /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete Walk three times a week' }))
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Reopen Walk three times a week' }))

  expect((await screen.findByRole('checkbox', { name: 'Complete Walk three times a week' })).getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('heading', { name: 'Tracking' })).toBeTruthy()
})

it('keeps the goal unchecked and reports a failed completion write', async () => {
  const goal = { session_id: 'saved-chat', session_title: 'Move plans', goal: { status: 'active', title: 'Find a new place' } }

  const request = vi.fn(async (method: string) => {
    if (method === 'session.goals.list') {
      return { goals: [goal] }
    }

    throw new Error('write failed')
  })

  $gateway.set({ request } as never)

  render(<MemoryRouter><ConsumerGoalsView /></MemoryRouter>)

  fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete Find a new place' }))
  expect((await screen.findByRole('alert')).textContent).toContain('could not be updated')
  expect(screen.getByRole('checkbox', { name: 'Complete Find a new place' }).getAttribute('aria-checked')).toBe('false')
})
