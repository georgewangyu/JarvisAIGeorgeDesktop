import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { DESKTOP_PROFILE_NAME_RE } from './desktop-profile'
import type { WindowConnectionRoute } from './window-connection-route'

export type CalendarAuthorization = 'notDetermined' | 'restricted' | 'denied' | 'writeOnly' | 'fullAccess' | 'unknown'

interface CalendarStatus {
  authorization: CalendarAuthorization
  connected: boolean
  supported: boolean
}

interface CalendarError {
  code: string
  ok: false
}

interface CalendarSuccess {
  [key: string]: unknown
  command: string
  ok: true
}

type CalendarResponse = CalendarError | CalendarSuccess

const MAX_RESPONSE_BYTES = 256 * 1024
const CONFIG_PREFIX = 'jarvis-calendar-connection-'

const AUTHORIZATIONS = new Set<CalendarAuthorization>([
  'notDetermined', 'restricted', 'denied', 'writeOnly', 'fullAccess', 'unknown'
])

export function calendarHelperPath(appPath: string): string {
  return path.resolve(appPath, 'dist/native/jarvis-calendar-helper').replace(/\.asar(?=[/\\])/g, '.asar.unpacked')
}

export function calendarConnectionScope(
  route: WindowConnectionRoute | null,
  primaryProfile: string,
  isPrimaryWindow: boolean
): string | null {
  if (route) {
    return route.profile && DESKTOP_PROFILE_NAME_RE.test(route.profile)
      ? JSON.stringify([route.connectionId, route.profile])
      : null
  }

  return isPrimaryWindow && DESKTOP_PROFILE_NAME_RE.test(primaryProfile)
    ? JSON.stringify([null, primaryProfile])
    : null
}

export function calendarRendererMatches(event: IpcMainInvokeEvent, rendererUrl: string): boolean {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    return false
  }

  try {
    const expected = new URL(rendererUrl)
    const actual = new URL(event.senderFrame.url)

    return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname
  } catch {
    return false
  }
}

function enabled(configPath: string): boolean {
  try {
    const data = fs.readFileSync(configPath)

    return data.length <= 1024 && JSON.parse(data.toString('utf8'))?.enabled === true
  } catch {
    return false
  }
}

function configForScope(userData: string, scope: string): string {
  const hash = createHash('sha256').update(scope).digest('hex')

  return path.join(userData, `${CONFIG_PREFIX}${hash}.json`)
}

function saveEnabled(configPath: string, value: boolean): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const staging = `${configPath}.${process.pid}.tmp`

  try {
    fs.writeFileSync(staging, JSON.stringify({ enabled: value }), { mode: 0o600 })
    fs.renameSync(staging, configPath)
  } finally {
    fs.rmSync(staging, { force: true })
  }
}

function validResponse(value: unknown): value is CalendarResponse {
  if (!value || typeof value !== 'object') {return false}
  const response = value as Record<string, unknown>

  return response.ok === true && typeof response.command === 'string'
    || response.ok === false && typeof response.code === 'string'
}

export function runCalendarHelper(executable: string, input: Record<string, unknown>): Promise<CalendarResponse> {
  return new Promise(resolve => {
    let finished = false
    let output = ''
    let child: ReturnType<typeof spawn>

    const finish = (response: CalendarResponse) => {
      if (finished) {return}
      finished = true
      clearTimeout(timer)
      resolve(response)
    }

    try {
      child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true })
    } catch {
      resolve({ ok: false, code: 'unavailable' })

      return
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, code: 'timed_out' })
    }, input.command === 'request-full-access' ? 120_000 : 15_000)

    timer.unref()

    child.stdout.on('data', chunk => {
      output += chunk.toString()

      if (Buffer.byteLength(output) > MAX_RESPONSE_BYTES) {
        child.kill('SIGKILL')
        finish({ ok: false, code: 'response_too_large' })
      }
    })
    child.on('error', () => finish({ ok: false, code: 'unavailable' }))
    child.on('close', code => {
      if (finished) {return}

      if (code !== 0) {
        finish({ ok: false, code: 'unavailable' })

        return
      }

      try {
        const response: unknown = JSON.parse(output)
        finish(validResponse(response) ? response : { ok: false, code: 'invalid_response' })
      } catch {
        finish({ ok: false, code: 'invalid_response' })
      }
    })
    child.stdin.on('error', () => finish({ ok: false, code: 'unavailable' }))
    child.stdin.end(JSON.stringify(input))
  })
}

interface CalendarBridgeDeps {
  appPath: string
  ipcMain: IpcMain
  platform?: NodeJS.Platform
  run?: typeof runCalendarHelper
  scopeForSender: (event: IpcMainInvokeEvent) => string | null
  ownerVersionForSender?: (event: IpcMainInvokeEvent) => number
  trustedSender: (event: IpcMainInvokeEvent) => boolean
  userData: string
}

