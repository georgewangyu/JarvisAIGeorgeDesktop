import { pathToFileURL } from 'node:url'

import { expect, it, vi } from 'vitest'

import { resolveRequestedPathForIpc } from './hardening'
import { openLocalArtifact } from './local-artifact-open'

it('waits for the OS to open a resolved local artifact', async () => {
  const localPath = '/tmp/jarvis-test-artifact.md'

  let reportResult: (error: string) => void = () => {}

  const openPath = vi.fn(
    () =>
      new Promise<string>(resolve => {
        reportResult = resolve
      })
  )

  const pending = openLocalArtifact(pathToFileURL(localPath).toString(), {
    resolvePath: resolveRequestedPathForIpc,
    openPath
  })

  let settled = false
  void pending.then(() => {
    settled = true
  })

  expect(openPath).toHaveBeenCalledWith(localPath)
  expect(settled).toBe(false)
  reportResult('')
  await expect(pending).resolves.toBeUndefined()
  expect(settled).toBe(true)
})

it('propagates OS and path-validation failures without claiming an open', async () => {
  const openPath = vi.fn().mockResolvedValue('No application can open this file')
  const deps = { resolvePath: resolveRequestedPathForIpc, openPath }

  await expect(openLocalArtifact('file:///tmp/jarvis-test-artifact.unknown', deps)).rejects.toThrow(
    'No application can open this file'
  )
  await expect(openLocalArtifact('file://remote-host/secret.txt', deps)).rejects.toThrow()
  expect(openPath).toHaveBeenCalledTimes(1)
})
