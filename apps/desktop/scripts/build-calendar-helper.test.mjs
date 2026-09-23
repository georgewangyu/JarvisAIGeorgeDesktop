import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

const { execFileSync } = await import('node:child_process')
const { buildCalendarHelper } = await import('./build-calendar-helper.mjs')
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempDirs = []

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-helper-build-'))
  tempDirs.push(dir)
  return { dir, output: path.resolve(dir, 'native/jarvis-calendar-helper') }
}

afterEach(() => {
  vi.mocked(execFileSync).mockReset()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('buildCalendarHelper packaging', () => {
  it('builds both macOS slices with an embedded usage plist, then stages one executable', () => {
    const { dir, output } = fixture()
    vi.mocked(execFileSync).mockImplementation((_command, argv) => {
      if (argv.includes('--show-sdk-path')) return '/synthetic/MacOSX.sdk\n'
      const destination = argv[argv.indexOf(argv.includes('lipo') ? '-output' : '-o') + 1]
      fs.writeFileSync(destination, argv.includes('lipo') ? 'universal' : 'slice')
    })

    expect(buildCalendarHelper({ distDir: dir, platform: 'darwin' })).toBe(output)
    expect(fs.readFileSync(output, 'utf8')).toBe('universal')
    expect(fs.statSync(output).mode & 0o111).toBe(0o111)
    expect(fs.readdirSync(path.dirname(output))).toEqual(['jarvis-calendar-helper'])

    const calls = vi.mocked(execFileSync).mock.calls
    expect(calls).toHaveLength(4)
    expect(calls[0][0]).toBe('xcrun')
    expect(calls[0][1]).toEqual(['--sdk', 'macosx', '--show-sdk-path'])
    for (const [index, arch] of ['arm64', 'x86_64'].entries()) {
      const argv = calls[index + 1][1]
      expect(argv.slice(0, 3)).toEqual(['--sdk', 'macosx', 'swiftc'])
      expect(argv).toContain(`${arch}-apple-macosx14.0`)
      expect(argv).toContain('/synthetic/MacOSX.sdk')
      expect(argv).toContain('EventKit')
      expect(argv).toContain(path.resolve(desktopRoot, 'native/calendar-helper/main.swift'))
      expect(argv.slice(argv.indexOf('-Xlinker'))).toEqual([
        '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT',
        '-Xlinker', '__info_plist', '-Xlinker',
        path.resolve(desktopRoot, 'native/calendar-helper/Info.plist'), '-o', argv.at(-1),
      ])
    }
    expect(calls[3][1].slice(0, 2)).toEqual(['lipo', '-create'])
    expect(calls[3][1]).toContain(calls[1][1].at(-1))
    expect(calls[3][1]).toContain(calls[2][1].at(-1))
  })

  it('leaves an existing build intact and removes staging after a compile failure', () => {
    const { dir, output } = fixture()
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, 'prior build')
    vi.mocked(execFileSync).mockImplementation((_command, argv) => {
      if (argv.includes('--show-sdk-path')) return '/synthetic/MacOSX.sdk\n'
      throw new Error('synthetic compiler failure')
    })

    expect(() => buildCalendarHelper({ distDir: dir, platform: 'darwin' })).toThrow('synthetic compiler failure')
    expect(fs.readFileSync(output, 'utf8')).toBe('prior build')
    expect(fs.readdirSync(path.dirname(output))).toEqual(['jarvis-calendar-helper'])
  })

  it('does not run a compiler or create dist on non-macOS hosts', () => {
    const { dir } = fixture()
    expect(buildCalendarHelper({ distDir: path.resolve(dir, 'dist'), platform: 'linux' })).toBeNull()
    expect(fs.existsSync(path.resolve(dir, 'dist'))).toBe(false)
    expect(execFileSync).not.toHaveBeenCalled()
  })
})
