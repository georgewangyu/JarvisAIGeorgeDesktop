import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

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
const CONFIG_FILE = 'jarvis-calendar-connection.json'

const AUTHORIZATIONS = new Set<CalendarAuthorization>([
  'notDetermined', 'restricted', 'denied', 'writeOnly', 'fullAccess', 'unknown'
])

export function calendarHelperPath(appPath: string): string {
  return path.resolve(appPath, 'dist/native/jarvis-calendar-helper').replace(/\.asar(?=[/\\])/g, '.asar.unpacked')
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
  trustedSender: (event: IpcMainInvokeEvent) => boolean
  userData: string
}

export function registerJarvisCalendar({ appPath, ipcMain, platform = process.platform, run = runCalendarHelper, trustedSender, userData }: CalendarBridgeDeps): void {
  const configPath = path.join(userData, CONFIG_FILE)
  const helper = calendarHelperPath(appPath)

  const call = (input: Record<string, unknown>) => platform === 'darwin'
    ? run(helper, input)
    : Promise.resolve<CalendarResponse>({ ok: false, code: 'unavailable' })

  const status = async (): Promise<CalendarStatus> => {
    const response = await call({ command: 'status' })
    const raw = response.ok ? response.authorization : undefined

    const authorization = typeof raw === 'string' && AUTHORIZATIONS.has(raw as CalendarAuthorization)
      ? raw as CalendarAuthorization
      : 'unknown'

    return { authorization, connected: enabled(configPath) && authorization === 'fullAccess', supported: platform === 'darwin' && response.ok }
  }

  const requireTrusted = (event: IpcMainInvokeEvent) => {
    if (!trustedSender(event)) {
      throw new Error('Untrusted Calendar renderer')
    }
  }

  ipcMain.handle('jarvis:calendar:status', async event => {
    requireTrusted(event)

    return status()
  })
  ipcMain.handle('jarvis:calendar:connect', async (event): Promise<CalendarStatus> => {
    requireTrusted(event)
    const before = await status()

    if (!before.supported) {return before}

    if (before.authorization !== 'fullAccess') {
      const request = await call({ command: 'request-full-access' })

      if (!request.ok || request.authorization !== 'fullAccess') {return status()}
    }

    saveEnabled(configPath, true)

    return status()
  })
  ipcMain.handle('jarvis:calendar:disconnect', async (event): Promise<CalendarStatus> => {
    requireTrusted(event)
    saveEnabled(configPath, false)

    return status()
  })
  ipcMain.handle('jarvis:calendar:list', async (event, start: unknown, end: unknown) => {
    requireTrusted(event)

    if (!(await status()).connected) {return { ok: false, code: 'not_connected' }}

    if (typeof start !== 'string' || typeof end !== 'string') {return { ok: false, code: 'invalid_input' }}

    return call({ command: 'list-events', start, end, limit: 100 })
  })
  ipcMain.handle('jarvis:calendar:create', async (event, title: unknown, start: unknown, end: unknown) => {
    requireTrusted(event)

    if (!(await status()).connected) {return { ok: false, code: 'not_connected' }}

    if (typeof title !== 'string' || typeof start !== 'string' || typeof end !== 'string') {
      return { ok: false, code: 'invalid_input' }
    }

    return call({ command: 'create-event', title, start, end })
  })
}
