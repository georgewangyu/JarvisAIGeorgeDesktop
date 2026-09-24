import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as notifications from '@/store/notifications'
import { makeOAuthProvider } from '@/test/oauth-provider'
import type { OAuthProvider } from '@/types/hermes'

import {
  $desktopOnboarding,
  confirmOnboardingModel,
  type DesktopOnboardingState,
  type OnboardingContext,
  refreshOnboarding,
  requestDesktopOnboarding,
  saveOnboardingApiKey,
  saveOnboardingLocalEndpoint,
  setOnboardingModel,
  startManualOnboarding,
  submitOnboardingCode
} from './onboarding'

function baseState(overrides: Partial<DesktopOnboardingState> = {}): DesktopOnboardingState {
  return {
    configured: false,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false,
    freeTierReady: false,
    ...overrides
  }
}

function installApiMock(api: (request: { path: string }) => Promise<unknown>) {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { api }
  })
}

function emptyOpenRouterGateway(): OnboardingContext['requestGateway'] {
  return async method => {
    if (method === 'setup.status') {
      return { provider_configured: true } as never
    }

    if (method === 'setup.runtime_check') {
      return { error: 'No usable credentials found for openrouter.', ok: false, provider: 'openrouter' } as never
    }

    throw new Error(`unexpected gateway method: ${method}`)
  }
}

function keylessCustomGateway(): OnboardingContext['requestGateway'] {
  return async method => {
    if (method === 'setup.status') {
      return { provider_configured: true } as never
    }

    if (method === 'setup.runtime_check') {
      return { ok: true, provider: 'custom' } as never
    }

    throw new Error(`unexpected gateway method: ${method}`)
  }
}

function onboardingContext(requestGateway: OnboardingContext['requestGateway']): OnboardingContext {
  return { requestGateway }
}

function fallbackTimeoutGateway(): OnboardingContext['requestGateway'] {
  return async method => {
    if (method === 'setup.status' || method === 'setup.runtime_check') {
      throw new Error(`request timed out: ${method}`)
    }

    throw new Error(`unexpected gateway method: ${method}`)
  }
}

