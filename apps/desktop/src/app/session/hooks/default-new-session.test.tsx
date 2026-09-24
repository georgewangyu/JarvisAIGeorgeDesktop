import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopProfileRoute } from '@/global'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $defaultProfileRoute, setDefaultProfile } from '@/store/default-profile'
import { requestGatewayForAgent, requestGatewayForProfile } from '@/store/gateway'
import {
  $activeGatewayProfile,
  $newChatConnectionId,
  $newChatProfile,
  $newChatRoute,
  captureNewChatSource,
  ensureGatewayAgent,
  ensureGatewayProfile,
  resolveNewChatOwnerRoute
} from '@/store/profile'
import { $projectScope, ALL_PROJECTS } from '@/store/projects'
import {
  $activeSessionId,
  $sessions,
  _resetSessionOwnerHintsForTests,
  applyConfiguredDefaultProjectDir,
  getSessionOwnerHint,
  setActiveSessionId,
  setConnection,
  setSessions
} from '@/store/session'

import { useSlashCommand } from './use-prompt-actions/slash'
import { useSessionActions } from './use-session-actions'

vi.mock('@/store/profile', async original => ({
  ...(await original<Record<string, unknown>>()),
  ensureGatewayAgent: vi.fn(async () => undefined),
  ensureGatewayProfile: vi.fn(async () => undefined)
}))
vi.mock('@/store/gateway', async original => ({
  ...(await original<Record<string, unknown>>()),
  activeGatewayConnectionId: vi.fn(() => 'previous'),
  requestGatewayForAgent: vi.fn(),
  requestGatewayForProfile: vi.fn(),
  retainGatewayForAgent: vi.fn(async () => () => undefined)
}))

// Routed session.create dials are user gestures (send / "New session"), so the
// hook tags them foreground (#105104); the two undefineds are timeout/signal.
const FOREGROUND_CREATE_DIAL = [undefined, undefined, { spawnPriority: 'foreground' }] as const

function mountActions(getRouteToken = () => 'route') {
  const ref = <T,>(current: T) => ({ current })
  const requestGateway = vi.fn(async () => ({ session_id: 'ambient', stored_session_id: 'ambient-stored' }) as never)
  const navigate = vi.fn()
  const state = createClientSessionState()

  const result = renderHook(() =>
    useSessionActions({
      activeSessionId: 'existing-runtime',
      activeSessionIdRef: ref<string | null>('existing-runtime'),
      busyRef: ref(false),
      creatingSessionRef: ref(false),
      ensureSessionState: () => state,
      getRouteToken,
      getRoutedStoredSessionId: () => null,
      navigate,
      requestGateway,
      resetViewSync: vi.fn(),
      runtimeIdByStoredSessionIdRef: ref(new Map()),
      selectedStoredSessionId: null,
      selectedStoredSessionIdRef: ref<string | null>(null),
      sessionStateByRuntimeIdRef: ref(new Map()),
      syncSessionStateToView: vi.fn(),
      updateSessionState: () => state
    })
  )

  return { ...result, navigate, requestGateway }
}

function mountSlashCommand(startFreshSessionDraft: () => void) {
  return renderHook(() =>
    useSlashCommand({
      activeSessionIdRef: { current: 'existing-runtime' },
      busyRef: { current: false },
      selectedStoredSessionIdRef: { current: null },
      startFreshSessionDraft,
      requestGateway: vi.fn(async () => ({})),
      copy: {},
      getRoutedStoredSessionId: () => null,
      getRuntimeIdForStoredSession: () => null
    } as never)
  )
}

