import { expect, it } from 'vitest'

import type { CronJob } from '@/types/hermes'

import { jobFrequencyDisplay } from './job-state'

it('does not describe a completed one-shot with an expired relative time', () => {
  const job: CronJob = {
    id: 'one-shot',
    enabled: false,
    state: 'completed',
    schedule: { kind: 'once', display: 'once in 1 minute' },
    schedule_display: 'once in 1 minute'
  }

  expect(jobFrequencyDisplay(job, 'One time')).toBe('One time')
  expect(jobFrequencyDisplay({ ...job, state: 'scheduled' }, 'One time')).toBe('once in 1 minute')
  expect(
    jobFrequencyDisplay(
      { ...job, schedule: { kind: 'cron', display: 'weekdays at 9am' }, schedule_display: 'weekdays at 9am' },
      'One time'
    )
  ).toBe('weekdays at 9am')
})
