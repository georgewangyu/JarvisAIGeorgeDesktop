import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, it } from 'vitest'

import { clearSessionDraft, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $cronFocusJobId, $cronJobs, setCronFocusJobId } from '@/store/cron'
import { $goalsBySession } from '@/store/goals'
import { $sessions } from '@/store/session'
import { makeSessionInfo } from '@/test/session-info'

import { ConsumerFeedView, ConsumerGoalsView, ConsumerIdeasView } from './consumer-pages'

afterEach(() => {
  cleanup()
  clearSessionDraft(null)
  $cronJobs.set([])
  setCronFocusJobId(null)
  $goalsBySession.set({})
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

it('shows completed automation state instead of its expired one-time schedule', () => {
  $cronJobs.set([{ id: 'finished', name: 'Morning briefing', enabled: true, state: 'completed', schedule_display: 'once in 1 minute' }])

  render(
    <MemoryRouter>
      <ConsumerFeedView />
    </MemoryRouter>
  )

  expect(screen.getByRole('button', { name: /Morning briefing Completed/ })).toBeTruthy()
  expect(screen.queryByText('once in 1 minute')).toBeNull()
})

it('opens the exact automation selected from Feed', () => {
  $cronJobs.set([
    { id: 'first', name: 'Morning briefing', enabled: true },
    { id: 'second', name: 'Weekly review', enabled: true }
  ])

  render(
    <MemoryRouter initialEntries={['/feed']}>
      <Routes>
        <Route element={<ConsumerFeedView />} path="/feed" />
        <Route element={<p>Opened automations</p>} path="/cron" />
      </Routes>
    </MemoryRouter>
  )

  fireEvent.click(screen.getByRole('button', { name: /Weekly review/ }))

  expect(screen.getByText('Opened automations')).toBeTruthy()
  expect($cronFocusJobId.get()).toBe('second')
})

it('turns an Idea into an editable chat draft without sending it', () => {
  render(
    <MemoryRouter>
      <ConsumerIdeasView />
    </MemoryRouter>
  )

  fireEvent.click(screen.getByRole('button', { name: /Plan my day/ }))
  expect(takeSessionDraft(null).text).toBe('Help me plan today around my calendar, priorities, and energy.')
})

it('preserves an existing unsent draft when starting a goal', () => {
  stashSessionDraft(null, 'Existing thought', [])

  render(
    <MemoryRouter>
      <ConsumerGoalsView />
    </MemoryRouter>
  )

  fireEvent.click(screen.getByRole('button', { name: 'Start a goal' }))
  expect(takeSessionDraft(null).text).toBe('Existing thought\n\nHelp me set a goal and turn it into a realistic plan: ')
})

it('shows live goal state and opens its owning conversation', () => {
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