describe('refreshOnboarding', () => {
  it('keeps onboarding work in its initiating lifetime and profile', async () => {
    const { startManualOnboarding, startProviderOAuth, saveOnboardingApiKey, closeManualOnboarding } =
      await import('./onboarding')

    const requests: { path: string; profile?: string }[] = []
    let release!: () => void
    let delayKey = true
    installApiMock(async request => {
      requests.push(request)

      if (request.path === '/api/providers/oauth') {
        return { providers: [] }
      }

      if (request.path.endsWith('/start')) {
        return {
          flow: 'device_code',
          session_id: 'local-fixture',
          user_code: 'FAKE',
          verification_url: 'http://localhost/fixture',
          expires_in: 600
        }
      }

      if (request.path.includes('/poll/')) {
        return { status: 'approved' }
      }

      if (request.path === '/api/env' && delayKey) {
        await new Promise<void>(resolve => {
          release = resolve
        })
      }

      if (request.path.startsWith('/api/model/options')) {
        return { providers: [{ slug: 'fixture', name: 'Fixture', models: ['fixture-model'] }] }
      }

      if (request.path.startsWith('/api/model/recommended-default')) {
        return { model: 'fixture-model' }
      }

      return { ok: true }
    })
    vi.spyOn(window, 'open').mockReturnValue(null)
    let profile = 'beta'

    const ctx: OnboardingContext = {
      get profile() {
        return profile
      },
      requestGateway: async method =>
        (method === 'setup.status' ? { provider_configured: true } : { ok: true }) as never
    }

    try {
      startManualOnboarding(null, 'beta')
      const pending = saveOnboardingApiKey('FIREWORKS_API_KEY', 'fake-key', 'Fireworks', ctx)
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      closeManualOnboarding()
      profile = 'alpha'
      startManualOnboarding(null, 'alpha')
      release()
      await pending
      expect(requests.some(r => r.path === '/api/model/set')).toBe(false)
      expect($desktopOnboarding.get()).toMatchObject({ targetProfile: 'alpha', flow: { status: 'idle' } })
      closeManualOnboarding()
      delayKey = false
      profile = 'beta'
      startManualOnboarding(null, 'beta')
      const startAt = requests.length
      await startProviderOAuth(makeOAuthProvider('fixture'), ctx)
      await vi.waitFor(() => expect($desktopOnboarding.get().flow.status).toBe('confirming_model'), { timeout: 5000 })
      expect(requests.slice(startAt).some(r => r.path.includes('/poll/'))).toBe(true)
      expect(requests.slice(startAt).some(r => r.path === '/api/model/set')).toBe(true)
      expect(requests.slice(startAt).every(r => r.profile === 'beta')).toBe(true)
    } finally {
      closeManualOnboarding()
    }
  })

  beforeEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
  })

  afterEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
    vi.restoreAllMocks()
  })

  it('refreshes OAuth providers again when onboarding was explicitly requested', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [makeOAuthProvider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(baseState({ providers: [makeOAuthProvider('cached')] }))
    requestDesktopOnboarding('Need provider setup')

    const ready = await refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))

    expect(ready).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)
    expect($desktopOnboarding.get().providers?.map(p => p.id)).toEqual(['fresh'])
    expect($desktopOnboarding.get().reason).toContain('No usable credentials found for openrouter.')
    expect($desktopOnboarding.get().reason).toContain('setup.status reports configured credentials')
  })

  it('keeps cached providers when onboarding was not re-requested', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [makeOAuthProvider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(baseState({ providers: [makeOAuthProvider('cached')] }))

    const ready = await refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))

    expect(ready).toBe(false)
    expect(api).not.toHaveBeenCalled()
    expect($desktopOnboarding.get().providers?.map(p => p.id)).toEqual(['cached'])
  })

  it('does not downgrade configured=true on fallback-only readiness failures', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [makeOAuthProvider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    // Simulate a returning user: cache is set and store is configured.
    window.localStorage.setItem('hermes-desktop-onboarded-v1', '1')
    $desktopOnboarding.set(
      baseState({
        configured: true,
        providers: [makeOAuthProvider('cached')],
        reason: null,
        requested: false
      })
    )

    const ready = await refreshOnboarding(onboardingContext(fallbackTimeoutGateway()))

    expect(ready).toBe(false)
    expect(api).not.toHaveBeenCalled()
    expect($desktopOnboarding.get().configured).toBe(true)
    expect($desktopOnboarding.get().reason).toBeNull()
    // The cache must survive the refresh — proving we didn't downgrade.
    expect(window.localStorage.getItem('hermes-desktop-onboarded-v1')).toBe('1')
  })

  it('shows a non-blocking notification when preserving configured on fallback', async () => {
    const notifySpy = vi.spyOn(notifications, 'notify')

    installApiMock(vi.fn())
    $desktopOnboarding.set(
      baseState({
        configured: true,
        providers: [makeOAuthProvider('cached')],
        reason: null,
        requested: false
      })
    )

    await refreshOnboarding(onboardingContext(fallbackTimeoutGateway()))

    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'runtime-not-ready',
        kind: 'error'
      })
    )
    expect($desktopOnboarding.get().configured).toBe(true)
  })

  it('enters setup when the selected OpenRouter credential is genuinely empty', async () => {
    installApiMock(vi.fn())
    window.localStorage.setItem('hermes-desktop-onboarded-v1', '1')
    $desktopOnboarding.set(
      baseState({
        configured: true,
        providers: [makeOAuthProvider('cached')],
        reason: null,
        requested: false
      })
    )

    const ready = await refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))

    expect(ready).toBe(false)
    expect($desktopOnboarding.get().configured).toBe(false)
    expect($desktopOnboarding.get().reason).toContain('No usable credentials found for openrouter.')
    expect(window.localStorage.getItem('hermes-desktop-onboarded-v1')).toBeNull()
  })

  it('keeps a keyless custom runtime out of setup', async () => {
    const api = vi.fn()

    installApiMock(api)
    $desktopOnboarding.set(baseState({ configured: false, reason: 'stale setup error', requested: true }))

    const ready = await refreshOnboarding(onboardingContext(keylessCustomGateway()))

    expect(ready).toBe(true)
    expect(api).not.toHaveBeenCalled()
    expect($desktopOnboarding.get()).toMatchObject({
      configured: true,
      reason: null,
      requested: false
    })
  })

  it('does not preserve configured when onboarding was explicitly requested', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [makeOAuthProvider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(
      baseState({
        configured: true,
        providers: [makeOAuthProvider('cached')],
        reason: null,
        requested: true
      })
    )

    const ready = await refreshOnboarding(onboardingContext(fallbackTimeoutGateway()))

    expect(ready).toBe(false)
    // requested overrides preservation — should downgrade.
    expect($desktopOnboarding.get().configured).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('still surfaces onboarding when fallback failure happens before configured state', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [makeOAuthProvider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(baseState({ configured: false, providers: null, requested: true }))

    const ready = await refreshOnboarding(onboardingContext(fallbackTimeoutGateway()))

    expect(ready).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)
    expect($desktopOnboarding.get().configured).toBe(false)
    expect($desktopOnboarding.get().reason).toContain('request timed out')
  })

  it('deduplicates concurrent provider refresh calls', async () => {
    let resolveProviders!: (value: { providers: OAuthProvider[] }) => void

    const providersPromise = new Promise<{ providers: OAuthProvider[] }>(resolve => {
      resolveProviders = value => {
        resolve(value)
      }
    })

    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return providersPromise
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(baseState({ requested: true }))

    const first = refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))
    const second = refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))

    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1))

    resolveProviders({ providers: [makeOAuthProvider('shared')] })
    await Promise.all([first, second])

    expect($desktopOnboarding.get().providers?.map(p => p.id)).toEqual(['shared'])
  })
})

