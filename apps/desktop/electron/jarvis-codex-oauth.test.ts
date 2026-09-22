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
      message: 'The sign-in window expired. Choose Connect to try again.'
    })
  })
})
