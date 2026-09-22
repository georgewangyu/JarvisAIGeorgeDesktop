import { useEffect, useState } from 'react'

import { getSessionMessages } from '@/api/sessions'
import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { useJarvisCopy } from '@/i18n/jarvis'
import { chatMessageText, toChatMessages } from '@/lib/chat-messages'
import type { SessionInfo, SessionMessage } from '@/types/hermes'

// Reuse transcript hydration (including Codex sidecars), but only expose the
// final assistant answer. Scheduler instructions, tools and reasoning stay
// in the original session, not in a consumer automation's result card.
export function automationAnswer(messages: SessionMessage[]): string {
  const answers = toChatMessages(messages)
    .filter(message => message.role === 'assistant')
    .map(chatMessageText)
    .filter(text => text.trim())

  const final = answers.at(-1)?.trim() ?? ''

  return final === '[SILENT]' ? '' : final.replace(/^\[CRON_FAILURE\]\s*/, '')
}

export function AutomationRunResult({ run }: { run: SessionInfo }) {
  const { t } = useI18n()
  const s = useJarvisCopy()
  const [answer, setAnswer] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setAnswer(null)
    setError(false)
    void getSessionMessages(run.id, run.profile, { limit: 100, order: 'latest' }, { passive: true })
      .then(result => {
        if (!cancelled) {
          setAnswer(automationAnswer(result.messages))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [run.id, run.profile, attempt])

  return (
    <div aria-label={s.runResult} className="my-3 rounded-xl bg-(--ui-bg-secondary) p-5" role="region">
      {error ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{s.runError}</p>
          <Button onClick={() => setAttempt(value => value + 1)} variant="secondary">
            {t.common.retry}
          </Button>
        </div>
      ) : answer === null ? (
        <Codicon name="loading" spinning />
      ) : answer ? (
        <MarkdownTextContent isRunning={false} previewOnly text={answer} />
      ) : (
        <p className="text-sm text-muted-foreground">{s.runEmpty}</p>
      )}
    </div>
  )
}