describe('OAuth onboarding', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
  })

  afterEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
    vi.restoreAllMocks()
  })

  it('never stores raw callback or account details after OAuth start fails', async () => {
    const { startProviderOAuth } = await import('./onboarding')
    const privateError = 'callback code=ac_test-secret state=private-state for user@example.com at synthetic-auth-path'
    installApiMock(async () => { throw new Error(privateError) })

    await startProviderOAuth(makeOAuthProvider('nous', 'Nous Portal'), onboardingContext(emptyOpenRouterGateway()))

    const flow = $desktopOnboarding.get().flow
    expect(flow.status).toBe('error')
    expect(JSON.stringify(flow)).not.toContain('ac_test-secret')
    expect(JSON.stringify(flow)).not.toContain('user@example.com')
    expect(JSON.stringify(flow)).not.toContain('synthetic-auth-path')
  })

  it('keeps the newer provider screen when an earlier OAuth start finishes late', async () => {
    const { startProviderOAuth } = await import('./onboarding')
    let releaseOld!: (value: unknown) => void
    const cancelled: string[] = []
    installApiMock(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth/old/start') {
        return new Promise(resolve => {
          releaseOld = resolve
        })
      }

      if (path === '/api/providers/oauth/new/start') {
        return { flow: 'pkce', session_id: 'new-session', auth_url: 'https://example.test/new', expires_in: 600 }
      }

      if (path.includes('/sessions/')) {
        cancelled.push(path)

        return { ok: true }
      }

      throw new Error(`unexpected api path: ${path}`)
    })
    vi.spyOn(window, 'open').mockReturnValue(null)
    const ctx = onboardingContext(emptyOpenRouterGateway())
    const oldStart = startProviderOAuth(makeOAuthProvider('old', 'Old'), ctx)
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf('function'))

    await startProviderOAuth(makeOAuthProvider('new', 'New'), ctx)
    expect($desktopOnboarding.get().flow).toMatchObject({ status: 'awaiting_user', provider: { id: 'new' } })

    releaseOld({ flow: 'pkce', session_id: 'old-session', auth_url: 'https://example.test/old', expires_in: 600 })
    await oldStart

    expect($desktopOnboarding.get().flow).toMatchObject({ status: 'awaiting_user', provider: { id: 'new' } })
    expect(cancelled.some(path => path.includes('old-session'))).toBe(true)
  })

  it('clears stale readiness errors after OAuth succeeds and model confirmation is shown', async () => {
    const model = 'anthropic/claude-opus-4.8'
    const calls: { body?: unknown; path: string }[] = []

    installApiMock(async ({ body, path }: { body?: unknown; path: string }) => {
      calls.push({ body, path })

      if (path === '/api/providers/oauth/nous/submit') {
        return { ok: true, status: 'approved' }
      }

      if (path.startsWith('/api/model/options')) {
        return {
          providers: [
            {
              name: 'Nous Portal',
              slug: 'nous',
              models: [model]
            }
          ]
        }
      }

      if (path.startsWith('/api/model/recommended-default?')) {
        return { provider: 'nous', model, free_tier: false }
      }

      if (path === '/api/model/set') {
        return { ok: true, provider: 'nous', model, gateway_tools: [] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const requestGateway: OnboardingContext['requestGateway'] = async (method, params) => {
      if (method === 'reload.env') {
        return {} as never
      }

      if (method === 'setup.status') {
        return { provider_configured: true } as never
      }

      if (method === 'setup.runtime_check') {
        expect(params).toEqual({ provider: 'nous' })

        return { ok: true } as never
      }

      throw new Error(`unexpected gateway method: ${method}`)
    }

    $desktopOnboarding.set(
      baseState({
        flow: {
          status: 'awaiting_user',
          provider: makeOAuthProvider('nous', 'Nous Portal'),
          start: {
            auth_url: 'https://portal.example/auth',
            expires_in: 600,
            flow: 'pkce',
            session_id: 'portal-session'
          },
          code: 'fresh-code'
        },
        reason:
          'No access token found for Nous Portal login. setup.status reports configured credentials, but runtime resolution still failed.',
        requested: true
      })
    )

    await submitOnboardingCode(onboardingContext(requestGateway))

    const state = $desktopOnboarding.get()
    expect(state.reason).toBeNull()
    expect(state.flow.status).toBe('confirming_model')

    if (state.flow.status === 'confirming_model') {
      expect(state.flow.label).toBe('Nous Portal')
      expect(state.flow.currentModel).toBe(model)
    }

    expect(calls.some(c => c.path === '/api/model/set')).toBe(true)

    const optionsIndex = calls.findIndex(c => c.path.startsWith('/api/model/options'))
    const recommendedIndex = calls.findIndex(c => c.path.startsWith('/api/model/recommended-default'))
    const setIndex = calls.findIndex(c => c.path === '/api/model/set')

    expect(optionsIndex).toBeGreaterThanOrEqual(0)
    expect(recommendedIndex).toBeGreaterThan(optionsIndex)
    expect(setIndex).toBeGreaterThan(recommendedIndex)
  })

  it('requires an explicit, persisted model confirmation before completing OAuth setup', async () => {
    const model = 'openai/gpt-5.5-pro'
    let allowConfirm = false
    const assignmentBodies: unknown[] = []
    installApiMock(async ({ body, path }: { body?: unknown; path: string }) => {
      if (path === '/api/providers/oauth/nous/submit') {
        return { ok: true, status: 'approved' }
      }

      if (path.startsWith('/api/model/options')) {
        return { providers: [{ name: 'Nous Portal', slug: 'nous', models: [model] }] }
      }

      if (path.startsWith('/api/model/recommended-default?')) {
        return { provider: 'nous', model, free_tier: false }
      }

      if (path === '/api/model/set') {
        assignmentBodies.push(body)

        if (allowConfirm && (body as { confirm_expensive_model?: boolean })?.confirm_expensive_model) {
          return { ok: true, provider: 'nous', model }
        }

        return {
          ok: false,
          provider: 'nous',
          model,
          confirm_required: true,
          confirm_message: 'Confirm this expensive model. code=private-callback-secret'
        }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const requestGatewayMock = vi.fn(async (method: string) => {
      if (method === 'reload.env') {
        return {}
      }

      if (method === 'setup.runtime_check') {
        return { ok: true, provider: 'nous' }
      }

      throw new Error(`unexpected gateway method: ${method}`)
    })

    const requestGateway = requestGatewayMock as OnboardingContext['requestGateway']
    $desktopOnboarding.set(
      baseState({
        flow: {
          status: 'awaiting_user',
          provider: makeOAuthProvider('nous', 'Nous Portal'),
          start: {
            auth_url: 'https://portal.example/auth',
            expires_in: 600,
            flow: 'pkce',
            session_id: 'portal-session'
          },
          code: 'fresh-code'
        },
        requested: true
      })
    )

    await submitOnboardingCode(onboardingContext(requestGateway))

    const state = $desktopOnboarding.get()
    expect(state.flow.status).toBe('confirming_model')
    expect(state.flow.status === 'confirming_model' ? state.flow.requiresConfirmation : false).toBe(true)
    expect(JSON.stringify(state.flow)).not.toContain('private-callback-secret')
    expect(requestGatewayMock).not.toHaveBeenCalledWith('setup.runtime_check', expect.anything())

    await confirmOnboardingModel(onboardingContext(requestGateway))
    expect($desktopOnboarding.get().configured).toBe(false)
    expect($desktopOnboarding.get().flow).toMatchObject({ status: 'confirming_model', saving: false, confirmationError: true })

    allowConfirm = true
    await confirmOnboardingModel(onboardingContext(requestGateway))
    expect(assignmentBodies).toEqual(expect.arrayContaining([expect.objectContaining({ confirm_expensive_model: true })]))
    expect(requestGatewayMock).toHaveBeenCalledWith('setup.runtime_check', { provider: 'nous' })
    expect($desktopOnboarding.get()).toMatchObject({ configured: true, flow: { status: 'idle' } })
  })

  it('does not finish a guarded setup after switching profiles during the save', async () => {
    let releaseAssignment!: (value: unknown) => void
    installApiMock(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [] }
      }

      if (path === '/api/model/set') {
        return new Promise(resolve => {
          releaseAssignment = resolve
        })
      }

      throw new Error(`unexpected api path: ${path}`)
    })
    const requestGateway = vi.fn(async () => ({ ok: true })) as OnboardingContext['requestGateway']
    startManualOnboarding(null, 'alpha')
    $desktopOnboarding.set(baseState({
      targetProfile: 'alpha',
      flow: {
        status: 'confirming_model',
        providerSlug: 'nous',
        currentModel: 'openai/gpt-5.5-pro',
        label: 'Nous Portal',
        requiresConfirmation: true,
        saving: false
      }
    }))

    const pending = confirmOnboardingModel(onboardingContext(requestGateway))
    await vi.waitFor(() => expect(releaseAssignment).toBeTypeOf('function'))
    startManualOnboarding(null, 'beta')
    releaseAssignment({ ok: true, provider: 'nous', model: 'openai/gpt-5.5-pro' })
    await pending

    expect($desktopOnboarding.get()).toMatchObject({ configured: false, targetProfile: 'beta', flow: { status: 'idle' } })
    expect(requestGateway).not.toHaveBeenCalled()
  })
})

describe('saveOnboardingApiKey', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
  })

  afterEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
    vi.restoreAllMocks()
  })

  it('does not echo a backend exception containing the submitted key', async () => {
    installApiMock(async ({ path }: { path: string }) => {
      if (path === '/api/env') {
        throw new Error('write failed for api_key=private-api-key')
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const result = await saveOnboardingApiKey('FIREWORKS_API_KEY', 'private-api-key', 'Fireworks', onboardingContext(emptyOpenRouterGateway()))

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Could not save the key')
    expect(JSON.stringify(result)).not.toContain('private-api-key')
  })

  it('does not claim the key was saved when the backend returns ok=false', async () => {
    const paths: string[] = []
    installApiMock(async ({ path }: { path: string }) => {
      paths.push(path)

      if (path === '/api/env') {
        return { ok: false }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const result = await saveOnboardingApiKey('FIREWORKS_API_KEY', 'synthetic-key', 'Fireworks', onboardingContext(emptyOpenRouterGateway()))

    expect(result.ok).toBe(false)
    expect(paths).toEqual(['/api/env'])
  })

  it('reports an incomplete model setup after a successful key write', async () => {
    installApiMock(async ({ path }: { path: string }) => {
      if (path === '/api/env') {
        return { ok: true }
      }

      if (path.startsWith('/api/model/options')) {
        return { providers: [{ slug: 'fireworks', name: 'Fireworks', models: ['fixture-model'] }] }
      }

      if (path.startsWith('/api/model/recommended-default')) {
        return { provider: 'fireworks', model: 'fixture-model' }
      }

      if (path === '/api/model/set') {
        throw new Error('model write failed with api_key=private-api-key')
      }

      throw new Error(`unexpected api path: ${path}`)
    })
    const gateway = vi.fn(async () => ({})) as OnboardingContext['requestGateway']

    const result = await saveOnboardingApiKey('FIREWORKS_API_KEY', 'private-api-key', 'Fireworks', onboardingContext(gateway))

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Saved the key, but could not finish model setup')
    expect(JSON.stringify(result)).not.toContain('private-api-key')
    expect($desktopOnboarding.get().configured).not.toBe(true)
  })
})

describe('saveOnboardingLocalEndpoint', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
  })

  afterEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
    vi.restoreAllMocks()
  })

  function readyGateway(): OnboardingContext['requestGateway'] {
    return async method => {
      if (method === 'reload.env') {
        return {} as never
      }

      if (method === 'setup.status') {
        return { provider_configured: true } as never
      }

      if (method === 'setup.runtime_check') {
        return { ok: true } as never
      }

      throw new Error(`unexpected gateway method: ${method}`)
    }
  }

  it('errors when the endpoint advertises no models (nothing to route to)', async () => {
    const calls: string[] = []
    installApiMock(async ({ path }: { path: string }) => {
      calls.push(path)

      if (path === '/api/providers/validate') {
        return { ok: true, reachable: true, message: '', models: [] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const result = await saveOnboardingLocalEndpoint('http://127.0.0.1:8000/v1', '', {
      requestGateway: readyGateway()
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('no models')
    // Must not attempt to persist an assignment without a model.
    expect(calls).not.toContain('/api/model/set')
  })

  it('does not echo a credential-bearing URL or probe diagnostic into the form', async () => {
    installApiMock(async ({ path }: { path: string }) => {
      if (path === '/api/providers/validate') {
        return { ok: false, reachable: false, message: 'token=private-probe-secret for user@example.com' }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const result = await saveOnboardingLocalEndpoint('https://user:private-url-secret@example.test/v1?key=hidden', '', {
      requestGateway: readyGateway()
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Check its URL')
    expect(JSON.stringify(result)).not.toContain('private-probe-secret')
    expect(JSON.stringify(result)).not.toContain('private-url-secret')
    expect(JSON.stringify(result)).not.toContain('user@example.com')
  })

  it('does not echo model-assignment transport diagnostics into the form', async () => {
    installApiMock(async ({ path }: { path: string }) => {
      if (path === '/api/providers/validate') {
        return { ok: true, reachable: true, models: ['fixture-model'] }
      }

      if (path === '/api/model/set') {
        throw new Error('backend refused api_key=private-assignment-secret')
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const result = await saveOnboardingLocalEndpoint('http://127.0.0.1:8000/v1', 'private-assignment-secret', {
      requestGateway: readyGateway()
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Could not save the endpoint')
    expect(JSON.stringify(result)).not.toContain('private-assignment-secret')
  })

  it('auto-discovers the model and persists provider=custom + base_url, then finishes', async () => {
    const calls: { body?: unknown; path: string }[] = []

    const api = vi.fn(async ({ body, path }: { body?: unknown; path: string }) => {
      calls.push({ body, path })

      if (path === '/api/providers/validate') {
        return { ok: true, reachable: true, message: '', models: ['llama-3.1-8b', 'qwen2.5-7b'] }
      }

      if (path === '/api/model/set') {
        return { ok: true, provider: 'custom', model: 'llama-3.1-8b', base_url: 'http://127.0.0.1:8000/v1' }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    const onCompleted = vi.fn()

    const result = await saveOnboardingLocalEndpoint('http://127.0.0.1:8000/v1', '', {
      onCompleted,
      requestGateway: readyGateway()
    })

    expect(result.ok).toBe(true)

    const assign = calls.find(c => c.path === '/api/model/set')
    expect(assign?.body).toMatchObject({
      scope: 'main',
      provider: 'custom',
      model: 'llama-3.1-8b',
      base_url: 'http://127.0.0.1:8000/v1'
    })

    expect(onCompleted).toHaveBeenCalledTimes(1)
    expect($desktopOnboarding.get().configured).toBe(true)
  })

  it('forwards the API key to the probe and persists it for auth-gated endpoints', async () => {
    const calls: { body?: unknown; path: string }[] = []

    const api = vi.fn(async ({ body, path }: { body?: unknown; path: string }) => {
      calls.push({ body, path })

      if (path === '/api/providers/validate') {
        return { ok: true, reachable: true, message: '', models: ['gpt-oss-120b'] }
      }

      if (path === '/api/model/set') {
        return { ok: true, provider: 'custom', model: 'gpt-oss-120b', base_url: 'https://text.example.com/v1' }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)

    const result = await saveOnboardingLocalEndpoint('https://text.example.com/v1', 'sk-secret', {
      requestGateway: readyGateway()
    })

    expect(result.ok).toBe(true)

    // The probe must receive the key so an auth-gated /v1/models enumerates.
    const probe = calls.find(c => c.path === '/api/providers/validate')
    expect(probe?.body).toMatchObject({
      key: 'OPENAI_BASE_URL',
      value: 'https://text.example.com/v1',
      api_key: 'sk-secret'
    })

    // And the key must be persisted alongside the endpoint for runtime auth.
    const assign = calls.find(c => c.path === '/api/model/set')
    expect(assign?.body).toMatchObject({
      scope: 'main',
      provider: 'custom',
      model: 'gpt-oss-120b',
      base_url: 'https://text.example.com/v1',
      api_key: 'sk-secret'
    })
  })

  it('persists the resolved_base_url that served /models, not the URL as typed (#65488)', async () => {
    const calls: { body?: unknown; path: string }[] = []

    const api = vi.fn(async ({ body, path }: { body?: unknown; path: string }) => {
      calls.push({ body, path })

      if (path === '/api/providers/validate') {
        // The probe fell through from the bare host root to its /v1 variant.
        return {
          ok: true,
          reachable: true,
          message: '',
          models: ['llama-3.1-8b'],
          resolved_base_url: 'http://127.0.0.1:1234/v1'
        }
      }

      if (path === '/api/model/set') {
        return { ok: true, provider: 'custom', model: 'llama-3.1-8b', base_url: 'http://127.0.0.1:1234/v1' }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)

    const result = await saveOnboardingLocalEndpoint('http://127.0.0.1:1234', '', {
      requestGateway: readyGateway()
    })

    expect(result.ok).toBe(true)

    // The runtime POSTs {base_url}/chat/completions verbatim, so Save must store
    // the base that actually answered /models rather than the typed host root.
    const assign = calls.find(c => c.path === '/api/model/set')
    expect(assign?.body).toMatchObject({
      scope: 'main',
      provider: 'custom',
      model: 'llama-3.1-8b',
      base_url: 'http://127.0.0.1:1234/v1'
    })
  })

  it('reports the runtime reason when resolution still fails after saving', async () => {
    installApiMock(async ({ path }: { path: string }) => {
      if (path === '/api/providers/validate') {
        return { ok: true, reachable: true, message: '', models: ['llama-3.1-8b'] }
      }

      if (path === '/api/model/set') {
        return { ok: true }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const failingGateway: OnboardingContext['requestGateway'] = async method => {
      if (method === 'reload.env') {
        return {} as never
      }

      if (method === 'setup.status') {
        return { provider_configured: false } as never
      }

      if (method === 'setup.runtime_check') {
        return { ok: false, error: 'No provider can serve the selected model. api_key=private-runtime-secret' } as never
      }

      throw new Error(`unexpected gateway method: ${method}`)
    }

    const result = await saveOnboardingLocalEndpoint('http://127.0.0.1:8000/v1', '', {
      requestGateway: failingGateway
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('could not use the selected model')
    expect(JSON.stringify(result)).not.toContain('private-runtime-secret')
    expect($desktopOnboarding.get().configured).not.toBe(true)
  })
})

describe('device-code poll expiry', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
  })

  afterEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function deviceCodeProvider() {
    // makeOAuthProvider builds a pkce provider; device-code flows need the
    // device_code branch instead.
    return { ...makeOAuthProvider('nous', 'Nous Portal'), flow: 'device_code' as const }
  }

  function deviceStart(expiresIn: number) {
    return {
      expires_in: expiresIn,
      flow: 'device_code',
      poll_interval: 5,
      session_id: 'device-sess-1',
      user_code: 'ABCD-EFGH',
      verification_url: 'https://portal.example/device'
    }
  }

  it('lapses to an error with actionable guidance when the window expires still pending', async () => {
    vi.useFakeTimers()
    installApiMock(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth/nous/start') {
        return deviceStart(2)
      }

      if (path === '/api/providers/oauth/nous/poll/device-sess-1') {
        return { status: 'pending' }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const { startProviderOAuth } = await import('./onboarding')
    await startProviderOAuth(deviceCodeProvider(), onboardingContext(emptyOpenRouterGateway()))

    expect($desktopOnboarding.get().flow.status).toBe('polling')

    // Let both the poll interval and the expiry window lapse.
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    const flow = $desktopOnboarding.get().flow
    expect(flow.status).toBe('error')

    if (flow.status === 'error') {
      expect(flow.message).toMatch(/timed out before you finished/)
      expect(flow.message).not.toMatch(/server-side|CLI/)
    }
  })

  it('keeps polling while the window is open and clears the expiry on cancel', async () => {
    vi.useFakeTimers()
    installApiMock(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth/nous/start') {
        return deviceStart(600)
      }

      if (path === '/api/providers/oauth/nous/poll/device-sess-1') {
        return { status: 'pending' }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const { startProviderOAuth, cancelOnboardingFlow } = await import('./onboarding')
    await startProviderOAuth(deviceCodeProvider(), onboardingContext(emptyOpenRouterGateway()))

    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect($desktopOnboarding.get().flow.status).toBe('polling')

    cancelOnboardingFlow()
    // Far past the original window: the cancelled flow must not flip to an
    // expiry error after the fact.
    await act(async () => {
      vi.advanceTimersByTime(700_000)
    })
    expect($desktopOnboarding.get().flow.status).toBe('idle')
  })
})

// The happy path (cross-provider pick reaches /api/model/set with the picked
// model's provider) is covered from the ConfirmingModelPanel in
// components/onboarding/flow.test.tsx so it exercises the onSelect wiring.
describe('setOnboardingModel', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
  })

  afterEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
    vi.restoreAllMocks()
  })

  function confirmingModelState(overrides: Partial<Extract<DesktopOnboardingState['flow'], { status: 'confirming_model' }>> = {}) {
    return baseState({
      flow: {
        status: 'confirming_model',
        currentModel: 'gpt-5.6-terra',
        label: 'OpenAI OAuth (ChatGPT)',
        providerSlug: 'openai',
        saving: false,
        ...overrides
      }
    })
  }

  it('reverts the model, provider and label when persistence fails', async () => {
    const notification = vi.spyOn(notifications, 'notifyError').mockReturnValue('')
    installApiMock(async () => {
      throw new Error('backend down with token=synthetic-secret')
    })
    $desktopOnboarding.set(confirmingModelState())

    await setOnboardingModel('deepseek/deepseek-v4-flash-0731', 'nous', 'Nous Portal')

    const flow = $desktopOnboarding.get().flow
    expect(flow.status).toBe('confirming_model')

    if (flow.status === 'confirming_model') {
      expect(flow.currentModel).toBe('gpt-5.6-terra')
      expect(flow.providerSlug).toBe('openai')
      expect(flow.label).toBe('OpenAI OAuth (ChatGPT)')
      expect(flow.saving).toBe(false)
    }

    expect(notification).toHaveBeenCalledWith(new Error('Check the provider and try again.'), 'Could not change model')
    expect(JSON.stringify(notification.mock.calls)).not.toContain('synthetic-secret')
  })

  it('clears an unpersisted model guard only after a safe replacement saves', async () => {
    installApiMock(async ({ path }: { path: string }) => {
      if (path === '/api/model/set') {
        return { ok: true, provider: 'nous', model: 'deepseek/deepseek-v4-flash-0731' }
      }

      throw new Error(`unexpected api path: ${path}`)
    })
    $desktopOnboarding.set(confirmingModelState({ requiresConfirmation: true }))

    await setOnboardingModel('deepseek/deepseek-v4-flash-0731', 'nous', 'Nous Portal')

    expect($desktopOnboarding.get().flow).toMatchObject({
      status: 'confirming_model',
      currentModel: 'deepseek/deepseek-v4-flash-0731',
      providerSlug: 'nous',
      requiresConfirmation: false,
      saving: false
    })
  })
})
