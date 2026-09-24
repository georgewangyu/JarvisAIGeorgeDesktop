import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { registerJarvisCodexOAuth } from './jarvis-codex-oauth'

function childProcessFixture() {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    stderr: new EventEmitter(),
    stdout: new EventEmitter()
  })
}

describe('Jarvis Codex OAuth', () => {
  it('uses the resolved Hermes runtime command and working directory', async () => {
    let handler: (() => Promise<{ message?: string; ok: boolean }>) | undefined

    const ipcMain = {
      handle: vi.fn((_channel: string, callback: typeof handler) => {
        handler = callback
      })
    }

    const child = childProcessFixture()
    const spawnProcess = vi.fn(() => child)

    registerJarvisCodexOAuth({
      ipcMain: ipcMain as never,
      resolveCommand: async () => ({
        args: ['auth', 'add', 'openai-codex', '--browser'],
        command: '/usr/local/bin/hermes',
        cwd: '/Users/example',
        env: { HERMES_HOME: '/Users/example/.hermes' },
        shell: false
      }),
      spawnProcess: spawnProcess as never
    })

    expect(handler).toBeTypeOf('function')
    const result = handler!()

    await vi.waitFor(() => {
      expect(spawnProcess).toHaveBeenCalledWith(
        '/usr/local/bin/hermes',
        ['auth', 'add', 'openai-codex', '--browser'],
        expect.objectContaining({
          cwd: '/Users/example',
          env: { HERMES_HOME: '/Users/example/.hermes' },
          shell: false
        })
      )
    })

    child.exitCode = 0
    child.emit('exit', 0)
    await expect(result).resolves.toEqual({ ok: true })
  })

  it('turns a loopback timeout into consumer-facing retry guidance', async () => {
    let handler: (() => Promise<{ message?: string; ok: boolean }>) | undefined

    const ipcMain = {
      handle: vi.fn((_channel: string, callback: typeof handler) => {
        handler = callback
      })
    }

    const child = childProcessFixture()
    const spawnProcess = vi.fn(() => child)

    registerJarvisCodexOAuth({
      ipcMain: ipcMain as never,
      resolveCommand: async () => ({
        args: ['auth', 'add', 'openai-codex', '--browser'],
        command: '/usr/local/bin/hermes',
        cwd: '/Users/example',
        env: { HERMES_HOME: '/Users/example/.hermes' },
        shell: false
      }),
      spawnProcess: spawnProcess as never
    })

    const result = handler!()

    await vi.waitFor(() => {
      expect(spawnProcess).toHaveBeenCalledOnce()
    })

    child.stderr.emit('data', 'Authorization timed out waiting for the local callback.\n')
    child.exitCode = 1
    child.emit('exit', 1)

    await expect(result).resolves.toEqual({
      ok: false,
      message: 'The sign-in window expired. Choose Continue with ChatGPT / Codex to try again.'
    })
  })

  it('never exposes callback codes, account details, or local paths in a failed sign-in', async () => {
    let handler: (() => Promise<{ message?: string; ok: boolean }>) | undefined
    const ipcMain = { handle: vi.fn((_channel: string, callback: typeof handler) => { handler = callback }) }
    const child = childProcessFixture()

    registerJarvisCodexOAuth({
      ipcMain: ipcMain as never,
      resolveCommand: async () => ({
        args: ['auth', 'add', 'openai-codex', '--browser'],
        command: '/usr/local/bin/hermes',
        cwd: '/Users/example',
        env: {},
        shell: false
      }),
      spawnProcess: vi.fn(() => child) as never
    })

    const result = handler!()

    await vi.waitFor(() => expect(child.listenerCount('exit')).toBe(1))
    child.stderr.emit('data', 'callback code=private-code state=private-state for user@example.com at /Users/example/auth.json\n')
    child.exitCode = 1
    child.emit('exit', 1)

    await expect(result).resolves.toEqual({
      ok: false,
      message: 'ChatGPT sign-in did not finish. Please try again.'
    })
  })

  it('keeps a process-launch error private and allows a later retry', async () => {
    let handler: (() => Promise<{ message?: string; ok: boolean }>) | undefined
    const ipcMain = { handle: vi.fn((_channel: string, callback: typeof handler) => { handler = callback }) }
    const failedChild = childProcessFixture()
    const retryChild = childProcessFixture()
    const spawnProcess = vi.fn().mockReturnValueOnce(failedChild).mockReturnValueOnce(retryChild)

    registerJarvisCodexOAuth({
      ipcMain: ipcMain as never,
      resolveCommand: async () => ({
        args: ['auth', 'add', 'openai-codex', '--browser'],
        command: '/usr/local/bin/hermes',
        cwd: '/Users/example',
        env: {},
        shell: false
      }),
      spawnProcess: spawnProcess as never
    })

    const failed = handler!()

    await vi.waitFor(() => expect(failedChild.listenerCount('error')).toBe(1))
    failedChild.emit('error', new Error('private credential at /Users/example/secret.json'))
    await expect(failed).resolves.toEqual({
      ok: false,
      message: 'ChatGPT sign-in could not start. Please try again.'
    })

    const retry = handler!()

    await vi.waitFor(() => expect(retryChild.listenerCount('exit')).toBe(1))
    retryChild.exitCode = 0
    retryChild.emit('exit', 0)
    await expect(retry).resolves.toEqual({ ok: true })
    expect(spawnProcess).toHaveBeenCalledTimes(2)
  })

  it('does not reject IPC when runtime discovery or process launch throws', async () => {
    let discoveryHandler: (() => Promise<{ message?: string; ok: boolean }>) | undefined
    const discoveryIpc = { handle: vi.fn((_channel: string, callback: typeof discoveryHandler) => { discoveryHandler = callback }) }

    registerJarvisCodexOAuth({
      ipcMain: discoveryIpc as never,
      resolveCommand: async () => { throw new Error('private path from runtime discovery') }
    })
    await expect(discoveryHandler!()).resolves.toEqual({
      ok: false,
      message: 'The Jarvis local engine is not ready yet.'
    })

    let launchHandler: (() => Promise<{ message?: string; ok: boolean }>) | undefined
    const launchIpc = { handle: vi.fn((_channel: string, callback: typeof launchHandler) => { launchHandler = callback }) }

    registerJarvisCodexOAuth({
      ipcMain: launchIpc as never,
      resolveCommand: async () => ({ args: [], command: '/usr/local/bin/hermes', cwd: '/Users/example', env: {} }),
      spawnProcess: vi.fn(() => { throw new Error('private launch path') }) as never
    })
    await expect(launchHandler!()).resolves.toEqual({
      ok: false,
      message: 'ChatGPT sign-in could not start. Please try again.'
    })
  })
})
