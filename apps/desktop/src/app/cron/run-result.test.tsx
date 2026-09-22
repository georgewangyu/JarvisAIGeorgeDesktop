import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { getSessionMessages } from '@/api/sessions'
import type { SessionInfo } from '@/types/hermes'

import { automationAnswer, AutomationRunResult } from './run-result'

vi.mock('@/api/sessions', () => ({ getSessionMessages: vi.fn() }))
vi.mock('@/components/assistant-ui/markdown-text', () => ({
  MarkdownTextContent: ({ text }: { text: string }) => <p>{text}</p>
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('shows assistant output without leaking prompts, tools or reasoning', () => {
  const answer = automationAnswer([
    { role: 'user', content: 'Internal scheduler instruction' },
    { role: 'tool', content: 'Private raw result', tool_call_id: 't1' },
    { role: 'assistant', content: 'Ready for your day.', reasoning: 'Private reasoning' }
  ])

  expect(answer).toBe('Ready for your day.')
  expect(automationAnswer([{ role: 'assistant', content: '[SILENT]' }])).toBe('')
})

it('retries a failed read against the run owner instead of the active chat', async () => {
  vi.mocked(getSessionMessages)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({
      session_id: 'run-one',
      messages: [{ role: 'assistant', content: 'Done' }]
    })
  render(<AutomationRunResult run={{ id: 'run-one', profile: 'owner' } as SessionInfo} />)
  await screen.findByText('Could not load this result. Try again.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Done')
  expect(getSessionMessages).toHaveBeenLastCalledWith(
    'run-one',
    'owner',
    { limit: 100, order: 'latest' },
    { passive: true }
  )
})

it('refreshes an expanded result when its run receives a completion update', async () => {
  vi.mocked(getSessionMessages).mockResolvedValueOnce({ session_id: 'run-one', messages: [] })
  const run = { id: 'run-one', profile: 'owner', last_active: 1, message_count: 1, is_active: true } as SessionInfo
  const { rerender } = render(<AutomationRunResult run={run} />)
  await screen.findByText('No new update from this run.')
  vi.mocked(getSessionMessages).mockResolvedValueOnce({
    session_id: 'run-one',
    messages: [{ role: 'assistant', content: 'Finished in the background' }]
  })
  rerender(<AutomationRunResult run={{ ...run, last_active: 2, message_count: 2, is_active: false }} />)
  await screen.findByText('Finished in the background')
  expect(getSessionMessages).toHaveBeenCalledTimes(2)
})
