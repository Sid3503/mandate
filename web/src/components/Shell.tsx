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
import { useStudioName } from './StoryRail'

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
  { to: '/payees', label: 'Payees', tour: 'nav-payees', icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75' },
  { to: '/new', label: 'Request form', tour: 'nav-new', icon: 'M12 5v14 M5 12h14' },
  { to: '/clerk', label: 'Ask Mandate', tour: 'nav-clerk', icon: 'M4 5h16v11H9l-5 4z M8 9h8 M8 12h5' },
  { to: '/system#h-connect', label: 'Connect an agent', tour: 'nav-connect', icon: 'M8 12h8 M5 8v8 M19 8v8 M3 10v4 M21 10v4' },
]

/** Everything the desktop rail shows. */

const ROLE_WORD: Record<string, string> = {
  owner: 'Owner',
  approver: 'Approver',
  proposer: 'Proposer',
  viewer: 'Viewer',
  payee: 'Payee',
}

const ROLE_CHIP: Record<string, string> = {
  approver: 'Approver · the queue, not the rules',
  proposer: 'Proposer · can ask, not approve',
  viewer: 'Viewer · can look',
  payee: 'Payee · your payments',
}

/** The chip says which PayPal this server actually uses. A simulated demo is not a missing account. */
function paypalChip(mode: string | undefined): { text: string; tone: 'auto' | 'muted'; title: string } {
  if (mode === 'live') return { text: 'PayPal live', tone: 'auto', title: 'Every studio on this server settles through one live PayPal account.' }
  if (mode === 'sandbox') return { text: 'PayPal sandbox', tone: 'auto', title: 'Every studio on this server settles through one PayPal sandbox. Invoices and payouts still go to this studio.' }
  if (mode === 'fake') return { text: 'Simulated PayPal', tone: 'muted', title: 'No real money. This demo uses a stand-in for PayPal.' }
  return { text: 'PayPal not connected', tone: 'muted', title: 'Nothing on this server can be charged until PayPal is connected.' }
}
/** A client key sees only its own price. The rest of the studio is not its console. */
const CLIENT_NAV: NavItem[] = [
  { to: '/deals', label: 'Deals', tour: 'nav-deals', icon: 'M3 12h7 M14 12h7 M9 7l3 5-3 5 M15 7l-3 5 3 5', end: true },
]

const RAIL: NavItem[] = [...NAV, ...MORE]

/**
 * Whether a nav item is the current place. An item's own address beats another item's alias, so on a surface that shows
 * both Jobs and Deals, /deals lights Deals and not Jobs (two lit links fight over the one lime pill and one goes dark).
 * Pass the items that surface actually shows: the phone tab bar has no Deals tab, so there /deals still lights Jobs.
 */
