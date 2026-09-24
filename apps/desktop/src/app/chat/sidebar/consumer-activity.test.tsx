import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import type { SessionDotState } from '@/store/session-dot-state'
import type { SessionInfo } from '@/types/hermes'

import { buildConsumerActivityRows, ConsumerActivity, openConsumerActivityRow } from './consumer-activity'

afterEach(() => {
  cleanup()
  $gateway.set(null as never)
  $activeGatewayProfile.set('default')
})

const session = (id: string, title: string, lastActive: number): SessionInfo => ({
  ended_at: null,
  id,
  input_tokens: 0,
  is_active: false,
  last_active: lastActive,
  message_count: 1,
  model: null,
  output_tokens: 0,
  preview: null,
  source: 'desktop',
  started_at: lastActive,
  title,
  tool_call_count: 0
})

describe('consumer activity rows', () => {
  it('shows only meaningful consumer states in priority order', () => {
    const sessions = [
      session('idle', 'Idle chat', 9),
      session('done', 'Finished plan', 7),
      session('working', 'Trip planning', 8),
      session('input', 'Book dinner', 6)
    ]

    const states: Record<string, SessionDotState> = {
      done: 'unread',
      idle: 'idle',
      input: 'needs-input',
      working: 'background'
    }

    expect(buildConsumerActivityRows(sessions, states)).toEqual([
      { id: 'input', kind: 'chat', status: 'needs-input', title: 'Book dinner' },
      { id: 'working', kind: 'chat', status: 'working', title: 'Trip planning' },
      { id: 'done', kind: 'chat', status: 'unread', title: 'Finished plan' }
    ])
  })

  it('orders equal states by recency and limits the surface', () => {
    const sessions = Array.from({ length: 8 }, (_, index) => session(`s${index}`, `Chat ${index}`, index))
    const states = Object.fromEntries(sessions.map(item => [item.id, 'working' as const]))

    expect(buildConsumerActivityRows(sessions, states).map(row => row.id)).toEqual(['s7', 's6', 's5', 's4', 's3', 's2'])
  })

  it('includes scheduled runs as automations without exposing their runtime source', () => {
    const automation = session('cron-run', 'Morning briefing', 10)

    expect(buildConsumerActivityRows([], { 'cron-run': 'unread' }, [automation])).toEqual([
      { id: 'cron-run', kind: 'automation', status: 'unread', title: 'Morning briefing' }
    ])
  })

  it('never exposes worker or messaging rows if they enter recents optimistically', () => {
    const hidden = [
      { ...session('child', 'Private worker task', 10), source: 'subagent' },
      { ...session('tool', 'Shell command', 9), source: 'tool' },
      { ...session('message', 'Personal message', 8), source: 'telegram' },
      { ...session('cron', 'Technical cron run', 7), source: 'cron' }
    ]

    const states = Object.fromEntries(hidden.map(row => [row.id, 'needs-input' as const]))

    expect(buildConsumerActivityRows(hidden, states)).toEqual([])
  })

  it('routes automation rows to Automations and chat rows to their visible chat', () => {
    const openChat = vi.fn()
    const openAutomations = vi.fn()
    const visibleChat = session('chat', 'Trip planning', 1)

    openConsumerActivityRow(
      { id: 'cron_morning_brief_20260923_090000', kind: 'automation', status: 'working', title: 'Morning briefing' },
      undefined,
      openChat,
      openAutomations,
      [{ id: 'morning_brief', enabled: true }]
    )
    openConsumerActivityRow(
      { id: 'chat', kind: 'chat', status: 'working', title: 'Trip planning' },
      visibleChat,
      openChat,
      openAutomations
    )

    expect(openAutomations).toHaveBeenCalledWith('morning_brief')
    expect(openChat).toHaveBeenCalledWith('chat', visibleChat)
  })

  it('opens generic Automations rather than guessing an unknown or ambiguous owner', () => {
    const openAutomations = vi.fn()
    const row = { id: 'cron_unknown_20260923_090000', kind: 'automation' as const, status: 'working' as const, title: 'Run' }

    openConsumerActivityRow(row, undefined, vi.fn(), openAutomations, [{ id: 'known', enabled: true }])
    expect(openAutomations).toHaveBeenCalledWith(null)
  })
})

