import { useEffect, useState, type ReactNode } from 'react'
import { ApiError } from '../lib/api'
import { dollars } from '../lib/money'
import { GATE, phaseInfo, problemWords } from '../lib/words'
import type { Gate, Proposal } from '../lib/types'

export function Chip({ tone = 'ink', children, title, pop = false }: { tone?: 'deny' | 'auto' | 'need' | 'ink' | 'muted' | 'build'; children: ReactNode; title?: string; pop?: boolean }) {
  return <span className={`chip chip-${tone}${pop ? ' chip-pop' : ''}`} title={title}>{children}</span>
}

export function GateChip({ gate }: { gate: Gate }) {
  const info = GATE[gate]
  return <Chip tone={info.tone}>{info.label}</Chip>
}

export function PhaseChip({ phase, kind }: { phase: string; kind?: Proposal['kind'] }) {
  const info = phaseInfo(phase, kind)
  // Keyed by the phase, so the chip pops each time the request moves on.
  return <Chip key={phase} tone={info.tone} pop>{info.label}</Chip>
}

export function Money({ cents, size = 'md', currency }: { cents: number | null | undefined; size?: 'sm' | 'md' | 'lg' | 'xl'; currency?: string }) {
  return <span className={`money money-${size}`}>{dollars(cents, currency)}</span>
}

/** A lock hash in groups of eight. When `reveal` is set, the characters arrive left to right once. */
export function Hash({ value, reveal = false, full = false }: { value: string | null | undefined; reveal?: boolean; full?: boolean }) {
  const text = value ?? ''
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const [shown, setShown] = useState(reveal && !reduced ? 0 : text.length)
  useEffect(() => {
    if (!reveal || reduced) {
      setShown(text.length)
      return
    }
    setShown(0)
    const timer = window.setInterval(() => setShown((count) => {
      if (count >= text.length) {
        window.clearInterval(timer)
        return count
      }
      return count + 2
    }), 14)
    return () => window.clearInterval(timer)
  }, [text, reveal, reduced])
  if (!text) return <span className="hash muted">no lock yet</span>
  const visible = full ? text : `${text.slice(0, 16)}…${text.slice(-8)}`
  const body = full ? text.slice(0, shown) : shown >= text.length ? visible : text.slice(0, Math.min(shown, 16))
  const groups = full ? body.match(/.{1,8}/g) ?? [] : [body]
  return (
    <span className={`hash${reveal ? ' hash-reveal' : ''}`} aria-label={`Lock hash ${text}`} title={text}>
      {groups.map((group, index) => <span key={index}>{group}</span>)}
    </span>
  )
}

export function KV({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="kv">
      <span className="kv-k">{label}</span>
      <span className={`kv-v${mono ? ' mono' : ''}`}>{children}</span>
    </div>
  )
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="eyebrow">{children}</div>
}

export function PageHead({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head" data-tour="page-head">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1>{title}</h1>
      </div>
      {children ? <div className="page-head-side">{children}</div> : null}
    </header>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-mark" aria-hidden="true"><span /><span /><span /></div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  )
}

/** A skeleton in the shape of a page, so the screen holds its layout while it loads instead of jumping. */
export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="loading-head"><span className="loading-bar" />{label}</span>
      <span className="skel skel-title" aria-hidden="true" />
      <span className="skel skel-line" aria-hidden="true" />
      <span className="skel skel-line short" aria-hidden="true" />
      <span className="skel skel-block" aria-hidden="true" />
    </div>
  )
}

/** Shows a server problem exactly: plain words, the code, and the server's own sentence. */
export function ProblemCard({ error, children }: { error: unknown; children?: ReactNode }) {
  if (!error) return null
  const problem = error instanceof ApiError ? error : null
  const words = problem ? problemWords(problem.code) : ''
  return (
    <div className="problem" role="alert">
      <div className="problem-head">
        <Chip tone="deny">{problem ? `${problem.status || 'offline'} · ${problem.code}` : 'error'}</Chip>
      </div>
      <p className="problem-words">{words || problem?.title || String(error)}</p>
      {problem?.detail ? <p className="server-words"><span>Server</span>{problem.detail}</p> : null}
      {problem && Array.isArray(problem.body.errors) ? (
        <ul className="problem-errors">
          {(problem.body.errors as Array<{ path: string; message: string }>).map((item) => (
            <li key={`${item.path}-${item.message}`}><code>{item.path || 'body'}</code> {item.message}</li>
          ))}
        </ul>
      ) : null}
      {typeof problem?.body.debugId === 'string' ? <p className="server-words"><span>PayPal debug id</span>{String(problem.body.debugId)}</p> : null}
      {children}
    </div>
  )
}

export function NoMoneyMoved() {
  return <p className="no-money"><span>PayPal was never called</span><strong>$0 moved</strong></p>
}

export function Person({ tone = 'paper', size = 44 }: { tone?: 'lime' | 'paper' | 'ink' | 'stone'; size?: number }) {
  const fill = { lime: 'var(--lime)', paper: 'var(--surface)', ink: 'var(--ink)', stone: 'var(--stone)' }[tone]
  return (
    <svg className="person" width={size} height={size * 1.3} viewBox="0 0 100 130" aria-hidden="true">
      <circle cx="50" cy="36" r="22" fill="var(--ink)" />
      <path d="M10 128 Q10 66 50 66 Q90 66 90 128 Z" fill={fill} stroke="var(--ink)" strokeWidth="4" />
    </svg>
  )
}
