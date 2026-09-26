import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { type ConsumerUploadedImage, exportConsumerUploadedImages, listConsumerUploadedImages } from '@/hermes'
import { useJarvisCopy } from '@/i18n/jarvis'
import { $connection } from '@/store/session'

export function ConsumerImageExportSettings({ profile }: { profile: string }) {
  const s = useJarvisCopy().imageExport
  const connection = useStore($connection)
  const local = connection?.mode === 'local'
  const request = useRef(0)
  const [images, setImages] = useState<ConsumerUploadedImage[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState(false)
  const [listAttempt, setListAttempt] = useState(0)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')

  // Request token invalidates in-flight list and save work when the profile or connection changes.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const current = ++request.current

    setImages(null)
    setListError(false)
    setOpen(false)
    setBusy(false)
    setError('')
    setResult('')

    if (!local) {
      setLoading(false)

      return () => { request.current = current + 1 }
    }

    setLoading(true)
    void listConsumerUploadedImages(profile).then(
      response => {
        if (request.current !== current) {return}
        setImages(response.images)
        setLoading(false)
      },
      () => {
        if (request.current !== current) {return}
        setListError(true)
        setLoading(false)
      }
    )

    return () => { request.current = current + 1 }
  }, [local, profile, listAttempt])

  async function download() {
    if (!local || busy || images === null) {return}
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
        defaultPath: 'Jarvis-chat-images.zip',
        filters: [{ extensions: ['zip'], name: s.zipArchive }],
        title: s.saveDialogTitle
      })

      if (!output || request.current !== current) {return}

      const saved = await exportConsumerUploadedImages(profile, output)

      if (request.current !== current) {return}

      if (!saved.ok) {throw new Error('Export was not completed')}
      setResult(s.saved(saved.images))
      setOpen(false)
    } catch {
      if (request.current === current) {
        setError(s.saveError)
      }
    } finally {
      if (request.current === current) {setBusy(false)}
    }
  }

  const count = images?.length ?? 0

  return (
    <section className="mt-10 border-t border-(--ui-stroke-tertiary) pt-8">
      <h2 className="text-base font-semibold">{s.title}</h2>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        {s.detail}
      </p>
      {local && loading && <p className="mt-3 text-sm text-muted-foreground" role="status">{s.checking}</p>}
      {local && listError && (
        <div className="mt-3">
          <p className="text-sm text-destructive" role="alert">{s.listError}</p>
          <Button className="mt-2" onClick={() => setListAttempt(attempt => attempt + 1)} size="sm" variant="secondary">{s.retry}</Button>
        </div>
      )}
      {local && images && (
        <>
          <p className="mt-3 text-sm">{s.available(count)}</p>
          {count > 0 && (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer">{s.viewList}</summary>
              <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-muted-foreground">
                {images.map((image, index) => (
                  <li key={image.artifact_id}>{s.row(index + 1, image.extension.slice(1).toUpperCase(), Math.ceil(image.byte_size / 1024))}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <Button
        className="mt-4"
        disabled={!local || images === null || count === 0}
        onClick={() => {setError(''); setResult(''); setOpen(true)}}
        variant="secondary"
      >
        {s.download}
      </Button>
      {!local && <p className="mt-2 text-xs text-muted-foreground">{s.localOnly}</p>}
      {result && <p className="mt-2 text-sm" role="status">{result}</p>}
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{s.confirmTitle}</DialogTitle>
            <DialogDescription>
              {s.confirmDetail(count)}
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button disabled={busy} onClick={() => setOpen(false)} variant="outline">{s.cancel}</Button>
            <Button disabled={busy} onClick={() => void download()}>{busy ? s.saving : s.choose}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
