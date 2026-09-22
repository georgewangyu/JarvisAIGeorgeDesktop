import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import path from 'node:path'

import type { IpcMain } from 'electron'

export interface JarvisCodexOAuthResult {
  ok: boolean
  message?: string
}

interface JarvisCodexOAuthDeps {
  agentRoot: string
  hermesHome: string
  ipcMain: IpcMain
  resolvePython: () => Promise<string | null>
  spawnProcess?: typeof spawn
}

let activeLogin: ChildProcess | null = null

const ACTIVATE_CODEX_SCRIPT = [
  'from hermes_cli.auth import DEFAULT_CODEX_BASE_URL, _update_config_for_provider',
  '_update_config_for_provider("openai-codex", DEFAULT_CODEX_BASE_URL, "gpt-5.6-sol")'
].join('; ')

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
  agentRoot,
  hermesHome,
  ipcMain,
  resolvePython,
  spawnProcess = spawn
}: JarvisCodexOAuthDeps): void {
  ipcMain.handle('jarvis:codex-oauth:start', async (): Promise<JarvisCodexOAuthResult> => {
    if (activeLogin && activeLogin.exitCode === null) {
      return { ok: false, message: 'ChatGPT sign-in is already open in your browser.' }
    }

    const python = await resolvePython()

    if (!python) {
      return { ok: false, message: 'The Jarvis local engine is not ready yet.' }
    }

    return new Promise(resolve => {
      const options: SpawnOptions = {
        cwd: agentRoot,
        env: {
          ...process.env,
          HERMES_HOME: hermesHome,
          PYTHONPATH: [agentRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
          PYTHONUTF8: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
      const child = spawnProcess(python, [
        '-m',
        'hermes_cli.main',
        'auth',
        'add',
        'openai-codex',
        '--type',
        'oauth',
        '--browser',
        '--timeout',
        '300'
      ], options)

      activeLogin = child
      let output = ''
      const remember = (chunk: Buffer | string) => {
        output = `${output}${String(chunk)}`.slice(-16_384)
      }

      collectOutput(child.stdout, remember)
      collectOutput(child.stderr, remember)
      child.once('error', error => {
        if (activeLogin === child) activeLogin = null
        resolve({ ok: false, message: error.message || 'ChatGPT sign-in could not start.' })
      })
      child.once('exit', code => {
        if (code !== 0) {
          if (activeLogin === child) activeLogin = null
          resolve({ ok: false, message: safeFailure(output) })

          return
        }

        // Make the freshly authorized provider explicit and pair it with a
        // valid Codex model. Otherwise the inherited Hermes default can still
        // read “auto: anthropic/…” even though the only connected account is
        // OpenAI, which is confusing and can produce an invalid first turn.
        const activate = spawnProcess(python, ['-c', ACTIVATE_CODEX_SCRIPT], options)
        activeLogin = activate
        let activateOutput = ''
        collectOutput(activate.stdout, chunk => {
          activateOutput = `${activateOutput}${String(chunk)}`.slice(-16_384)
        })
        collectOutput(activate.stderr, chunk => {
          activateOutput = `${activateOutput}${String(chunk)}`.slice(-16_384)
        })
        activate.once('error', error => {
          if (activeLogin === activate) activeLogin = null
          resolve({ ok: false, message: error.message || 'Codex connected, but Jarvis could not activate it.' })
        })
        activate.once('exit', activateCode => {
          if (activeLogin === activate) activeLogin = null
          resolve(
            activateCode === 0
              ? { ok: true }
              : { ok: false, message: safeFailure(activateOutput) || 'Codex connected, but Jarvis could not activate it.' }
          )
        })
      })
    })
  })
}
