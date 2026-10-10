import { NavLink } from 'react-router-dom'

const TABS = [
  { to: '/ledger', label: 'Ledger', hint: 'every request', phone: true },
  { to: '/proof', label: 'Proof', hint: 'check it', phone: true },
  { to: '/control-room', label: 'Control room', hint: 'dashboard', phone: false },
]

/** One row for the three views of what happened. Each is still its own address, so a link or a bookmark keeps working. */
export function ActivityTabs() {
  return (
    <nav className="activity-tabs" aria-label="Activity views">
      {TABS.map((tab) => (
        <NavLink key={tab.to} to={tab.to} className={tab.phone ? undefined : 'hide-phone'}>
          {tab.label}<small>{tab.hint}</small>
        </NavLink>
      ))}
    </nav>
  )
}
