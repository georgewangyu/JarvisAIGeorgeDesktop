import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { listOAuthProviders } from '@/api/config'
import { getGlobalModelInfo, setGlobalModel } from '@/api/models'
import { $activeGatewayProfile } from '@/store/profile'
import { $currentModel, $currentProvider } from '@/store/session'
import { makeOAuthProvider } from '@/test/oauth-provider'

import { ConnectionsView } from './index'

vi.mock('@/api/config', () => ({ listOAuthProviders: vi.fn() }))
vi.mock('@/api/models', () => ({ getGlobalModelInfo: vi.fn(), setGlobalModel: vi.fn() }))

beforeEach(() => {
  $activeGatewayProfile.set('default')
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
  $activeGatewayProfile.set('default')
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

it('does not expose a synchronous connection-check exception to the consumer', async () => {
  vi.mocked(listOAuthProviders).mockImplementation(() => {
    throw new Error('private credential at synthetic-path')
  })

  render(<MemoryRouter><ConnectionsView /></MemoryRouter>)
  expect(await screen.findByText('Could not check this Mac. Try again.')).toBeTruthy()
  expect(screen.queryByText(/private credential/)).toBeNull()
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
  expect(screen.getByText('Calendar')).toBeTruthy()
  expect(screen.getByText('Apple Calendar preview. macOS access and a separate Jarvis connection are both required.')).toBeTruthy()
  expect(screen.queryByText('Connect')).toBeNull()

  fireEvent.change(search, { target: { value: '' } })
  expect(screen.getByText('ChatGPT / Codex')).toBeTruthy()
  expect(screen.getByText('Files on this Mac')).toBeTruthy()
})

it('does not read or request Calendar access during status check, and disconnect hides event actions', async () => {
  const status = vi.fn().mockResolvedValue({ supported: true, authorization: 'fullAccess', connected: false })
  const connect = vi.fn().mockResolvedValue({ supported: true, authorization: 'fullAccess', connected: true })
  const disconnect = vi.fn().mockResolvedValue({ supported: true, authorization: 'fullAccess', connected: false })
  const list = vi.fn().mockResolvedValue({ ok: true, command: 'list-events', events: [] })
  const create = vi.fn()
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { jarvisCalendar: { status, connect, disconnect, list, create } }
  })

  render(<MemoryRouter><ConnectionsView /></MemoryRouter>)
  const section = screen.getByRole('heading', { name: 'Apps' }).closest('section')!
  await waitFor(() => expect(within(section).getByText('Not connected')).toBeTruthy())
  expect(status).toHaveBeenCalled()
  expect(connect).not.toHaveBeenCalled()
  expect(list).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()

  fireEvent.click(within(section).getByRole('button', { name: 'Connect' }))
  await waitFor(() => expect(within(section).getByText('Connected')).toBeTruthy())
  fireEvent.click(within(section).getByRole('button', { name: 'View upcoming' }))
  await waitFor(() => expect(list).toHaveBeenCalledOnce())
  expect(within(section).getByText('No events in the next 7 days.')).toBeTruthy()
  expect(create).not.toHaveBeenCalled()

  fireEvent.click(within(section).getByRole('button', { name: 'Disconnect' }))
  await waitFor(() => expect(within(section).getByText('Not connected')).toBeTruthy())
  expect(within(section).queryByRole('button', { name: 'View upcoming' })).toBeNull()
  expect(within(section).queryByRole('button', { name: 'Create event' })).toBeNull()
})

it('requires an explicit valid create action and reports a denied Calendar connection', async () => {
  const status = vi.fn().mockResolvedValue({ supported: true, authorization: 'notDetermined', connected: false })

  const connect = vi.fn().mockResolvedValueOnce({ supported: true, authorization: 'denied', connected: false })
    .mockResolvedValueOnce({ supported: true, authorization: 'fullAccess', connected: true })

  const create = vi.fn().mockResolvedValue({ ok: true, command: 'create-event', event: {
    id: 'synthetic', title: 'Synthetic test', start: '2026-09-23T10:00:00.000Z', end: '2026-09-23T11:00:00.000Z', isAllDay: false, calendarId: 'synthetic'
  } })

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { jarvisCalendar: { status, connect, disconnect: vi.fn(), list: vi.fn(), create } }
  })

  render(<MemoryRouter><ConnectionsView /></MemoryRouter>)
  const section = screen.getByRole('heading', { name: 'Apps' }).closest('section')!
  await waitFor(() => expect(within(section).getByText('Not connected')).toBeTruthy())
  fireEvent.click(within(section).getByRole('button', { name: 'Connect' }))
  await waitFor(() => expect(within(section).getByText('Needs macOS access')).toBeTruthy())
  expect(within(section).getByText('Calendar access was not granted. You can try again from macOS Settings.')).toBeTruthy()
  expect(create).not.toHaveBeenCalled()

  fireEvent.click(within(section).getByRole('button', { name: 'Connect' }))
  await waitFor(() => expect(within(section).getByRole('button', { name: 'Create event' })).toBeTruthy())
  fireEvent.click(within(section).getByRole('button', { name: 'Create event' }))
  expect(within(section).getByText('Add a title and a valid start and end time.')).toBeTruthy()
  expect(create).not.toHaveBeenCalled()
  fireEvent.change(within(section).getByRole('textbox', { name: 'Event title' }), { target: { value: 'Synthetic test' } })
  fireEvent.change(within(section).getByLabelText('Event start'), { target: { value: '2026-09-23T10:00' } })
  fireEvent.change(within(section).getByLabelText('Event end'), { target: { value: '2026-09-23T11:00' } })
  fireEvent.click(within(section).getByRole('button', { name: 'Create event' }))
  await waitFor(() => expect(create).toHaveBeenCalledOnce())
})

