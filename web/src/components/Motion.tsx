import { useEffect, useRef, useState } from 'react'
import { dollars } from '../lib/money'

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

/** Counts from the previous value to the new one. Jumps straight there when the person prefers less motion. */
export function useCountUp(target: number, ms = 700): number {
  const [shown, setShown] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || target === from.current) {
      from.current = target
      setShown(target)
      return
    }
    const start = performance.now()
    const begin = from.current
    let frame = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      setShown(Math.round(begin + (target - begin) * easeOut(t)))
      if (t < 1) frame = requestAnimationFrame(tick)
      else from.current = target
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, ms])
  return shown
}

/** Money that counts up to its value, so a total that just changed is noticed. Shows the final value to assistive tech at once. */
export function CountMoney({ cents, size = 'md' }: { cents: number; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const shown = useCountUp(cents)
  return (
    <span className={`money money-${size}`}>
      <span aria-hidden="true">{dollars(shown)}</span>
      <span className="sr-only">{dollars(cents)}</span>
    </span>
  )
}

/**
 * Reveals elements as they scroll into view. Mark elements with `data-reveal`; children of a marked group with
 * `data-reveal-item` arrive one after another. Nothing is hidden until this has run, so a page without script,
 * or a person who prefers less motion, simply sees everything.
 */
export function useReveal(): React.RefObject<HTMLDivElement | null> {
  const root = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = root.current
    if (!node || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return
    node.classList.add('reveal-ready')
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-in')
        observer.unobserve(entry.target)
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })
    node.querySelectorAll('[data-reveal]').forEach((el) => {
      el.querySelectorAll('[data-reveal-item]').forEach((item, index) => (item as HTMLElement).style.setProperty('--i', String(index)))
      observer.observe(el)
    })
    return () => {
      observer.disconnect()
      node.classList.remove('reveal-ready')
    }
  }, [])
  return root
}
