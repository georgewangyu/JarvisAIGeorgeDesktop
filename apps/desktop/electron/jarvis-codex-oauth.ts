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
let loginPending = false

function safeFailure(output: string): string {
  if (/authorization timed out waiting for the local callback/i.test(output)) {
    return 'The sign-in window expired. Choose Continue with ChatGPT / Codex to try again.'
  }

  if (/authorization callback state mismatch/i.test(output)) {
    return 'The browser response did not match this sign-in. Please try again.'
  }

  if (/authorization failed:.*(?:access_denied|declined|denied)/i.test(output)) {
    return 'Sign-in was declined in the browser. Try again when you are ready.'
  }

  // CLI diagnostics can include the callback URL, code, state, account details,
  // or a machine path. Never return an arbitrary output line to the renderer.
  return 'ChatGPT sign-in did not finish. Please try again.'
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
    if (loginPending || (activeLogin && activeLogin.exitCode === null)) {
      return { ok: false, message: 'ChatGPT sign-in is already open in your browser.' }
    }

    // Reserve the attempt before runtime discovery awaits. Otherwise two
    // windows can both pass the guard and launch separate browser flows.
    loginPending = true
    let runtime: JarvisCodexOAuthCommand | null

    try {
      runtime = await resolveCommand()
    } catch {
      loginPending = false

      return { ok: false, message: 'The Jarvis local engine is not ready yet.' }
    }

    if (!runtime) {
      loginPending = false

      return { ok: false, message: 'The Jarvis local engine is not ready yet.' }
    }

    return new Promise(resolve => {
      const options: SpawnOptions = {
        cwd: runtime.cwd,
        env: runtime.env,
        shell: runtime.shell,
        stdio: ['ignore', 'pipe', 'pipe']
      }

      let child: ChildProcess

      try {
        child = spawnProcess(runtime.command, runtime.args, options)
      } catch {
        loginPending = false
        resolve({ ok: false, message: 'ChatGPT sign-in could not start. Please try again.' })

        return
      }

      activeLogin = child
      let output = ''
      let portBusy = false

      const remember = (chunk: Buffer | string) => {
        output = `${output}${String(chunk)}`.slice(-16_384)

        // The CLI falls back to a device code when Codex owns its fixed
        // callback port. Desktop does not display CLI output, so that flow
        // cannot be completed here. Stop it instead of waiting invisibly.
        if (!portBusy && /port 1455 is already in use/i.test(output)) {
          portBusy = true
          child.kill()
        }
      }

      collectOutput(child.stdout, remember)
      collectOutput(child.stderr, remember)
      child.once('error', () => {
        if (activeLogin === child) {
          activeLogin = null
          loginPending = false
        }

        resolve({ ok: false, message: 'ChatGPT sign-in could not start. Please try again.' })
      })
      // 'close' follows stdio closure; 'exit' can arrive before the CLI's
      // final diagnostic reaches us.
      child.once('close', code => {
        if (activeLogin === child) {
          activeLogin = null
          loginPending = false
        }

        if (code !== 0 || portBusy) {
          resolve({
            ok: false,
            message: portBusy
              ? 'Another Codex sign-in is using the browser callback. Finish or close it, then try again.'
              : safeFailure(output)
          })

          return
        }

        resolve({ ok: true })
      })
    })
  })
}
