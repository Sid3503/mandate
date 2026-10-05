import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check, X } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

type Tone = 'good' | 'info' | 'bad'
type Toast = { id: number; title: string; body?: string; tone: Tone }
type Push = (toast: { title: string; body?: string; tone?: Tone }) => void

const ToastContext = createContext<Push>(() => undefined)

/** A short confirmation that something happened: approved, settled, paid. It never carries information you need later. */
export function useToast(): Push {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(1)
  const reduce = useReducedMotion()
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((item) => item.id !== id)), [])
  const push = useCallback<Push>((toast) => {
    const id = next.current++
    setToasts((current) => [...current.slice(-2), { id, title: toast.title, body: toast.body, tone: toast.tone ?? 'good' }])
    window.setTimeout(() => dismiss(id), 5200)
  }, [dismiss])
  const value = useMemo(() => push, [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout={!reduce}
              className={`toast toast-${toast.tone}`}
              initial={reduce ? false : { opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: 40, transition: { duration: 0.18 } }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            >
              <span className="toast-mark" aria-hidden="true"><Check size={16} strokeWidth={3} /></span>
              <div className="toast-text"><strong>{toast.title}</strong>{toast.body ? <span>{toast.body}</span> : null}</div>
              <button type="button" className="toast-x" onClick={() => dismiss(toast.id)} aria-label="Dismiss"><X size={14} strokeWidth={3} aria-hidden="true" /></button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}
