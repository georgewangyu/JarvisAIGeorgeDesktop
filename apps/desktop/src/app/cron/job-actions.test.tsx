import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useI18n } from '@/i18n'

import { JobActions } from './job-actions'

afterEach(cleanup)

function Fixture({
  state,
  busy = false,
  onTrigger = vi.fn(),
  onPauseResume = vi.fn()
}: {
  state: string
  busy?: boolean
  onTrigger?: () => void
  onPauseResume?: () => void
}) {
  const { t } = useI18n()

  return <JobActions busy={busy} c={t.cron} onPauseResume={onPauseResume} onTrigger={onTrigger} state={state} />
}

it('offers an explicit rerun instead of pause for completed automations', () => {
  const onTrigger = vi.fn()
  render(<Fixture onTrigger={onTrigger} state="completed" />)
  expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Run again' }))
  expect(onTrigger).toHaveBeenCalledOnce()
})

it('keeps scheduled controls usable and blocks duplicate running actions', () => {
  const onPauseResume = vi.fn()
  const { rerender } = render(<Fixture onPauseResume={onPauseResume} state="paused" />)
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
  expect(onPauseResume).toHaveBeenCalledOnce()
  rerender(<Fixture state="running" />)
  expect((screen.getByRole('button', { name: 'Trigger now' }) as HTMLButtonElement).disabled).toBe(true)
})
