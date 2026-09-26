import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { $connection } from '@/store/session'

import { ConsumerChatExportSettings } from './consumer-chat-export-settings'

const exportChats = vi.hoisted(() => vi.fn())
const exportLocalData = vi.hoisted(() => vi.fn())
vi.mock('@/hermes', () => ({ exportConsumerChatHistory: exportChats, exportConsumerLocalData: exportLocalData }))

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
  expect(screen.getByRole('button', { name: 'Download local Jarvis data' }).hasAttribute('disabled')).toBe(true)
  expect(exportChats).not.toHaveBeenCalled()
  expect(exportLocalData).not.toHaveBeenCalled()
})

it('confirms sensitive bounded scope before saving local data for one profile', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { selectSavePath: pick }
  pick.mockResolvedValue('/synthetic/local-data.zip')
  exportLocalData.mockResolvedValue({ ok: true, chats: 2, messages: 4, images: 1 })
  render(<ConsumerChatExportSettings profile="writer" />)

  fireEvent.click(screen.getByRole('button', { name: 'Download local Jarvis data' }))
  expect(screen.getByText(/not a complete or restorable backup/)).toBeTruthy()
  expect(exportLocalData).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))
  await waitFor(() => expect(exportLocalData).toHaveBeenCalledWith('writer', '/synthetic/local-data.zip'))
  expect(await screen.findByText('Local copy saved: 2 chats and 1 uploaded image.')).toBeTruthy()
})

it('reports refusal, allows retry, and drops a stale profile save selection', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { selectSavePath: pick }
  pick.mockResolvedValueOnce('/synthetic/refused.zip').mockResolvedValueOnce('/synthetic/good.zip')
  exportLocalData.mockRejectedValueOnce(new Error('private path')).mockResolvedValueOnce({ ok: true, chats: 1, images: 0 })
  const view = render(<ConsumerChatExportSettings profile="writer" />)
  fireEvent.click(screen.getByRole('button', { name: 'Download local Jarvis data' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Choose another location and try again')
  expect(screen.queryByText(/Local copy saved/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))
  expect(await screen.findByText('Local copy saved: 1 chat and 0 uploaded images.')).toBeTruthy()

  let finishOldPick!: (path: string) => void
  pick.mockImplementationOnce(() => new Promise<string>(resolve => { finishOldPick = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Download local Jarvis data' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))
  await waitFor(() => expect(pick).toHaveBeenCalledTimes(3))
  view.rerender(<ConsumerChatExportSettings profile="reader" />)
  finishOldPick('/synthetic/stale-writer.zip')
  expect(exportLocalData).not.toHaveBeenCalledWith('writer', '/synthetic/stale-writer.zip')
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

it.each([
  ['ja', 'あなたのデータ', 'Jarvisのローカルデータをダウンロード', '保存先を選択', '完全または復元可能なバックアップではありません', 'ローカルコピーを保存しました：チャット2件、アップロード画像1枚。'],
  ['zh', '你的数据', '下载本地 Jarvis 数据', '选择保存位置', '不是完整或可恢复的备份', '已保存本地副本：2 个聊天和 1 张上传的图片。'],
  ['zh-hant', '你的資料', '下載本機 Jarvis 資料', '選擇儲存位置', '不是完整或可還原的備份', '已儲存本機副本：2 個聊天及 1 張上傳的圖片。']
] as const)('localizes the bounded local export flow in %s', async (locale, title, download, choose, disclosure, saved) => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { selectSavePath: pick }
  pick.mockResolvedValue('/synthetic/local-data.zip')
  exportLocalData.mockResolvedValue({ ok: true, chats: 2, images: 1 })
  render(<I18nProvider configClient={null} initialLocale={locale}><ConsumerChatExportSettings profile="writer" /></I18nProvider>)

  expect(screen.getByRole('heading', { name: title })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: download }))
  expect(screen.getByText(new RegExp(disclosure))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: choose }))
  expect(await screen.findByRole('status')).toHaveProperty('textContent', saved)
  expect(pick).toHaveBeenCalledWith(expect.objectContaining({ title: expect.not.stringContaining('Save local Jarvis data') }))
})

it('localizes Japanese chat disclosure, failure, and remote-only state', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { selectSavePath: pick }
  pick.mockResolvedValue('/synthetic/history.jsonl')
  exportChats.mockRejectedValue(new Error('refused'))
  const view = render(<I18nProvider configClient={null} initialLocale="ja"><ConsumerChatExportSettings profile="writer" /></I18nProvider>)

  fireEvent.click(screen.getByRole('button', { name: 'チャット履歴をダウンロード' }))
  expect(screen.getByText(/ファイルやログイン認証情報は含まれません/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '保存先を選択' }))
  expect((await screen.findByRole('alert')).textContent).toContain('チャット履歴を保存できませんでした')
  $connection.set({ mode: 'remote' } as NonNullable<ReturnType<typeof $connection.get>>)
  view.rerender(<I18nProvider configClient={null} initialLocale="ja"><ConsumerChatExportSettings profile="writer" /></I18nProvider>)
  expect(screen.getByText('JarvisがこのMacで実行中の場合に利用できます。')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'チャット履歴をダウンロード' }).hasAttribute('disabled')).toBe(true)
})
