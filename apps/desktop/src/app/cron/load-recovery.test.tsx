import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { setCronJobs } from '@/store/cron'

import { CronView } from './index'

const getCronJobs = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiRequestConnection: () => null,
  getAutomationBlueprints: async () => ({ blueprints: [] }),
  getCronJobs: (...args: unknown[]) => getCronJobs(...args),
  getCronJobRuns: async () => []
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

afterEach(() => {
  cleanup()
  setCronJobs([])
  getCronJobs.mockReset()
})

it('shows a retryable error instead of an empty schedule after the first read fails', async () => {
  setCronJobs([])
  getCronJobs
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce([{ id: 'morning', name: 'Morning briefing', enabled: true, state: 'scheduled' }])
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider configClient={null} initialLocale="en">
        <CronView onClose={() => undefined} />
      </I18nProvider>
    </QueryClientProvider>
  )

  await screen.findByText('Failed to load automations')
  expect(screen.queryByText('No automations yet')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findAllByText('Morning briefing')
  expect(screen.queryByText('Failed to load automations')).toBeNull()
  expect(getCronJobs).toHaveBeenCalledTimes(2)
})

it('shows a failed automation without rendering backend paths or credentials', async () => {
  const diagnostic = 'ProviderError: failed at /tmp/private/credentials.json with sk-test-secret'
  getCronJobs.mockResolvedValueOnce([{
    id: 'morning',
    name: 'Morning briefing',
    enabled: true,
    state: 'error',
    last_error: diagnostic
  }])
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider configClient={null} initialLocale="en">
        <CronView onClose={() => undefined} />
      </I18nProvider>
    </QueryClientProvider>
  )

  fireEvent.click((await screen.findAllByText('Morning briefing'))[0])
  await screen.findByText('Last run failed')
  expect(container.textContent).not.toContain(diagnostic)
  expect(container.querySelector(`[title="${diagnostic}"]`)).toBeNull()
})
