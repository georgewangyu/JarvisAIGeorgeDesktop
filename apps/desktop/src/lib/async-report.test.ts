import { describe, expect, it } from 'vitest'

import { toChatMessages } from '@/lib/chat-messages/hydration'
import { toRuntimeMessage } from '@/lib/chat-runtime'

const report = '# Report\n\n**Conclusion:** ready\n\n| Task | Status |\n|---|---|\n| probe | ok |'

const envelope = (body: string) =>
  `[ASYNC DELEGATION COMPLETE — probe]\nPrivate instructions\nOriginal goal: private goal\nRole: leaf\n--- RESULT ---\n${body}`

function hydrate(content: string) {
  return toRuntimeMessage(
    toChatMessages([
      {
        role: 'user',
        content,
        display_kind: 'async_delegation_complete',
        display_metadata: { delegation_id: 'probe', task_count: 1 }
      }
    ])[0]
  )
}

function hydrateWithOutcome(displayText: string, completed: number, failed: number) {
  return toRuntimeMessage(toChatMessages([{
    role: 'user',
    content: envelope(report),
    display_kind: 'async_delegation_complete',
    display_metadata: {
      display_text: displayText,
      task_count: 1,
      completed_count: completed,
      failed_count: failed
    }
  }])[0])
}

describe('async report hydration', () => {
  it('marks only repeated attention for the same delegation and failed child', () => {
    const row = (delegationId: string, indexes: number[], notice: boolean) => ({
      role: 'user' as const,
      content: envelope(report),
      display_kind: 'async_delegation_complete',
      display_metadata: {
        delegation_id: delegationId,
        display_text: 'Subagent Task Failed',
        task_count: indexes.length,
        failed_count: indexes.length,
        task_failure_notice: notice,
        failure_task_indexes: indexes,
        all_task_outcomes_known: true
      }
    })

    const messages = toChatMessages([
      row('batch-a', [0], true),
      row('batch-a', [0], true),
      row('batch-a', [0], false),
      row('batch-b', [0], false),
      row('batch-a', [0, 1], false)
    ])

    expect(messages.map(message => message.asyncResultAttentionAlreadyShown ?? false))
      .toEqual([false, true, true, false, false])

    const newFailure = toChatMessages([
      row('batch-a', [0], true),
      row('batch-a', [0, 1], false)
    ])

    expect(newFailure[1].asyncResultAttentionAlreadyShown).toBeUndefined()
  })

  it('carries producer-owned delegation outcome without exposing its goal', () => {
    const done = hydrateWithOutcome('Subagent Task Completed: private goal', 1, 0)
    const failed = hydrateWithOutcome('Subagent Task Failed: private goal', 0, 1)
    const timedOut = hydrateWithOutcome('Subagent Task Timed Out: private goal', 1, 0)

    expect(done.metadata.custom).toMatchObject({ asyncResultKind: 'delegation', asyncResultNeedsAttention: false })
    expect(failed.metadata.custom).toMatchObject({ asyncResultKind: 'delegation', asyncResultNeedsAttention: true })
    expect(timedOut.metadata.custom).toMatchObject({ asyncResultKind: 'delegation', asyncResultNeedsAttention: true })
  })

  it('keeps only result bodies beside compact system metadata across current and legacy deliveries', () => {
    for (const input of [
      envelope(report),
      envelope(
        `Cron job 'probe' (id) finished its manual run.\nResult: ok\nDelivery target: local\n--- JOB OUTPUT ---\n${report}`
      ),
      report
    ]) {
      const message = hydrate(input)
      expect(message.role).toBe('system')
      expect(message.content).toEqual([{ type: 'text', text: '1 background agent finished' }])
      expect(message.metadata.custom.asyncResult).toBe(report)
    }
  })

  it('separates batch result blocks without leaking preambles or transcript plumbing', () => {
    const content = `[ASYNC DELEGATION BATCH COMPLETE — batch]\nPrivate instructions\nRole: leaf\n\n--- ✓ TASK 1/2: private goal  (status=completed) ---\n${report}\nFull live transcript (complete tool/assistant trace): /private/path\n\n--- ✓ TASK 2/2: private goal\nprivate continuation  (status=completed) ---\nPlain result`
    expect(hydrate(content).metadata.custom.asyncResult).toBe(`${report}\n\nPlain result`)
    expect(
      hydrate('[ASYNC DELEGATION COMPLETE — malformed]\nPrivate instructions').metadata.custom.asyncResult
    ).toBeUndefined()
    expect(hydrate('').metadata.custom.asyncResult).toBeUndefined()
  })
})
