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
  expect(screen.getByText(/chats and sign-in credentials aren’t included/i)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save setup backup' }))
  await waitFor(() => expect(exportFlow).toHaveBeenCalledWith('writer', { consumer: true }))
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
  expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t open the save dialog.')
  fireEvent.click(screen.getByRole('button', { name: 'Save setup backup' }))
  await waitFor(() => expect(exportFlow).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})
