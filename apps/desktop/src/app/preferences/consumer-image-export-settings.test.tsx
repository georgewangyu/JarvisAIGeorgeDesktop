import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { $connection } from '@/store/session'

import { ConsumerImageExportSettings } from './consumer-image-export-settings'

const { listImages, exportImages } = vi.hoisted(() => ({ listImages: vi.fn(), exportImages: vi.fn() }))
vi.mock('@/hermes', () => ({
  listConsumerUploadedImages: listImages,
  exportConsumerUploadedImages: exportImages
}))

const pick = vi.fn()
const image = { artifact_id: 'a'.repeat(32), session_id: 'chat-1', kind: 'user_uploaded_image', byte_size: 2048, extension: '.png' }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $connection.set(null)
  Reflect.deleteProperty(window, 'hermesDesktop')
})

it('lists only the selected profile and requires confirmation before saving a ZIP', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { selectSavePath: pick } })
  listImages.mockResolvedValue({ images: [image] })
  pick.mockResolvedValue('/synthetic/new-images.zip')
  exportImages.mockResolvedValue({ ok: true, images: 1, bytes: 2048 })

  render(<ConsumerImageExportSettings profile="writer" />)

  expect(await screen.findByText('1 image available to download.')).toBeTruthy()
  expect(listImages).toHaveBeenCalledWith('writer')
  fireEvent.click(screen.getByText('View image list'))
  expect(screen.getByText('Image 1 · PNG · 2 KB')).toBeTruthy()
  expect(exportImages).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Download uploaded images' }))
  expect(screen.getByText(/Generated images and other files are not included/)).toBeTruthy()
  expect(pick).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))

  await waitFor(() => expect(exportImages).toHaveBeenCalledWith('writer', '/synthetic/new-images.zip'))
  expect(pick).toHaveBeenCalledWith(expect.objectContaining({ filters: [{ extensions: ['zip'], name: 'ZIP archive' }] }))
  expect(await screen.findByText('1 image saved to the location you chose.')).toBeTruthy()
})

it('keeps the export unavailable on remote connections and when ownership listing fails', async () => {
  $connection.set({ mode: 'remote' } as NonNullable<ReturnType<typeof $connection.get>>)
  const view = render(<ConsumerImageExportSettings profile="writer" />)
  expect(screen.getByRole('button', { name: 'Download uploaded images' }).hasAttribute('disabled')).toBe(true)
  expect(listImages).not.toHaveBeenCalled()

  listImages.mockRejectedValue(new Error('ownership refused'))
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  view.rerender(<ConsumerImageExportSettings profile="writer" />)
  expect((await screen.findByRole('alert')).textContent).toContain('Could not check uploaded images')
  expect(screen.getByRole('button', { name: 'Download uploaded images' }).hasAttribute('disabled')).toBe(true)
  expect(exportImages).not.toHaveBeenCalled()

  listImages.mockResolvedValue({ images: [image] })
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('1 image available to download.')).toBeTruthy()
})

it('does not export after the selected profile changes while the save dialog is open', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  let choose!: (path: string) => void
  pick.mockImplementation(() => new Promise<string>(resolve => { choose = resolve }))
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { selectSavePath: pick } })
  listImages.mockResolvedValue({ images: [image] })
  const view = render(<ConsumerImageExportSettings profile="writer" />)

  await screen.findByText('1 image available to download.')
  fireEvent.click(screen.getByRole('button', { name: 'Download uploaded images' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))
  await waitFor(() => expect(pick).toHaveBeenCalledOnce())
  view.rerender(<ConsumerImageExportSettings profile="reader" />)
  choose('/synthetic/stale.zip')

  await waitFor(() => expect(listImages).toHaveBeenCalledWith('reader'))
  expect(exportImages).not.toHaveBeenCalled()
})

it('reports a refused write without claiming success and permits retry', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { selectSavePath: pick } })
  listImages.mockResolvedValue({ images: [image] })
  pick.mockResolvedValue('/synthetic/new-images.zip')
  exportImages.mockRejectedValueOnce(new Error('file exists')).mockResolvedValueOnce({ ok: true, images: 1, bytes: 2048 })
  render(<ConsumerImageExportSettings profile="writer" />)

  await screen.findByText('1 image available to download.')
  fireEvent.click(screen.getByRole('button', { name: 'Download uploaded images' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Choose a new ZIP filename')
  expect(screen.queryByText(/image saved to the location/)).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }))
  expect(await screen.findByText('1 image saved to the location you chose.')).toBeTruthy()
  expect(exportImages).toHaveBeenCalledTimes(2)
})

it('uses Jarvis locale copy for labels and image counts', async () => {
  $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
  listImages.mockResolvedValue({ images: [image] })
  render(
    <I18nProvider configClient={null} initialLocale="ja">
      <ConsumerImageExportSettings profile="writer" />
    </I18nProvider>
  )

  expect(await screen.findByText('1枚の画像をダウンロードできます。')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'チャットでアップロードした画像' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'アップロードした画像をダウンロード' }))
  expect(screen.getByText(/1枚の画像をZIP形式で保存します/)).toBeTruthy()
})
