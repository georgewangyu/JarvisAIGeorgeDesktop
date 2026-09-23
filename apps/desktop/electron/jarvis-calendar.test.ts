import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { IpcMain } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { runCalendarHelper } from './jarvis-calendar';
import { calendarRendererMatches, registerJarvisCalendar } from './jarvis-calendar'

const roots: string[] = []

function bridge(run: typeof runCalendarHelper, userData: string) {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const ipcMain = { handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, fn) } as unknown as IpcMain

  registerJarvisCalendar({
    appPath: '/tmp/Jarvis.app/Contents/Resources/app.asar',
    ipcMain,
    platform: 'darwin',
    run,
    trustedSender: event => calendarRendererMatches(event, 'file:///tmp/Jarvis.app/Contents/Resources/app.asar.unpacked/dist/index.html'),
    userData
  })

  const frame = { url: 'file:///tmp/Jarvis.app/Contents/Resources/app.asar.unpacked/dist/index.html#/connections' }
  const event = { sender: { mainFrame: frame }, senderFrame: frame }

  return (name: string, ...args: unknown[]) => handlers.get(`jarvis:calendar:${name}`)?.(event, ...args)
}

function testHome() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-calendar-bridge-'))
  roots.push(directory)

  return directory
}

afterEach(() => {
  for (const root of roots.splice(0)) {fs.rmSync(root, { recursive: true, force: true })}
})

describe('Jarvis Calendar connection boundary', () => {
  it('rejects untrusted or nested renderer frames before reading status or changing access', async () => {
    const run = vi.fn()
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
    const ipcMain = { handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, fn) } as unknown as IpcMain

    registerJarvisCalendar({
      appPath: '/tmp/Jarvis.app/Contents/Resources/app.asar',
      ipcMain,
      platform: 'darwin',
      run: run as typeof runCalendarHelper,
      trustedSender: event => calendarRendererMatches(event, 'file:///tmp/Jarvis.app/Contents/Resources/app.asar.unpacked/dist/index.html'),
      userData: testHome()
    })

    const mainFrame = { url: 'file:///tmp/Jarvis.app/Contents/Resources/app.asar.unpacked/dist/index.html' }
    const sender = { mainFrame }
    const foreign = { sender, senderFrame: { url: 'https://example.org/' } }
    const nested = { sender, senderFrame: { url: mainFrame.url } }

    for (const event of [foreign, nested]) {
      for (const channel of ['status', 'connect', 'disconnect', 'list', 'create']) {
        await expect(handlers.get(`jarvis:calendar:${channel}`)?.(event)).rejects.toThrow('Untrusted Calendar renderer')
      }
    }

    expect(run).not.toHaveBeenCalled()
  })
  it('never asks for permission or reads events from a status check', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, command: 'status', authorization: 'notDetermined' })
    const call = bridge(run, testHome())

    expect(await call('status')).toEqual({ authorization: 'notDetermined', connected: false, supported: true })
    expect(await call('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z')).toEqual({ ok: false, code: 'not_connected' })
    expect(await call('create', 'Test', '2026-09-23T00:00:00Z', '2026-09-23T01:00:00Z'))
      .toEqual({ ok: false, code: 'not_connected' })
    expect(run.mock.calls.every(([, input]) => input.command === 'status')).toBe(true)
  })

  it('requires explicit app and OS grants, and disconnect survives bridge restart', async () => {
    const userData = testHome()
    let osGrant = false

    const run = vi.fn(async (_executable, input) => {
      if (input.command === 'request-full-access') {
        osGrant = true

        return { ok: true, command: 'request-full-access', authorization: 'fullAccess' }
      }

      if (input.command === 'status') {
        return { ok: true, command: 'status', authorization: osGrant ? 'fullAccess' : 'notDetermined' }
      }

      return { ok: true, command: input.command, events: [], event: { id: 'synthetic' } }
    }) as typeof runCalendarHelper

    const first = bridge(run, userData)

    expect((await first('connect'))).toMatchObject({ connected: true, authorization: 'fullAccess' })
    expect(await first('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z'))
      .toMatchObject({ ok: true, command: 'list-events' })
    expect(await first('create', 'Synthetic', '2026-09-23T00:00:00Z', '2026-09-23T01:00:00Z'))
      .toMatchObject({ ok: true, command: 'create-event' })
    expect((await first('disconnect'))).toMatchObject({ connected: false, authorization: 'fullAccess' })

    const restarted = bridge(run, userData)
    expect(await restarted('status')).toMatchObject({ connected: false, authorization: 'fullAccess' })
    expect(await restarted('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z'))
      .toEqual({ ok: false, code: 'not_connected' })
  })

  it('refuses reads immediately after macOS authorization is revoked', async () => {
    const userData = testHome()
    let osGrant = true

    const spy = vi.fn(async (_executable, input) => ({
      ok: true,
      command: input.command,
      authorization: osGrant ? 'fullAccess' : 'denied'
    }))

    const run = spy as typeof runCalendarHelper
    const call = bridge(run, userData)

    expect(await call('connect')).toMatchObject({ connected: true })
    osGrant = false
    expect(await call('status')).toMatchObject({ connected: false, authorization: 'denied' })
    expect(await call('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z'))
      .toEqual({ ok: false, code: 'not_connected' })
    expect(spy.mock.calls.some(([, input]) => input.command === 'list-events')).toBe(false)
  })
})
