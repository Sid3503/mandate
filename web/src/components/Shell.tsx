import { useCallback, useEffect, useState } from 'react'
import { useLive } from '../lib/live'
import { useToast } from './Toast'
import { motion } from 'framer-motion'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { ChevronsLeft, Lock, Settings } from 'lucide-react'
import { PageTransition } from './PageTransition'
import { ErrorBoundary } from './ErrorBoundary'
import { StatusBanner } from './StatusBanner'
import { PauseButton } from './PauseButton'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useOnline, useSession, useToday } from '../lib/hooks'
import { AskProvider, useAsk } from './Ask'
import { session } from '../lib/session'
import { GuideButton, GuideProvider, useGuide } from './GuidedTour'
import { Chip } from './ui'

type NavItem = { to: string; label: string; tour: string; icon: string; end?: boolean; also?: string[] }

/** Four places, and only four: what needs me, my jobs, my rules, what happened. Everything else is one step inside them. */
const NAV: NavItem[] = [
  { to: '/', label: 'Today', tour: 'nav-waiting', icon: 'M4 5h16v14H4z M4 9h16', end: true },
  { to: '/jobs', label: 'Jobs', tour: 'nav-jobs', icon: 'M4 7h16v12H4z M9 7V4h6v3', also: ['/deals'] },
  { to: '/rules', label: 'Rules', tour: 'nav-rules', icon: 'M6 4h12v16H6z M9 9h6 M9 13h6 M9 17h3' },
  { to: '/ledger', label: 'Activity', tour: 'nav-activity', icon: 'M4 5h16 M4 10h16 M4 15h16 M4 20h16', also: ['/proof', '/control-room'] },
]

/** Quiet shortcuts on the desktop rail. On a phone they live inside Jobs and Today. */
const MORE: NavItem[] = [
  { to: '/deals', label: 'Deals', tour: 'nav-deals', icon: 'M3 12h7 M14 12h7 M9 7l3 5-3 5 M15 7l-3 5 3 5' },
  { to: '/new', label: 'Request form', tour: 'nav-new', icon: 'M12 5v14 M5 12h14' },
  { to: '/clerk', label: 'Ask Mandate', tour: 'nav-clerk', icon: 'M4 5h16v11H9l-5 4z M8 9h8 M8 12h5' },
  { to: '/system#h-connect', label: 'Connect an agent', tour: 'nav-connect', icon: 'M8 12h8 M5 8v8 M19 8v8 M3 10v4 M21 10v4' },
]

function isHere(item: NavItem, pathname: string): boolean {
  if (item.end) return pathname === item.to
  return [item.to, ...(item.also ?? [])].some((base) => pathname === base || pathname.startsWith(`${base}/`))
}

function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
      {path.split(' M').map((segment, index) => <path key={index} d={index === 0 ? segment : `M${segment}`} />)}
    </svg>
  )
}

export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg className="mark-live" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" fill="var(--ink)" />
      <rect x="10" y="10" width="44" height="44" fill="var(--lime)" />
      <rect x="10" y="10" width="15" height="15" fill="var(--ink)" />
      <rect x="25" y="25" width="14" height="14" fill="var(--ink)" />
      <rect x="39" y="39" width="15" height="15" fill="var(--ink)" />
    </svg>
  )
}

export function Shell() {
  return (
    <GuideProvider>
      <AskProvider>
        <ShellFrame />
      </AskProvider>
    </GuideProvider>
  )
}

function RailLink({ item, collapsed, here, badge, small = false }: { item: NavItem; collapsed: boolean; here: boolean; badge: number; small?: boolean }) {
  // A shortcut to a spot inside a page is a plain link: it never lights up as the page you are on.
  if (item.to.includes('#')) {
    return (
      <Link to={item.to} className={`rail-link${small ? ' small' : ''}`} data-tour={item.tour} title={collapsed ? item.label : undefined}>
        <Icon path={item.icon} />
        <span className="rail-label">{item.label}</span>
      </Link>
    )
  }
  return (
    <NavLink to={item.to} end={item.end} className={`rail-link${small ? ' small' : ''}${here ? ' active' : ''}`} data-tour={item.tour} title={collapsed ? item.label : undefined}>
      <>
        {here ? <motion.span layoutId="rail-pill" className="pill" transition={{ type: 'spring', stiffness: 520, damping: 40 }} /> : null}
        <Icon path={item.icon} />
        <span className="rail-label">{item.label}</span>
        {badge > 0 ? <span className="badge">{badge}</span> : null}
      </>
    </NavLink>
  )
}

