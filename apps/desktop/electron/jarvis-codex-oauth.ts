import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process'

import type { IpcMain } from 'electron'

export interface JarvisCodexOAuthResult {
  ok: boolean
  message?: string
}

interface JarvisCodexOAuthDeps {
  ipcMain: IpcMain
  resolveCommand: () => Promise<JarvisCodexOAuthCommand | null>
  spawnProcess?: typeof spawn
}

export interface JarvisCodexOAuthCommand {
  args: string[]
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  shell?: boolean
}

let activeLogin: ChildProcess | null = null

function safeFailure(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.includes('https://'))

  return lines.at(-1) || 'ChatGPT sign-in did not finish. Please try again.'
}

function collectOutput(stream: NodeJS.ReadableStream | null, append: (chunk: Buffer | string) => void): void {
  stream?.on('data', append)
}

/**
 * Launch the bundled Hermes Codex browser-PKCE flow. This deliberately avoids
 * the device-code grant: many ChatGPT accounts keep that grant disabled, while
 * the loopback flow is the same familiar browser authorization used by Codex.
 *
 * The command is fixed and receives no renderer-controlled arguments. Tokens
 * stay inside HERMES_HOME; stdout is retained only long enough to produce a
 * non-secret failure message and is never forwarded to the renderer verbatim.
 */
export function registerJarvisCodexOAuth({
  ipcMain,
  resolveCommand,
  spawnProcess = spawn
}: JarvisCodexOAuthDeps): void {
  ipcMain.handle('jarvis:codex-oauth:start', async (): Promise<JarvisCodexOAuthResult> => {
    if (activeLogin && activeLogin.exitCode === null) {
      return { ok: false, message: 'ChatGPT sign-in is already open in your browser.' }
    }

    const runtime = await resolveCommand()

    if (!runtime) {
      return { ok: false, message: 'The Jarvis local engine is not ready yet.' }
    }

    return new Promise(resolve => {
      const options: SpawnOptions = {
        cwd: runtime.cwd,
        env: runtime.env,
        shell: runtime.shell,
        stdio: ['ignore', 'pipe', 'pipe']
      }

      const child = spawnProcess(runtime.command, runtime.args, options)

      activeLogin = child
      let output = ''

      const remember = (chunk: Buffer | string) => {
        output = `${output}${String(chunk)}`.slice(-16_384)
      }

      collectOutput(child.stdout, remember)
      collectOutput(child.stderr, remember)
      child.once('error', error => {
        if (activeLogin === child) {
          activeLogin = null
        }

        resolve({ ok: false, message: error.message || 'ChatGPT sign-in could not start.' })
      })
      child.once('exit', code => {
        if (code !== 0) {
          if (activeLogin === child) {
            activeLogin = null
          }

          resolve({ ok: false, message: safeFailure(output) })

          return
        }

        if (activeLogin === child) {
          activeLogin = null
        }

        resolve({ ok: true })
      })
    })
  })
}
