import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $notifications } from '@/store/notifications'

import { ArtifactsView } from './index'

const listSessions = vi.hoisted(() => vi.fn())

vi.mock('@/hermes', async () => ({
  ...(await vi.importActual('@/hermes')),
  listAllProfileSessions: (...args: unknown[]) => listSessions(...args),
  getAllSessionMessages: async (sessionId: string) => ({
    messages: [{ role: 'assistant', timestamp: 1000, content: `Saved /tmp/${sessionId === 'older' ? 'older' : 'library-test'}.pdf` }]
  })
}))

beforeEach(() => {
  $notifications.set([])
  listSessions.mockReset()
  listSessions.mockResolvedValue({ sessions: [{ id: 'synthetic-session', title: 'Fixture', profile: 'default' }] })
})

afterEach(() => {
  cleanup()
})

it('distinguishes an indexing failure from an empty Library and recovers on retry', async () => {
  listSessions.mockRejectedValueOnce(new Error('Could not read /Users/private/notes.db?token=secret-value'))

  render(
    <MemoryRouter>
      <ArtifactsView />
    </MemoryRouter>
  )

  expect(await screen.findByRole('heading', { name: 'Artifacts failed to load' })).toBeTruthy()
  expect(screen.queryByText('No artifacts found')).toBeNull()
  expect($notifications.get()[0]?.message).toBe('Artifacts failed to load')
  expect(JSON.stringify($notifications.get())).not.toContain('secret-value')
  expect(JSON.stringify($notifications.get())).not.toContain('/Users/private')

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('button', { name: 'library-test.pdf' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Artifacts failed to load' })).toBeNull()
})

it('keeps last successful artifacts visible after a failed refresh', async () => {
  render(
    <MemoryRouter>
      <ArtifactsView />
    </MemoryRouter>
  )

  expect(await screen.findByRole('button', { name: 'library-test.pdf' })).toBeTruthy()
  listSessions.mockRejectedValueOnce(new Error('synthetic refresh failure'))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh artifacts' }))

  await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('button', { name: 'library-test.pdf' })).toBeTruthy()
  expect(screen.queryByText('No artifacts found')).toBeNull()
})

it('indexes older chats on demand without replacing recent artifacts', async () => {
  listSessions.mockResolvedValueOnce({
    sessions: [{ id: 'synthetic-session', title: 'Recent', profile: 'default' }],
    total: 31
  })
  listSessions.mockResolvedValueOnce({
    sessions: [{ id: 'older', title: 'Older', profile: 'default' }],
    total: 31
  })

  render(
    <MemoryRouter>
      <ArtifactsView />
    </MemoryRouter>
  )

  expect(await screen.findByRole('button', { name: 'library-test.pdf' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'older.pdf' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Load older chats' }))
  expect(await screen.findByRole('button', { name: 'older.pdf' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'library-test.pdf' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Load older chats' })).toBeNull()
  expect(listSessions.mock.calls[1][6]).toBe(30)
})

it('keeps the older-page action available for retry after a read failure', async () => {
  listSessions.mockResolvedValueOnce({
    sessions: [{ id: 'synthetic-session', title: 'Recent', profile: 'default' }],
    total: 31
  })
  listSessions.mockRejectedValueOnce(new Error('Could not read /Users/private/archive?token=secret-value'))
  listSessions.mockResolvedValueOnce({ sessions: [{ id: 'older', title: 'Older', profile: 'default' }], total: 31 })

  render(
    <MemoryRouter>
      <ArtifactsView />
    </MemoryRouter>
  )

  expect(await screen.findByRole('button', { name: 'library-test.pdf' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Load older chats' }))
  expect(await screen.findByText('Older chats could not be loaded.')).toBeTruthy()
  expect($notifications.get()[0]?.message).toBe('Older chats could not be loaded.')
  expect(JSON.stringify($notifications.get())).not.toContain('secret-value')
  expect(JSON.stringify($notifications.get())).not.toContain('/Users/private')
  expect(screen.getByRole('button', { name: 'library-test.pdf' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Load older chats' }))
  expect(await screen.findByRole('button', { name: 'older.pdf' })).toBeTruthy()
})
