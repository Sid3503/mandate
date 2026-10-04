import * as React from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowLeft, ArrowRight, X } from 'lucide-react'

/**
 * Product tour: a spotlight on one element, a card that explains it, keyboard and screen-reader support.
 *
 * Ported from a Tailwind original. This console has no Tailwind, so the look lives in the `.tour-*` rules
 * of src/styles/app.css and uses the console's own tokens (paper, ink, lime, hard shadows).
 */

export type TourPlacement = 'top' | 'bottom' | 'left' | 'right' | 'auto' | 'center'

export type TourStep = {
  /** CSS selector of the element to spotlight. The first visible match wins. Omit for a centred card. */
  target?: string
  title: string
  content: React.ReactNode
  placement?: TourPlacement
  /** Used instead of `placement` on narrow screens (under 860px), where the side rail becomes a bottom bar. */
  mobilePlacement?: TourPlacement
  padding?: number
}

export type TourProps = {
  steps: TourStep[]
  open: boolean
  onOpenChange?: (open: boolean) => void
  index?: number
  onIndexChange?: (index: number) => void
  onFinish?: () => void
  onSkip?: () => void
  showProgress?: boolean
  clickToNext?: boolean
  className?: string
}

type Rect = { top: number; left: number; width: number; height: number }

const SPRING = { type: 'spring' as const, stiffness: 320, damping: 32, mass: 0.7 }
const NARROW = 860

/** The first element matching the selector that is actually on screen (the rail and the tab bar share labels). */
export function findTarget(selector?: string): HTMLElement | null {
  if (!selector) return null
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return el
  }
  return null
}

