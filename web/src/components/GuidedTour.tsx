import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { CircleHelp } from 'lucide-react'
import { useSession } from '../lib/hooks'
import { session } from '../lib/session'
import { TOURS, tourFor, TOUR_LABEL, type TourId } from '../lib/tours'
import { findTarget, Tour, useTour, type TourStep } from './ui/product-tour'

const storageKey = (id: TourId) => `mandate.tour.${id}`

function isSeen(id: TourId): boolean {
  try {
    return localStorage.getItem(storageKey(id)) === '1'
  } catch {
    return false
  }
}

function markSeen(id: TourId): void {
  try {
    localStorage.setItem(storageKey(id), '1')
    if (id === 'coach') {
      localStorage.setItem('mandate.coach.seen', '1')
    }
  } catch {
    // Private mode: the tour simply offers itself again next time.
  }
}

type Guide = {
  /** Open a tour. Steps that point at something not on this screen are left out. */
  start: (id: TourId) => void
  /** The guide that belongs to the screen the person is looking at. */
  screen: TourId
  /** True until that screen's guide has been finished or skipped once. */
  unseen: boolean
}

const GuideContext = createContext<Guide | null>(null)

export function useGuide(): Guide {
  const value = useContext(GuideContext)
  if (!value) throw new Error('useGuide needs <GuideProvider>')
  return value
}

/**
 * Owns the one product tour on screen. The welcome tour opens by itself the first time someone unlocks the
 * console on this browser. Every other guide opens only when asked, from the Guide button.
 */
export function GuideProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const me = useSession()
  const tour = useTour()
  const { start: open, setOpen } = tour
  const [active, setActive] = useState<TourId>('welcome')
  const [steps, setSteps] = useState<TourStep[]>([])
  const [seenVersion, setSeenVersion] = useState(0)
  const isOpen = useRef(false)
  isOpen.current = tour.open
  const activeRef = useRef<TourId>('welcome')
  activeRef.current = active
  const autoOpened = useRef(false)

  const start = useCallback((id: TourId) => {
    const usable = TOURS[id].filter((step) => !step.target || findTarget(step.target))
    if (usable.length === 0) return
    // A tour that was open and is now being replaced has been seen. It must not open by itself again later.
    if (activeRef.current === 'welcome' || activeRef.current === 'coach') markSeen(activeRef.current)
    setActive(id)
    setSteps(usable)
    open()
  }, [open])

  const done = useCallback(() => {
    markSeen(active)
    setSeenVersion((value) => value + 1)
  }, [active])

  useEffect(() => {
    if (!me.data) return
    if (autoOpened.current) return
    if (localStorage.getItem('mandate.tour.welcome') === '1' || localStorage.getItem('mandate.coach.seen') === '1') return
    // The welcome tour belongs on the console's front door. It must never open by itself over a screen the
    // person asked for, and while it is open it covers the page, so the Guide button cannot be pressed.
    if (location.pathname !== '/') return
    const isDemo = session.mode() === 'demo'
    const targetTour: TourId = isDemo ? 'coach' : 'welcome'
    autoOpened.current = true
    const timer = window.setTimeout(() => {
      if (!isOpen.current) start(targetTour)
    }, 700)
    return () => window.clearTimeout(timer)
  }, [me.data, start, location.pathname])

  const screen = tourFor(location.pathname)
  const value = useMemo<Guide>(
    () => ({ start, screen, unseen: !isSeen(screen) }),
    // seenVersion makes the dot react to a finished tour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [start, screen, seenVersion],
  )

  return (
    <GuideContext.Provider value={value}>
      {children}
      <Tour
        steps={steps}
        open={tour.open}
        onOpenChange={setOpen}
        index={tour.index}
        onIndexChange={tour.setIndex}
        onFinish={done}
        onSkip={done}
      />
    </GuideContext.Provider>
  )
}

export function GuideButton() {
  const guide = useGuide()
  return (
    <button
      type="button"
      className="guide-btn"
      data-tour="guide"
      onClick={() => guide.start(guide.screen)}
      title={`A walkthrough of ${TOUR_LABEL[guide.screen]}`}
    >
      <CircleHelp size={16} strokeWidth={2.5} aria-hidden="true" />
      <span>Guide</span>
      {guide.unseen ? <><span className="guide-dot" aria-hidden="true" /><span className="sr-only">, new</span></> : null}
    </button>
  )
}
