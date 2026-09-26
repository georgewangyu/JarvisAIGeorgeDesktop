import { describe, expect, it } from 'vitest'

import { toChatMessages } from './hydration'

describe('durable turn failure hydration', () => {
  it('restores the classified failure card from saved assistant metadata only', () => {
    const messages = toChatMessages([
      { role: 'user', content: 'try it' },
      {
        role: 'assistant',
        content: 'Details: format refused',
        display_metadata: {
          turn_failure: { layer: 'provider', code: 'format_error', retryable: false, provider: 'openai' }
        }
      },
      { role: 'assistant', content: 'later successful reply' }
    ])

    expect(messages[1].errorSurface).toMatchObject({ layer: 'provider', code: 'format_error', retryable: false })
    expect(messages[1].error).toContain('format refused')
    expect(messages[2].errorSurface).toBeUndefined()
    expect(messages[2].error).toBeUndefined()
  })

  it('ignores malformed and non-assistant markers', () => {
    const messages = toChatMessages([
      { role: 'user', content: 'text', display_metadata: { turn_failure: { layer: 'provider' } } },
      { role: 'assistant', content: 'ok', display_metadata: { turn_failure: { layer: 'unknown', code: 'x' } } }
    ])

    expect(messages.every(message => !message.error)).toBe(true)
  })

  it('shows a classified initialization failure without a second raw text bubble', () => {
    const messages = toChatMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'No inference provider is configured.', display_metadata: {
        turn_failure: { layer: 'runtime', code: 'agent_init_failed', retryable: true }
      } }
    ])

    expect(messages).toHaveLength(2)
    expect(messages[1].parts).toEqual([])
    expect(messages[1].error).toBe('No inference provider is configured.')
    expect(messages[1].errorSurface?.code).toBe('agent_init_failed')
  })
})
