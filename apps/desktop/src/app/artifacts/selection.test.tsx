import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { clearSessionDraft, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $notifications } from '@/store/notifications'
import { $activeGatewayProfile, $freshSessionRequest } from '@/store/profile'

import { ArtifactsView } from './index'

const listSessions = vi.hoisted(() => vi.fn())

vi.mock('@/hermes', async () => ({
  ...(await vi.importActual('@/hermes')),
  listAllProfileSessions: (...args: unknown[]) => listSessions(...args),
  getAllSessionMessages: async () => ({
    messages: [{ role: 'assistant', timestamp: 1000, content: 'Saved /tmp/alpha.md and /tmp/beta.pdf' }]
  })
}))

beforeEach(() => {
  listSessions.mockReset()
  listSessions.mockResolvedValue({ sessions: [{ id: 'selection-session', title: 'Fixture', profile: 'default' }] })
  $activeGatewayProfile.set('default')
  $notifications.set([])
  clearSessionDraft(null)
  $freshSessionRequest.set(0)
})

afterEach(() => cleanup())

function mount() {
  render(<MemoryRouter><ArtifactsView /></MemoryRouter>)
}

it('selects indexed entries on the visible page and prepares editable file reads', async () => {
  mount()
  expect(await screen.findByRole('button', { name: 'alpha.md' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Select' }))
  expect(screen.getByText('0 selected')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Select all on page' }))
  expect(screen.getByText('2 selected')).toBeTruthy()
  expect((screen.getByRole('checkbox', { name: 'Select alpha.md' }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Discuss selected' }))

  const draft = takeSessionDraft(null)
  expect(draft.text).toContain('"alpha.md" — @file:/tmp/alpha.md')
  expect(draft.text).toContain('"beta.pdf" — "/tmp/beta.pdf" (reference only)')
  expect(draft.text).toContain('when I send this message')
  expect(draft.attachments).toEqual([])
  expect($freshSessionRequest.get()).toBe(1)
})

it('does not turn another profile’s Library file into a readable reference', async () => {
  $activeGatewayProfile.set('other')
  mount()
  expect(await screen.findByRole('button', { name: 'alpha.md' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Select' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select alpha.md' }))
  fireEvent.click(screen.getByRole('button', { name: 'Discuss selected' }))

  const draft = takeSessionDraft(null)
  expect(draft.text).toContain('"alpha.md" — "/tmp/alpha.md" (reference only)')
  expect(draft.text).not.toContain('@file:/tmp/alpha.md')
})

it('keeps the empty selection honest and resets on filter, profile and index changes', async () => {
  listSessions.mockResolvedValueOnce({ sessions: [] })
  mount()
  expect(await screen.findByText('No artifacts found')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Select' }))
  expect(screen.getByRole('button', { name: 'Select all on page' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Discuss selected' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Exit selection' }))
  expect(screen.queryByText('0 selected')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Refresh artifacts' }))
  expect(await screen.findByRole('button', { name: 'alpha.md' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Select' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select alpha.md' }))
  fireEvent.click(screen.getByRole('button', { name: /^Documents/ }))
  expect(screen.queryByText('1 selected')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Select' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select alpha.md' }))
  $activeGatewayProfile.set('other')
  await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Select' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select alpha.md' }))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh artifacts' }))
  await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull())
})

it('preserves an existing draft and offers explicit recovery before adding selected references', async () => {
  stashSessionDraft(null, 'Unfinished thought', [])
  mount()
  expect(await screen.findByRole('button', { name: 'alpha.md' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Select' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select alpha.md' }))
  fireEvent.click(screen.getByRole('button', { name: 'Discuss selected' }))

  expect(takeSessionDraft(null).text).toBe('Unfinished thought')
  expect($freshSessionRequest.get()).toBe(0)
  const recovery = $notifications.get().find(item => item.id === 'consumer-draft-already-open')
  expect(recovery?.action?.label).toBe('Add to draft')
  recovery?.action?.onClick()
  expect(takeSessionDraft(null).text).toContain('Unfinished thought\n\nHelp me discuss')
  expect($freshSessionRequest.get()).toBe(1)
})
