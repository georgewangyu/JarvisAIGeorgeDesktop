import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { JarvisFileImportAccess } from './jarvis-file-import-access'

const roots: string[] = []

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-file-import-'))
  roots.push(root)
  const userData = path.join(root, 'user-data')
  const allowed = path.join(root, 'allowed')
  const blocked = path.join(root, 'blocked')
  fs.mkdirSync(allowed)
  fs.mkdirSync(blocked)
  const inside = path.join(allowed, 'inside.txt')
  const outside = path.join(blocked, 'outside.txt')
  fs.writeFileSync(inside, 'inside')
  fs.writeFileSync(outside, 'outside')

  return { access: new JarvisFileImportAccess(userData), allowed, blocked, inside, outside, userData }
}

afterEach(() => {
  for (const root of roots.splice(0)) {fs.rmSync(root, { recursive: true, force: true })}
})

it('accepts an exact picker selection but refuses an unselected path and a different profile', () => {
  const { access, inside, outside } = fixture()
  expect(() => access.assertAllowed('profile-a', inside)).toThrow(/needs a file picked/)
  access.selectFiles('profile-a', [inside])
  expect(() => access.assertAllowed('profile-a', inside)).not.toThrow()
  expect(() => access.assertAllowed('profile-a', outside)).toThrow(/needs a file picked/)
  expect(() => access.assertAllowed('profile-b', inside)).toThrow(/needs a file picked/)
})

it('blocks a selected file and symlink escape, and enforces revoke before a retry', () => {
  const { access, allowed, blocked, inside, outside } = fixture()
  access.setFolder('profile', allowed, 'allow')
  expect(() => access.assertAllowed('profile', inside)).not.toThrow()

  const escape = path.join(allowed, 'escape.txt')
  fs.symlinkSync(outside, escape)
  expect(() => access.assertAllowed('profile', escape)).toThrow(/needs a file picked/)

  access.selectFiles('profile', [outside])
  access.setFolder('profile', blocked, 'block')
  expect(() => access.assertAllowed('profile', outside)).toThrow(/blocked/)

  const exactLink = path.join(allowed, 'exact-link.txt')
  fs.symlinkSync(inside, exactLink)
  access.selectFiles('profile', [exactLink])
  fs.unlinkSync(exactLink)
  fs.symlinkSync(outside, exactLink)
  expect(() => access.assertAllowed('profile', exactLink)).toThrow(/blocked/)

  access.selectFiles('profile', [inside])
  access.revokeFolder('profile', allowed)
  expect(() => access.assertAllowed('profile', inside)).toThrow(/blocked/)
  access.setFolder('profile', allowed, 'allow')
  expect(() => access.assertAllowed('profile', inside)).not.toThrow()
})

it('persists folder rules across instances and refuses corrupt policy instead of granting', () => {
  const { access, allowed, inside, userData } = fixture()
  access.setFolder('profile', allowed, 'allow')
  const fresh = new JarvisFileImportAccess(userData)
  expect(() => fresh.assertAllowed('profile', inside)).not.toThrow()
  const policy = fs.readdirSync(userData)[0]
  fs.writeFileSync(path.join(userData, policy), '{bad')
  expect(() => fresh.assertAllowed('profile', inside)).toThrow(/Could not verify/)
})
