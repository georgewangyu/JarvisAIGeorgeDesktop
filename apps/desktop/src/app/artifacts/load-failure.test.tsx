import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ArtifactsView } from './index'

const listSessions = vi.hoisted(() => vi.fn())

vi.mock('@/hermes', async () => ({
  ...(await vi.importActual('@/hermes')),
  listAllProfileSessions: (...args: unknown[]) => listSessions(...args),
  getAllSessionMessages: async () => ({
    messages: [{ role: 'assistant', timestamp: 1000, content: 'Saved /tmp/library-test.pdf' }]
  })
}))

beforeEach(() => {
  listSessions.mockReset()
  listSessions.mockResolvedValue({ sessions: [{ id: 'synthetic-session', title: 'Fixture', profile: 'default' }] })
})

afterEach(() => {
  cleanup()
})

it('distinguishes an indexing failure from an empty Library and recovers on retry', async () => {
  listSessions.mockRejectedValueOnce(new Error('synthetic index failure'))

  render(
    <MemoryRouter>
      <ArtifactsView />
    </MemoryRouter>
  )

  expect(await screen.findByRole('heading', { name: 'Artifacts failed to load' })).toBeTruthy()
  expect(screen.queryByText('No artifacts found')).toBeNull()

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
