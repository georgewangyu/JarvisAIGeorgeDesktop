import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { type FeedEdition, generateFeedEdition, getFeedEditions } from '@/api/feed'
import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ExternalLink } from '@/lib/external-link'
import { stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $activeGatewayProfile, requestFreshSession } from '@/store/profile'
import { $connection } from '@/store/session'

import { feedEditionLovedKey, readLovedFeedEditions, setFeedEditionLoved } from './feed/edition-feedback'
import { groupFeedEditionsByDay } from './feed/group-editions'
import { readFeedPrompt, saveFeedPrompt } from './feed/prompt'
import { CONNECTIONS_ROUTE, NEW_CHAT_ROUTE } from './routes'

function feedFailureCopy(item: FeedEdition): string {
  if (item.error?.includes('[blocked_config]')) {
    return 'Connect an AI account in Connections before generating a briefing.'
  }

  if (item.status === 'denied') {
    return 'Jarvis needs access to prepare this briefing. Review Connections, then try again.'
  }

  if (item.status === 'interrupted') {
    return 'This briefing was interrupted. Try again when you’re ready.'
  }

  return 'This briefing did not finish. Check your connection and try again.'
}

function feedRetrievalCopy(item: FeedEdition, url: string): string {
  if (!Array.isArray(item.retrieved_source_urls)) {
    return 'Retrieval status unavailable'
  }

  return item.retrieved_source_urls.includes(url)
    ? 'Page content retrieved; claims not verified'
    : 'Page content not retrieved'
}