export function Tour({
  steps,
  open,
  onOpenChange,
  index: controlledIndex,
  onIndexChange,
  onFinish,
  onSkip,
  showProgress = true,
  clickToNext = false,
  className,
}: TourProps) {
  const reduce = useReducedMotion()
  const [mounted, setMounted] = React.useState(false)
  const [indexState, setIndexState] = React.useState(0)
  const index = controlledIndex ?? indexState
  const setIndex = React.useCallback(
    (i: number) => {
      onIndexChange?.(i)
      setIndexState(i)
    },
    [onIndexChange],
  )

  const cardRef = React.useRef<HTMLDivElement>(null)
  const [rect, setRect] = React.useState<Rect | null>(null)
  const [cardSize, setCardSize] = React.useState({ w: 340, h: 220 })
  const [vp, setVp] = React.useState({ w: 1024, h: 768 })
  const titleId = React.useId()
  const bodyId = React.useId()

  React.useEffect(() => setMounted(true), [])

  const step = steps[index]
  const count = steps.length
  const isFirst = index === 0
  const isLast = index === count - 1
  const pad = step?.padding ?? 8

  const finish = React.useCallback(() => {
    onFinish?.()
    onOpenChange?.(false)
    setIndexState(0)
  }, [onFinish, onOpenChange])

  const skip = React.useCallback(() => {
    onSkip?.()
    onOpenChange?.(false)
    setIndexState(0)
  }, [onSkip, onOpenChange])

  const next = React.useCallback(() => {
    if (isLast) finish()
    else setIndex(index + 1)
  }, [isLast, finish, index, setIndex])

  const back = React.useCallback(() => {
    if (!isFirst) setIndex(index - 1)
  }, [isFirst, index, setIndex])

  // Hand focus back to whatever had it before the tour opened.
  React.useEffect(() => {
    if (!open) return
    const before = document.activeElement as HTMLElement | null
    return () => before?.focus?.()
  }, [open])

  // Find the target, scroll it into view, and keep the spotlight on it. A target that is not there yet
  // (a screen still loading) is retried for about a second and a half before the card falls back to the centre.
  React.useEffect(() => {
    if (!open || !step) return
    let tries = 0
    const measure = (): boolean => {
      setVp({ w: window.innerWidth, h: window.innerHeight })
      const el = findTarget(step.target)
      if (!el) {
        setRect(null)
        return false
      }
      const r = el.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
      return true
    }

    findTarget(step.target)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center', inline: 'nearest' })
    const found = measure()
    const poll = step.target && !found
      ? window.setInterval(() => {
          tries += 1
          if (measure() || tries > 15) window.clearInterval(poll)
        }, 100)
      : undefined
    const settle = window.setTimeout(measure, reduce ? 0 : 320)
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(settle)
      if (poll) window.clearInterval(poll)
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, index, step, reduce])

  React.useLayoutEffect(() => {
    if (cardRef.current) {
      const r = cardRef.current.getBoundingClientRect()
      setCardSize({ w: r.width, h: r.height })
    }
  }, [index, open, rect, mounted])

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const onButton = (e.target as HTMLElement | null)?.closest?.('button')
      if (e.key === 'Escape') {
        e.preventDefault()
        skip()
      } else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !onButton)) {
        e.preventDefault()
        next()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        back()
      } else if (e.key === 'Tab') {
        const focusables = cardRef.current?.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])')
        if (!focusables || focusables.length === 0) return
        const first = focusables[0]!
        const last = focusables[focusables.length - 1]!
        if (!cardRef.current?.contains(document.activeElement)) {
          e.preventDefault()
          first.focus()
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, next, back, skip])

  React.useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      cardRef.current?.querySelector<HTMLElement>('[data-tour-primary]')?.focus()
    }, 40)
    return () => window.clearTimeout(t)
  }, [open, index])

  if (!mounted || !open || !step) return null

  const gap = 14
  const narrow = vp.w <= NARROW
  let place: TourPlacement = (narrow ? step.mobilePlacement : undefined) ?? step.placement ?? 'auto'
  if (!rect) place = 'center'
  if (place === 'auto' && rect) {
    if (rect.top + rect.height + gap + cardSize.h < vp.h) place = 'bottom'
    else if (rect.top - gap - cardSize.h > 0) place = 'top'
    else if (rect.left + rect.width + gap + cardSize.w < vp.w) place = 'right'
    else place = 'left'
  }

  let left = vp.w / 2 - cardSize.w / 2
  let top = vp.h / 2 - cardSize.h / 2
  if (rect) {
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    if (place === 'bottom') {
      left = cx - cardSize.w / 2
      top = rect.top + rect.height + gap + pad
    } else if (place === 'top') {
      left = cx - cardSize.w / 2
      top = rect.top - gap - pad - cardSize.h
    } else if (place === 'right') {
      left = rect.left + rect.width + gap + pad
      top = cy - cardSize.h / 2
    } else if (place === 'left') {
      left = rect.left - gap - pad - cardSize.w
      top = cy - cardSize.h / 2
    }
  }
  left = Math.min(Math.max(12, left), Math.max(12, vp.w - 12 - cardSize.w))
  top = Math.min(Math.max(12, top), Math.max(12, vp.h - 12 - cardSize.h))

  const spot = rect
    ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : null

  return createPortal(
    <div className={className}>
      <AnimatePresence>
        <motion.div
          key="tour-layer"
          className="tour-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.2 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
        >
          <div className="tour-click" onClick={() => clickToNext && next()} />

          {spot ? (
            <motion.div
              key="spot"
              className="tour-spot"
              initial={false}
              animate={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
              transition={reduce ? { duration: 0 } : SPRING}
            />
          ) : (
            <motion.div key="dim" className="tour-dim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} />
          )}

          <motion.div
            ref={cardRef}
            className="tour-card"
            initial={reduce ? false : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1, left, top }}
            transition={reduce ? { duration: 0 } : SPRING}
            style={{ left, top }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tour-head">
              <span className="tour-count">Step {index + 1} of {count}</span>
              <button type="button" className="tour-x" onClick={skip} aria-label="Close tour">
                <X size={18} strokeWidth={2.5} aria-hidden="true" />
              </button>
            </div>

            <h3 id={titleId} className="tour-title">{step.title}</h3>
            <div id={bodyId} className="tour-body" aria-live="polite">{step.content}</div>

            {showProgress ? (
              <div className="tour-progress" aria-hidden="true">
                {steps.map((_, i) => <span key={i} className={i === index ? 'on' : i < index ? 'done' : ''} />)}
              </div>
            ) : null}

            <div className="tour-actions">
              {isLast ? <span /> : <button type="button" className="link" onClick={skip}>Skip tour</button>}
              <div className="row gap-s">
                {!isFirst ? (
                  <button type="button" className="btn btn-ghost" onClick={back}>
                    <ArrowLeft size={16} strokeWidth={2.5} aria-hidden="true" />
                    Back
                  </button>
                ) : null}
                <button type="button" className="btn btn-ink" data-tour-primary onClick={next}>
                  {isLast ? 'Done' : 'Next'}
                  {!isLast ? <ArrowRight size={16} strokeWidth={2.5} aria-hidden="true" /> : null}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </div>,
    document.body,
  )
}

export function useTour(storageKey?: string) {
  const [open, setOpen] = React.useState(false)
  const [index, setIndex] = React.useState(0)

  const seen = React.useCallback(() => {
    if (!storageKey) return false
    try {
      return localStorage.getItem(storageKey) === '1'
    } catch {
      return false
    }
  }, [storageKey])

  const start = React.useCallback(() => {
    setIndex(0)
    setOpen(true)
  }, [])

  const markSeen = React.useCallback(() => {
    if (!storageKey) return
    try {
      localStorage.setItem(storageKey, '1')
    } catch {
      return
    }
  }, [storageKey])

  return { open, setOpen, index, setIndex, start, seen, markSeen }
}
