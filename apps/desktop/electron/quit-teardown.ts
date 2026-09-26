export interface QuitTeardownTask {
  /** Whether Electron must defer this quit until the task settles. */
  waitForCompletion: boolean
  /** Starts teardown. This is invoked synchronously from before-quit. */
  run: () => Promise<unknown> | unknown
}

export interface QuitTeardownCoordinator {
  /**
   * Starts teardown once and reports whether the current quit must be
   * prevented. Re-entrant quit requests are held until all required teardown
   * settles; the coordinator then requests exactly one final quit.
   */
  begin: (tasks: readonly QuitTeardownTask[]) => boolean
}

export interface BackendQuitActivity {
  connectionPending: boolean
  poolPending: boolean
  processAttached: boolean
  shutdownPending: boolean
}

export function backendQuitNeedsWait(activity: BackendQuitActivity): boolean {
  return activity.shutdownPending || activity.processAttached || activity.connectionPending || activity.poolPending
}

export interface QuitWindow {
  destroy: () => void
  isDestroyed: () => boolean
  once: (event: 'closed', listener: () => void) => unknown
}

/** Give renderers a chance to flush before closing a window that never answers. */
export function requestFinalQuitWithWindowGrace(
  requestQuit: () => void,
  windows: readonly QuitWindow[],
  graceMs = 1_500
): void {
  const remaining = new Set(windows.filter(win => !win.isDestroyed()))

  if (remaining.size === 0) {
    requestQuit()

    return
  }

  let retryRequested = false

  const requestQuitAfterWindowsClose = () => {
    if (retryRequested) {
      return
    }

    retryRequested = true
    // A close event can fire while Electron is still inside app.quit(). Wait
    // until that stack unwinds before asking macOS to leave the Dock too.
    queueMicrotask(requestQuit)
  }

  const deadline = setTimeout(() => {
    for (const win of remaining) {
      if (!win.isDestroyed()) {
        win.destroy()
      }
    }

    // On macOS, closing the last window alone leaves the process in the Dock.
    requestQuitAfterWindowsClose()
  }, graceMs)

  for (const win of remaining) {
    win.once('closed', () => {
      remaining.delete(win)

      if (remaining.size === 0) {
        clearTimeout(deadline)
        requestQuitAfterWindowsClose()
      }
    })
  }

  requestQuit()
}

function runTask(task: QuitTeardownTask): Promise<unknown> {
  try {
    return Promise.resolve(task.run())
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * Coordinates Electron's before-quit teardown without cancelling a quit that
 * has no asynchronous work to wait for.
 */
export function createQuitTeardownCoordinator(
  requestFinalQuit: () => void,
  onDeferredQuit: () => void = () => {}
): QuitTeardownCoordinator {
  let started = false
  let finished = false

  return {
    begin(tasks): boolean {
      if (finished) {
        return false
      }

      if (started) {
        return true
      }

      started = true
      const mustWait = tasks.some(task => task.waitForCompletion)

      // The renderer remains mounted after a prevented before-quit. Conceal it
      // before shutdown rejects in-flight connection requests, otherwise an
      // intentional quit can briefly paint an actionable recovery failure.
      if (mustWait) {
        onDeferredQuit()
      }

      const executions = tasks.map(task => ({ promise: runTask(task), waitForCompletion: task.waitForCompletion }))

      if (!mustWait) {
        // Observe asynchronous no-wait cleanup so a late rejection cannot
        // become unhandled, but let Electron continue the original quit.
        void Promise.allSettled(executions.map(task => task.promise))
        finished = true

        return false
      }

      void Promise.allSettled(executions.map(task => task.promise)).then(() => {
        finished = true
        requestFinalQuit()
      })

      return true
    }
  }
}