export function registerJarvisCalendar({ appPath, ipcMain, platform = process.platform, run = runCalendarHelper, scopeForSender, ownerVersionForSender = () => 0, trustedSender, userData }: CalendarBridgeDeps): void {
  const helper = calendarHelperPath(appPath)
  const pendingConnects = new Map<string, Set<{ cancelled: boolean }>>()

  const call = (input: Record<string, unknown>) => platform === 'darwin'
    ? run(helper, input)
    : Promise.resolve<CalendarResponse>({ ok: false, code: 'unavailable' })

  const status = async (configPath: string): Promise<CalendarStatus> => {
    const response = await call({ command: 'status' })
    const raw = response.ok ? response.authorization : undefined

    const authorization = typeof raw === 'string' && AUTHORIZATIONS.has(raw as CalendarAuthorization)
      ? raw as CalendarAuthorization
      : 'unknown'

    // An observed OS revocation ends the app grant too. A later macOS regrant
    // must still require the user's explicit Connect action.
    if (enabled(configPath) && authorization !== 'fullAccess' && authorization !== 'unknown') {
      saveEnabled(configPath, false)
    }

    // A helper response without a recognized macOS authorization is not proof
    // that Calendar access can be requested or used. Preserve the app opt-in so
    // a transient unknown result does not silently revoke the user's choice.
    return {
      authorization,
      connected: enabled(configPath) && authorization === 'fullAccess',
      supported: platform === 'darwin' && response.ok && authorization !== 'unknown'
    }
  }

  const requireTrustedScope = (event: IpcMainInvokeEvent): string | null => {
    if (!trustedSender(event)) {
      throw new Error('Untrusted Calendar renderer')
    }

    const scope = scopeForSender(event)

    return typeof scope === 'string' && scope.length > 0 && scope.length <= 256 ? scope : null
  }

  const sameOwner = (event: IpcMainInvokeEvent, scope: string, version: number) =>
    scopeForSender(event) === scope && ownerVersionForSender(event) === version

  ipcMain.handle('jarvis:calendar:status', async event => {
    const scope = requireTrustedScope(event)
    const version = ownerVersionForSender(event)

    if (!scope) {return { authorization: 'unknown', connected: false, supported: false }}

    const result = await status(configForScope(userData, scope))

    return sameOwner(event, scope, version) ? result : { authorization: 'unknown', connected: false, supported: false }
  })
  ipcMain.handle('jarvis:calendar:connect', async (event): Promise<CalendarStatus> => {
    const scope = requireTrustedScope(event)
    const version = ownerVersionForSender(event)

    if (!scope) {return { authorization: 'unknown', connected: false, supported: false }}

    const configPath = configForScope(userData, scope)
    const attempt = { cancelled: false }
    const pending = pendingConnects.get(configPath) ?? new Set<{ cancelled: boolean }>()
    pending.add(attempt)
    pendingConnects.set(configPath, pending)

    try {
      const before = await status(configPath)

      if (attempt.cancelled || !sameOwner(event, scope, version)) {return { authorization: 'unknown', connected: false, supported: false }}

      if (!before.supported) {return before}

      if (before.authorization !== 'fullAccess') {
        const request = await call({ command: 'request-full-access' })

        if (!request.ok || request.authorization !== 'fullAccess') {
          return !attempt.cancelled && sameOwner(event, scope, version)
            ? status(configPath)
            : { authorization: 'unknown', connected: false, supported: false }
        }
      }

      if (attempt.cancelled || !sameOwner(event, scope, version)) {return { authorization: 'unknown', connected: false, supported: false }}

      saveEnabled(configPath, true)

      const result = await status(configPath)

      return !attempt.cancelled && sameOwner(event, scope, version)
        ? result
        : { authorization: 'unknown', connected: false, supported: false }
    } finally {
      pending.delete(attempt)

      if (pending.size === 0) {pendingConnects.delete(configPath)}
    }
  })
  ipcMain.handle('jarvis:calendar:disconnect', async (event): Promise<CalendarStatus> => {
    const scope = requireTrustedScope(event)
    const version = ownerVersionForSender(event)

    if (!scope) {return { authorization: 'unknown', connected: false, supported: false }}

    const configPath = configForScope(userData, scope)

    for (const attempt of pendingConnects.get(configPath) ?? []) {attempt.cancelled = true}
    saveEnabled(configPath, false)

    const result = await status(configPath)

    return sameOwner(event, scope, version)
      ? result
      : { authorization: 'unknown', connected: false, supported: false }
  })
  ipcMain.handle('jarvis:calendar:list', async (event, start: unknown, end: unknown) => {
    const scope = requireTrustedScope(event)
    const version = ownerVersionForSender(event)
    const configPath = scope ? configForScope(userData, scope) : ''

    if (!scope || !(await status(configPath)).connected || !sameOwner(event, scope, version)) {
      return { ok: false, code: 'not_connected' }
    }

    if (typeof start !== 'string' || typeof end !== 'string') {return { ok: false, code: 'invalid_input' }}

    const result = await call({ command: 'list-events', start, end, limit: 100 })

    if (!sameOwner(event, scope, version)) {return { ok: false, code: 'scope_changed' }}

    if (!(await status(configPath)).connected) {return { ok: false, code: 'not_connected' }}

    return sameOwner(event, scope, version) ? result : { ok: false, code: 'scope_changed' }
  })
  ipcMain.handle('jarvis:calendar:create', async (event, title: unknown, start: unknown, end: unknown) => {
    const scope = requireTrustedScope(event)
    const version = ownerVersionForSender(event)
    const configPath = scope ? configForScope(userData, scope) : ''

    if (!scope || !(await status(configPath)).connected || !sameOwner(event, scope, version)) {
      return { ok: false, code: 'not_connected' }
    }

    if (typeof title !== 'string' || typeof start !== 'string' || typeof end !== 'string') {
      return { ok: false, code: 'invalid_input' }
    }

    const result = await call({ command: 'create-event', title, start, end })

    // The helper may already have created the event. Suppress the old owner's
    // details in this renderer, but never claim it definitely did not happen.
    if (!sameOwner(event, scope, version)) {return { ok: false, code: 'outcome_unknown' }}

    if (!(await status(configPath)).connected) {return { ok: false, code: 'outcome_unknown' }}

    return sameOwner(event, scope, version) ? result : { ok: false, code: 'outcome_unknown' }
  })
}