it('does not resurrect previously read events after Calendar access is revoked and reconnected', async () => {
  let granted = true
  const calendarStatus = () => ({ supported: true, authorization: granted ? 'fullAccess' : 'denied', connected: granted })
  const status = vi.fn(async () => calendarStatus())
  const connect = vi.fn(async () => calendarStatus())

  const list = vi.fn().mockResolvedValue({
    ok: true,
    command: 'list-events',
    events: [{
      id: 'old-event', title: 'Previously read event', start: '2026-09-23T10:00:00.000Z',
      end: '2026-09-23T11:00:00.000Z', isAllDay: false, calendarId: 'synthetic'
    }]
  })

  const create = vi.fn(async () => {
    granted = false

    return { ok: false, code: 'full_access_required' }
  })

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { jarvisCalendar: { status, connect, disconnect: vi.fn(), list, create } }
  })

  render(<MemoryRouter><ConnectionsView /></MemoryRouter>)
  const section = screen.getByRole('heading', { name: 'Apps' }).closest('section')!

  await waitFor(() => expect(within(section).getByRole('button', { name: 'View upcoming' })).toBeTruthy())
  fireEvent.click(within(section).getByRole('button', { name: 'View upcoming' }))
  await waitFor(() => expect(within(section).getByText('Previously read event')).toBeTruthy())

  fireEvent.change(within(section).getByRole('textbox', { name: 'Event title' }), { target: { value: 'New event' } })
  fireEvent.change(within(section).getByLabelText('Event start'), { target: { value: '2026-09-23T10:00' } })
  fireEvent.change(within(section).getByLabelText('Event end'), { target: { value: '2026-09-23T11:00' } })
  fireEvent.click(within(section).getByRole('button', { name: 'Create event' }))
  await waitFor(() => expect(within(section).getByText('Needs macOS access')).toBeTruthy())

  granted = true
  fireEvent.click(within(section).getByRole('button', { name: 'Connect' }))
  await waitFor(() => expect(within(section).getByRole('button', { name: 'View upcoming' })).toBeTruthy())
  expect(within(section).queryByText('Previously read event')).toBeNull()
})

it('drops a delayed Calendar read and draft when the active profile changes', async () => {
  $activeGatewayProfile.set('alpha')
  let finishList!: (value: unknown) => void
  const list = vi.fn(() => new Promise(resolve => {finishList = resolve}))
  const status = vi.fn().mockResolvedValue({ supported: true, authorization: 'fullAccess', connected: true })

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { jarvisCalendar: { status, connect: vi.fn(), disconnect: vi.fn(), list, create: vi.fn() } }
  })

  render(<MemoryRouter><ConnectionsView /></MemoryRouter>)
  const section = screen.getByRole('heading', { name: 'Apps' }).closest('section')!

  await waitFor(() => expect(within(section).getByRole('button', { name: 'View upcoming' })).toBeTruthy())
  fireEvent.change(within(section).getByRole('textbox', { name: 'Event title' }), { target: { value: 'Alpha draft' } })
  fireEvent.click(within(section).getByRole('button', { name: 'View upcoming' }))
  await waitFor(() => expect(list).toHaveBeenCalledOnce())

  act(() => $activeGatewayProfile.set('beta'))
  await waitFor(() => expect(within(section).getByRole('textbox', { name: 'Event title' })).toHaveProperty('value', ''))
  await act(async () => finishList({
    ok: true,
    command: 'list-events',
    events: [{ id: 'alpha', title: 'Alpha private event', start: '2026-09-23T10:00:00.000Z', end: '2026-09-23T11:00:00.000Z', isAllDay: false, calendarId: 'alpha' }]
  }))
  expect(within(section).queryByText('Alpha private event')).toBeNull()
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
