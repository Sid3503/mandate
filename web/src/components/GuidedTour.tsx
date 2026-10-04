import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { CircleHelp } from 'lucide-react'
import { useSession } from '../lib/hooks'
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

  const start = useCallback((id: TourId) => {
    const usable = TOURS[id].filter((step) => !step.target || findTarget(step.target))
    if (usable.length === 0) return
    setActive(id)
    setSteps(usable)
    open()
  }, [open])

  const done = useCallback(() => {
    markSeen(active)
    setSeenVersion((value) => value + 1)
  }, [active])

  useEffect(() => {
    if (!me.data || isSeen('welcome')) return
    const timer = window.setTimeout(() => {
      if (!isOpen.current) start('welcome')
    }, 700)
    return () => window.clearTimeout(timer)
  }, [me.data, start])

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