function isHere(item: NavItem, pathname: string, shown: NavItem[]): boolean {
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`)
  const own = (it: NavItem) => (it.end ? pathname === it.to : under(it.to))
  if (own(item)) return true
  if (item.end) return false
  return (item.also ?? []).some(under) && !shown.some((other) => other !== item && own(other))
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
  const studio = useStudioName()
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

  const onSwitchDemoRole = async (role: 'owner' | 'approver' | 'proposer' | 'viewer' | 'payee') => {
    try {
      await api.switchDemoRole(role)
      await client.invalidateQueries()
      toast({ title: `Switched to ${role}`, body: `You are now browsing as ${role}.`, tone: 'info', key: 'demo-role' })
      const landing = role === 'proposer' ? '/clerk' : role === 'viewer' ? '/proof' : role === 'payee' ? '/payments' : '/'
      navigate(landing)
    } catch {
      toast({ title: 'Could not switch role', body: 'The demo role switch failed.', tone: 'warn', key: 'demo-role-error' })
    }
  }

  const onResetDemo = async () => {
    try {
      await api.resetDemo()
      await client.invalidateQueries()
      toast({ title: 'Demo reset', body: 'The ledger and rules are back to a fresh Line Studio.', tone: 'info', key: 'demo-reset' })
      navigate('/')
    } catch {
      toast({ title: 'Could not reset demo', body: 'Reset failed.', tone: 'warn', key: 'demo-reset-error' })
    }
  }
  const buyer = me.data?.side === 'buyer'
  const nav = buyer ? CLIENT_NAV : NAV
  const more = buyer ? [] : MORE
  const rail = buyer ? CLIENT_NAV : RAIL
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
          {nav.map((item) => (
            <RailLink key={item.to} item={item} collapsed={collapsed} here={isHere(item, location.pathname, rail)} badge={item.to === '/' ? waiting : 0} />
          ))}
          {more.length > 0 ? (
          <div className="rail-more" role="group" aria-label="More">
            <span className="rail-more-title rail-label">More</span>
            {more.map((item) => (
              <RailLink key={item.to} item={item} collapsed={collapsed} here={isHere(item, location.pathname, rail)} badge={0} small />
            ))}
          </div>
          ) : null}
        </nav>
        <div className="rail-foot">
          {buyer ? null : (
          <NavLink to="/system" className="rail-link small" title={collapsed ? 'System' : undefined}>
            {({ isActive }) => (
              <>
                {isActive ? <motion.span layoutId="rail-pill" className="pill" transition={{ type: 'spring', stiffness: 520, damping: 40 }} /> : null}
                <Settings size={20} aria-hidden="true" className="rail-foot-icon" />
                <span className="rail-label">System</span>
              </>
            )}
          </NavLink>
          )}
          {buyer ? null : <button type="button" className="link rail-tour" onClick={() => guide.start('welcome')} title={collapsed ? 'Full tour' : undefined}><span className="rail-label">Full tour</span></button>}
          <div className="who" data-tour="keys">
            <span className="mono rail-label">{buyer ? 'Client' : (ROLE_WORD[me.data?.role ?? ''] ?? 'Signed in')}</span>
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
            {/* Who the person at the keyboard is, in every screen: the studio. Everyone else has their own link or key. */}
            {buyer ? (
              <span className="you-chip" data-testid="you-are" title="You set only what this client will pay. The studio never sees that number.">
                You · client of <b>{me.data?.studioName ?? studio ?? 'this studio'}</b>
              </span>
            ) : me.data?.role === 'owner' ? (
              <span className="you-chip" data-testid="you-are" title="You run the studio. Your client and your contractors each get their own link and see only their part. Agents get keys that can ask, never pay.">
                You · <b>{studio ?? 'the studio'}</b> owner
              </span>
            ) : null}
            <span className="ai-badge hide-phone" data-testid="ai-boundary" title="AI agents here can draft, ask and negotiate. None of them has a way to approve or move money: only your rules and your tap can.">AI asks · never pays</span>
            {buyer ? null : <button type="button" className="btn btn-ghost btn-small ask-top" onClick={() => ask.open()} disabled={!me.data?.agents.enabled} title="Ask the clerk (Cmd or Ctrl + K)">Ask <kbd aria-hidden="true">⌘K</kbd></button>}
            {buyer ? null : <GuideButton />}
            {buyer ? null : <PauseButton paused={Boolean(paused)} />}
            {buyer ? <Chip tone="need">Client · your ceiling only</Chip> : me.data && ROLE_CHIP[me.data.role] ? <Chip tone={me.data.role === 'approver' ? 'ink' : 'need'}>{ROLE_CHIP[me.data.role]}</Chip> : null}
            {buyer ? null : <Chip tone={live.connected ? 'auto' : 'muted'}><span title={live.connected ? 'Updates arrive the moment they happen' : 'Reconnecting. The page still refreshes every few seconds.'}>{live.connected ? 'Live' : 'Reconnecting'}</span></Chip>}
            {me.data ? <Chip tone={paypalChip(me.data.paypalMode).tone}><span title={paypalChip(me.data.paypalMode).title}>{paypalChip(me.data.paypalMode).text}</span></Chip> : null}
            {buyer ? <span className="topbar-sys">v{me.data?.version ?? '—'}</span> : <NavLink to="/system" className="topbar-sys" aria-label="System">v{me.data?.version ?? '—'}</NavLink>}
          </div>
        </header>
        {me.data?.workspaceMode === 'demo' ? (
          <div className="demo-banner" role="status" data-testid="demo-banner">
            <div className="row between align-center wrap gap-s">
              <div>
                Simulated PayPal. No real money. Your demo ends in 24 hours.{' '}
                <Link to="/live-proof" className="link small" data-testid="live-proof-link" style={{ marginLeft: 6 }}>Live proof ↗</Link>
              </div>
              <div className="row gap-xs align-center demo-controls" data-testid="demo-role-switcher">
                <span className="small muted">Role:</span>
                {(['owner', 'approver', 'proposer', 'viewer', 'payee'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`btn btn-small ${me.data?.role === r ? 'btn-ink' : 'btn-ghost'}`}
                    data-testid={`demo-role-${r}`}
                    onClick={() => void onSwitchDemoRole(r)}
                  >
                    {r}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  data-testid="demo-reset-btn"
                  onClick={() => void onResetDemo()}
                  title="Reset the demo to start clean"
                >
                  Reset
                </button>
              </div>
            </div>
          </div>
        ) : null}
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
        {nav.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={isHere(item, location.pathname, nav) ? 'tab active' : 'tab'} data-tour={item.tour}>
            <>
              {isHere(item, location.pathname, nav) ? <motion.span layoutId="tab-pill" className="pill" transition={{ type: 'spring', stiffness: 520, damping: 40 }} /> : null}
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
