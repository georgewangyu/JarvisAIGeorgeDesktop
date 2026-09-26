import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'

import { TrackChatGoal } from './track-chat-goal'

const renderGoal = (sessionId = 'clarified-chat') => render(
  <MemoryRouter initialEntries={['/chat']}>
    <Routes>
      <Route element={<TrackChatGoal sessionId={sessionId} sessionTitle="Jarvis" />} path="/chat" />
      <Route element={<p>Goals page opened</p>} path="/goals" />
    </Routes>
  </MemoryRouter>
)

beforeEach(() => {
  $activeGatewayProfile.set('default')
})

afterEach(() => {
  cleanup()
  $gateway.set(null)
  $activeGatewayProfile.set('default')
})

it('links a clarified chat to a passive saved goal and opens Goals', async () => {
  const request = vi.fn(async (method: string) => method === 'session.goals.list'
    ? { goals: [] }
    : { goal: { session_id: 'clarified-chat' } })

  $gateway.set({ request } as never)
  renderGoal()

  fireEvent.click(screen.getByRole('button', { name: 'Track goal' }))
  expect(screen.getByRole('dialog', { name: 'Track this conversation as a goal' })).toBeTruthy()
  expect(screen.getByText(/Tracking is passive/)).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'Goal name' }), { target: { value: 'Walk three times a week' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))

  await waitFor(() => expect(request).toHaveBeenCalledWith('session.goals.create', {
    profile: 'default', source_session_id: 'clarified-chat', title: 'Walk three times a week'
  }))
  expect(await screen.findByText('Goals page opened')).toBeTruthy()
})

it('keeps the same chat and editable name after a save refusal, then retries', async () => {
  const privateError = 'Provider failed at /Users/example/private/keychain with token sk-test-secret'
  let saveAttempts = 0

  const request = vi.fn(async (method: string) => {
    if (method === 'session.goals.list') {
      return { goals: [] }
    }

    saveAttempts += 1

    if (saveAttempts === 1) {
      throw new Error(privateError)
    }

    return { goal: { session_id: 'clarified-chat' } }
  })

  $gateway.set({ request } as never)
  renderGoal()

  fireEvent.click(screen.getByRole('button', { name: 'Track goal' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Goal name' }), { target: { value: 'Walk three times a week' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))

  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(globalThis.document.body.textContent).not.toContain(privateError)
  expect(screen.getByRole('textbox', { name: 'Goal name' }).getAttribute('value')).toBe('Walk three times a week')
  fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))

  expect(await screen.findByText('Goals page opened')).toBeTruthy()
  expect(saveAttempts).toBe(2)
})

it('opens the existing goal instead of offering a duplicate save', async () => {
  const request = vi.fn(async () => ({ goals: [{ session_id: 'clarified-chat' }] }))
  $gateway.set({ request } as never)
  renderGoal()

  fireEvent.click(await screen.findByRole('button', { name: 'View goal' }))

  expect(await screen.findByText('Goals page opened')).toBeTruthy()
  expect(request).toHaveBeenCalledWith('session.goals.list', { profile: 'default' })
  expect(request).not.toHaveBeenCalledWith('session.goals.create', expect.anything())
})
