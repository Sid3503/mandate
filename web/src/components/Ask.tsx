import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { ClerkChat } from './ClerkChat'
import { useToday } from '../lib/hooks'

type AskContext = { open: (message?: string) => void; close: () => void; isOpen: boolean }
const Ask = createContext<AskContext>({ open: () => undefined, close: () => undefined, isOpen: false })
export const useAsk = () => useContext(Ask)

const LINK = 'https://www.figma.com/file/northwind-logo'

/**
 * "Ask Mandate": the studio clerk, one keystroke away from any screen. Say what you want in a sentence; the clerk turns
 * it into a request and the rules answer. It is the same clerk as on the Clerk screen, with the same powers: it can
 * only ask.
 */
export function AskProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false)
  const [initial, setInitial] = useState<string | undefined>()
  const opener = useRef<HTMLElement | null>(null)
  const open = useCallback((message?: string) => {
    opener.current = document.activeElement as HTMLElement | null
    setInitial(message)
    setOpen(true)
  }, [])
  const close = useCallback(() => {
    setOpen(false)
    setInitial(undefined)
    window.setTimeout(() => opener.current?.focus?.(), 0)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((current) => {
          if (!current) opener.current = document.activeElement as HTMLElement | null
          return !current
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const value = useMemo(() => ({ open, close, isOpen }), [open, close, isOpen])
  return (
    <Ask.Provider value={value}>
      {children}
      {isOpen ? <AskDialog initial={initial} onClose={close} /> : null}
    </Ask.Provider>
  )
}

function AskDialog({ initial, onClose }: { initial: string | undefined; onClose: () => void }) {
  const today = useToday()
  const location = useLocation()
  const box = useRef<HTMLDivElement>(null)
  const first = useRef(location.pathname)

  // A visit to another screen ends the conversation's welcome, not the conversation: close so the page can be seen.
  useEffect(() => { if (location.pathname !== first.current) onClose() }, [location.pathname, onClose])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); return }
      if (event.key !== 'Tab' || !box.current) return
      const focusable = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
      if (focusable.length === 0) return
      const firstEl = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === firstEl) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); firstEl.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const examples = [
    'what is waiting for me?',
    ...(today.data?.readyToBill ?? []).slice(0, 1).map((item) => `${item.title} for ${item.buyerName} is delivered, bill it ${LINK}`),
    ...((today.data?.automation?.standingRules ?? 0) > 0 ? [`pay Priya her share for the latest Northwind payment ${LINK}`] : []),
    'what did the rules refuse this month, and why?',
  ]

  return (
    <div className="ask-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={box} className="ask" role="dialog" aria-modal="true" aria-labelledby="ask-title">
        <div className="ask-head">
          <h2 id="ask-title">Ask Mandate</h2>
          <span className="fine">The clerk can ask the rules. It cannot pay, approve or change them.</span>
          <button type="button" className="link" onClick={onClose} aria-label="Close">Esc</button>
        </div>
        <div className="chat ask-chat">
          <ClerkChat examples={examples} autoFocus initial={initial} placeholder="Say what you want done…" />
        </div>
      </div>
    </div>
  )
}
