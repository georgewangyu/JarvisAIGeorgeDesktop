import { describe, expect, it } from 'vitest'

import type { SessionDotState } from '@/store/session-dot-state'
import type { SessionInfo } from '@/types/hermes'

import { buildConsumerActivityRows } from './consumer-activity'

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
      { id: 'input', status: 'needs-input', title: 'Book dinner' },
      { id: 'working', status: 'working', title: 'Trip planning' },
      { id: 'done', status: 'unread', title: 'Finished plan' }
    ])
  })

  it('orders equal states by recency and limits the surface', () => {
    const sessions = Array.from({ length: 8 }, (_, index) => session(`s${index}`, `Chat ${index}`, index))
    const states = Object.fromEntries(sessions.map(item => [item.id, 'working' as const]))

    expect(buildConsumerActivityRows(sessions, states).map(row => row.id)).toEqual(['s7', 's6', 's5', 's4', 's3', 's2'])
  })
})
