import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { IpcMain } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { runCalendarHelper } from './jarvis-calendar';
import { calendarConnectionScope, calendarRendererMatches, registerJarvisCalendar } from './jarvis-calendar'

const roots: string[] = []

function bridge(run: typeof runCalendarHelper, userData: string, scopeForSender = () => '[null,"default"]', ownerVersionForSender = () => 0) {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const ipcMain = { handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, fn) } as unknown as IpcMain

  registerJarvisCalendar({
    appPath: '/tmp/Jarvis.app/Contents/Resources/app.asar',
    ipcMain,
    platform: 'darwin',
    run,
    scopeForSender,
    ownerVersionForSender,
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
  it('binds only a valid exact window route, never an unknown peer or invalid profile', () => {
    expect(calendarConnectionScope(null, 'default', true)).toBe('[null,"default"]')
    expect(calendarConnectionScope(null, 'default', false)).toBeNull()
    expect(calendarConnectionScope({ connectionId: 'remote', profile: 'alpha', registryScoped: true }, 'default', true))
      .toBe('["remote","alpha"]')
    expect(calendarConnectionScope({ connectionId: null, profile: '../alpha', registryScoped: false }, 'default', true))
      .toBeNull()
    expect(calendarConnectionScope({ connectionId: null, profile: undefined, registryScoped: false }, 'default', true))
      .toBeNull()
  })

  it('rejects untrusted or nested renderer frames before reading status or changing access', async () => {
    const run = vi.fn()
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
    const ipcMain = { handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, fn) } as unknown as IpcMain

    registerJarvisCalendar({
      appPath: '/tmp/Jarvis.app/Contents/Resources/app.asar',
      ipcMain,
      platform: 'darwin',
      run: run as typeof runCalendarHelper,
      scopeForSender: () => '[null,"default"]',
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

    expect(await call('status')).toEqual({ authorization: 'notDetermined', connected: false, mode: 'off', supported: true })
    expect(await call('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z')).toEqual({ ok: false, code: 'not_connected' })
    expect(await call('create', 'Test', '2026-09-23T00:00:00Z', '2026-09-23T01:00:00Z'))
      .toEqual({ ok: false, code: 'not_connected' })
    expect(run.mock.calls.every(([, input]) => input.command === 'status')).toBe(true)
  })

  it('treats unknown OS authorization as unavailable without erasing a previous app opt-in', async () => {
    const userData = testHome()
    let authorization = 'fullAccess'

    const spy = vi.fn(async (_executable, input) => ({
      ok: true,
      command: input.command,
      authorization
    }))

    const call = bridge(spy as typeof runCalendarHelper, userData)

    expect(await call('connect')).toMatchObject({ connected: true, supported: true })
    authorization = 'unexpected-status'
    expect(await call('status')).toEqual({ authorization: 'unknown', connected: false, mode: 'read', supported: false })
    expect(await call('connect')).toEqual({ authorization: 'unknown', connected: false, mode: 'read', supported: false })
    expect(await call('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z'))
      .toEqual({ ok: false, code: 'not_connected' })
    expect(spy.mock.calls.some(([, input]) => input.command === 'request-full-access' || input.command === 'list-events'))
      .toBe(false)

    authorization = 'fullAccess'
    expect(await call('status')).toMatchObject({ connected: true, supported: true })
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

    expect((await first('connect', 'interact'))).toMatchObject({ connected: true, mode: 'interact', authorization: 'fullAccess' })
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

  it('enforces off, read and interact modes at the IPC boundary', async () => {
    const userData = testHome()
    const spy = vi.fn(async (_executable, input) => ({
      ok: true,
      command: input.command,
      authorization: 'fullAccess',
      events: [],
      event: { id: 'synthetic' }
    }))
    const call = bridge(spy as typeof runCalendarHelper, userData)

    expect(await call('status')).toMatchObject({ connected: false, mode: 'off' })
    expect(await call('connect')).toMatchObject({ connected: true, mode: 'read' })
    expect(await call('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z'))
      .toMatchObject({ ok: true, command: 'list-events' })
    expect(await call('create', 'Synthetic', '2026-09-23T00:00:00Z', '2026-09-23T01:00:00Z'))
      .toEqual({ ok: false, code: 'not_allowed' })
    expect(spy.mock.calls.some(([, input]) => input.command === 'create-event')).toBe(false)

    expect(await call('connect', 'interact')).toMatchObject({ connected: true, mode: 'interact' })
    expect(await call('create', 'Synthetic', '2026-09-23T00:00:00Z', '2026-09-23T01:00:00Z'))
      .toMatchObject({ ok: true, command: 'create-event' })
    expect(await call('connect', 'read')).toMatchObject({ connected: true, mode: 'read' })
    expect(await call('create', 'Synthetic', '2026-09-23T00:00:00Z', '2026-09-23T01:00:00Z'))
      .toEqual({ ok: false, code: 'not_allowed' })
    expect(spy.mock.calls.filter(([, input]) => input.command === 'create-event')).toHaveLength(1)
    expect(await call('disconnect')).toMatchObject({ connected: false, mode: 'off' })
    expect(await bridge(spy as typeof runCalendarHelper, userData)('status'))
      .toMatchObject({ connected: false, mode: 'off' })
  })

  it('treats a legacy boolean grant as read only after restart', async () => {
    const userData = testHome()
    const spy = vi.fn(async (_executable, input) => ({
      ok: true, command: input.command, authorization: 'fullAccess', events: []
    }))
    const call = bridge(spy as typeof runCalendarHelper, userData)
    expect(await call('connect', 'interact')).toMatchObject({ mode: 'interact' })
    const [configName] = fs.readdirSync(userData)
    fs.writeFileSync(path.join(userData, configName), '{"enabled":true}')

    const restarted = bridge(spy as typeof runCalendarHelper, userData)
    expect(await restarted('status')).toMatchObject({ connected: true, mode: 'read' })
    expect(await restarted('create', 'Synthetic', '2026-09-23T00:00:00Z', '2026-09-23T01:00:00Z'))
      .toEqual({ ok: false, code: 'not_allowed' })
    expect(spy.mock.calls.some(([, input]) => input.command === 'create-event')).toBe(false)
  })

  it('keeps modes separate across profiles and rejects a stale write after downgrade', async () => {
    const userData = testHome()
    let scope = '[null,"alpha"]'
    let finishCreate!: (value: { ok: true; command: string; event: { id: string } }) => void
    const pendingCreate = new Promise<{ ok: true; command: string; event: { id: string } }>(resolve => {finishCreate = resolve})
    const spy = vi.fn(async (_executable, input) => input.command === 'create-event'
      ? pendingCreate
      : { ok: true, command: input.command, authorization: 'fullAccess', events: [] })
    const call = bridge(spy as typeof runCalendarHelper, userData, () => scope)

    expect(await call('connect', 'interact')).toMatchObject({ mode: 'interact' })
    const creating = call('create', 'Synthetic', '2026-09-23T00:00:00Z', '2026-09-23T01:00:00Z')
    await vi.waitFor(() => expect(spy.mock.calls.some(([, input]) => input.command === 'create-event')).toBe(true))
    expect(await call('connect', 'read')).toMatchObject({ mode: 'read' })
    finishCreate({ ok: true, command: 'create-event', event: { id: 'synthetic' } })
    expect(await creating).toEqual({ ok: false, code: 'outcome_unknown' })
    scope = '[null,"beta"]'
    expect(await call('status')).toMatchObject({ connected: false, mode: 'off' })
    expect(await call('connect', 'read')).toMatchObject({ mode: 'read' })
    scope = '[null,"alpha"]'
    expect(await call('status')).toMatchObject({ connected: true, mode: 'read' })
    expect(spy.mock.calls.filter(([, input]) => input.command === 'create-event')).toHaveLength(1)
  })

  it('does not let an older permission request replace a newer read mode', async () => {
    const userData = testHome()
    let grant = false
    let finishPermission!: (value: { ok: true; command: string; authorization: string }) => void
    const pendingPermission = new Promise<{ ok: true; command: string; authorization: string }>(resolve => {
      finishPermission = resolve
    })
    const spy = vi.fn(async (_executable, input) => input.command === 'request-full-access'
      ? pendingPermission
      : { ok: true, command: input.command, authorization: grant ? 'fullAccess' : 'notDetermined' })
    const call = bridge(spy as typeof runCalendarHelper, userData)

    const older = call('connect', 'interact')
    await vi.waitFor(() => expect(spy.mock.calls.some(([, input]) => input.command === 'request-full-access')).toBe(true))
    grant = true
    expect(await call('connect', 'read')).toMatchObject({ connected: true, mode: 'read' })
    finishPermission({ ok: true, command: 'request-full-access', authorization: 'fullAccess' })
    expect(await older).toMatchObject({ connected: false, mode: 'off' })
    expect(await call('status')).toMatchObject({ connected: true, mode: 'read' })
  })

  it('blocks writes as soon as a read-only downgrade starts, even with delayed OS status', async () => {
    const userData = testHome()
    let statusCalls = 0
    let finishStatus!: (value: { ok: true; command: string; authorization: string }) => void
    const pendingStatus = new Promise<{ ok: true; command: string; authorization: string }>(resolve => {
      finishStatus = resolve
    })
    const spy = vi.fn(async (_executable, input) => {
      if (input.command === 'status' && ++statusCalls === 3) {return pendingStatus}

      return { ok: true, command: input.command, authorization: 'fullAccess' }
    })
    const call = bridge(spy as typeof runCalendarHelper, userData)

    expect(await call('connect', 'interact')).toMatchObject({ mode: 'interact' })
    const downgrading = call('connect', 'read')
    await vi.waitFor(() => expect(statusCalls).toBe(3))
    expect(await call('create', 'Synthetic', '2026-09-23T00:00:00Z', '2026-09-23T01:00:00Z'))
      .toEqual({ ok: false, code: 'not_allowed' })
    expect(spy.mock.calls.some(([, input]) => input.command === 'create-event')).toBe(false)
    finishStatus({ ok: true, command: 'status', authorization: 'fullAccess' })
    expect(await downgrading).toMatchObject({ connected: true, mode: 'read' })
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

    expect(await call('connect', 'interact')).toMatchObject({ connected: true })
    osGrant = false
    expect(await call('status')).toMatchObject({ connected: false, authorization: 'denied' })
    expect(await call('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z'))
      .toEqual({ ok: false, code: 'not_connected' })
    expect(spy.mock.calls.some(([, input]) => input.command === 'list-events')).toBe(false)
    osGrant = true
    const restarted = bridge(run, userData)
    expect(await restarted('status')).toMatchObject({ connected: false, authorization: 'fullAccess' })
    expect(await restarted('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z'))
      .toEqual({ ok: false, code: 'not_connected' })
    expect(await restarted('connect')).toMatchObject({ connected: true, authorization: 'fullAccess' })
  })

  it('does not let an older denied status revoke a newer successful Connect', async () => {
    const userData = testHome()
    let finishOldStatus!: (value: { ok: true; command: string; authorization: string }) => void

    const oldStatus = new Promise<{ ok: true; command: string; authorization: string }>(resolve => {
      finishOldStatus = resolve
    })

    let statusCalls = 0

    const spy = vi.fn(async (_executable, input) => {
      if (input.command === 'status' && ++statusCalls === 1) {return oldStatus}

      return { ok: true, command: input.command, authorization: 'fullAccess' }
    })

    const call = bridge(spy as typeof runCalendarHelper, userData)

    const stale = call('status')
    await vi.waitFor(() => expect(statusCalls).toBe(1))
    expect(await call('connect', 'read')).toMatchObject({ connected: true, mode: 'read' })
    finishOldStatus({ ok: true, command: 'status', authorization: 'denied' })
    await stale

    expect(await call('status')).toMatchObject({ connected: true, mode: 'read' })
    expect(await call('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z'))
      .toMatchObject({ ok: true, command: 'list-events' })
  })

  it('keeps app opt-in separate across profiles, restarts and the old global config', async () => {
    const userData = testHome()
    fs.writeFileSync(path.join(userData, 'jarvis-calendar-connection.json'), '{"enabled":true}')
    let scope = '[null,"alpha"]'

    const spy = vi.fn(async (_executable, input) => ({
      ok: true,
      command: input.command,
      authorization: 'fullAccess',
      events: []
    }))

    const run = spy as typeof runCalendarHelper
    const call = bridge(run, userData, () => scope)

    expect(await call('status')).toMatchObject({ connected: false })
    expect(await call('connect', 'interact')).toMatchObject({ connected: true })
    scope = '[null,"beta"]'
    expect(await call('status')).toMatchObject({ connected: false })
    expect(await call('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z'))
      .toEqual({ ok: false, code: 'not_connected' })
    expect(await call('connect', 'interact')).toMatchObject({ connected: true })
    expect(await call('disconnect')).toMatchObject({ connected: false })
    scope = '[null,"alpha"]'
    expect(await bridge(run, userData, () => scope)('status')).toMatchObject({ connected: true })
    scope = '["remote-connection","alpha"]'
    expect(await call('status')).toMatchObject({ connected: false })
    expect(spy.mock.calls.some(([, input]) => input.command === 'list-events')).toBe(false)
  })

  it('cannot grant a profile that changes while macOS permission is pending', async () => {
    const userData = testHome()
    let scope = '[null,"alpha"]'
    let finishPermission!: (value: { ok: true; command: string; authorization: string }) => void

    const pendingPermission = new Promise<{ ok: true; command: string; authorization: string }>(resolve => {
      finishPermission = resolve
    })

    const spy = vi.fn(async (_executable, input) => {
      if (input.command === 'request-full-access') {return pendingPermission}

      return { ok: true, command: input.command, authorization: 'notDetermined' }
    })

    const run = spy as typeof runCalendarHelper
    const call = bridge(run, userData, () => scope)
    const connecting = call('connect')

    await vi.waitFor(() => expect(spy.mock.calls.some(([, input]) => input.command === 'request-full-access')).toBe(true))
    scope = '[null,"beta"]'
    finishPermission({ ok: true, command: 'request-full-access', authorization: 'fullAccess' })
    expect(await connecting).toMatchObject({ connected: false })
    scope = '[null,"alpha"]'
    expect(await call('status')).toMatchObject({ connected: false })
  })

  it('does not restore app access when a pending Connect finishes after Disconnect', async () => {
    const userData = testHome()
    let osGrant = false
    let finishPermission!: (value: { ok: true; command: string; authorization: string }) => void

    const pendingPermission = new Promise<{ ok: true; command: string; authorization: string }>(resolve => {
      finishPermission = resolve
    })

    const spy = vi.fn(async (_executable, input) => {
      if (input.command === 'request-full-access') {return pendingPermission}

      return { ok: true, command: input.command, authorization: osGrant ? 'fullAccess' : 'notDetermined' }
    })

    const call = bridge(spy as typeof runCalendarHelper, userData)
    const connecting = call('connect')

    await vi.waitFor(() => expect(spy.mock.calls.some(([, input]) => input.command === 'request-full-access')).toBe(true))
    expect(await call('disconnect')).toMatchObject({ connected: false })
    osGrant = true
    finishPermission({ ok: true, command: 'request-full-access', authorization: 'fullAccess' })

    expect(await connecting).toMatchObject({ connected: false })
    expect(await bridge(spy as typeof runCalendarHelper, userData)('status')).toMatchObject({ connected: false })
    expect(await call('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z'))
      .toEqual({ ok: false, code: 'not_connected' })
    expect(spy.mock.calls.some(([, input]) => input.command === 'list-events')).toBe(false)
    expect(await call('connect')).toMatchObject({ connected: true })
  })

  it('does not request permission when the owner changes during its status check', async () => {
    const userData = testHome()
    let scope = '[null,"alpha"]'
    let finishStatus!: (value: { ok: true; command: string; authorization: string }) => void

    const pendingStatus = new Promise<{ ok: true; command: string; authorization: string }>(resolve => {
      finishStatus = resolve
    })

    const spy = vi.fn(async (_executable, input) => input.command === 'status'
      ? pendingStatus
      : { ok: true, command: input.command, authorization: 'fullAccess' })

    const call = bridge(spy as typeof runCalendarHelper, userData, () => scope)
    const connecting = call('connect')

    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
    scope = '[null,"beta"]'
    finishStatus({ ok: true, command: 'status', authorization: 'notDetermined' })
    expect(await connecting).toMatchObject({ connected: false })
    expect(spy.mock.calls.some(([, input]) => input.command === 'request-full-access')).toBe(false)
    scope = '[null,"alpha"]'
    expect(await call('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z'))
      .toEqual({ ok: false, code: 'not_connected' })
  })

  it('does not return an old profile read after the native helper finishes', async () => {
    const userData = testHome()
    let scope = '[null,"alpha"]'
    let finishList!: (value: { ok: true; command: string; events: unknown[] }) => void

    const pendingList = new Promise<{ ok: true; command: string; events: unknown[] }>(resolve => {
      finishList = resolve
    })

    const spy = vi.fn(async (_executable, input) => input.command === 'list-events'
      ? pendingList
      : { ok: true, command: input.command, authorization: 'fullAccess' })

    const run = spy as typeof runCalendarHelper

    const call = bridge(run, userData, () => scope)

    expect(await call('connect')).toMatchObject({ connected: true })
    const reading = call('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z')
    await vi.waitFor(() => expect(spy.mock.calls.some(([, input]) => input.command === 'list-events')).toBe(true))
    scope = '[null,"beta"]'
    finishList({ ok: true, command: 'list-events', events: [{ title: 'Alpha private event' }] })

    expect(await reading).toEqual({ ok: false, code: 'scope_changed' })
  })

  it('reports an unknown create outcome after an owner switch instead of promising failure', async () => {
    const userData = testHome()
    let scope = '[null,"alpha"]'
    let finishCreate!: (value: { ok: true; command: string; event: { id: string } }) => void

    const pendingCreate = new Promise<{ ok: true; command: string; event: { id: string } }>(resolve => {
      finishCreate = resolve
    })

    const spy = vi.fn(async (_executable, input) => input.command === 'create-event'
      ? pendingCreate
      : { ok: true, command: input.command, authorization: 'fullAccess' })

    const run = spy as typeof runCalendarHelper

    const call = bridge(run, userData, () => scope)

    expect(await call('connect', 'interact')).toMatchObject({ connected: true })
    const creating = call('create', 'Synthetic', '2026-09-23T00:00:00Z', '2026-09-23T01:00:00Z')
    await vi.waitFor(() => expect(spy.mock.calls.some(([, input]) => input.command === 'create-event')).toBe(true))
    scope = '[null,"beta"]'
    finishCreate({ ok: true, command: 'create-event', event: { id: 'alpha-event' } })

    expect(await creating).toEqual({ ok: false, code: 'outcome_unknown' })
    expect(spy.mock.calls.filter(([, input]) => input.command === 'create-event')).toHaveLength(1)
  })

  it('rejects old read and create results when the route switches A to B to A', async () => {
    const userData = testHome()
    let scope = '[null,"alpha"]'
    let version = 1
    let finishRead!: (value: { ok: true; command: string; events: unknown[] }) => void
    let finishCreate!: (value: { ok: true; command: string; event: { id: string } }) => void
    const pendingRead = new Promise<{ ok: true; command: string; events: unknown[] }>(resolve => {finishRead = resolve})
    const pendingCreate = new Promise<{ ok: true; command: string; event: { id: string } }>(resolve => {finishCreate = resolve})

    const spy = vi.fn(async (_executable, input) => {
      if (input.command === 'list-events') {return pendingRead}

      if (input.command === 'create-event') {return pendingCreate}

      return { ok: true, command: input.command, authorization: 'fullAccess' }
    })

    const call = bridge(spy as typeof runCalendarHelper, userData, () => scope, () => version)

    expect(await call('connect', 'interact')).toMatchObject({ connected: true })
    const reading = call('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z')
    await vi.waitFor(() => expect(spy.mock.calls.some(([, input]) => input.command === 'list-events')).toBe(true))
    scope = '[null,"beta"]'
    version += 1
    scope = '[null,"alpha"]'
    version += 1
    finishRead({ ok: true, command: 'list-events', events: [{ title: 'Alpha private event' }] })
    expect(await reading).toEqual({ ok: false, code: 'scope_changed' })

    const creating = call('create', 'Synthetic', '2026-09-23T00:00:00Z', '2026-09-23T01:00:00Z')
    await vi.waitFor(() => expect(spy.mock.calls.some(([, input]) => input.command === 'create-event')).toBe(true))
    scope = '[null,"beta"]'
    version += 1
    scope = '[null,"alpha"]'
    version += 1
    finishCreate({ ok: true, command: 'create-event', event: { id: 'synthetic' } })
    expect(await creating).toEqual({ ok: false, code: 'outcome_unknown' })
  })

  it('rechecks revoked macOS access after a read or create helper finishes', async () => {
    const userData = testHome()
    let granted = true
    let finishRead!: (value: { ok: true; command: string; events: unknown[] }) => void
    let finishCreate!: (value: { ok: true; command: string; event: { id: string } }) => void
    const pendingRead = new Promise<{ ok: true; command: string; events: unknown[] }>(resolve => {finishRead = resolve})
    const pendingCreate = new Promise<{ ok: true; command: string; event: { id: string } }>(resolve => {finishCreate = resolve})

    const spy = vi.fn(async (_executable, input) => {
      if (input.command === 'list-events') {return pendingRead}

      if (input.command === 'create-event') {return pendingCreate}

      return { ok: true, command: input.command, authorization: granted ? 'fullAccess' : 'denied' }
    })

    const call = bridge(spy as typeof runCalendarHelper, userData)

    expect(await call('connect', 'interact')).toMatchObject({ connected: true })
    const reading = call('list', '2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z')
    await vi.waitFor(() => expect(spy.mock.calls.some(([, input]) => input.command === 'list-events')).toBe(true))
    granted = false
    finishRead({ ok: true, command: 'list-events', events: [{ title: 'Private event' }] })
    expect(await reading).toEqual({ ok: false, code: 'not_connected' })

    granted = true
    expect(await call('connect', 'interact')).toMatchObject({ connected: true })
    const creating = call('create', 'Synthetic', '2026-09-23T00:00:00Z', '2026-09-23T01:00:00Z')
    await vi.waitFor(() => expect(spy.mock.calls.some(([, input]) => input.command === 'create-event')).toBe(true))
    granted = false
    finishCreate({ ok: true, command: 'create-event', event: { id: 'synthetic' } })
    expect(await creating).toEqual({ ok: false, code: 'outcome_unknown' })
  })
})