export function ConsumerFeedEditions() {
  const navigate = useNavigate()
  const profile = useStore($activeGatewayProfile)
  const connection = useStore($connection)
  const connectionId = connection?.mode === 'remote' ? (connection.connectionId || connection.baseUrl) : null
  const scope = feedEditionLovedKey(profile, connectionId)
  const activeScope = useRef(scope)
  activeScope.current = scope
  const [promptSnapshot, setPromptSnapshot] = useState(() => ({ scope, value: readFeedPrompt(profile, connectionId) }))
  const prompt = promptSnapshot.scope === scope ? promptSnapshot.value : readFeedPrompt(profile, connectionId)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [promptDraft, setPromptDraft] = useState(prompt)
  const [promptError, setPromptError] = useState('')
  const [lovedSnapshot, setLovedSnapshot] = useState(() => ({ scope, ids: readLovedFeedEditions(profile, connectionId) }))
  const lovedEditions = lovedSnapshot.scope === scope ? lovedSnapshot.ids : readLovedFeedEditions(profile, connectionId)
  const [feedbackError, setFeedbackError] = useState('')
  const [snapshot, setSnapshot] = useState<{ items: FeedEdition[]; scope: string }>({ items: [], scope })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | { kind: 'load' | 'generate'; message: string; prompt?: string; retry?: FeedEdition }>(null)
  const [refresh, setRefresh] = useState(0)
  const items = snapshot.scope === scope ? snapshot.items : []
  const generating = items.some(item => item.status === 'generating')

  useEffect(() => {
    setPromptSnapshot({ scope, value: readFeedPrompt(profile, connectionId) })
    setPromptDraft(readFeedPrompt(profile, connectionId))
    setPromptError('')
    setEditingPrompt(false)
    setLovedSnapshot({ scope, ids: readLovedFeedEditions(profile, connectionId) })
    setFeedbackError('')
    setBusy(false)
    setError(null)
  }, [connectionId, profile, scope])

  useEffect(() => {
    let cancelled = false

    setLoading(true)
    void getFeedEditions(profile)
      .then(editions => {
        if (!cancelled) {
          setSnapshot({ items: editions, scope })
          setError(null)
        }
      })
      .catch(() => {
        if (!cancelled) {setError({ kind: 'load', message: 'Could not load Feed editions. Check your connection and try again.' })}
      })
      .finally(() => {
        if (!cancelled) {setLoading(false)}
      })

    return () => { cancelled = true }
  }, [connectionId, profile, refresh, scope])

  useEffect(() => {
    if (!generating || loading) {return}

    // Only poll while an explicitly requested edition is running. Idle Feed
    // has no timer, network churn or model calls.
    const timer = window.setTimeout(() => setRefresh(value => value + 1), 2000)

    return () => window.clearTimeout(timer)
  }, [generating, loading, refresh])

  const generate = async (retry?: FeedEdition, failedPrompt?: string) => {
    const text = retry?.prompt ?? failedPrompt ?? prompt.trim()

    if (!text || busy || generating) {return}

    setBusy(true)
    setError(null)

    try {
      const edition = await generateFeedEdition(profile, text, retry?.id, retry ? [] : lovedEditions)

      if (activeScope.current !== scope) {return}

      setSnapshot(current => ({
        items: [edition, ...(current.scope === scope ? current.items : []).filter(item => item.id !== edition.id)],
        scope
      }))
    } catch {
      if (activeScope.current === scope) {
        setError({
          kind: 'generate',
          message: 'Could not start this Feed edition. Check your connection and try again.',
          prompt: text,
          retry
        })
      }
    } finally {
      if (activeScope.current === scope) {setBusy(false)}
    }
  }

  const editPrompt = () => {
    setPromptDraft(prompt)
    setPromptError('')
    setEditingPrompt(true)
  }

  const savePrompt = () => {
    if (!saveFeedPrompt(profile, connectionId, promptDraft)) {
      setPromptError('Could not save Feed instructions on this Mac. Check the text and try again.')

      return
    }

    setPromptSnapshot({ scope, value: promptDraft.trim() })
    setEditingPrompt(false)
    setPromptError('')
  }

  const toggleLove = (editionId: string) => {
    const loved = !lovedEditions.includes(editionId)

    if (!setFeedEditionLoved(profile, connectionId, editionId, loved)) {
      setFeedbackError('Could not save that choice on this Mac. Please try again.')

      return
    }

    setLovedSnapshot({ scope, ids: readLovedFeedEditions(profile, connectionId) })
    setFeedbackError('')
  }

  const discuss = (edition: FeedEdition) => {
    if (!edition.content) {return}

    const current = takeSessionDraft(null)
    const context = edition.content.slice(0, 4000)
    const next = `Help me think through this Feed edition:\n\n${context}`

    stashSessionDraft(null, current.text.trim() ? `${current.text.trimEnd()}\n\n${next}` : next, current.attachments)
    requestFreshSession()
    navigate(NEW_CHAT_ROUTE)
  }

  return (
    <section aria-label="Feed editions" className="space-y-5">
      <div className="rounded-3xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) px-6 py-6 shadow-sm">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-(--ui-text-tertiary)">Your Feed instructions</h2>
        <p className="mt-5 whitespace-pre-wrap text-base leading-7 text-(--ui-text-primary)">{prompt}</p>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-(--ui-text-tertiary)">Generated claims and links need your review.</span>
          <div className="flex gap-2">
            <Button onClick={editPrompt} size="sm" variant="secondary">Edit</Button>
            <Button disabled={busy || generating} onClick={() => void generate()} size="sm">
              {busy || generating ? 'Generating…' : 'Generate'}
            </Button>
          </div>
        </div>
        <p className="mt-4 text-xs text-(--ui-text-tertiary)">Loved briefings can guide the next generation when you choose Generate. You can undo Love at any time.</p>
      </div>
      <Dialog onOpenChange={setEditingPrompt} open={editingPrompt}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Feed instructions</DialogTitle>
            <DialogDescription>Choose what Jarvis should cover in future briefings. This preference stays on this Mac for this profile.</DialogDescription>
          </DialogHeader>
          <label className="text-sm font-medium" htmlFor="feed-generation-prompt">What should your Feed cover?</label>
          <textarea
            className="min-h-40 w-full resize-y rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) p-4 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-primary"
            id="feed-generation-prompt"
            maxLength={8000}
            onChange={event => setPromptDraft(event.target.value)}
            value={promptDraft}
          />
          {promptError && <p className="text-sm text-destructive" role="alert">{promptError}</p>}
          <DialogFooter>
            <Button onClick={() => setEditingPrompt(false)} variant="secondary">Cancel</Button>
            <Button disabled={!promptDraft.trim() || promptDraft.trim() === prompt} onClick={savePrompt}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {error && <div className="flex items-center gap-3 text-sm text-destructive" role="alert">
        <span>{error.message}</span>
        <Button
          disabled={busy || generating}
          onClick={() => error.kind === 'load' ? setRefresh(value => value + 1) : void generate(error.retry, error.prompt)}
          size="sm"
          variant="text"
        >
          {error.kind === 'load' ? 'Retry load' : 'Try again'}
        </Button>
      </div>}
      {feedbackError && <p className="text-sm text-destructive" role="alert">{feedbackError}</p>}
      {loading && items.length === 0 ? <p className="text-sm text-(--ui-text-tertiary)" role="status">Loading briefings…</p> : null}
      {!loading && items.length === 0 && !error ? <p className="text-sm text-(--ui-text-tertiary)">No briefings yet. Generate one when you’re ready.</p> : null}
      {groupFeedEditionsByDay(items).map(day => (
        <section aria-label={day.label} className="pt-4" key={day.key}>
          <h2 className="border-b border-(--ui-stroke-tertiary) pb-3 text-xs font-semibold uppercase tracking-[0.14em] text-(--ui-text-tertiary)">{day.label}</h2>
          <div className="divide-y divide-(--ui-stroke-tertiary)">
            {day.editions.map(item => (
              <article className="py-7 first:pt-6" key={item.id}>
                <div className="flex items-center justify-between gap-4 text-xs text-(--ui-text-tertiary)">
                  <span className="font-medium">Jarvis briefing</span>
                  <span>{item.status === 'generating' ? 'Working' : item.status === 'completed' ? 'Ready' : item.status === 'interrupted' ? 'Interrupted' : item.status === 'denied' ? 'Needs access' : 'Failed'}</span>
                </div>
                <h3 className="mt-3 line-clamp-2 text-xl font-semibold leading-snug tracking-tight text-(--ui-text-primary)">{item.prompt}</h3>
                {(item.feedback_applied_count ?? 0) > 0 ? <p className="mt-2 text-xs text-(--ui-text-tertiary)">Guided by {item.feedback_applied_count} loved {item.feedback_applied_count === 1 ? 'briefing' : 'briefings'}</p> : null}
                {item.status === 'completed' && item.content ? <>
                  <p className="mt-4 text-xs text-(--ui-text-tertiary)">Sources have not been verified. Links in this generated briefing may be inaccurate.</p>
                  {item.source_urls.length > 0 ? <div className="mt-2 text-xs text-(--ui-text-tertiary)">
                    <p>Links mentioned in this generated briefing:</p>
                    <ul aria-label="Generated briefing links and retrieval status" className="mt-1 list-inside list-disc break-all">
                      {item.source_urls.map(url => <li key={url}><ExternalLink href={url}>{url}</ExternalLink> — {feedRetrievalCopy(item, url)}</li>)}
                    </ul>
                  </div> : null}
                  {/* Generated prose is passive until the user chooses a listed source.
                      Rich transcript links fetch titles and embeds on mount. */}
                  <div className="mt-3 text-sm leading-7"><MarkdownTextContent isRunning={false} previewOnly text={item.content} /></div>
                </> : null}
                {item.status === 'generating' ? <p className="mt-5 text-sm text-(--ui-text-secondary)" role="status">Jarvis is preparing this briefing…</p> : null}
                {(item.status === 'failed' || item.status === 'interrupted' || item.status === 'denied') && <p className="mt-5 text-sm text-destructive" role="alert">{feedFailureCopy(item)}</p>}
                <div className="mt-5 flex gap-3">
                  {item.status === 'completed' && <Button aria-pressed={lovedEditions.includes(item.id)} onClick={() => toggleLove(item.id)} size="sm" variant="text">{lovedEditions.includes(item.id) ? 'Loved' : 'Love'}</Button>}
                  {item.status === 'completed' && <Button onClick={() => discuss(item)} size="sm" variant="textStrong">Discuss</Button>}
                  {(item.status === 'failed' || item.status === 'interrupted' || item.status === 'denied') && <Button disabled={busy || generating} onClick={() => void generate(item)} size="sm" variant="textStrong">Try again</Button>}
                  {(item.status === 'failed' || item.status === 'denied') && item.error?.includes('[blocked_config]') && <Button onClick={() => navigate(CONNECTIONS_ROUTE)} size="sm" variant="text">Connections</Button>}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </section>
  )
}
