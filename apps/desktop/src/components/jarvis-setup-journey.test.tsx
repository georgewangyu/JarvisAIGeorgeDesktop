// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { JarvisOnboardingPermissionSnapshot } from '@/global'

import { JarvisSetupJourney } from './jarvis-setup-journey'

function permissionSnapshot(microphone: JarvisOnboardingPermissionSnapshot['microphone']): JarvisOnboardingPermissionSnapshot {
  return {
    apps: { mail: false, messages: false, notes: false, whatsapp: false },
    fullDiskAccess: 'denied',
    microphone,
    platform: 'darwin'
  }
}

async function reachMicrophoneStep() {
  fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue without access' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue with 0 detected apps' }))
  await screen.findByRole('heading', { name: 'Enable voice input?' })
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('Jarvis microphone onboarding recovery', () => {
  it('offers settings after denial and updates when permission is granted', async () => {
    let microphone: JarvisOnboardingPermissionSnapshot['microphone'] = 'denied'

    const requestMicrophone = vi.fn().mockImplementation(async () => {
      microphone = 'granted'

      return true
    })

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        jarvisOnboarding: {
          getPermissions: vi.fn().mockImplementation(async () => permissionSnapshot(microphone)),
          requestMicrophone
        }
      }
    })

    render(
      <JarvisSetupJourney
        bootstrapComplete={false}
        bootstrapError={null}
        onBeginSetup={vi.fn().mockResolvedValue(undefined)}
        onConnectOther={vi.fn()}
        onFinish={vi.fn().mockResolvedValue(undefined)}
        onShowInstallDetails={vi.fn()}
      />
    )

    await reachMicrophoneStep()
    expect(await screen.findByText('Access was denied. You can change it in System Settings.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))

    await waitFor(() => expect(requestMicrophone).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Allowed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
  })

  it('does not promise a permission prompt when access is restricted', async () => {
    const requestMicrophone = vi.fn()

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        jarvisOnboarding: {
          getPermissions: vi.fn().mockResolvedValue(permissionSnapshot('restricted')),
          requestMicrophone
        }
      }
    })

    render(
      <JarvisSetupJourney
        bootstrapComplete={false}
        bootstrapError={null}
        onBeginSetup={vi.fn().mockResolvedValue(undefined)}
        onConnectOther={vi.fn()}
        onFinish={vi.fn().mockResolvedValue(undefined)}
        onShowInstallDetails={vi.fn()}
      />
    )

    await reachMicrophoneStep()
    expect(await screen.findByText('Microphone access is restricted on this Mac.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(await screen.findByRole('heading', { name: 'Preparing Jarvis' })).toBeTruthy()
    expect(requestMicrophone).not.toHaveBeenCalled()
  })
})
