import type { IpcMain } from 'electron'
import { expect, it, vi } from 'vitest'

import { registerJarvisOnboardingPermissions } from './jarvis-onboarding-permissions'

it.runIf(process.platform === 'darwin')('recovers a denied microphone through settings rather than a dead prompt', async () => {
  const handlers = new Map<string, () => Promise<unknown>>()
  const openExternal = vi.fn().mockResolvedValue(undefined)
  const askForMediaAccess = vi.fn().mockResolvedValue(false)
  registerJarvisOnboardingPermissions({
    ipcMain: { handle: (name: string, fn: () => Promise<unknown>) => handlers.set(name, fn) } as unknown as IpcMain,
    shell: { openExternal },
    systemPreferences: { getMediaAccessStatus: () => 'denied', askForMediaAccess }
  })
  expect(await handlers.get('jarvis:onboarding-permissions:request-microphone')?.()).toBe(false)
  expect(askForMediaAccess).not.toHaveBeenCalled()
  expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('Privacy_Microphone'))
})
