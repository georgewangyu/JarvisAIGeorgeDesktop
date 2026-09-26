// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopBootstrapEvent, DesktopBootstrapState, DesktopConnectionProbeResult } from '@/global'
import { $consumerSetupReview, closeConsumerSetupReview, openConsumerSetupReview } from '@/store/consumer-setup-review'
import { $desktopOnboarding } from '@/store/onboarding'
import { onboardingSurfaceActive, resetOnboardingPresenceForTests } from '@/store/onboarding-presence'

import { DesktopInstallOverlay } from './desktop-install-overlay'

function bootstrapState(overrides: Partial<DesktopBootstrapState> = {}): DesktopBootstrapState {
  return {
    active: false,
    manifest: null,
    stages: {},
    error: null,
    log: [],
    startedAt: null,
    completedAt: null,
    setupChoice: null,
    unsupportedPlatform: null,
    ...overrides
  }
}

function installDesktopMock(state: DesktopBootstrapState) {
  const bootstrapListeners = new Set<(event: DesktopBootstrapEvent) => void>()

  const desktop = {
    getBootstrapState: vi.fn().mockResolvedValue(state),
    onBootstrapEvent: vi.fn((listener: (event: DesktopBootstrapEvent) => void) => {
      bootstrapListeners.add(listener)

      return () => bootstrapListeners.delete(listener)
    }),
    continueBootstrapLocal: vi.fn().mockResolvedValue({ ok: true }),
    probeConnectionConfig: vi.fn(),
    testConnectionConfig: vi.fn(),
    applyConnectionConfig: vi.fn(),
    oauthLoginConnectionConfig: vi.fn(),
    openExternal: vi.fn(),
    emitBootstrapEvent: (event: DesktopBootstrapEvent) => {
      for (const listener of bootstrapListeners) {
        listener(event)
      }
    }
  }

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: desktop
  })

  return desktop
}

// Resolve the instant a node commits, via MutationObserver rather than
// waitFor's polling timer. findBy* only settles on a timer tick, by which
// point React has already drained its passive effects — that hides any bug
// living in the window between paint and effect.
function whenPresent(text: string): Promise<HTMLElement> {
  return new Promise(resolve => {
    const existing = screen.queryByText(text)

    if (existing) {
      resolve(existing)

      return
    }

    const observer = new MutationObserver(() => {
      const node = screen.queryByText(text)

      if (node) {
        observer.disconnect()
        resolve(node)
      }
    })

    observer.observe(globalThis.document.body, { childList: true, subtree: true, characterData: true })
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  $desktopOnboarding.set({
    configured: null,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false,
    freeTierReady: false
  })
  resetOnboardingPresenceForTests()
  closeConsumerSetupReview()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'hermesDesktop')
  resetOnboardingPresenceForTests()
  closeConsumerSetupReview()
})

