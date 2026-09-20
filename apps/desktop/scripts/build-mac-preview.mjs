import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.error('The Mac preview build must run on macOS.')
  process.exit(1)
}

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }

// A preview never borrows a release certificate or notarization credential.
for (const key of [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'APPLE_NOTARY_PROFILE',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER'
]) {
  delete env[key]
}

// Command Line Tools can compile Hermes's native helper even when full Xcode
// is installed but its separate license has not yet been accepted.
const commandLineTools = '/Library/Developer/CommandLineTools'
if (existsSync(resolve(commandLineTools, 'usr/bin/clang'))) {
  env.DEVELOPER_DIR = commandLineTools
}

function run(args) {
  const result = spawnSync('npm', args, { cwd: desktopDir, env, stdio: 'inherit' })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(['run', 'build'])
run([
  'run', 'builder', '--', '--mac',
  '-c.mac.identity=null',
  '-c.mac.hardenedRuntime=false',
  ...process.argv.slice(2)
])
