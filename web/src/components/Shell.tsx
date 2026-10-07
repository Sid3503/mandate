import { useLive } from '../lib/live'
import { motion } from 'framer-motion'
import { NavLink, useNavigate } from 'react-router-dom'
import { PageTransition } from './PageTransition'
import { useQueryClient } from '@tanstack/react-query'
import { useOnline, useSession, useToday } from '../lib/hooks'
import { AskProvider, useAsk } from './Ask'
import { session } from '../lib/session'
import { GuideButton, GuideProvider, useGuide } from './GuidedTour'
import { Chip } from './ui'

const NAV = [
  { to: '/', label: 'Today', tour: 'nav-waiting', icon: 'M4 5h16v14H4z M4 9h16', end: true },
  { to: '/jobs', label: 'Jobs', tour: 'nav-jobs', icon: 'M4 7h16v12H4z M9 7V4h6v3' },
  { to: '/deals', label: 'Deals', tour: 'nav-deals', icon: 'M3 12h7 M14 12h7 M9 7l3 5-3 5 M15 7l-3 5 3 5' },
  { to: '/clerk', label: 'Ask', tour: 'nav-clerk', icon: 'M4 5h16v11H9l-5 4z M8 9h8 M8 12h5' },
  { to: '/new', label: 'Request', tour: 'nav-new', icon: 'M12 5v14 M5 12h14' },
  { to: '/ledger', label: 'Ledger', tour: 'nav-ledger', icon: 'M4 5h16 M4 10h16 M4 15h16 M4 20h16' },
  { to: '/rules', label: 'Rules', tour: 'nav-rules', icon: 'M6 4h12v16H6z M9 9h6 M9 13h6 M9 17h3' },
  { to: '/proof', label: 'Proof', tour: 'nav-proof', icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M8.5 12l2.5 2.5 4.5-5' },
]

function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
      {path.split(' M').map((segment, index) => <path key={index} d={index === 0 ? segment : `M${segment}`} />)}
    </svg>
  )
}

export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
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

function ShellFrame() {
  const guide = useGuide()
  const online = useOnline()
  const me = useSession()
  const today = useToday()
  const ask = useAsk()
  const navigate = useNavigate()
  const client = useQueryClient()
  const waiting = today.data?.waiting.length ?? 0
  const live = useLive()
  const lock = () => {
    session.clear()
    client.clear()
    navigate('/unlock', { replace: true })
  }
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="rail" aria-label="Main">
        <div className="brand"><Mark /><span>Mandate</span></div>
        <nav className="rail-nav">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="rail-link" data-tour={item.tour}>
              {({ isActive }) => (
                <>
                  {isActive ? <motion.span layoutId="rail-pill" className="pill" transition={{ type: 'spring', stiffness: 520, damping: 40 }} /> : null}
                  <Icon path={item.icon} />
                  <span>{item.label === 'Request' ? 'Request form' : item.label === 'Ask' ? 'Ask Mandate' : item.label}</span>
                  {item.to === '/' && waiting > 0 ? <span className="badge">{waiting}</span> : null}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="rail-foot">
          <NavLink to="/system" className="rail-link small">System</NavLink>
          <button type="button" className="link rail-tour" onClick={() => guide.start('welcome')}>Full tour</button>
          <div className="who" data-tour="keys">
            <span className="mono">{me.data?.role === 'owner' ? 'Owner key' : me.data?.role === 'proposer' ? 'Proposer key' : '…'}</span>
            <button type="button" className="link" onClick={lock}>Lock</button>
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
          <PageTransition />
        </main>
      </div>

      <nav className="tabbar" aria-label="Main">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className="tab" data-tour={item.tour}>
            {({ isActive }) => (
              <>
                {isActive ? <motion.span layoutId="tab-pill" className="pill" transition={{ type: 'spring', stiffness: 520, damping: 40 }} /> : null}
                <Icon path={item.icon} />
                <span>{item.label}</span>
                {item.to === '/' && waiting > 0 ? <span className="badge">{waiting}</span> : null}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
