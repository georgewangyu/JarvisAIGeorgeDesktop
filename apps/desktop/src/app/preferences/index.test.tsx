import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { PreferencesView } from './index'

const { setMode, setTheme } = vi.hoisted(() => ({ setMode: vi.fn(), setTheme: vi.fn() }))
vi.mock('@/themes', () => ({
  useTheme: () => ({ mode: 'system', themeName: 'other', setMode, setTheme })
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  Reflect.deleteProperty(window, 'hermesDesktop')
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
  fireEvent.click(screen.getByRole('switch', { name: 'Quick Entry' }))
  await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ enabled: false }))
})
