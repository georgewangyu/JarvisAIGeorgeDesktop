import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

import { ConsumerBackupSettings } from './consumer-backup-settings'

const exportFlow = vi.hoisted(() => vi.fn())
vi.mock('@/store/profile-share', () => ({ runExportProfileFlow: exportFlow }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $connection.set(null)
})

it('exports the selected local profile only after an explicit click', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  exportFlow.mockResolvedValue('/synthetic/backup.tar.gz')
  render(<ConsumerBackupSettings profile="writer" />)

  expect(exportFlow).not.toHaveBeenCalled()
  expect(screen.getByText(/chat history, routines, sign-in files, and internal worker data aren’t included/i)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save setup backup' }))
  await waitFor(() => expect(exportFlow).toHaveBeenCalledWith('writer', expect.objectContaining({ consumer: true })))
})

it('does not offer a local save path for a remote backend', () => {
  $connection.set({ mode: 'remote' } as NonNullable<ReturnType<typeof $connection.get>>)
  render(<ConsumerBackupSettings profile="writer" />)

  expect(screen.getByRole('button', { name: 'Save setup backup' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('Available when Jarvis is running on this Mac.')).toBeTruthy()
})

it('shows a retryable picker error without exporting', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  exportFlow.mockRejectedValueOnce(new Error('picker unavailable')).mockResolvedValueOnce(null)
  render(<ConsumerBackupSettings profile="writer" />)

  fireEvent.click(screen.getByRole('button', { name: 'Save setup backup' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t save assistant setup.')
  fireEvent.click(screen.getByRole('button', { name: 'Save setup backup' }))
  await waitFor(() => expect(exportFlow).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})

it('retires an old profile save and lets the new profile start another', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  let finishOld!: () => void
  exportFlow.mockImplementationOnce(() => new Promise<null>(resolve => { finishOld = () => resolve(null) }))
    .mockResolvedValueOnce('/synthetic/reader-setup.tar.gz')
  const view = render(<ConsumerBackupSettings profile="writer" />)

  fireEvent.click(screen.getByRole('button', { name: 'Save setup backup' }))
  await waitFor(() => expect(exportFlow).toHaveBeenCalledTimes(1))
  const oldScope = exportFlow.mock.calls[0]?.[1]?.shouldContinue as () => boolean

  view.rerender(<ConsumerBackupSettings profile="reader" />)
  expect(oldScope()).toBe(false)
  expect(screen.getByRole('button', { name: 'Save setup backup' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Save setup backup' }))
  await waitFor(() => expect(exportFlow).toHaveBeenCalledWith('reader', expect.objectContaining({ consumer: true })))
  finishOld()
})