function ShellFrame() {
  const guide = useGuide()
  const online = useOnline()
  const me = useSession()
  const today = useToday()
  const ask = useAsk()
  const navigate = useNavigate()
  const client = useQueryClient()
  // Collapsible-icon rail, mirroring shadcn `collapsible="icon"`:
  // expanded = 248px with labels, collapsed = icon-only. Persisted per tab-group.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('mandate:rail-collapsed') === '1'
    } catch {
      return false
    }
  })
  const toggleRail = useCallback(() => {
    setCollapsed((value) => {
      try {
        window.localStorage.setItem('mandate:rail-collapsed', value ? '0' : '1')
      } catch {
        /* storage unavailable (private mode) — collapse still works for the session */
      }
      return !value
    })
  }, [])
  useEffect(() => {
    try {
      window.localStorage.setItem('mandate:rail-collapsed', collapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [collapsed])
  // Same shortcut as shadcn Sidebar (Cmd/Ctrl+B).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        // Don't steal the keystroke from fields.
        const target = event.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
        event.preventDefault()
        toggleRail()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleRail])
  const waiting = Array.isArray(today.data?.waiting) ? today.data.waiting.length : 0
  const live = useLive()
  const paused = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 15_000, retry: false }).data?.paused ?? null
  const location = useLocation()
  const toast = useToast()
  const lock = () => {
    session.clear()
    client.clear()
    toast({ title: 'Locked', body: 'The key is gone from this tab.', tone: 'info', key: 'lock' })
    navigate('/unlock', { replace: true })
  }
  return (
    <div className="shell" data-collapsed={collapsed ? 'true' : 'false'}>
      <a className="skip" href="#main">Skip to content</a>
      <aside className="rail" aria-label="Main" data-state={collapsed ? 'collapsed' : 'expanded'}>
        <div className="brand">
          <button
            type="button"
            className="brand-swap"
            onClick={toggleRail}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar (⌘B)' : 'Collapse sidebar (⌘B)'}
          >
            <Mark />
            <ChevronsLeft size={18} aria-hidden="true" className="brand-chevron" />
          </button>
          <span className="brand-word">Mandate</span>
        </div>
        <nav className="rail-nav" aria-label="Sections">
          {NAV.map((item) => (
            <RailLink key={item.to} item={item} collapsed={collapsed} here={isHere(item, location.pathname)} badge={item.to === '/' ? waiting : 0} />
          ))}
          <div className="rail-more" role="group" aria-label="More">
            <span className="rail-more-title rail-label">More</span>
            {MORE.map((item) => (
              <RailLink key={item.to} item={item} collapsed={collapsed} here={isHere(item, location.pathname)} badge={0} small />
            ))}
          </div>
        </nav>
        <div className="rail-foot">
          <NavLink to="/system" className="rail-link small" title={collapsed ? 'System' : undefined}>
            {({ isActive }) => (
              <>
                {isActive ? <motion.span layoutId="rail-pill" className="pill" transition={{ type: 'spring', stiffness: 520, damping: 40 }} /> : null}
                <Settings size={20} aria-hidden="true" className="rail-foot-icon" />
                <span className="rail-label">System</span>
              </>
            )}
          </NavLink>
          <button type="button" className="link rail-tour" onClick={() => guide.start('welcome')} title={collapsed ? 'Full tour' : undefined}><span className="rail-label">Full tour</span></button>
          <div className="who" data-tour="keys">
            <span className="mono rail-label">{me.data?.role === 'owner' ? 'Owner key' : me.data?.role === 'proposer' ? 'Proposer key' : '…'}</span>
            <button type="button" className="link lock-btn" onClick={lock} title={collapsed ? 'Lock' : undefined} aria-label="Lock">
              <Lock size={18} aria-hidden="true" className="rail-foot-icon" />
              <span className="rail-label">Lock</span>
            </button>
          </div>
          <p className="rail-rule">Agents can ask. Only the rules, and the owner’s tap or standing rule, can pay.</p>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <div className="brand brand-mobile"><Mark size={24} /><span>Mandate</span></div>
          <div className="topbar-status">
            <button type="button" className="btn btn-ghost btn-small ask-top" onClick={() => ask.open()} disabled={!me.data?.agents.enabled} title="Ask the clerk (Cmd or Ctrl + K)">Ask <kbd aria-hidden="true">⌘K</kbd></button>
            <GuideButton />
            <PauseButton paused={Boolean(paused)} />
            {me.data?.role === 'proposer' ? <Chip tone="need">Proposer · can ask, not approve</Chip> : null}
            <Chip tone={live.connected ? 'auto' : 'muted'}><span title={live.connected ? 'Updates arrive the moment they happen' : 'Reconnecting. The page still refreshes every few seconds.'}>{live.connected ? 'Live' : 'Reconnecting'}</span></Chip>
            {me.data ? <Chip tone={me.data.paypalConfigured ? 'auto' : 'muted'}>{me.data.paypalConfigured ? 'PayPal sandbox' : 'PayPal not set'}</Chip> : null}
            <NavLink to="/system" className="topbar-sys" aria-label="System">v{me.data?.version ?? '—'}</NavLink>
          </div>
        </header>
        {!online ? (
          <div className="offline" role="status">
            <strong>Offline</strong> Reading what was already loaded. Nothing that moves money can be sent until you are back online.
          </div>
        ) : null}
        <main id="main" className="main" tabIndex={-1}>
          <StatusBanner />
          <ErrorBoundary key={location.pathname} scope={location.pathname.split('/')[1] || 'today'}>
            <PageTransition />
          </ErrorBoundary>
        </main>
      </div>

      <nav className="tabbar" aria-label="Main">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={isHere(item, location.pathname) ? 'tab active' : 'tab'} data-tour={item.tour}>
            <>
              {isHere(item, location.pathname) ? <motion.span layoutId="tab-pill" className="pill" transition={{ type: 'spring', stiffness: 520, damping: 40 }} /> : null}
              <Icon path={item.icon} />
              <span>{item.label}</span>
              {item.to === '/' && waiting > 0 ? <span className="badge">{waiting}</span> : null}
            </>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
