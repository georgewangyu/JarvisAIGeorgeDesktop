import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClientSessionState } from '@/lib/chat-runtime'
import { $approvalRecoveryReceipts, dismissApprovalRecovery, noteApprovalPending, reconcileApprovalRecovery } from '@/store/approval-recovery'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { _resetSessionOwnerHintsForTests, setSessionOwnerHint } from '@/store/session'
import type { SessionDotState } from '@/store/session-dot-state'
import { clearAllSessionStates, publishSessionState } from '@/store/session-states'
import type { SessionInfo } from '@/types/hermes'

import { buildConsumerActivityRows, buildUnavailableApprovalRows, ConsumerActivity, consumerChatCue, openConsumerActivityRow } from './consumer-activity'

afterEach(() => {
  cleanup()
  $gateway.set(null as never)
  $activeGatewayProfile.set('default')
  clearAllSessionStates()
  dismissApprovalRecovery({ connectionId: 'local', profile: 'default' }, 'approval-chat')
  dismissApprovalRecovery({ connectionId: 'remote', profile: 'default' }, 'approval-chat')
  dismissApprovalRecovery({ connectionId: 'local', profile: 'default' }, 'worker-chat')
  _resetSessionOwnerHintsForTests({ storage: true })
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
  it('lights only the owning connection for a consumer approval needing input', () => {
    const local = { connectionId: 'local', profile: 'default' }
    const remote = { connectionId: 'remote', profile: 'default' }
    const visible = { ...session('approval-chat', 'Plan a trip', 10), connection_id: 'local', profile: 'default' }
    const worker = { ...session('worker-chat', 'Private worker', 9), connection_id: 'local', profile: 'default', source: 'subagent' }
    const states: Record<string, SessionDotState> = { 'approval-chat': 'needs-input', 'worker-chat': 'needs-input' }

    expect(consumerChatCue([worker, visible], states, [], local.connectionId, local.profile)).toBe('needs-input')
    expect(consumerChatCue([worker, visible], states, [], remote.connectionId, remote.profile)).toBeNull()
    expect(consumerChatCue([worker], states, [], local.connectionId, local.profile)).toBeNull()
    expect(consumerChatCue([visible], states, [], null, local.profile)).toBeNull()
    expect(consumerChatCue([visible], { 'approval-chat': 'working' }, [], local.connectionId, local.profile)).toBeNull()
    expect(consumerChatCue([visible], { 'approval-chat': 'unread' }, [], local.connectionId, local.profile)).toBe('unread')
    expect(consumerChatCue([worker, visible], { 'worker-chat': 'unread' }, [], local.connectionId, local.profile)).toBeNull()
    expect(consumerChatCue([worker, visible], { 'approval-chat': 'unread', 'worker-chat': 'needs-input' }, [], local.connectionId, local.profile)).toBe('unread')
    expect(consumerChatCue([visible], { 'approval-chat': 'needs-input' }, [], local.connectionId, local.profile)).toBe('needs-input')
  })

  it('links an unavailable approval only to its exact visible owner', () => {
    const visible = session('approval-chat', 'Plan a trip', 10)
    const worker = { ...session('worker-chat', 'Private worker', 9), source: 'subagent' }
    const local = { connectionId: 'local', profile: 'default' }
    const remote = { connectionId: 'remote', profile: 'default' }
    setSessionOwnerHint(visible.id, local)
    setSessionOwnerHint(worker.id, local)
    noteApprovalPending(local, visible.id, visible.id, 'request-local')
    noteApprovalPending(remote, visible.id, visible.id, 'request-remote')
    noteApprovalPending(local, worker.id, worker.id, 'request-worker')
    reconcileApprovalRecovery(local, visible.id, new Set())
    reconcileApprovalRecovery(remote, visible.id, new Set())
    reconcileApprovalRecovery(local, worker.id, new Set())

    const rows = buildUnavailableApprovalRows([worker, visible], $approvalRecoveryReceipts.get())
    expect(rows).toEqual([{
      id: visible.id, title: 'Plan a trip', connectionId: 'local', profile: 'default', session: visible
    }])

    const onOpenChat = vi.fn()
    render(<ConsumerActivity onOpenAutomations={vi.fn()} onOpenChat={onOpenChat} sessions={[worker, visible]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Jarvis activity' }))
    expect(screen.getByText('Approval no longer available · Review chat before retrying')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Plan a trip/ }))
    expect(onOpenChat).toHaveBeenCalledWith(visible.id, visible)
  })

  it('finds the exact approval owner when a foreign chat has the same stored id first', () => {
    const foreign = { ...session('shared-id', 'Foreign chat', 20), connection_id: 'remote', profile: 'default' }
    const local = { ...session('shared-id', 'My chat', 10), connection_id: 'local', profile: 'default' }

    const receipt = {
      connectionId: 'local', profile: 'default', storedSessionId: 'shared-id',
      runtimeSessionId: 'runtime-local', requestId: 'request-local',
      state: 'interrupted' as const, seenAt: 1
    }

    expect(buildUnavailableApprovalRows([foreign, local], [receipt])).toEqual([{
      id: 'shared-id', title: 'My chat', connectionId: 'local', profile: 'default', session: local
    }])

    expect(buildUnavailableApprovalRows([foreign, local, { ...local }], [receipt])).toEqual([])

    const foreignReceipt = { ...receipt, connectionId: 'remote', requestId: 'request-remote', seenAt: 2 }
    expect(buildUnavailableApprovalRows([foreign, local], [receipt, foreignReceipt])).toEqual([
      { id: 'shared-id', title: 'Foreign chat', connectionId: 'remote', profile: 'default', session: foreign },
      { id: 'shared-id', title: 'My chat', connectionId: 'local', profile: 'default', session: local }
    ])

    const onOpenChat = vi.fn()
    act(() => $approvalRecoveryReceipts.set([receipt, foreignReceipt]))
    render(<ConsumerActivity onOpenAutomations={vi.fn()} onOpenChat={onOpenChat} sessions={[foreign, local]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Jarvis activity' }))
    fireEvent.click(screen.getByRole('button', { name: /My chat/ }))
    expect(onOpenChat).toHaveBeenCalledWith('shared-id', local)
    act(() => $approvalRecoveryReceipts.set([]))
  })

  it('opens the owning visible chat when a live approval needs input, then clears attention', async () => {
    const openChat = vi.fn()
    const visible = session('approval-chat', 'Plan a trip', 10)

    const pending = {
      ...createClientSessionState(null), storedSessionId: visible.id, busy: true, needsInput: true
    }

    act(() => publishSessionState('approval-runtime', pending))
    render(<ConsumerActivity onOpenAutomations={vi.fn()} onOpenChat={openChat} sessions={[visible]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Jarvis activity' }))
    expect(await screen.findByText('Plan a trip')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Plan a trip/ }))
    expect(openChat).toHaveBeenCalledWith(visible.id, visible)

    act(() => publishSessionState('approval-runtime', { ...pending, busy: false, needsInput: false }))
    await waitFor(() => expect(screen.getByText('New update')).toBeTruthy())
    expect(screen.queryByText('Needs your input')).toBeNull()
  })

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

  it('does not promote model-authored previews into durable Activity labels', () => {
    const preview = 'I delegated this to worker alpha'
    const chat = { ...session('untitled-chat', '', 10), preview }
    const automation = { ...session('untitled-run', '', 9), preview, source: 'cron' }
    const worker = { ...session('untitled-run', 'Worker alpha', 8), source: 'subagent' }

    const states: Record<string, SessionDotState> = {
      'untitled-chat': 'unread', 'untitled-run': 'unread'
    }

    expect(buildConsumerActivityRows([chat, worker], states, [automation])).toEqual([
      { id: 'untitled-chat', kind: 'chat', status: 'unread', title: 'Jarvis chat' },
      { id: 'untitled-run', kind: 'automation', status: 'unread', title: 'Scheduled update' }
    ])

    const local = { connectionId: 'local', profile: 'default' }
    setSessionOwnerHint(chat.id, local)
    expect(buildUnavailableApprovalRows([chat], [{
      ...local, storedSessionId: chat.id, runtimeSessionId: chat.id,
      requestId: 'pending', state: 'interrupted', seenAt: 1
    }])[0]?.title).toBe('Jarvis chat')
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

  it('does not guess an Activity owner when two consumer chats share a stored id', () => {
    const foreign = { ...session('shared-id', 'Foreign chat', 20), connection_id: 'remote', profile: 'default' }
    const local = { ...session('shared-id', 'My chat', 10), connection_id: 'local', profile: 'default' }
    const openChat = vi.fn()

    expect(buildConsumerActivityRows([foreign, local], { 'shared-id': 'unread' })).toEqual([])

    render(<ConsumerActivity onOpenAutomations={vi.fn()} onOpenChat={openChat} sessions={[foreign, local]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Jarvis activity' }))
    expect(screen.queryByRole('button', { name: /Foreign chat|My chat/ })).toBeNull()
    expect(openChat).not.toHaveBeenCalled()
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

  it('does not show an old profile review failure after switching profiles', async () => {
    let rejectOldReview: (error: Error) => void = () => {}

    const request = vi.fn((method: string, params: { profile: string }) => {
      if (method === 'jarvis.events.interrupted') {
        return Promise.resolve({
          events: [{ delivery_id: `${params.profile}-event`, claimed_at: 1, status: 'outcome_unknown' }]
        })
      }

      if (method === 'jarvis.events.review' && params.profile === 'default') {
        return new Promise((_resolve, reject) => {rejectOldReview = reject})
      }

      if (method === 'jarvis.events.review') {
        return Promise.resolve({
          delivery_id: 'other-event', message: 'Current profile request', review_digest: 'current', status: 'outcome_unknown'
        })
      }

      throw new Error('Unexpected request')
    })

    $gateway.set({ request } as never)
    render(<ConsumerActivity onOpenAutomations={vi.fn()} onOpenChat={vi.fn()} sessions={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Jarvis activity' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review request' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('jarvis.events.review', {
      profile: 'default', delivery_id: 'default-event'
    }))

    act(() => $activeGatewayProfile.set('other'))
    fireEvent.click(await screen.findByRole('button', { name: 'Review request' }))
    expect(await screen.findByText('Current profile request')).toBeTruthy()

    await act(async () => {rejectOldReview(new Error('Old profile failed'))})
    expect(screen.getByText('Current profile request')).toBeTruthy()
    expect(screen.queryByText('Could not load the original request. Please try again.')).toBeNull()
  })
})
