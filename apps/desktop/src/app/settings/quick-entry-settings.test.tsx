import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $quickEntry, QUICK_ENTRY_DEFAULT_SHORTCUT } from '@/store/quick-entry'

import { QuickEntrySettings } from './quick-entry-settings'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'hermesDesktop')
  $quickEntry.set({
    enabled: true, error: null, failure: null, registered: null, retryPatch: null,
    shortcut: QUICK_ENTRY_DEFAULT_SHORTCUT
  })
  vi.clearAllMocks()
})

it('renders consumer Quick Entry and its live registration in Japanese', async () => {
  const getSettings = vi.fn().mockResolvedValue({
    enabled: true, error: null, registered: true, shortcut: QUICK_ENTRY_DEFAULT_SHORTCUT
  })

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true, value: { quickEntry: { getSettings, setSettings: vi.fn() } }
  })

  render(
    <I18nProvider configClient={null} initialLocale="ja">
      <QuickEntrySettings consumer />
    </I18nProvider>
  )

  expect(screen.getByRole('switch', { name: 'クイック入力' })).toBeTruthy()
  expect(screen.getByText(/グローバルショートカットで/)).toBeTruthy()
  expect(await screen.findByText('ショートカットは有効です。')).toBeTruthy()
  expect(screen.getByRole('button', { name: '変更 クイック入力のショートカット' })).toBeTruthy()
  expect(getSettings).toHaveBeenCalledOnce()
})

it('shows a taken shortcut and recovers after the person chooses a different chord', async () => {
  const getSettings = vi.fn().mockResolvedValue({
    enabled: true, error: 'taken', registered: false, shortcut: QUICK_ENTRY_DEFAULT_SHORTCUT
  })

  const nextShortcut = 'CommandOrControl+Alt+Space'

  const setSettings = vi.fn().mockResolvedValue({
    enabled: true, error: null, registered: true, shortcut: nextShortcut
  })

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true, value: { quickEntry: { getSettings, setSettings } }
  })

  render(
    <I18nProvider configClient={null} initialLocale="ja">
      <QuickEntrySettings consumer />
    </I18nProvider>
  )

  expect(await screen.findByText(/他のアプリが使用しています/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '変更 クイック入力のショートカット' }))
  const field = screen.getByRole('textbox', { name: 'クイック入力のショートカット' })
  fireEvent.change(field, { target: { value: nextShortcut } })
  fireEvent.keyDown(field, { key: 'Enter' })

  await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ shortcut: nextShortcut }))
  expect(await screen.findByText('ショートカットは有効です。')).toBeTruthy()
  expect(screen.queryByText(/他のアプリが使用しています/)).toBeNull()
})

it('keeps an invalid shortcut visible and lets the person retry', async () => {
  const getSettings = vi.fn().mockResolvedValue({
    enabled: true, error: null, registered: true, shortcut: QUICK_ENTRY_DEFAULT_SHORTCUT
  })

  const setSettings = vi.fn()
    .mockResolvedValueOnce({ enabled: true, error: 'invalid', registered: false, shortcut: 'Space' })
    .mockResolvedValueOnce({ enabled: true, error: null, registered: true, shortcut: QUICK_ENTRY_DEFAULT_SHORTCUT })

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true, value: { quickEntry: { getSettings, setSettings } }
  })

  render(
    <I18nProvider configClient={null} initialLocale="ja">
      <QuickEntrySettings consumer />
    </I18nProvider>
  )

  await screen.findByText('ショートカットは有効です。')
  fireEvent.click(screen.getByRole('button', { name: '変更 クイック入力のショートカット' }))
  const field = screen.getByRole('textbox', { name: 'クイック入力のショートカット' })
  fireEvent.change(field, { target: { value: 'Space' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(await screen.findByText(/修飾キーを 1 つ以上含めてください/)).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: '変更 クイック入力のショートカット' }))
  const retryField = screen.getByRole('textbox', { name: 'クイック入力のショートカット' })
  fireEvent.change(retryField, { target: { value: QUICK_ENTRY_DEFAULT_SHORTCUT } })
  fireEvent.keyDown(retryField, { key: 'Enter' })

  await waitFor(() => expect(setSettings).toHaveBeenCalledTimes(2))
  expect(await screen.findByText('ショートカットは有効です。')).toBeTruthy()
})

it('does not claim a shortcut is active after the desktop bridge rejects a change, then retries it', async () => {
  const getSettings = vi.fn().mockResolvedValue({
    enabled: true, error: null, registered: true, shortcut: QUICK_ENTRY_DEFAULT_SHORTCUT
  })

  const nextShortcut = 'CommandOrControl+Alt+Space'

  const setSettings = vi.fn()
    .mockRejectedValueOnce(new Error('synthetic IPC failure'))
    .mockResolvedValueOnce({ enabled: true, error: null, registered: true, shortcut: nextShortcut })

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true, value: { quickEntry: { getSettings, setSettings } }
  })

  render(
    <I18nProvider configClient={null} initialLocale="ja">
      <QuickEntrySettings consumer />
    </I18nProvider>
  )

  await screen.findByText('ショートカットは有効です。')
  fireEvent.click(screen.getByRole('button', { name: '変更 クイック入力のショートカット' }))
  const field = screen.getByRole('textbox', { name: 'クイック入力のショートカット' })
  fireEvent.change(field, { target: { value: nextShortcut } })
  fireEvent.keyDown(field, { key: 'Enter' })

  await waitFor(() => expect(setSettings).toHaveBeenCalledTimes(1))
  expect(await screen.findByText(/ショートカットの変更を確認できませんでした/)).toBeTruthy()
  expect(screen.queryByText('ショートカットは有効です。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '再試行' }))
  await waitFor(() => expect(setSettings).toHaveBeenCalledTimes(2))
  expect(setSettings).toHaveBeenLastCalledWith({ shortcut: nextShortcut })
  expect(await screen.findByText('ショートカットは有効です。')).toBeTruthy()
  expect(screen.queryByText(/ショートカットの変更を確認できませんでした/)).toBeNull()
})

it('offers a retry when the first bridge read fails without claiming registration', async () => {
  const getSettings = vi.fn()
    .mockRejectedValueOnce(new Error('synthetic read failure'))
    .mockResolvedValueOnce({
      enabled: true, error: null, registered: true, shortcut: QUICK_ENTRY_DEFAULT_SHORTCUT
    })

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true, value: { quickEntry: { getSettings, setSettings: vi.fn() } }
  })

  render(
    <I18nProvider configClient={null} initialLocale="ja">
      <QuickEntrySettings consumer />
    </I18nProvider>
  )

  expect(await screen.findByText(/ショートカットの状態を確認できませんでした/)).toBeTruthy()
  expect(screen.queryByText('ショートカットは有効です。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '再試行' }))
  await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2))
  expect(await screen.findByText('ショートカットは有効です。')).toBeTruthy()
})

it.each(['zh', 'zh-hant'] as const)('describes the composer without promising a sent prompt in %s', locale => {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      quickEntry: {
        getSettings: vi.fn().mockResolvedValue({
          enabled: true, error: null, registered: true, shortcut: QUICK_ENTRY_DEFAULT_SHORTCUT
        }),
        setSettings: vi.fn()
      }
    }
  })

  render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <QuickEntrySettings consumer />
    </I18nProvider>
  )

  expect(screen.getByText(/主窗口|主視窗/)).toBeTruthy()
  expect(screen.queryByText(/Hermes/)).toBeNull()
  expect(screen.queryByText(/发送提示|送出提示/)).toBeNull()
})