describe('interrupted activity', () => {
  it('reports a settled reviewed retry without presenting another retry action', async () => {
    const request = vi.fn(async () => ({
      events: [{ delivery_id: 'synthetic', claimed_at: 1, status: 'outcome_unknown', retry_status: 'settled' }]
    }))

    $gateway.set({ request } as never)
    render(<ConsumerActivity onOpenAutomations={vi.fn()} onOpenChat={vi.fn()} sessions={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Jarvis activity' }))

    expect(await screen.findByText('Reviewed retry finished')).toBeTruthy()
    expect(screen.getByText(/original outcome remains unknown/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Review request' })).toBeNull()
  })

  it('requires review and acknowledgement before a single explicit retry', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'jarvis.events.interrupted') {
        return { events: [{ delivery_id: 'synthetic', claimed_at: 1, status: 'outcome_unknown' }] }
      }

      if (method === 'jarvis.events.review') {
        return { delivery_id: 'synthetic', message: 'Review this exact request', review_digest: 'digest', status: 'outcome_unknown' }
      }

      if (method === 'jarvis.events.retry') {
        return { delivery_id: 'retry-id', status: 'queued' }
      }

      throw new Error('Unexpected request')
    })

    $gateway.set({ request } as never)
    render(<ConsumerActivity onOpenAutomations={vi.fn()} onOpenChat={vi.fn()} sessions={[]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Jarvis activity' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review request' }))
    expect(await screen.findByText('Review this exact request')).toBeTruthy()
    expect(request).not.toHaveBeenCalledWith('jarvis.events.retry', expect.anything())
    const retry = screen.getByRole('button', { name: 'Retry this request' })
    expect((retry as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox', { name: /I understand retrying may repeat actions/ }))
    fireEvent.click(retry)
    await waitFor(() => expect(request).toHaveBeenCalledWith('jarvis.events.retry', {
      profile: 'default', delivery_id: 'synthetic', review_digest: 'digest'
    }))
    expect(await screen.findByText('Retry queued. The outcome is not yet known.')).toBeTruthy()
    expect((retry as HTMLButtonElement).disabled).toBe(true)
    expect(request).not.toHaveBeenCalledWith('prompt.submit', expect.anything())
  })

  it('warns about an unknown outcome without showing a completed result or replaying it', async () => {
    const request = vi.fn(async () => ({
      events: [{ delivery_id: 'synthetic', claimed_at: 1, status: 'outcome_unknown' }]
    }))

    $gateway.set({ request } as never)

    render(<ConsumerActivity onOpenAutomations={vi.fn()} onOpenChat={vi.fn()} sessions={[]} />)

    await waitFor(() => expect(request).toHaveBeenCalledWith('jarvis.events.interrupted', { profile: 'default' }))
    fireEvent.click(screen.getByRole('button', { name: 'Jarvis activity' }))
    expect(await screen.findByText('Outcome unknown after restart')).toBeTruthy()
    expect(screen.getByText(/nothing was replayed automatically/)).toBeTruthy()
    expect(screen.queryByText('Finished')).toBeNull()
    expect(request).not.toHaveBeenCalledWith('prompt.submit', expect.anything())
  })

  it('offers a retry when the read fails, without inventing a settled state', async () => {
    let shouldFail = true

    const request = vi.fn(async () => {
      if (shouldFail) {throw new Error('temporary')}

      return { events: [] }
    })

    $gateway.set({ request } as never)

    render(<ConsumerActivity onOpenAutomations={vi.fn()} onOpenChat={vi.fn()} sessions={[]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Jarvis activity' }))
    expect(await screen.findByText(/Could not check interrupted activity/)).toBeTruthy()
    shouldFail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3))
    expect(screen.queryByText('Outcome unknown after restart')).toBeNull()
  })

  it('drops an interrupted warning immediately when the active profile changes', async () => {
    const request = vi.fn(async (_method: string, params: { profile: string }) => ({
      events: params.profile === 'default'
        ? [{ delivery_id: 'synthetic', claimed_at: 1, status: 'outcome_unknown' }]
        : []
    }))

    $gateway.set({ request } as never)

    render(<ConsumerActivity onOpenAutomations={vi.fn()} onOpenChat={vi.fn()} sessions={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Jarvis activity' }))
    expect(await screen.findByText('Outcome unknown after restart')).toBeTruthy()

    act(() => $activeGatewayProfile.set('other'))
    await waitFor(() => expect(request).toHaveBeenCalledWith('jarvis.events.interrupted', { profile: 'other' }))
    expect(screen.queryByText('Outcome unknown after restart')).toBeNull()
  })
})
