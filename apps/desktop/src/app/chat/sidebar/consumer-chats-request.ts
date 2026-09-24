import { isPaneVisible, revealTreePane } from '@/components/pane-shell/tree/store'
import { setSidebarOpen } from '@/store/layout'

export const OPEN_CONSUMER_CHATS_EVENT = 'jarvis:open-chats'

// The sidebar pane can be unmounted when collapsed. Keep a one-shot request
// until its drawer owner mounts, rather than dropping the header click.
let pendingChatsRequest = false
let restoreCollapsedSidebar = false

export function requestConsumerChats(): void {
  pendingChatsRequest = true
  restoreCollapsedSidebar = !isPaneVisible('sessions')
  setSidebarOpen(true)
  revealTreePane('sessions')
  window.dispatchEvent(new Event(OPEN_CONSUMER_CHATS_EVENT))
}

export function consumeConsumerChatsRequest(): boolean {
  const pending = pendingChatsRequest

  pendingChatsRequest = false

  return pending
}

export function restoreConsumerChatsLayout(): void {
  if (!restoreCollapsedSidebar) {
    return
  }

  restoreCollapsedSidebar = false
  revealTreePane('workspace')
  setSidebarOpen(false)
}