beforeEach(() => {
  _resetSessionOwnerHintsForTests()
  $defaultProfileRoute.set(null)
  $newChatRoute.set({ connectionId: 'previous', profile: 'other' })
  $newChatProfile.set('other')
  $newChatConnectionId.set('previous')
  $activeGatewayProfile.set('other')
  $projectScope.set(ALL_PROJECTS)
  setSessions([])
  setActiveSessionId('existing-runtime')
  setConnection({
    baseUrl: 'http://localhost:7070',
    connectionId: 'previous',
    isFullscreen: false,
    logs: [],
    mode: 'remote',
    nativeOverlayWidth: 0,
    token: '',
    windowButtonPosition: null,
    wsUrl: 'ws://localhost:7070'
  })
  window.hermesDesktop = { profile: { setDefault: async (route: DesktopProfileRoute) => route } } as never
  vi.mocked(requestGatewayForAgent).mockReset()
  vi.mocked(requestGatewayForProfile).mockReset()
  vi.mocked(requestGatewayForProfile).mockResolvedValue({ sessions: [] })
  vi.mocked(requestGatewayForAgent).mockResolvedValue({
    session_id: 'created',
    stored_session_id: 'created-stored',
    info: {}
  })
})

afterEach(() => {
  cleanup()
  applyConfiguredDefaultProjectDir('')
  window.history.replaceState(null, '', '/')
  $defaultProfileRoute.set(null)
  $newChatRoute.set(null)
  $newChatProfile.set(null)
  $newChatConnectionId.set(null)
  captureNewChatSource(null)
  setActiveSessionId(null)
  setConnection(null)
  setSessions([])
  vi.clearAllMocks()
})

