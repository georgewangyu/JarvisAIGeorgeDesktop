import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { exportConsumerChatHistory, exportConsumerLocalData } from '@/hermes'
import { useJarvisCopy } from '@/i18n/jarvis'
import { $connection } from '@/store/session'

export function ConsumerChatExportSettings({ profile }: { profile: string }) {
  const s = useJarvisCopy().chatExport
  const connection = useStore($connection)
  const local = connection?.mode === 'local'
  const request = useRef(0)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [localOpen, setLocalOpen] = useState(false)
  const [localBusy, setLocalBusy] = useState(false)
  const [localError, setLocalError] = useState('')
  const [localResult, setLocalResult] = useState('')

  // An already-open save dialog must not export the previous profile after a switch.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const current = ++request.current

    setOpen(false)
    setBusy(false)
    setError('')
    setResult('')
    setLocalOpen(false)
    setLocalBusy(false)
    setLocalError('')
    setLocalResult('')

    return () => { request.current = current + 1 }
  }, [local, profile])

  async function download() {
    if (!local || busy) {return}
    const pick = window.hermesDesktop?.selectSavePath

    if (!pick) {
      setError(s.saveUnavailable)

      return
    }

    const current = request.current

    setBusy(true)
    setError('')

    try {
      const output = await pick({
        defaultPath: 'Jarvis-chat-history.jsonl',
        filters: [{ extensions: ['jsonl'], name: 'JSON Lines' }],
        title: s.chatSaveTitle
      })

      if (!output || request.current !== current) {return}
      const saved = await exportConsumerChatHistory(profile, output)

      if (request.current !== current) {return}

      if (!saved.ok) {throw new Error('Export was not completed')}
      setResult(s.chatSaved(saved.chats))
      setOpen(false)
    } catch {
      if (request.current === current) {setError(s.chatSaveError)}
    } finally {
      if (request.current === current) {setBusy(false)}
    }
  }

  async function downloadLocalData() {
    if (!local || localBusy) {return}
    const pick = window.hermesDesktop?.selectSavePath

    if (!pick) {
      setLocalError(s.saveUnavailable)

      return
    }

    const current = request.current

    setLocalBusy(true)
    setLocalError('')

    try {
      const output = await pick({
        defaultPath: 'Jarvis-local-data.zip',
        filters: [{ extensions: ['zip'], name: s.zipArchive }],
        title: s.localSaveTitle
      })

      if (!output || request.current !== current) {return}
      const saved = await exportConsumerLocalData(profile, output)

      if (request.current !== current) {return}

      if (!saved.ok) {throw new Error('Export was not completed')}
      setLocalResult(s.localSaved(saved.chats, saved.images))
      setLocalOpen(false)
    } catch {
      if (request.current === current) {setLocalError(s.localSaveError)}
    } finally {
      if (request.current === current) {setLocalBusy(false)}
    }
  }

  return (
    <section className="mt-10 border-t border-(--ui-stroke-tertiary) pt-8">
      <h2 className="text-base font-semibold">{s.title}</h2>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        {s.detail}
      </p>
      <Button className="mt-4" disabled={!local} onClick={() => {setLocalError(''); setLocalResult(''); setLocalOpen(true)}} variant="secondary">
        {s.localDownload}
      </Button>
      {localResult && <p className="mt-2 text-sm" role="status">{localResult}</p>}
      <p className="mt-5 max-w-xl text-sm text-muted-foreground">{s.localHint}</p>
      <Button className="mt-4" disabled={!local} onClick={() => {setError(''); setResult(''); setOpen(true)}} variant="secondary">
        {s.chatDownload}
      </Button>
      {!local && <p className="mt-2 text-xs text-muted-foreground">{s.localOnly}</p>}
      {result && <p className="mt-2 text-sm" role="status">{result}</p>}
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{s.chatConfirmTitle}</DialogTitle>
            <DialogDescription>{s.chatConfirmDetail}</DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button disabled={busy} onClick={() => setOpen(false)} variant="outline">{s.cancel}</Button>
            <Button disabled={busy} onClick={() => void download()}>{busy ? s.saving : s.choose}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={setLocalOpen} open={localOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{s.localConfirmTitle}</DialogTitle>
            <DialogDescription>{s.localConfirmDetail}</DialogDescription>
          </DialogHeader>
          {localError && <p className="text-sm text-destructive" role="alert">{localError}</p>}
          <DialogFooter>
            <Button disabled={localBusy} onClick={() => setLocalOpen(false)} variant="outline">{s.cancel}</Button>
            <Button disabled={localBusy} onClick={() => void downloadLocalData()}>{localBusy ? s.saving : s.choose}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
