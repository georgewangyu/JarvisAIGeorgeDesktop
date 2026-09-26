import { isPaneVisible, revealTreePane } from '@/components/pane-shell/tree/store'
import { setSidebarOpen } from '@/store/layout'

export const OPEN_CONSUMER_CHATS_EVENT = 'jarvis:open-chats'

// The sidebar pane can be unmounted when collapsed. Keep a one-shot request
// until its drawer owner mounts, rather than dropping the header click.
let pendingChatsRequest = false
let restoreCollapsedSidebar = false

export function requestConsumerChats(): void {
  // An owner can acknowledge this event and still unmount before its drawer
  // commits (for example, while returning from Feed). Keep the request until
  // an open Chats drawer has rendered, so the next owner can honor that click.
  pendingChatsRequest = true
  // The Jarvis rail often already owns the drawer. Let that mounted owner
  // handle the request before changing the pane tree, which can unmount it.
  const event = new Event(OPEN_CONSUMER_CHATS_EVENT, { cancelable: true })

  window.dispatchEvent(event)

  if (event.defaultPrevented) {
    return
  }

  restoreCollapsedSidebar = !isPaneVisible('sessions')
  setSidebarOpen(true)
  revealTreePane('sessions')
}

export function hasConsumerChatsRequest(): boolean {
  return pendingChatsRequest
}

export function completeConsumerChatsRequest(): void {
  pendingChatsRequest = false
}

export function restoreConsumerChatsLayout(): void {
  if (!restoreCollapsedSidebar) {
    return
  }

  restoreCollapsedSidebar = false
  revealTreePane('workspace')
  setSidebarOpen(false)
}
