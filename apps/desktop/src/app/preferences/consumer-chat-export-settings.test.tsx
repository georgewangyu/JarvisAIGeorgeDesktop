import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

import { ConsumerChatExportSettings } from './consumer-chat-export-settings'

const exportChats = vi.hoisted(() => vi.fn())
vi.mock('@/hermes', () => ({ exportConsumerChatHistory: exportChats }))

const pick = vi.fn()

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $connection.set(null)
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

it('keeps download explicit and exports only the selected local profile', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { selectSavePath: pick }
  pick.mockResolvedValue('/synthetic/chat-history.jsonl')
  exportChats.mockResolvedValue({ ok: true, chats: 2, messages: 4 })
  render(<ConsumerChatExportSettings profile="writer" />)

  expect(exportChats).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Download chat history' }))
  expect(screen.getByText(/does not include files or sign-in credentials/)).toBeTruthy()
  expect(exportChats).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))

  await waitFor(() => expect(exportChats).toHaveBeenCalledWith('writer', '/synthetic/chat-history.jsonl'))
  expect(await screen.findByText('2 chats saved to the location you chose.')).toBeTruthy()
})

it('does not open a local save action for a remote backend', () => {
  $connection.set({ mode: 'remote' } as NonNullable<ReturnType<typeof $connection.get>>)
  render(<ConsumerChatExportSettings profile="writer" />)

  expect(screen.getByRole('button', { name: 'Download chat history' }).hasAttribute('disabled')).toBe(true)
  expect(exportChats).not.toHaveBeenCalled()
})

it('does not export the old profile after a switch in the save dialog and permits the new profile', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  let finishOldPick!: (path: string) => void
  pick.mockImplementationOnce(() => new Promise<string>(resolve => { finishOldPick = resolve }))
    .mockResolvedValueOnce('/synthetic/reader-history.jsonl')
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { selectSavePath: pick }
  exportChats.mockResolvedValue({ ok: true, chats: 1, messages: 2 })
  const view = render(<ConsumerChatExportSettings profile="writer" />)

  fireEvent.click(screen.getByRole('button', { name: 'Download chat history' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))
  await waitFor(() => expect(pick).toHaveBeenCalledOnce())
  view.rerender(<ConsumerChatExportSettings profile="reader" />)
  fireEvent.click(screen.getByRole('button', { name: 'Download chat history' }))
  const choose = screen.getByRole('button', { name: 'Choose save location' })
  expect(choose.hasAttribute('disabled')).toBe(false)
  fireEvent.click(choose)
  await waitFor(() => expect(exportChats).toHaveBeenCalledWith('reader', '/synthetic/reader-history.jsonl'))

  finishOldPick('/synthetic/stale-writer-history.jsonl')
  expect(exportChats).not.toHaveBeenCalledWith('writer', '/synthetic/stale-writer-history.jsonl')
})

it('reports an export refusal without claiming a saved file and permits retry', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { selectSavePath: pick }
  pick.mockResolvedValue('/synthetic/chat-history.jsonl')
  exportChats.mockRejectedValueOnce(new Error('write refused')).mockResolvedValueOnce({ ok: true, chats: 1, messages: 2 })
  render(<ConsumerChatExportSettings profile="writer" />)

  fireEvent.click(screen.getByRole('button', { name: 'Download chat history' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Could not save chat history')
  expect(screen.queryByText(/chats saved to the location/)).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))
  expect(await screen.findByText('1 chat saved to the location you chose.')).toBeTruthy()
})

it('retires a previous success before a new export that the backend refuses', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { selectSavePath: pick }
  pick.mockResolvedValue('/synthetic/chat-history.jsonl')
  exportChats.mockResolvedValueOnce({ ok: true, chats: 2, messages: 4 }).mockResolvedValueOnce({ ok: false })
  render(<ConsumerChatExportSettings profile="synthetic" />)

  fireEvent.click(screen.getByRole('button', { name: 'Download chat history' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))
  expect(await screen.findByRole('status')).toHaveProperty('textContent', '2 chats saved to the location you chose.')

  fireEvent.click(screen.getByRole('button', { name: 'Download chat history' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))

  expect((await screen.findByRole('alert')).textContent).toContain('Could not save chat history')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByText('2 chats saved to the location you chose.')).toBeNull()
  expect(exportChats).toHaveBeenNthCalledWith(2, 'synthetic', '/synthetic/chat-history.jsonl')
})
