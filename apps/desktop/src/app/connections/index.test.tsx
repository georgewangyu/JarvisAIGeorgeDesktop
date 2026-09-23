import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
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
  render(
    <MemoryRouter>
      <ConnectionsView />
    </MemoryRouter>
  )
  await screen.findByText('Not connected')
  expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
})

it('keeps Mac permission results when the AI account check fails', async () => {
  const openFullDiskAccess = vi.fn().mockResolvedValue(undefined)
  vi.mocked(listOAuthProviders).mockRejectedValue(new Error('Account request failed'))
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      jarvisOnboarding: {
        openFullDiskAccess,
        getPermissions: vi.fn().mockResolvedValue({
          apps: { mail: true, messages: false, notes: false, whatsapp: false },
          fullDiskAccess: 'granted',
          microphone: 'not-determined',
          platform: 'darwin'
        })
      }
    }
  })

  render(
    <MemoryRouter>
      <ConnectionsView />
    </MemoryRouter>
  )

  await waitFor(() =>
    expect(
      within(screen.getByRole('heading', { name: 'AI account' }).closest('section')!).getByText('Unavailable')
    ).toBeTruthy()
  )
  expect(screen.getByText('Allowed')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
  expect(openFullDiskAccess).toHaveBeenCalledOnce()
  expect(screen.getByText('Could not check your AI account.')).toBeTruthy()
  expect(screen.queryByText('Not connected')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
})

it('recovers the account state after a failed check and refresh', async () => {
  const connected = makeOAuthProvider('openai-codex')
  connected.status.logged_in = true
  vi.mocked(listOAuthProviders)
    .mockRejectedValueOnce(new Error('Temporary account failure'))
    .mockResolvedValue({ providers: [connected] })

  render(
    <MemoryRouter>
      <ConnectionsView />
    </MemoryRouter>
  )

  await waitFor(() =>
    expect(
      within(screen.getByRole('heading', { name: 'AI account' }).closest('section')!).getByText('Unavailable')
    ).toBeTruthy()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText('Connected')
  expect(screen.queryByText('Could not check your AI account.')).toBeNull()
})

it('keeps a verified AI account when the Mac permission check fails', async () => {
  const connected = makeOAuthProvider('openai-codex')
  connected.status.logged_in = true
  vi.mocked(listOAuthProviders).mockResolvedValue({ providers: [connected] })
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { jarvisOnboarding: { getPermissions: vi.fn().mockRejectedValue(new Error('Mac request failed')) } }
  })

  render(
    <MemoryRouter>
      <ConnectionsView />
    </MemoryRouter>
  )

  await screen.findByText('Connected')
  expect(screen.getByText('Could not check Mac permissions.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
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
  render(
    <MemoryRouter>
      <ConnectionsView />
    </MemoryRouter>
  )
  await waitFor(() => expect(listOAuthProviders).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByText('Connected')
  expect(screen.getByText('connected-model')).toBeTruthy()
  expect(setGlobalModel).toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
})

it('shows detected local apps without claiming their access is connected', async () => {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      jarvisOnboarding: {
        getPermissions: vi.fn().mockResolvedValue({
          apps: { mail: true, messages: true, notes: true, whatsapp: false },
          fullDiskAccess: 'not-determined',
          microphone: 'not-determined',
          platform: 'darwin'
        })
      }
    }
  })

  render(
    <MemoryRouter>
      <ConnectionsView />
    </MemoryRouter>
  )

  await screen.findByText('App detection only. Mail access is not connected yet.')
  expect(screen.getByText('Files on this Mac')).toBeTruthy()
  expect(screen.getByText('Read files on this Mac when you ask. App access is separate.')).toBeTruthy()
  expect(screen.queryByText('Files and local apps')).toBeNull()
  expect(screen.getByText('App detection only. Message access is not connected yet.')).toBeTruthy()
  expect(screen.getByText('App detection only. Notes access is not connected yet.')).toBeTruthy()
  expect(screen.getByText('WhatsApp')).toBeTruthy()
  expect(screen.getByText('App detection only. WhatsApp access is not connected yet.')).toBeTruthy()
  expect(screen.getByText('Not installed')).toBeTruthy()
  expect(screen.getAllByText('Detected')).toHaveLength(3)

  for (const detected of screen.getAllByText('Detected')) {
    expect(detected.className).not.toContain('text-emerald')
  }

  expect(screen.getByText('Browser research is set up when a task needs it.')).toBeTruthy()
  expect(screen.getByText('On demand')).toBeTruthy()
})

it('filters only real connection and permission rows without inventing available connectors', async () => {
  render(
    <MemoryRouter>
      <ConnectionsView />
    </MemoryRouter>
  )

  const search = screen.getByRole('textbox', { name: 'Search connections' })
  await screen.findByText('ChatGPT / Codex')
  fireEvent.change(search, { target: { value: 'notes' } })
  expect(screen.getByText('Notes')).toBeTruthy()
  expect(screen.getByText('App detection only. Notes access is not connected yet.')).toBeTruthy()
  expect(screen.queryByText('ChatGPT / Codex')).toBeNull()
  expect(screen.queryByText('Files on this Mac')).toBeNull()
  expect(screen.queryByText('Mail')).toBeNull()

  fireEvent.change(search, { target: { value: 'calendar' } })
  expect(screen.getByText('No matching connections.')).toBeTruthy()
  expect(screen.queryByText('Connect')).toBeNull()

  fireEvent.change(search, { target: { value: '' } })
  expect(screen.getByText('ChatGPT / Codex')).toBeTruthy()
  expect(screen.getByText('Files on this Mac')).toBeTruthy()
})

it('does not claim an app is absent or offer a no-op permission action without a native permission bridge', async () => {
  render(
    <MemoryRouter>
      <ConnectionsView />
    </MemoryRouter>
  )

  await screen.findByText('Could not check Mac permissions.')
  expect(screen.queryByText('Not installed')).toBeNull()
  expect(screen.queryByRole('button', { name: /^(Allow|Manage)/ })).toBeNull()
  expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(1)
})

it('reports a failed microphone request and leaves the action available for retry', async () => {
  const requestMicrophone = vi.fn().mockRejectedValue(new Error('Native request failed'))
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      jarvisOnboarding: {
        getPermissions: vi.fn().mockResolvedValue({
          apps: { mail: false, messages: false, notes: false, whatsapp: false },
          fullDiskAccess: 'unknown',
          microphone: 'not-determined',
          platform: 'darwin'
        }),
        requestMicrophone
      }
    }
  })

  render(
    <MemoryRouter>
      <ConnectionsView />
    </MemoryRouter>
  )

  await screen.findByText('Not set up')
  fireEvent.click(screen.getByRole('button', { name: /^Allow/ }))
  await screen.findByText('Could not request microphone access. Try again from System Settings.')
  expect(requestMicrophone).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: /^Allow/ }).hasAttribute('disabled')).toBe(false)
})
