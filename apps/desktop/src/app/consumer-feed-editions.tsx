import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { type FeedEdition, generateFeedEdition, getFeedEditions } from '@/api/feed'
import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { Button } from '@/components/ui/button'
import { stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $activeGatewayProfile, requestFreshSession } from '@/store/profile'
import { $connection } from '@/store/session'

import { NEW_CHAT_ROUTE } from './routes'

const DEFAULT_PROMPT = 'Give me a concise briefing about what matters today. Use only information and sources you can actually access. Identify sources when available; if there is not enough information, say so.'

export function ConsumerFeedEditions() {
  const navigate = useNavigate()
  const profile = useStore($activeGatewayProfile)
  const connection = useStore($connection)
  const connectionId = connection?.mode === 'remote' ? (connection.connectionId || connection.baseUrl) : null
  const scope = `${profile}\u0000${connectionId ?? 'local'}`
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [snapshot, setSnapshot] = useState<{ items: FeedEdition[]; scope: string }>({ items: [], scope })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const [refresh, setRefresh] = useState(0)
  const items = snapshot.scope === scope ? snapshot.items : []
  const generating = items.some(item => item.status === 'generating')

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
      .catch(err => {
        if (!cancelled) {setError(err instanceof Error ? err.message : 'Could not load Feed editions.')}
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

  const generate = async (retry?: FeedEdition) => {
    const text = retry?.prompt ?? prompt.trim()

    if (!text || busy || generating) {return}

    setBusy(true)
    setError(null)

    try {
      const edition = await generateFeedEdition(profile, text, retry?.id)

      setSnapshot(current => ({
        items: [edition, ...current.items.filter(item => item.id !== edition.id)],
        scope
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start this Feed edition.')
    } finally {
      setBusy(false)
    }
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
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Your briefing</h2>
        <p className="mt-1 text-sm text-(--ui-text-tertiary)">Write what you want Jarvis to cover. Generate runs your connected AI once and saves the result here.</p>
      </div>
      <div className="rounded-3xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) p-4">
        <label className="sr-only" htmlFor="feed-generation-prompt">What should this briefing cover?</label>
        <textarea
          className="min-h-28 w-full resize-y bg-transparent text-sm leading-6 outline-none placeholder:text-(--ui-text-tertiary)"
          id="feed-generation-prompt"
          maxLength={8000}
          onChange={event => setPrompt(event.target.value)}
          value={prompt}
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-(--ui-text-tertiary)">Check generated claims and links before acting on them.</span>
          <Button disabled={!prompt.trim() || busy || generating} onClick={() => void generate()} size="sm">
            {busy || generating ? 'Generating…' : 'Generate'}
          </Button>
        </div>
      </div>
      {error && <div className="flex items-center gap-3 text-sm text-destructive" role="alert"><span>{error}</span><Button onClick={() => setRefresh(value => value + 1)} size="sm" variant="text">Retry load</Button></div>}
      {loading && items.length === 0 ? <p className="text-sm text-(--ui-text-tertiary)" role="status">Loading briefings…</p> : null}
      {!loading && items.length === 0 && !error ? <p className="text-sm text-(--ui-text-tertiary)">No briefings yet. Generate one when you’re ready.</p> : null}
      {items.map(item => (
        <article className="rounded-3xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) p-5" key={item.id}>
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold">Briefing · {new Date(item.created_at).toLocaleDateString()}</h3>
            <span className="text-xs text-(--ui-text-tertiary)">{item.status === 'generating' ? 'Working' : item.status === 'completed' ? 'Ready' : item.status === 'interrupted' ? 'Interrupted' : item.status === 'denied' ? 'Needs access' : 'Failed'}</span>
          </div>
          <p className="mt-2 text-xs text-(--ui-text-tertiary)">Your prompt: {item.prompt}</p>
          {item.status === 'completed' && item.content ? <div className="mt-4 text-sm leading-6"><MarkdownTextContent isRunning={false} text={item.content} /></div> : null}
          {item.status === 'generating' ? <p className="mt-4 text-sm text-(--ui-text-secondary)" role="status">Jarvis is preparing this briefing…</p> : null}
          {(item.status === 'failed' || item.status === 'interrupted' || item.status === 'denied') && <p className="mt-4 text-sm text-destructive" role="alert">{item.error || 'This briefing did not finish.'}</p>}
          <div className="mt-4 flex gap-3">
            {item.status === 'completed' && <Button onClick={() => discuss(item)} size="sm" variant="textStrong">Discuss</Button>}
            {(item.status === 'failed' || item.status === 'interrupted' || item.status === 'denied') && <Button disabled={busy || generating} onClick={() => void generate(item)} size="sm" variant="textStrong">Try again</Button>}
          </div>
        </article>
      ))}
    </section>
  )
}
