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
  trustedSender: (event: IpcMainInvokeEvent) => boolean
  userData: string
}

export function registerJarvisCalendar({ appPath, ipcMain, platform = process.platform, run = runCalendarHelper, scopeForSender, trustedSender, userData }: CalendarBridgeDeps): void {
  const helper = calendarHelperPath(appPath)

  const call = (input: Record<string, unknown>) => platform === 'darwin'
    ? run(helper, input)
    : Promise.resolve<CalendarResponse>({ ok: false, code: 'unavailable' })

  const status = async (configPath: string): Promise<CalendarStatus> => {
    const response = await call({ command: 'status' })
    const raw = response.ok ? response.authorization : undefined

    const authorization = typeof raw === 'string' && AUTHORIZATIONS.has(raw as CalendarAuthorization)
      ? raw as CalendarAuthorization
      : 'unknown'

    return { authorization, connected: enabled(configPath) && authorization === 'fullAccess', supported: platform === 'darwin' && response.ok }
  }

  const requireTrustedScope = (event: IpcMainInvokeEvent): string | null => {
    if (!trustedSender(event)) {
      throw new Error('Untrusted Calendar renderer')
    }

    const scope = scopeForSender(event)

    return typeof scope === 'string' && scope.length > 0 && scope.length <= 256 ? scope : null
  }

  ipcMain.handle('jarvis:calendar:status', async event => {
    const scope = requireTrustedScope(event)

    if (!scope) {return { authorization: 'unknown', connected: false, supported: false }}

    const result = await status(configForScope(userData, scope))

    return scopeForSender(event) === scope ? result : { authorization: 'unknown', connected: false, supported: false }
  })
  ipcMain.handle('jarvis:calendar:connect', async (event): Promise<CalendarStatus> => {
    const scope = requireTrustedScope(event)

    if (!scope) {return { authorization: 'unknown', connected: false, supported: false }}

    const configPath = configForScope(userData, scope)
    const before = await status(configPath)

    if (scopeForSender(event) !== scope) {return { authorization: 'unknown', connected: false, supported: false }}

    if (!before.supported) {return before}

    if (before.authorization !== 'fullAccess') {
      const request = await call({ command: 'request-full-access' })

      if (!request.ok || request.authorization !== 'fullAccess') {
        return scopeForSender(event) === scope
          ? status(configPath)
          : { authorization: 'unknown', connected: false, supported: false }
      }
    }

    if (scopeForSender(event) !== scope) {return { authorization: 'unknown', connected: false, supported: false }}

    saveEnabled(configPath, true)

    const result = await status(configPath)

    return scopeForSender(event) === scope ? result : { authorization: 'unknown', connected: false, supported: false }
  })
  ipcMain.handle('jarvis:calendar:disconnect', async (event): Promise<CalendarStatus> => {
    const scope = requireTrustedScope(event)

    if (!scope) {return { authorization: 'unknown', connected: false, supported: false }}

    const configPath = configForScope(userData, scope)
    saveEnabled(configPath, false)

    return status(configPath)
  })
  ipcMain.handle('jarvis:calendar:list', async (event, start: unknown, end: unknown) => {
    const scope = requireTrustedScope(event)

    if (!scope || !(await status(configForScope(userData, scope))).connected || scopeForSender(event) !== scope) {
      return { ok: false, code: 'not_connected' }
    }

    if (typeof start !== 'string' || typeof end !== 'string') {return { ok: false, code: 'invalid_input' }}

    return call({ command: 'list-events', start, end, limit: 100 })
  })
  ipcMain.handle('jarvis:calendar:create', async (event, title: unknown, start: unknown, end: unknown) => {
    const scope = requireTrustedScope(event)

    if (!scope || !(await status(configForScope(userData, scope))).connected || scopeForSender(event) !== scope) {
      return { ok: false, code: 'not_connected' }
    }

    if (typeof title !== 'string' || typeof start !== 'string' || typeof end !== 'string') {
      return { ok: false, code: 'invalid_input' }
    }

    return call({ command: 'create-event', title, start, end })
  })
}
