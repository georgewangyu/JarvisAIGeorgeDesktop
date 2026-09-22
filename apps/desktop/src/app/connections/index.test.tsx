import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { listOAuthProviders } from '@/api/config'
import { getGlobalModelInfo, setGlobalModel } from '@/api/models'
import { $currentModel, $currentProvider } from '@/store/session'
import { makeOAuthProvider } from '@/test/oauth-provider'

import { ConnectionsView } from './index'

vi.mock('@/api/config', () => ({ listOAuthProviders: vi.fn() }))
vi.mock('@/api/models', () => ({ getGlobalModelInfo: vi.fn(), setGlobalModel: vi.fn() }))

beforeEach(() => {
  $currentProvider.set('openai-codex')
  $currentModel.set('test-model')
  vi.mocked(listOAuthProviders).mockResolvedValue({ providers: [makeOAuthProvider('openai-codex')] })
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { jarvisOnboarding: { startCodexOAuth: vi.fn().mockResolvedValue({ ok: true }) } }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('does not treat a selected model as proof of an authenticated account', async () => {
  render(<ConnectionsView />)
  await waitFor(() => expect(listOAuthProviders).toHaveBeenCalled())
  expect(screen.getByText('Not connected')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
})

it('refreshes account and model state immediately after successful sign-in', async () => {
  const connected = makeOAuthProvider('openai-codex')
  connected.status.logged_in = true
  vi.mocked(listOAuthProviders)
    .mockResolvedValueOnce({ providers: [makeOAuthProvider('openai-codex')] })
    .mockResolvedValue({ providers: [connected] })
  vi.mocked(getGlobalModelInfo).mockResolvedValue({
    provider: 'openai-codex',
    model: 'connected-model'
  } as Awaited<ReturnType<typeof getGlobalModelInfo>>)
  render(<ConnectionsView />)
  await waitFor(() => expect(listOAuthProviders).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByText('Connected')
  expect(screen.getByText('connected-model')).toBeTruthy()
  expect(setGlobalModel).toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
})
