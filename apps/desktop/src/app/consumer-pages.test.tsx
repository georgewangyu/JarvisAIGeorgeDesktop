import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, it } from 'vitest'

import { $composerDraft } from '@/store/composer'
import { $cronJobs } from '@/store/cron'
import { $goalsBySession } from '@/store/goals'
import { $sessions } from '@/store/session'
import { makeSessionInfo } from '@/test/session-info'

import { ConsumerFeedView, ConsumerGoalsView, ConsumerIdeasView } from './consumer-pages'

afterEach(() => {
  cleanup()
  $composerDraft.set('')
  $cronJobs.set([])
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

it('turns an Idea into an editable chat draft without sending it', () => {
  render(
    <MemoryRouter>
      <ConsumerIdeasView />
    </MemoryRouter>
  )

  fireEvent.click(screen.getByRole('button', { name: /Plan my day/ }))
  expect($composerDraft.get()).toBe('Help me plan today around my calendar, priorities, and energy.')
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
