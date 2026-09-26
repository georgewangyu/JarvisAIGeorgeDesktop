import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useMicRecorder } from './use-mic-recorder'

const copy = {
  microphoneAccessDenied: 'access denied',
  microphoneConstraintsUnsupported: 'constraints unsupported',
  microphoneInUse: 'microphone in use',
  microphonePermissionDenied: 'permission denied',
  microphoneStartFailed: 'microphone start failed',
  microphoneUnsupported: 'microphone unsupported',
  noMicrophone: 'no microphone'
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useMicRecorder startup recovery', () => {
  it('discards a late microphone grant after cancel without replacing a retry', async () => {
    let grantFirstStream!: (stream: MediaStream) => void
    const firstStream = new Promise<MediaStream>(resolve => { grantFirstStream = resolve })
    const firstTrackStop = vi.fn()
    const secondTrackStop = vi.fn()
    const secondStream = { getTracks: () => [{ stop: secondTrackStop }] } as unknown as MediaStream
    const getUserMedia = vi.fn().mockReturnValueOnce(firstStream).mockResolvedValueOnce(secondStream)
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
    vi.stubGlobal('AudioContext', undefined)

    class TestMediaRecorder {
      static isTypeSupported = () => true
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: BlobEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onstop: (() => void) | null = null

      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; this.onstop?.() }
    }
    vi.stubGlobal('MediaRecorder', TestMediaRecorder)

    const { result } = renderHook(() => useMicRecorder(copy))
    let firstStart!: Promise<void>

    await act(async () => {
      firstStart = result.current.handle.start()
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())
    })

    act(() => result.current.handle.cancel())
    await act(async () => result.current.handle.start())
    expect(result.current.recording).toBe(true)

    await act(async () => {
      grantFirstStream({ getTracks: () => [{ stop: firstTrackStop }] } as unknown as MediaStream)
      await firstStart
    })

    expect(firstTrackStop).toHaveBeenCalledOnce()
    expect(secondTrackStop).not.toHaveBeenCalled()
    expect(result.current.recording).toBe(true)

    act(() => result.current.handle.cancel())
    expect(secondTrackStop).toHaveBeenCalledOnce()
  })

  it('keeps native permission denial ahead of capture and allows a granted retry', async () => {
    const requestMicrophoneAccess = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    vi.stubGlobal('hermesDesktop', { requestMicrophoneAccess })

    const stopTrack = vi.fn()
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] })
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })

    class TestMediaRecorder {
      static isTypeSupported = () => true
      state = 'inactive'
      ondataavailable: ((event: BlobEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onstop: (() => void) | null = null

      start() { this.state = 'recording' }
      stop() { this.state = 'inactive' }
    }
    vi.stubGlobal('MediaRecorder', TestMediaRecorder)
    vi.stubGlobal('AudioContext', undefined)

    const { result } = renderHook(() => useMicRecorder(copy))
    await expect(act(() => result.current.handle.start())).rejects.toThrow(copy.microphoneAccessDenied)
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(result.current.recording).toBe(false)

    await act(async () => result.current.handle.start())
    expect(requestMicrophoneAccess).toHaveBeenCalledTimes(2)
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(result.current.recording).toBe(true)

    act(() => result.current.handle.cancel())
    expect(stopTrack).toHaveBeenCalledOnce()
  })

  it('shows a microphone error if the native permission request fails', async () => {
    const getUserMedia = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
    vi.stubGlobal('MediaRecorder', class {})
    vi.stubGlobal('hermesDesktop', {
      requestMicrophoneAccess: vi.fn().mockRejectedValue(new Error('Electron IPC details'))
    })

    const { result } = renderHook(() => useMicRecorder(copy))
    await expect(act(() => result.current.handle.start())).rejects.toThrow(copy.microphoneStartFailed)
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(result.current.recording).toBe(false)
  })

  it('releases a granted stream when recorder start fails and allows another attempt', async () => {
    const stopTracks = [vi.fn(), vi.fn()]

    const getUserMedia = vi.fn()
      .mockResolvedValueOnce({ getTracks: () => [{ stop: stopTracks[0] }] })
      .mockResolvedValueOnce({ getTracks: () => [{ stop: stopTracks[1] }] })

    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia }
    })

    let starts = 0

    class TestMediaRecorder {
      static isTypeSupported = () => true
      mimeType = 'audio/webm'
      state = 'inactive'
      ondataavailable: ((event: BlobEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onstop: (() => void) | null = null

      start() {
        starts++

        if (starts === 1) {
          throw new DOMException('Recorder could not start', 'NotReadableError')
        }

        this.state = 'recording'
      }

      stop() {
        this.state = 'inactive'
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', TestMediaRecorder)
    vi.stubGlobal('AudioContext', undefined)

    const { result } = renderHook(() => useMicRecorder(copy))
    await expect(act(() => result.current.handle.start())).rejects.toThrow(copy.microphoneInUse)
    expect(stopTracks[0]).toHaveBeenCalledOnce()
    expect(result.current.recording).toBe(false)

    await act(async () => result.current.handle.start())
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(starts).toBe(2)
    expect(result.current.recording).toBe(true)

    act(() => result.current.handle.cancel())
    expect(stopTracks[1]).toHaveBeenCalledOnce()
  })
})
