import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useOnline, useProposals, useSession } from '../lib/hooks'
import { session } from '../lib/session'
import { GuideButton, GuideProvider, useGuide } from './GuidedTour'
import { Chip } from './ui'

const NAV = [
  { to: '/', label: 'Waiting', tour: 'nav-waiting', icon: 'M4 5h16v14H4z M4 9h16', end: true },
  { to: '/jobs', label: 'Jobs', tour: 'nav-jobs', icon: 'M4 7h16v12H4z M9 7V4h6v3' },
  { to: '/deals', label: 'Deals', tour: 'nav-deals', icon: 'M3 12h7 M14 12h7 M9 7l3 5-3 5 M15 7l-3 5 3 5' },
  { to: '/clerk', label: 'Clerk', tour: 'nav-clerk', icon: 'M4 5h16v11H9l-5 4z M8 9h8 M8 12h5' },
  { to: '/new', label: 'Ask', tour: 'nav-new', icon: 'M12 5v14 M5 12h14' },
  { to: '/ledger', label: 'Ledger', tour: 'nav-ledger', icon: 'M4 5h16 M4 10h16 M4 15h16 M4 20h16' },
  { to: '/rules', label: 'Rules', tour: 'nav-rules', icon: 'M6 4h12v16H6z M9 9h6 M9 13h6 M9 17h3' },
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
      <ShellFrame />
    </GuideProvider>
  )
}

function ShellFrame() {
  const guide = useGuide()
  const online = useOnline()
  const me = useSession()
  const proposals = useProposals()
  const navigate = useNavigate()
  const client = useQueryClient()
  const waiting = (proposals.data?.data ?? []).filter((item) => item.phase === 'pending_approval').length
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
              <Icon path={item.icon} />
              <span>{item.label === 'Ask' ? 'New request' : item.label === 'Waiting' ? 'Waiting for you' : item.label}</span>
              {item.to === '/' && waiting > 0 ? <span className="badge">{waiting}</span> : null}
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
          <p className="rail-rule">Agents can ask. Only the rules and the owner’s tap can pay.</p>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <div className="brand brand-mobile"><Mark size={24} /><span>Mandate</span></div>
          <div className="topbar-status">
            <GuideButton />
            {me.data?.role === 'proposer' ? <Chip tone="need">Proposer · can ask, not approve</Chip> : null}
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
          <Outlet />
        </main>
      </div>

      <nav className="tabbar" aria-label="Main">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className="tab" data-tour={item.tour}>
            <Icon path={item.icon} />
            <span>{item.label}</span>
            {item.to === '/' && waiting > 0 ? <span className="badge">{waiting}</span> : null}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
