import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  expect(screen.getByText('Advanced').closest('details')?.open).toBe(false)
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