describe('DesktopInstallOverlay first-run setup', () => {
  it('reviews an existing setup without reauthenticating or clearing connected state', async () => {
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: true })
    const desktop = installDesktopMock(bootstrapState())
    const startCodexOAuth = vi.fn()
    Object.assign(desktop, {
      jarvisOnboarding: {
        getPermissions: vi.fn().mockResolvedValue({
          apps: { mail: true, messages: true, notes: true, whatsapp: false },
          fullDiskAccess: 'granted', microphone: 'granted', platform: 'darwin'
        }),
        startCodexOAuth
      }
    })
    render(<DesktopInstallOverlay />)
    expect(screen.queryByText('Set up Jarvis')).toBeNull()

    act(openConsumerSetupReview)
    expect(await screen.findByText('Set up Jarvis')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close setup' }))
    await waitFor(() => expect(screen.queryByText('Set up Jarvis')).toBeNull())
    expect($desktopOnboarding.get().configured).toBe(true)

    act(openConsumerSetupReview)
    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('heading', { name: 'Setup reviewed' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Return to Jarvis' }))
    await waitFor(() => expect($consumerSetupReview.get()).toBe(false))
    expect($desktopOnboarding.get().configured).toBe(true)
    expect(startCodexOAuth).not.toHaveBeenCalled()
  })

  it('lets a providerless user close a setup review without changing their skip choice', async () => {
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: false, firstRunSkipped: true })
    const desktop = installDesktopMock(bootstrapState())
    const startCodexOAuth = vi.fn()
    Object.assign(desktop, { jarvisOnboarding: { startCodexOAuth } })
    render(<DesktopInstallOverlay />)

    act(openConsumerSetupReview)
    fireEvent.click(await screen.findByRole('button', { name: 'Close setup' }))
    await waitFor(() => expect($consumerSetupReview.get()).toBe(false))
    expect($desktopOnboarding.get().firstRunSkipped).toBe(true)
    expect($desktopOnboarding.get().configured).toBe(false)
    expect(startCodexOAuth).not.toHaveBeenCalled()
  })

  it('shows the permission journey when the local engine was installed before first launch', async () => {
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: false })
    const desktop = installDesktopMock(bootstrapState())
    Object.assign(desktop, {
      jarvisOnboarding: {
        getPermissions: vi.fn().mockResolvedValue({
          apps: { mail: false, messages: false, notes: false, whatsapp: false },
          fullDiskAccess: 'denied',
          microphone: 'not-determined',
          platform: 'darwin'
        }),
        startCodexOAuth: vi.fn()
      }
    })

    render(<DesktopInstallOverlay />)

    expect(await screen.findByText('Set up Jarvis')).toBeTruthy()
    await waitFor(() => expect(onboardingSurfaceActive()).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
    expect(await screen.findByText('Let Jarvis work with your files?')).toBeTruthy()
    expect(desktop.continueBootstrapLocal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Continue without access' }))
    expect(await screen.findByRole('heading', { name: 'Apps on this Mac' })).toBeTruthy()
  })

  it('keeps an IPC sign-in rejection private and permits retry in the setup journey', async () => {
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: false })
    const desktop = installDesktopMock(bootstrapState())

    const startCodexOAuth = vi.fn()
      .mockRejectedValueOnce(new Error('callback code=private-code at /Users/example/auth.json'))
      .mockResolvedValueOnce({ ok: true })

    Object.assign(desktop, {
      jarvisOnboarding: {
        getPermissions: vi.fn().mockResolvedValue({
          apps: { mail: false, messages: false, notes: false, whatsapp: false },
          fullDiskAccess: 'denied', microphone: 'denied', platform: 'darwin'
        }),
        startCodexOAuth
      }
    })
    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue without access' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with ChatGPT / Codex' }))

    expect(await screen.findByText('ChatGPT sign-in could not start. Please try again.')).toBeTruthy()
    expect(screen.queryByText(/private-code|auth\.json/)).toBeNull()
    expect($desktopOnboarding.get().configured).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT / Codex' }))
    await waitFor(() => expect(startCodexOAuth).toHaveBeenCalledTimes(2))
    await waitFor(() => expect($desktopOnboarding.get().configured).toBe(true))
  })

  it('keeps browser sign-in visible until OAuth settles even if provider discovery changes', async () => {
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: false })
    const desktop = installDesktopMock(bootstrapState())
    let finishSignIn: ((result: { ok: boolean }) => void) | undefined

    const startCodexOAuth = vi.fn(() => new Promise<{ ok: boolean }>(resolve => {
      finishSignIn = resolve
    }))

    Object.assign(desktop, {
      jarvisOnboarding: {
        getPermissions: vi.fn().mockResolvedValue({
          apps: { mail: false, messages: false, notes: false, whatsapp: false },
          fullDiskAccess: 'denied', microphone: 'denied', platform: 'darwin'
        }),
        startCodexOAuth
      }
    })
    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue without access' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with ChatGPT / Codex' }))
    await waitFor(() => expect(startCodexOAuth).toHaveBeenCalledTimes(1))

    act(() => $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: true }))
    expect(screen.getByRole('heading', { name: 'Finish connecting Jarvis' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Finish sign-in in your browser')

    act(() => finishSignIn?.({ ok: true }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Finish connecting Jarvis' })).toBeNull())
  })

  it('lets an already-installed first-run user defer the provider without claiming connection', async () => {
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: false })
    const desktop = installDesktopMock(bootstrapState())
    Object.assign(desktop, { jarvisOnboarding: { startCodexOAuth: vi.fn() } })

    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: "I'll choose a provider later" }))
    await waitFor(() => expect(screen.queryByText('Set up Jarvis')).toBeNull())
    expect($desktopOnboarding.get().firstRunSkipped).toBe(true)
    expect($desktopOnboarding.get().configured).toBe(false)
    await waitFor(() => expect(onboardingSurfaceActive()).toBe(false))
  })

  it('lets a finished first-run journey defer sign-in directly from its final screen', async () => {
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: false })
    const desktop = installDesktopMock(bootstrapState())
    const startCodexOAuth = vi.fn()
    Object.assign(desktop, { jarvisOnboarding: { startCodexOAuth } })
    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue without access' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }))
    fireEvent.click(await screen.findByRole('button', { name: "I'll choose a provider later" }))

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Finish connecting Jarvis' })).toBeNull())
    expect($desktopOnboarding.get().firstRunSkipped).toBe(true)
    expect($desktopOnboarding.get().configured).toBe(false)
    expect(startCodexOAuth).not.toHaveBeenCalled()
    await waitFor(() => expect(onboardingSurfaceActive()).toBe(false))
  })

  it('keeps defer available when install finishes before provider discovery', async () => {
    const desktop = installDesktopMock(bootstrapState({
      setupChoice: { platform: 'darwin', activeRoot: '/synthetic-test-engine' }
    }))

    Object.assign(desktop, { jarvisOnboarding: { startCodexOAuth: vi.fn() } })
    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue without access' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }))
    act(() => {
      desktop.emitBootstrapEvent({ type: 'manifest', protocolVersion: 1, stages: [] })
      desktop.emitBootstrapEvent({ type: 'complete', marker: {} })
    })

    expect(await screen.findByRole('button', { name: "I'll choose a provider later" })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: "I'll choose a provider later" }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Finish connecting Jarvis' })).toBeNull())
    expect($desktopOnboarding.get().firstRunSkipped).toBe(true)
    expect($desktopOnboarding.get().configured).not.toBe(true)
  })

  it('closes the guided setup after bootstrap when the user goes back and chooses a provider later', async () => {
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: false })

    const desktop = installDesktopMock(bootstrapState({
      setupChoice: { platform: 'darwin', activeRoot: '/synthetic-test-engine' }
    }))

    Object.assign(desktop, { jarvisOnboarding: { startCodexOAuth: vi.fn() } })
    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }))
    expect(await screen.findByRole('heading', { name: 'Let Jarvis work with your files?' })).toBeTruthy()

    act(() => {
      desktop.emitBootstrapEvent({ type: 'manifest', protocolVersion: 1, stages: [] })
      desktop.emitBootstrapEvent({ type: 'complete', marker: {} })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(await screen.findByRole('button', { name: "I'll choose a provider later" }))

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Set up Jarvis' })).toBeNull())
    expect($desktopOnboarding.get().firstRunSkipped).toBe(true)
    expect($desktopOnboarding.get().configured).toBe(false)
    await waitFor(() => expect(onboardingSurfaceActive()).toBe(false))
  })

  it('hands an already-installed first-run user to the normal provider picker', async () => {
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: false })
    const desktop = installDesktopMock(bootstrapState())
    Object.assign(desktop, { jarvisOnboarding: { startCodexOAuth: vi.fn() } })

    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect another Jarvis setup' }))
    await waitFor(() => expect(screen.queryByText('Set up Jarvis')).toBeNull())
    expect($desktopOnboarding.get().configured).toBe(false)
    expect($desktopOnboarding.get().firstRunSkipped).toBe(false)
    await waitFor(() => expect(onboardingSurfaceActive()).toBe(false))
  })

  it('shows the guided Jarvis setup without installer jargon', async () => {
    installDesktopMock(
      bootstrapState({
        setupChoice: { platform: 'win32', activeRoot: 'C:\\Users\\me\\AppData\\Local\\hermes\\hermes-agent' }
      })
    )

    render(<DesktopInstallOverlay />)

    expect(await screen.findByText('Set up Jarvis')).toBeTruthy()
    expect(screen.getByText('Connect another Jarvis setup')).toBeTruthy()
    expect(screen.getByText('Get started')).toBeTruthy()
    expect(screen.queryByText(/steps complete/i)).toBeNull()
    expect(screen.queryByText(/Fetching installer manifest/i)).toBeNull()
  })

  it('starts bootstrap behind the guided setup', async () => {
    const desktop = installDesktopMock(
      bootstrapState({
        setupChoice: { platform: 'win32', activeRoot: 'C:\\Users\\me\\AppData\\Local\\hermes\\hermes-agent' }
      })
    )

    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByText('Get started'))

    await waitFor(() => expect(desktop.continueBootstrapLocal).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Let Jarvis work with your files?')).toBeTruthy()

    act(() => {
      desktop.emitBootstrapEvent({ type: 'manifest', protocolVersion: 1, stages: [] })
    })

    expect(screen.getByText('Let Jarvis work with your files?')).toBeTruthy()
    expect(screen.queryByText(/Fetching installer manifest/i)).toBeNull()
  })

  it('surfaces a recoverable error when the local-bootstrap bridge is unavailable', async () => {
    const desktop = installDesktopMock(
      bootstrapState({
        setupChoice: { platform: 'win32', activeRoot: 'C:\\Users\\me\\AppData\\Local\\hermes\\hermes-agent' }
      })
    )

    desktop.continueBootstrapLocal = undefined as never
    render(<DesktopInstallOverlay />)

    const install = (await screen.findByText('Get started')).closest('button') as HTMLButtonElement
    fireEvent.click(install)

    expect(await screen.findByText('Setup could not start. Restart JarvisAIGeorge and try again.')).toBeTruthy()
    expect(install.disabled).toBe(false)
  })

  it('keeps the local-start error when the first snapshot commits under the click', async () => {
    const desktop = installDesktopMock(
      bootstrapState({
        setupChoice: { platform: 'win32', activeRoot: 'C:\\Users\\me\\AppData\\Local\\hermes\\hermes-agent' }
      })
    )

    desktop.continueBootstrapLocal = undefined as never
    render(<DesktopInstallOverlay />)

    // Click the instant the choice paints, before React drains the passive
    // effect that reacts to the first snapshot. A loaded runner hits this
    // window by accident; observing the DOM directly hits it every time.
    const install = (await whenPresent('Get started')).closest('button') as HTMLButtonElement
    fireEvent.click(install)

    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.queryByText('Setup could not start. Restart JarvisAIGeorge and try again.')).toBeTruthy()
  })

  it('opens the remote connection form from the first-run choice', async () => {
    installDesktopMock(
      bootstrapState({
        setupChoice: { platform: 'linux', activeRoot: '/home/me/.hermes/hermes-agent' }
      })
    )

    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect another Jarvis setup' }))

    expect(await screen.findByText('Service address')).toBeTruthy()
    expect(screen.getByText('Connect another Jarvis setup')).toBeTruthy()
    expect(screen.queryByText(/Hermes|gateway/i)).toBeNull()
    expect(screen.getByText('Test connection')).toBeTruthy()
    expect(screen.getByText('Connect')).toBeTruthy()
  })

  it('returns from the remote connection form to the first-run choice', async () => {
    installDesktopMock(
      bootstrapState({
        setupChoice: { platform: 'linux', activeRoot: '/home/me/.hermes/hermes-agent' }
      })
    )

    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect another Jarvis setup' }))
    expect(await screen.findByText('Service address')).toBeTruthy()

    fireEvent.click(screen.getByText('Back'))

    expect(await screen.findByText('Set up Jarvis')).toBeTruthy()
    expect(screen.getByText('Get started')).toBeTruthy()
  })

  it('keeps probe diagnostics out of the first-run connection screen', async () => {
    const desktop = installDesktopMock(
      bootstrapState({ setupChoice: { platform: 'linux', activeRoot: '/test-owned/remote' } })
    )

    desktop.probeConnectionConfig.mockRejectedValue(new Error('IPC internal-trace token=synthetic-secret'))
    render(<DesktopInstallOverlay />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect another Jarvis setup' }))
    fireEvent.change(await screen.findByPlaceholderText('https://assistant.example.com'), {
      target: { value: 'https://gateway.example.com/hermes' }
    })

    expect(await screen.findByText("Jarvis can't reach that address. Check the address and make sure the other setup is running.")).toBeTruthy()
    expect(screen.queryByText(/synthetic-secret|internal-trace/)).toBeNull()
  })

  it('requires a successful token connection test before applying remote config', async () => {
    const desktop = installDesktopMock(
      bootstrapState({
        setupChoice: { platform: 'linux', activeRoot: '/home/me/.hermes/hermes-agent' }
      })
    )

    desktop.probeConnectionConfig.mockResolvedValue({
      authMode: 'token',
      baseUrl: 'https://gateway.example.com/hermes',
      error: null,
      providers: [],
      reachable: true,
      version: '0.17.0'
    })
    desktop.testConnectionConfig.mockResolvedValue({
      baseUrl: 'https://gateway.example.com/hermes',
      ok: true,
      version: '0.17.0'
    })
    desktop.applyConnectionConfig.mockImplementation(async () => {
      desktop.emitBootstrapEvent({ type: 'dismissed' })

      return { mode: 'remote' }
    })

    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect another Jarvis setup' }))
    fireEvent.change(await screen.findByPlaceholderText('https://assistant.example.com'), {
      target: { value: 'https://gateway.example.com/hermes' }
    })

    const apply = screen.getByText('Connect').closest('button') as HTMLButtonElement
    expect(apply.disabled).toBe(true)

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 550))
    })

    fireEvent.change(await screen.findByPlaceholderText('Paste session token'), {
      target: { value: 'session-secret' }
    })
    fireEvent.click(screen.getByText('Test connection'))

    await waitFor(() => {
      expect(desktop.testConnectionConfig).toHaveBeenCalledWith({
        mode: 'remote',
        remoteAuthMode: 'token',
        remoteToken: 'session-secret',
        remoteUrl: 'https://gateway.example.com/hermes'
      })
    })

    await screen.findByText('Connected to https://gateway.example.com/hermes (0.17.0).')
    expect(apply.disabled).toBe(false)

    fireEvent.click(screen.getByText('Connect'))

    await waitFor(() => {
      expect(desktop.applyConnectionConfig).toHaveBeenCalledWith({
        mode: 'remote',
        remoteAuthMode: 'token',
        remoteToken: 'session-secret',
        remoteUrl: 'https://gateway.example.com/hermes'
      })
    })
    await waitFor(() => expect(screen.queryByText('Service address')).toBeNull())
    expect(await screen.findByRole('heading', { name: 'Let Jarvis work with your files?' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Set up Jarvis' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Continue without access' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }))
    expect(await screen.findByRole('heading', { name: 'Your other setup is connected' })).toBeTruthy()
    expect(screen.queryByText(/Sign in with ChatGPT to start asking Jarvis/)).toBeNull()
    expect(screen.queryByRole('button', { name: "I'll choose a provider later" })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start using Jarvis' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Your other setup is connected' })).toBeNull())
    expect($desktopOnboarding.get().configured).not.toBe(true)
    expect($desktopOnboarding.get().firstRunSkipped).toBe(true)
    expect(screen.queryByRole('heading', { name: 'Connect your AI to Jarvis' })).toBeNull()
  })

  it('ignores a completed probe after the gateway URL becomes invalid', async () => {
    const desktop = installDesktopMock(
      bootstrapState({
        setupChoice: { platform: 'linux', activeRoot: '/home/me/.hermes/hermes-agent' }
      })
    )

    let resolveProbe: ((result: DesktopConnectionProbeResult) => void) | undefined

    const pendingProbe = new Promise<DesktopConnectionProbeResult>(resolve => {
      resolveProbe = resolve
    })

    desktop.probeConnectionConfig.mockReturnValue(pendingProbe)

    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect another Jarvis setup' }))
    const urlInput = await screen.findByPlaceholderText('https://assistant.example.com')
    fireEvent.change(urlInput, { target: { value: 'https://gateway.example.com/hermes' } })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 550))
    })
    expect(desktop.probeConnectionConfig).toHaveBeenCalledTimes(1)

    fireEvent.change(urlInput, { target: { value: 'not-a-url' } })
    await act(async () => {
      resolveProbe?.({
        authMode: 'token',
        baseUrl: 'https://gateway.example.com/hermes',
        error: null,
        providers: [],
        reachable: true,
        version: '0.17.0'
      })
      await pendingProbe
    })

    expect(screen.queryByPlaceholderText('Paste session token')).toBeNull()
    expect((screen.getByText('Test connection').closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText('Connect').closest('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not enable Apply when credentials change during a connection test', async () => {
    const desktop = installDesktopMock(
      bootstrapState({
        setupChoice: { platform: 'linux', activeRoot: '/home/me/.hermes/hermes-agent' }
      })
    )

    desktop.probeConnectionConfig.mockResolvedValue({
      authMode: 'token',
      baseUrl: 'https://gateway.example.com/hermes',
      error: null,
      providers: [],
      reachable: true,
      version: '0.17.0'
    })

    let resolveTest: ((result: { baseUrl: string; ok: boolean; version: string }) => void) | undefined

    const pendingTest = new Promise<{ baseUrl: string; ok: boolean; version: string }>(resolve => {
      resolveTest = resolve
    })

    desktop.testConnectionConfig.mockReturnValue(pendingTest)

    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect another Jarvis setup' }))
    fireEvent.change(await screen.findByPlaceholderText('https://assistant.example.com'), {
      target: { value: 'https://gateway.example.com/hermes' }
    })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 550))
    })

    const tokenInput = await screen.findByPlaceholderText('Paste session token')
    const apply = screen.getByText('Connect').closest('button') as HTMLButtonElement

    fireEvent.change(tokenInput, { target: { value: 'token-a' } })
    fireEvent.click(screen.getByText('Test connection'))
    await waitFor(() => expect(desktop.testConnectionConfig).toHaveBeenCalledTimes(1))

    fireEvent.change(tokenInput, { target: { value: 'token-b' } })

    await act(async () => {
      resolveTest?.({ baseUrl: 'https://gateway.example.com/hermes', ok: true, version: '0.17.0' })
      await pendingTest
    })

    expect(screen.queryByText('Connected to https://gateway.example.com/hermes (0.17.0).')).toBeNull()
    expect(apply.disabled).toBe(true)
  })

  it('restores remote apply controls when applying the tested connection fails', async () => {
    const desktop = installDesktopMock(
      bootstrapState({
        setupChoice: { platform: 'linux', activeRoot: '/home/me/.hermes/hermes-agent' }
      })
    )

    desktop.probeConnectionConfig.mockResolvedValue({
      authMode: 'token',
      baseUrl: 'https://gateway.example.com/hermes',
      error: null,
      providers: [],
      reachable: true,
      version: '0.17.0'
    })
    desktop.testConnectionConfig.mockResolvedValue({
      baseUrl: 'https://gateway.example.com/hermes',
      ok: true,
      version: '0.17.0'
    })
    desktop.applyConnectionConfig.mockRejectedValue(new Error('remote apply failed'))

    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect another Jarvis setup' }))
    fireEvent.change(await screen.findByPlaceholderText('https://assistant.example.com'), {
      target: { value: 'https://gateway.example.com/hermes' }
    })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 550))
    })

    fireEvent.change(await screen.findByPlaceholderText('Paste session token'), {
      target: { value: 'session-secret' }
    })
    fireEvent.click(screen.getByText('Test connection'))
    await screen.findByText('Connected to https://gateway.example.com/hermes (0.17.0).')

    const apply = screen.getByText('Connect').closest('button') as HTMLButtonElement
    fireEvent.click(apply)

    expect(await screen.findByText('Could not save this connection. Please try again.')).toBeTruthy()
    expect(screen.queryByText('remote apply failed')).toBeNull()
    expect(apply.disabled).toBe(false)
    expect(screen.getByText('Service address')).toBeTruthy()
  })

  it('hides rejected gateway diagnostics and recovers after correcting the token', async () => {
    const desktop = installDesktopMock(
      bootstrapState({ setupChoice: { platform: 'linux', activeRoot: '/test-owned/remote' } })
    )

    desktop.probeConnectionConfig.mockResolvedValue({
      authMode: 'token',
      baseUrl: 'https://gateway.example.com/hermes',
      error: null,
      providers: [],
      reachable: true,
      version: '0.17.0'
    })
    desktop.testConnectionConfig
      .mockRejectedValueOnce(new Error('IPC internal-trace token=synthetic-secret'))
      .mockResolvedValueOnce({ baseUrl: 'https://gateway.example.com/hermes', ok: true, version: '0.17.0' })
    desktop.applyConnectionConfig.mockResolvedValue({ mode: 'remote' })

    render(<DesktopInstallOverlay />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect another Jarvis setup' }))
    fireEvent.change(await screen.findByPlaceholderText('https://assistant.example.com'), {
      target: { value: 'https://gateway.example.com/hermes' }
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 550))
    })

    const tokenInput = await screen.findByPlaceholderText('Paste session token')

    fireEvent.change(tokenInput, { target: { value: 'wrong-synthetic-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText('Could not connect. Check the address and sign-in details, then try again.')).toBeTruthy()
    expect(screen.queryByText(/synthetic-secret|internal-trace/)).toBeNull()
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(tokenInput, { target: { value: 'correct-synthetic-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText('Connected to https://gateway.example.com/hermes (0.17.0).')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('heading', { name: 'Let Jarvis work with your files?' })).toBeTruthy()
  })

  it('signs in, tests, and applies a password-style remote gateway', async () => {
    const desktop = installDesktopMock(
      bootstrapState({
        setupChoice: { platform: 'linux', activeRoot: '/home/me/.hermes/hermes-agent' }
      })
    )

    desktop.probeConnectionConfig.mockResolvedValue({
      authMode: 'oauth',
      baseUrl: 'https://gateway.example.com/hermes',
      error: null,
      providers: [{ displayName: 'Username & Password', name: 'password', supportsPassword: true }],
      reachable: true,
      version: '0.17.0'
    })
    desktop.oauthLoginConnectionConfig.mockResolvedValue({
      baseUrl: 'https://gateway.example.com/hermes',
      connected: true,
      ok: true
    })
    desktop.testConnectionConfig.mockResolvedValue({
      baseUrl: 'https://gateway.example.com/hermes',
      ok: true,
      version: null
    })
    desktop.applyConnectionConfig.mockResolvedValue({ mode: 'remote' })

    render(<DesktopInstallOverlay />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect another Jarvis setup' }))
    fireEvent.change(await screen.findByPlaceholderText('https://assistant.example.com'), {
      target: { value: 'https://gateway.example.com/hermes' }
    })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 550))
    })

    expect(screen.queryByText('Sign in with Username & Password')).toBeNull()
    fireEvent.click(await screen.findByText('Sign in'))

    await waitFor(() => {
      expect(desktop.oauthLoginConnectionConfig).toHaveBeenCalledWith('https://gateway.example.com/hermes')
    })

    fireEvent.click(screen.getByText('Test connection'))

    await waitFor(() => {
      expect(desktop.testConnectionConfig).toHaveBeenCalledWith({
        mode: 'remote',
        remoteAuthMode: 'oauth',
        remoteToken: undefined,
        remoteUrl: 'https://gateway.example.com/hermes'
      })
    })

    await screen.findByText('Connected to https://gateway.example.com/hermes.')
    const apply = screen.getByText('Connect').closest('button') as HTMLButtonElement
    expect(apply.disabled).toBe(false)
    fireEvent.click(apply)

    await waitFor(() => {
      expect(desktop.applyConnectionConfig).toHaveBeenCalledWith({
        mode: 'remote',
        remoteAuthMode: 'oauth',
        remoteToken: undefined,
        remoteUrl: 'https://gateway.example.com/hermes'
      })
    })
    expect(await screen.findByRole('heading', { name: 'Let Jarvis work with your files?' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Set up Jarvis' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Continue without access' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start using Jarvis' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Your other setup is connected' })).toBeNull())
    expect(screen.queryByRole('heading', { name: 'Set up Jarvis' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Connect your AI to Jarvis' })).toBeNull()
  })

  it('offers remote connection from the unsupported packaged install screen', async () => {
    const desktop = installDesktopMock(
      bootstrapState({
        unsupportedPlatform: {
          platform: 'darwin',
          activeRoot: '/Users/me/.hermes/hermes-agent',
          installCommand: 'curl -fsSL https://example.invalid/install.sh | sh',
          docsUrl: 'https://example.invalid/docs'
        }
      })
    )

    render(<DesktopInstallOverlay />)

    expect(await screen.findByText('Hermes needs a one-time install')).toBeTruthy()

    fireEvent.click(screen.getByText('Connect existing setup'))

    expect(await screen.findByText('Service address')).toBeTruthy()

    desktop.probeConnectionConfig.mockResolvedValue({
      authMode: 'token',
      baseUrl: 'https://gateway.example.com/hermes',
      error: null,
      providers: [],
      reachable: true,
      version: '0.17.0'
    })
    desktop.testConnectionConfig.mockResolvedValue({
      baseUrl: 'https://gateway.example.com/hermes',
      ok: true,
      version: '0.17.0'
    })
    desktop.applyConnectionConfig.mockImplementation(async () => {
      desktop.emitBootstrapEvent({ type: 'dismissed' })

      return { mode: 'remote' }
    })

    fireEvent.change(screen.getByPlaceholderText('https://assistant.example.com'), {
      target: { value: 'https://gateway.example.com/hermes' }
    })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 550))
    })

    fireEvent.change(await screen.findByPlaceholderText('Paste session token'), {
      target: { value: 'session-secret' }
    })
    fireEvent.click(screen.getByText('Test connection'))
    await screen.findByText('Connected to https://gateway.example.com/hermes (0.17.0).')
    fireEvent.click(screen.getByText('Connect'))

    await waitFor(() => expect(screen.queryByText('Service address')).toBeNull())
    expect(screen.queryByText('Hermes needs a one-time install')).toBeNull()
  })
})
