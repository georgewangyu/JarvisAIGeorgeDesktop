import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { IpcMain, IpcMainInvokeEvent, Shell, SystemPreferences } from 'electron'

export type JarvisPermissionStatus = 'denied' | 'granted' | 'not-determined' | 'restricted' | 'unknown'

export interface JarvisOnboardingPermissionSnapshot {
  apps: Record<'mail' | 'messages' | 'notes' | 'whatsapp', boolean>
  fullDiskAccess: JarvisPermissionStatus
  microphone: JarvisPermissionStatus
  platform: NodeJS.Platform
}

interface JarvisOnboardingPermissionDeps {
  ipcMain: IpcMain
  shell: Pick<Shell, 'openExternal'>
  systemPreferences: Pick<SystemPreferences, 'askForMediaAccess' | 'getMediaAccessStatus'>
  trustedSender: (event: IpcMainInvokeEvent) => boolean
}

const MAC_APPS = {
  mail: ['/System/Applications/Mail.app', '/Applications/Mail.app'],
  messages: ['/System/Applications/Messages.app', '/Applications/Messages.app'],
  notes: ['/System/Applications/Notes.app', '/Applications/Notes.app'],
  whatsapp: ['/Applications/WhatsApp.app', path.join(os.homedir(), 'Applications', 'WhatsApp.app')]
} as const

function installed(candidates: readonly string[]): boolean {
  return candidates.some(candidate => fs.existsSync(candidate))
}

/**
 * macOS has no public "Full Disk Access status" API. Reading Messages' database
 * is a deliberately narrow capability probe: success proves the access Jarvis
 * needs for the onboarding examples; failure stays unknown instead of claiming
 * the user denied a permission that may simply have no database yet.
 */
export function detectFullDiskAccess(): JarvisPermissionStatus {
  if (process.platform !== 'darwin') {
    return 'unknown'
  }

  const probe = path.join(os.homedir(), 'Library', 'Messages', 'chat.db')

  try {
    fs.accessSync(probe, fs.constants.R_OK)

    return 'granted'
  } catch {
    // A failed read can also be a filesystem/ACL restriction. macOS does not
    // expose enough information here to claim Full Disk Access was denied.
    return 'unknown'
  }
}

function permissionSnapshot(
  systemPreferences: JarvisOnboardingPermissionDeps['systemPreferences']
): JarvisOnboardingPermissionSnapshot {
  let microphone: JarvisPermissionStatus = 'unknown'

  if (process.platform === 'darwin' && typeof systemPreferences.getMediaAccessStatus === 'function') {
    try {
      microphone = systemPreferences.getMediaAccessStatus('microphone')
    } catch {
      // A native status failure is not a denial and must not block the other
      // onboarding permissions from rendering.
    }
  }

  return {
    apps: {
      mail: installed(MAC_APPS.mail),
      messages: installed(MAC_APPS.messages),
      notes: installed(MAC_APPS.notes),
      whatsapp: installed(MAC_APPS.whatsapp)
    },
    fullDiskAccess: detectFullDiskAccess(),
    microphone,
    platform: process.platform
  }
}

export function registerJarvisOnboardingPermissions({
  ipcMain,
  shell,
  systemPreferences,
  trustedSender
}: JarvisOnboardingPermissionDeps): void {
  const requireTrustedSender = (event: IpcMainInvokeEvent) => {
    if (!trustedSender(event)) {throw new Error('Untrusted Jarvis permissions renderer')}
  }

  ipcMain.handle('jarvis:onboarding-permissions:get', event => {
    requireTrustedSender(event)

    return permissionSnapshot(systemPreferences)
  })

  ipcMain.handle('jarvis:onboarding-permissions:open-full-disk-access', async event => {
    requireTrustedSender(event)

    if (process.platform !== 'darwin') {
      return false
    }

    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')

    return true
  })

  ipcMain.handle('jarvis:onboarding-permissions:request-microphone', async event => {
    requireTrustedSender(event)

    if (process.platform !== 'darwin' || typeof systemPreferences.askForMediaAccess !== 'function') {
      return false
    }

    // macOS will not show the prompt again after denial. Give the user a
    // recovery path instead of repeatedly invoking a prompt that cannot open.
    const status = systemPreferences.getMediaAccessStatus('microphone')

    if (status === 'denied' || status === 'restricted') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')

      return false
    }

    return systemPreferences.askForMediaAccess('microphone')
  })
}
