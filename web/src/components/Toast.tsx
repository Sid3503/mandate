import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { AlertTriangle, Check, Info, X } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

type Tone = 'good' | 'info' | 'bad' | 'warn'
type Action = { label: string; onClick: () => void }
type Toast = { id: number; key?: string; title: string; body?: string; tone: Tone; action?: Action; ms: number }
type Push = (toast: { title: string; body?: string; tone?: Tone; action?: Action; /** A toast with the same key replaces the one on screen instead of stacking. */ key?: string; ms?: number }) => void

const ToastContext = createContext<Push>(() => undefined)

/** A short note that something happened: approved, settled, paid, connection lost. It never carries information you need later. */
export function useToast(): Push {
  return useContext(ToastContext)
}

const ICON = { good: Check, info: Info, bad: X, warn: AlertTriangle } as const
const DEFAULT_MS = { good: 5200, info: 5200, warn: 7000, bad: 8000 } as const

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(1)
  const reduce = useReducedMotion()
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((item) => item.id !== id)), [])
  const push = useCallback<Push>((toast) => {
    const id = next.current++
    const tone = toast.tone ?? 'good'
    const item: Toast = { id, key: toast.key, title: toast.title, body: toast.body, tone, action: toast.action, ms: toast.ms ?? DEFAULT_MS[tone] }
    setToasts((current) => [...current.filter((existing) => !toast.key || existing.key !== toast.key).slice(-2), item])
  }, [])
  const value = useMemo(() => push, [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => <ToastCard key={toast.id} toast={toast} reduce={Boolean(reduce)} onDismiss={() => dismiss(toast.id)} />)}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

/** One note. Its clock stops while the pointer or the keyboard is on it, so it never leaves while being read. */
function ToastCard({ toast, reduce, onDismiss }: { toast: Toast; reduce: boolean; onDismiss: () => void }) {
  const Icon = ICON[toast.tone]
  const [paused, setPaused] = useState(false)
  const left = useRef(toast.ms)
  const stamp = useRef(Date.now())
  useEffect(() => {
    if (paused) {
      left.current -= Date.now() - stamp.current
      return
    }
    stamp.current = Date.now()
    const timer = window.setTimeout(onDismiss, Math.max(600, left.current))
    return () => window.clearTimeout(timer)
  }, [paused, onDismiss])
  return (
    <motion.div
      layout={!reduce}
      className={`toast toast-${toast.tone}`}
      role={toast.tone === 'bad' ? 'alert' : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      initial={reduce ? false : { opacity: 0, y: 28, scale: 0.94, rotate: -0.6 }}
      animate={{ opacity: 1, y: 0, scale: 1, rotate: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: 48, scale: 0.96, transition: { duration: 0.2 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 30 }}
    >
      <span className="toast-mark" aria-hidden="true"><Icon size={16} strokeWidth={3} /></span>
      <div className="toast-text">
        <strong>{toast.title}</strong>
        {toast.body ? <span>{toast.body}</span> : null}
        {toast.action ? <button type="button" className="toast-action" onClick={() => { toast.action!.onClick(); onDismiss() }}>{toast.action.label} →</button> : null}
      </div>
      <button type="button" className="toast-x" onClick={onDismiss} aria-label="Dismiss"><X size={14} strokeWidth={3} aria-hidden="true" /></button>
      {!reduce ? <span className="toast-clock" aria-hidden="true" style={{ animationDuration: `${toast.ms}ms`, animationPlayState: paused ? 'paused' : 'running' }} /> : null}
    </motion.div>
  )
}
