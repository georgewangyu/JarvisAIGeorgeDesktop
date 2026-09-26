import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $consumerSetupReview, closeConsumerSetupReview } from '@/store/consumer-setup-review'
import { $desktopVersion } from '@/store/updates'

import { PreferencesView } from './index'

const { setMode, setTheme } = vi.hoisted(() => ({ setMode: vi.fn(), setTheme: vi.fn() }))
vi.mock('@/themes', () => ({
  useTheme: () => ({ mode: 'system', themeName: 'other', setMode, setTheme })
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  Reflect.deleteProperty(window, 'hermesDesktop')
  $desktopVersion.set(null)
  closeConsumerSetupReview()
})

it('uses the shared appearance authority for mode and theme choices', () => {
  render(
    <MemoryRouter>
      <PreferencesView />
    </MemoryRouter>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Dark' }))
  expect(setMode).toHaveBeenCalledWith('dark')
  fireEvent.click(screen.getByRole('button', { name: 'Use Jarvis theme' }))
  expect(setTheme).toHaveBeenCalledWith('jarvis')
  expect(screen.getByRole('heading', { name: 'Language' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Switch language' })).toBeTruthy()
  expect(
    screen
      .getAllByText('Advanced')
      .find(element => element.closest('details'))
      ?.closest('details')?.open
  ).toBe(false)
})

it('opens connections without confusing the settings route with a chat', () => {
  render(
    <MemoryRouter initialEntries={['/preferences']}>
      <Routes>
        <Route element={<PreferencesView />} path="/preferences" />
        <Route element={<p>Connection destination</p>} path="/connections" />
      </Routes>
    </MemoryRouter>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Manage connections' }))
  expect(screen.getByText('Connection destination')).toBeTruthy()
})

it('keeps supported local exports in a distinct Data controls page', () => {
  render(
    <MemoryRouter initialEntries={['/preferences']}>
      <Routes><Route element={<PreferencesView />} path="/preferences" /></Routes>
    </MemoryRouter>
  )

  expect(screen.queryByRole('button', { name: 'Download chat history' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Data controls' }))
  expect(screen.getByRole('heading', { name: 'Data controls' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Data controls' }).getAttribute('aria-current')).toBe('page')
  expect(screen.getByRole('button', { name: 'Download chat history' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Save setup backup' })).toBeTruthy()
  expect(screen.getByText(/not a complete backup or a way to delete your data/i)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'General' }))
  expect(screen.getByRole('heading', { name: 'Language' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Download chat history' })).toBeNull()
})

it.each([
  ['en', 'Data controls', 'not a complete backup or a way to delete your data'],
  ['ja', 'データ管理', '完全なバックアップではなく、データを削除する機能でもありません'],
  ['zh', '数据管理', '不是完整备份，也不能用来删除你的数据'],
  ['zh-hant', '資料管理', '不是完整備份，也無法用來刪除你的資料']
] as const)('keeps the Data controls limits visible in %s', (locale, title, limit) => {
  render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MemoryRouter initialEntries={['/preferences?section=data-controls']}>
        <Routes><Route element={<PreferencesView />} path="/preferences" /></Routes>
      </MemoryRouter>
    </I18nProvider>
  )

  expect(screen.getByRole('heading', { name: title })).toBeTruthy()
  expect(screen.getByRole('button', { name: title }).getAttribute('aria-current')).toBe('page')
  expect(screen.getByText(new RegExp(limit))).toBeTruthy()
})

it('reopens setup for review without resetting app state', () => {
  render(<MemoryRouter><PreferencesView /></MemoryRouter>)
  expect($consumerSetupReview.get()).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Review setup steps' }))
  expect($consumerSetupReview.get()).toBe(true)
})

it('localizes the remaining General setup and preview copy in Japanese', () => {
  render(
    <I18nProvider configClient={null} initialLocale="ja">
      <MemoryRouter><PreferencesView /></MemoryRouter>
    </I18nProvider>
  )

  expect(screen.getByRole('heading', { name: 'セットアップを確認' })).toBeTruthy()
  expect(screen.getByText(/アカウント、チャット、アクセス権はリセットされません/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'セットアップ手順を確認' }))
  expect($consumerSetupReview.get()).toBe(true)
  expect(screen.getByText(/プロバイダーと実行環境の詳細をJarvisが自動的に管理します/)).toBeTruthy()
})

it('shows the running app version from the desktop bridge without offering an updater', async () => {
  const getVersion = vi.fn().mockResolvedValue({
    appVersion: '0.21.3', desktopAppVersion: '0.17.6', electronVersion: '40', nodeVersion: '24',
    platform: 'darwin', hermesRoot: '/synthetic'
  })

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { getVersion } })

  render(<MemoryRouter><PreferencesView /></MemoryRouter>)

  expect(await screen.findByText('0.17.6')).toBeTruthy()
  expect(screen.queryByText('0.21.3')).toBeNull()
  expect(screen.getByRole('heading', { name: 'App version' })).toBeTruthy()
  expect(getVersion).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: /check for updates/i })).toBeNull()
})

it('shows the real macOS quick-chat registration and saves its setting through the desktop bridge', async () => {
  const getSettings = vi.fn().mockResolvedValue({
    enabled: true,
    error: null,
    registered: true,
    shortcut: 'CommandOrControl+Shift+Space'
  })

  const setSettings = vi.fn().mockResolvedValue({
    enabled: false,
    error: null,
    registered: false,
    shortcut: 'CommandOrControl+Shift+Space'
  })

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { quickEntry: { getSettings, setSettings } }
  })

  render(
    <MemoryRouter>
      <PreferencesView />
    </MemoryRouter>
  )

  expect(screen.getByRole('heading', { name: 'Quick chat' })).toBeTruthy()
  await waitFor(() => expect(screen.getByText('Shortcut is active.')).toBeTruthy())
  expect(getSettings).toHaveBeenCalledOnce()
  expect(screen.queryByRole('textbox', { name: 'Quick Entry shortcut' })).toBeNull()
  const changeShortcut = screen.getByRole('button', { name: 'Change Quick Entry shortcut' })
  expect(changeShortcut.textContent).not.toContain('CommandOrControl')
  fireEvent.click(changeShortcut)
  const shortcutInput = screen.getByRole('textbox', { name: 'Quick Entry shortcut' }) as HTMLInputElement
  expect(shortcutInput.value).toBe('CommandOrControl+Shift+Space')
  fireEvent.change(shortcutInput, { target: { value: 'CommandOrControl+Alt+Space' } })
  fireEvent.keyDown(shortcutInput, { key: 'Escape' })
  expect(screen.queryByRole('textbox', { name: 'Quick Entry shortcut' })).toBeNull()
  expect(setSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('switch', { name: 'Quick Entry' }))
  await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ enabled: false }))
})