describe('generic new session default routing', () => {
  it('creates the first fixed Jarvis row as the permanent main chat', async () => {
    const { result } = mountActions()

    act(() => result.current.selectSidebarItem({ action: 'new-session' } as never))
    await act(() => result.current.createBackendSessionForSend('hello'))

    expect(requestGatewayForAgent).toHaveBeenCalledWith(
      'previous',
      'other',
      'session.create',
      expect.objectContaining({ title: 'Jarvis' }),
      ...FOREGROUND_CREATE_DIAL
    )
  })

  it('resolves the permanent Jarvis chat when startup cache is empty', async () => {
    vi.mocked(requestGatewayForAgent).mockResolvedValueOnce({
      sessions: [{ id: 'jarvis-main', title: 'Jarvis' }]
    })
    const { navigate, result } = mountActions()

    await act(async () => result.current.selectSidebarItem({ action: 'new-session' } as never))

    expect(navigate).toHaveBeenCalledWith('/jarvis-main')
    expect(requestGatewayForAgent).toHaveBeenCalledWith(
      'previous',
      'other',
      'session.list',
      { title: 'Jarvis', include_hidden: true, profile: 'other' },
      undefined,
      undefined,
      { spawnPriority: 'foreground' }
    )
  })

  it('does not open a cached Jarvis row from another profile', async () => {
    setSessions([{ id: 'other-jarvis', title: 'Jarvis', profile: 'stranger' } as never])
    vi.mocked(requestGatewayForAgent).mockResolvedValueOnce({
      sessions: [{ id: 'our-jarvis', title: 'Jarvis' }]
    })
    const { navigate, result } = mountActions()

    await act(async () => result.current.selectSidebarItem({ action: 'new-session' } as never))

    expect(navigate).toHaveBeenCalledWith('/our-jarvis')
    expect(navigate).not.toHaveBeenCalledWith('/other-jarvis')
  })

  it('does not let another profile\'s Jarvis row suppress this owner\'s permanent title', async () => {
    setSessions([{ id: 'other-jarvis', title: 'Jarvis', profile: 'stranger', connection_id: 'elsewhere' } as never])
    vi.mocked(requestGatewayForAgent).mockResolvedValueOnce({ sessions: [] })
    const { result } = mountActions()

    await act(async () => result.current.selectSidebarItem({ action: 'new-session' } as never))
    await act(() => result.current.createBackendSessionForSend('hello'))

    expect(requestGatewayForAgent).toHaveBeenCalledWith(
      'previous',
      'other',
      'session.create',
      expect.objectContaining({ title: 'Jarvis' }),
      ...FOREGROUND_CREATE_DIAL
    )
  })

  it('refuses to mint a second main chat when the exact owner cache contradicts an empty lookup', async () => {
    setSessions([{ id: 'known-jarvis', title: 'Jarvis', profile: 'other', connection_id: 'previous' } as never])
    vi.mocked(requestGatewayForAgent).mockResolvedValueOnce({ sessions: [] })
    const { navigate, result } = mountActions()

    await act(async () => result.current.selectSidebarItem({ action: 'new-session' } as never))

    expect(navigate).not.toHaveBeenCalled()
    expect($activeSessionId.get()).toBe('existing-runtime')
  })

  it('opens the live compression tip of the permanent Jarvis chat', async () => {
    vi.mocked(requestGatewayForAgent).mockResolvedValueOnce({
      sessions: [{ id: 'jarvis-root', resolved_id: 'jarvis-tip', title: 'Jarvis' }]
    })
    const { navigate, result } = mountActions()

    await act(async () => result.current.selectSidebarItem({ action: 'new-session' } as never))

    expect(navigate).toHaveBeenCalledWith('/jarvis-tip')
    expect(navigate).not.toHaveBeenCalledWith('/jarvis-root')
  })

  it('keeps the current chat on a registry failure, then opens Jarvis on retry', async () => {
    vi.mocked(requestGatewayForAgent).mockRejectedValueOnce(new Error('unavailable'))
    vi.mocked(requestGatewayForAgent).mockResolvedValueOnce({
      sessions: [{ id: 'jarvis-after-retry', title: 'Jarvis' }]
    })
    const { navigate, result } = mountActions()

    await act(async () => result.current.selectSidebarItem({ action: 'new-session' } as never))

    expect(navigate).not.toHaveBeenCalled()
    expect($activeSessionId.get()).toBe('existing-runtime')

    await act(async () => result.current.selectSidebarItem({ action: 'new-session' } as never))

    expect(navigate).toHaveBeenCalledWith('/jarvis-after-retry')
  })

  it('resolves a legacy-profile Jarvis chat through that profile, not the previous source', async () => {
    const { navigate, result } = mountActions()
    await act(() => setDefaultProfile({ connectionId: null, profile: 'personal' }))
    vi.mocked(requestGatewayForProfile).mockResolvedValueOnce({
      sessions: [{ id: 'personal-jarvis', title: 'Jarvis' }]
    })

    await act(async () => result.current.selectSidebarItem({ action: 'new-session' } as never))

    expect(requestGatewayForProfile).toHaveBeenCalledWith(
      'personal',
      'session.list',
      { title: 'Jarvis', include_hidden: true, profile: 'personal' },
      undefined,
      undefined,
      { spawnPriority: 'foreground' }
    )
    expect(navigate).toHaveBeenCalledWith('/personal-jarvis')
    expect(requestGatewayForAgent).not.toHaveBeenCalled()
  })

  it('does not steal the foreground after the user leaves during Jarvis lookup', async () => {
    let finishLookup!: (value: { sessions: Array<{ id: string; title: string }> }) => void
    vi.mocked(requestGatewayForAgent).mockImplementationOnce(
      () => new Promise(resolve => { finishLookup = resolve })
    )
    let routeToken = 'chat-before-click'
    const { navigate, result } = mountActions(() => routeToken)

    act(() => result.current.selectSidebarItem({ action: 'new-session' } as never))
    routeToken = 'another-page'
    await act(async () => finishLookup({ sessions: [{ id: 'jarvis-main', title: 'Jarvis' }] }))

    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not open the old profile\'s Jarvis chat after a profile switch on the same page', async () => {
    let finishLookup!: (value: { sessions: Array<{ id: string; title: string }> }) => void
    vi.mocked(requestGatewayForAgent).mockImplementationOnce(
      () => new Promise(resolve => { finishLookup = resolve })
    )
    const { navigate, result } = mountActions()

    act(() => result.current.selectSidebarItem({ action: 'new-session' } as never))
    $newChatProfile.set('next-profile')
    $newChatRoute.set({ connectionId: 'previous', profile: 'next-profile' })
    await act(async () => finishLookup({ sessions: [{ id: 'old-profile-jarvis', title: 'Jarvis' }] }))

    expect(navigate).not.toHaveBeenCalled()
  })

  it('keeps an explicitly requested fresh chat separate from Jarvis', async () => {
    const { result } = mountActions()

    act(() => result.current.startFreshSessionDraft())
    await act(() => result.current.createBackendSessionForSend('side task'))

    const create = vi.mocked(requestGatewayForAgent).mock.calls.find(call => call[2] === 'session.create')
    expect(create?.[3]).not.toHaveProperty('title')
  })

  it.each(
    [
      { name: 'primary window control', query: '/' },
      { name: 'peer inherited legacy route', query: '/?peer=1&profile=boot-profile&connectionId=' },
      { name: 'peer inherited local', query: '/?peer=1&profile=other&connectionId=local' },
      { name: 'peer inherited another remote', query: '/?peer=1&profile=other&connectionId=original-remote' }
    ].flatMap(source => ['draft', 'slash', 'tile'].map(action => ({ ...source, action })))
  )('preserves a later device selection for $action: $name', async ({ query, action }) => {
    // beforeEach establishes the state after selecting `previous`/`other`.
    // There is no saved app default; launch hints must not repin the draft.
    window.history.replaceState(null, '', query)
    const selected = { connectionId: 'previous', profile: 'other' }
    const { result } = mountActions()
    expect(resolveNewChatOwnerRoute()).toEqual(selected)

    if (action === 'tile') {
      await act(() => result.current.openNewSessionTile('right'))
    } else {
      if (action === 'slash') {
        const slash = mountSlashCommand(result.current.startFreshSessionDraft)

        await act(() => slash.result.current('/new'))
      } else {
        act(() => result.current.selectSidebarItem({ action: 'new-session' } as never))
      }

      await act(() => result.current.createBackendSessionForSend())
    }

    expect(requestGatewayForAgent).toHaveBeenCalledWith(
      selected.connectionId,
      selected.profile,
      'session.create',
      expect.objectContaining({ profile: selected.profile }),
      ...FOREGROUND_CREATE_DIAL
    )
    expect(getSessionOwnerHint('created-stored')).toEqual(selected)
  })

  it.each(['draft', 'tile'])('keeps a legacy default on the profile-only creation path for a %s', async action => {
    const { result, requestGateway } = mountActions()
    await act(() => setDefaultProfile({ connectionId: null, profile: 'personal' }))

    if (action === 'draft') {
      act(() => result.current.selectSidebarItem({ action: 'new-session' } as never))
      expect(resolveNewChatOwnerRoute()).toBeNull()
      await act(() => result.current.createBackendSessionForSend())
    } else {
      await act(() => result.current.openNewSessionTile('right'))
    }

    expect(ensureGatewayProfile).toHaveBeenCalledWith('personal', { forceLegacyRoute: true })
    expect(ensureGatewayAgent).not.toHaveBeenCalledWith('local', 'personal')
    expect(ensureGatewayAgent).not.toHaveBeenCalledWith('previous', 'personal')
    expect(requestGatewayForAgent).not.toHaveBeenCalled()
    expect(requestGateway).toHaveBeenCalledWith('session.create', expect.objectContaining({ profile: 'personal' }))
  })

  it('keeps a legacy profile peer separate from the app default and the active source', async () => {
    window.history.replaceState(null, '', '/?peer=1&profile=peer-agent&profileWindow=1')
    const { result, requestGateway } = mountActions()
    await act(() => setDefaultProfile({ connectionId: 'lab', profile: 'research' }))
    act(() => result.current.selectSidebarItem({ action: 'new-session' } as never))
    expect(resolveNewChatOwnerRoute()).toBeNull()
    await act(() => result.current.createBackendSessionForSend())
    expect(ensureGatewayProfile).toHaveBeenCalledWith('peer-agent', { forceLegacyRoute: true })
    expect(requestGatewayForAgent).not.toHaveBeenCalled()
    expect(requestGateway).toHaveBeenCalledWith('session.create', expect.objectContaining({ profile: 'peer-agent' }))
  })

  it('keeps an explicit legacy-profile tile request ahead of both defaults', async () => {
    const { result, requestGateway } = mountActions()
    await act(() => setDefaultProfile({ connectionId: 'lab', profile: 'research' }))
    await act(() => result.current.openNewSessionTile('right', { profile: 'chosen', route: null }))
    expect(requestGateway).toHaveBeenCalledWith('session.create', expect.objectContaining({ profile: 'chosen' }))
    expect(requestGatewayForAgent).not.toHaveBeenCalled()
  })

  it('does not mistake the configured default folder for explicit project routing', async () => {
    applyConfiguredDefaultProjectDir('/configured-default')
    const { result } = mountActions()
    await act(() => setDefaultProfile({ connectionId: 'lab', profile: 'research' }))
    act(() => result.current.selectSidebarItem({ action: 'new-session' } as never))
    expect($newChatRoute.get()).toEqual({ connectionId: 'lab', profile: 'research' })
    applyConfiguredDefaultProjectDir('')
  })

  it.each(['/', '/?peer=1&profile=opener&connectionId=opener-host'])(
    'routes /new to the saved default in %s',
    async query => {
      window.history.replaceState(null, '', query)
      const { result } = mountActions()
      const slash = mountSlashCommand(result.current.startFreshSessionDraft)

      await act(() => setDefaultProfile({ connectionId: 'lab', profile: 'research' }))
      await act(() => slash.result.current('/new'))
      expect($newChatRoute.get()).toEqual({ connectionId: 'lab', profile: 'research' })
    }
  )

  it('prefers a profile peer window over the app default after switching away', async () => {
    window.history.replaceState(null, '', '/?peer=1&profile=peer-agent&connectionId=peer-host&profileWindow=1')
    const { result } = mountActions()
    await act(() => setDefaultProfile({ connectionId: 'lab', profile: 'research' }))
    act(() => result.current.selectSidebarItem({ action: 'new-session' } as never))
    await act(() => result.current.createBackendSessionForSend())
    expect(requestGatewayForAgent).toHaveBeenCalledWith(
      'peer-host',
      'peer-agent',
      'session.create',
      expect.objectContaining({ profile: 'peer-agent' }),
      ...FOREGROUND_CREATE_DIAL
    )
  })

  it.each([
    { options: undefined, connectionId: 'lab', profile: 'research' },
    { options: { profile: 'chosen' }, connectionId: 'previous', profile: 'chosen' },
    {
      options: { route: { connectionId: 'chosen-host', profile: 'chosen' } },
      connectionId: 'chosen-host',
      profile: 'chosen'
    },
    { options: { cwd: '/clicked-project' }, connectionId: 'previous', profile: 'other' }
  ])(
    'routes tiles by explicit intent before the saved default: $profile',
    async ({ options, connectionId, profile }) => {
      const { result } = mountActions()
      await act(() => setDefaultProfile({ connectionId: 'lab', profile: 'research' }))
      await act(() => result.current.openNewSessionTile('right', options))
      expect(requestGatewayForAgent).toHaveBeenCalledWith(
        connectionId,
        profile,
        'session.create',
        expect.objectContaining({ profile }),
        ...FOREGROUND_CREATE_DIAL
      )
      expect(getSessionOwnerHint('created-stored')).toEqual({ connectionId, profile })
    }
  )

  it.each([
    { connectionId: 'lab', profile: 'research' },
    { connectionId: 'local', profile: 'personal' }
  ])('uses the saved exact owner only for a new draft: $connectionId/$profile', async saved => {
    const { result, requestGateway } = mountActions()
    await act(() => setDefaultProfile(saved))
    expect($activeSessionId.get()).toBe('existing-runtime')
    expect($newChatProfile.get()).toBe('other')

    act(() => result.current.selectSidebarItem({ action: 'new-session' } as never))
    await act(() => result.current.createBackendSessionForSend('hello'))

    const expected = saved
    expect(requestGatewayForAgent).toHaveBeenCalledWith(
      expected.connectionId,
      expected.profile,
      'session.create',
      expect.objectContaining({ profile: expected.profile }),
      ...FOREGROUND_CREATE_DIAL
    )
    expect(getSessionOwnerHint('created-stored')).toEqual(expected)
    expect($sessions.get().find(row => row.id === 'created-stored')).toMatchObject({
      connection_id: expected.connectionId,
      profile: expected.profile
    })
    expect(requestGateway).not.toHaveBeenCalled()
  })
})
