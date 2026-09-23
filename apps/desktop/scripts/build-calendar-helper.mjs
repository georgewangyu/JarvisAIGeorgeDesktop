#!/usr/bin/env node
// Build-time only. The Info.plist section gives the standalone Mach-O its own
// Calendar usage description; Electron's bundle Info.plist is not inherited.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const architectures = ['arm64', 'x86_64']

export function buildCalendarHelper({
  distDir = resolve(root, 'dist'),
  platform = process.platform,
} = {}) {
  if (platform !== 'darwin') return null

  const output = resolve(distDir, 'native/jarvis-calendar-helper')
  mkdirSync(dirname(output), { recursive: true })
  const stagingDir = mkdtempSync(resolve(dirname(output), '.calendar-helper-'))
  try {
    const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
      encoding: 'utf8', timeout: 30_000,
    }).trim()
    const source = resolve(root, 'native/calendar-helper/main.swift')
    const plist = resolve(root, 'native/calendar-helper/Info.plist')
    const slices = architectures.map(arch => {
      const slice = resolve(stagingDir, arch)
      execFileSync('xcrun', [
        '--sdk', 'macosx', 'swiftc',
        '-target', `${arch}-apple-macosx14.0`, '-sdk', sdk,
        '-framework', 'EventKit',
        source,
        '-Xlinker', '-sectcreate',
        '-Xlinker', '__TEXT',
        '-Xlinker', '__info_plist',
        '-Xlinker', plist,
        '-o', slice,
      ], { stdio: 'inherit', timeout: 120_000 })
      return slice
    })
    const staged = resolve(stagingDir, 'universal')
    execFileSync('xcrun', ['lipo', '-create', ...slices, '-output', staged], {
      stdio: 'inherit', timeout: 30_000,
    })
    chmodSync(staged, 0o755)
    renameSync(staged, output)
    console.log(`built ${output} (arm64 + x86_64, embedded Info.plist)`)
    return output
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--out-dir')) {
    throw new Error('Usage: build-calendar-helper.mjs [--out-dir PATH]')
  }
  buildCalendarHelper(args.length ? { distDir: resolve(args[1]) } : {})
}
