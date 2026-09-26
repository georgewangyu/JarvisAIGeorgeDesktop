import fs from 'node:fs'

import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { expect, it, vi } from 'vitest'

import { calendarRendererMatches } from './jarvis-calendar'
import { detectFullDiskAccess, registerJarvisOnboardingPermissions } from './jarvis-onboarding-permissions'

it.runIf(process.platform === 'darwin')('does not label a Messages database read error as Full Disk Access denial', () => {
  const access = vi.spyOn(fs, 'accessSync').mockImplementation(() => {
    throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
  })

  try {
    expect(detectFullDiskAccess()).toBe('unknown')
  } finally {
    access.mockRestore()
  }
})

it.runIf(process.platform === 'darwin')('recovers a denied microphone through settings rather than a dead prompt', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => Promise<unknown>>()
  const openExternal = vi.fn().mockResolvedValue(undefined)
  const askForMediaAccess = vi.fn().mockResolvedValue(false)
  registerJarvisOnboardingPermissions({
    ipcMain: { handle: (name: string, fn: (event: IpcMainInvokeEvent) => Promise<unknown>) => handlers.set(name, fn) } as unknown as IpcMain,
    shell: { openExternal },
    systemPreferences: { getMediaAccessStatus: () => 'denied', askForMediaAccess },
    trustedSender: () => true
  })
  expect(await handlers.get('jarvis:onboarding-permissions:request-microphone')?.({} as IpcMainInvokeEvent)).toBe(false)
  expect(askForMediaAccess).not.toHaveBeenCalled()
  expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('Privacy_Microphone'))
})

it('refuses foreign and nested frames before inspecting or requesting Mac permissions', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>()
  const openExternal = vi.fn().mockResolvedValue(undefined)
  const getMediaAccessStatus = vi.fn().mockReturnValue('not-determined')
  const askForMediaAccess = vi.fn().mockResolvedValue(false)
  const rendererUrl = 'file:///tmp/Jarvis.app/Contents/Resources/app.asar.unpacked/dist/index.html'

  registerJarvisOnboardingPermissions({
    ipcMain: { handle: (name: string, fn: (event: IpcMainInvokeEvent) => unknown) => handlers.set(name, fn) } as unknown as IpcMain,
    shell: { openExternal },
    systemPreferences: { getMediaAccessStatus, askForMediaAccess },
    trustedSender: event => calendarRendererMatches(event, rendererUrl)
  })

  const mainFrame = { url: rendererUrl }
  const sender = { mainFrame }

  const events = [
    { sender, senderFrame: { url: 'https://example.org/' } },
    { sender, senderFrame: { url: rendererUrl } }
  ] as unknown as IpcMainInvokeEvent[]

  for (const event of events) {
    for (const channel of ['get', 'open-full-disk-access', 'request-microphone']) {
      await expect(Promise.resolve().then(() => handlers.get(`jarvis:onboarding-permissions:${channel}`)?.(event)))
        .rejects.toThrow('Untrusted Jarvis permissions renderer')
    }
  }

  expect(getMediaAccessStatus).not.toHaveBeenCalled()
  expect(askForMediaAccess).not.toHaveBeenCalled()
  expect(openExternal).not.toHaveBeenCalled()
})
