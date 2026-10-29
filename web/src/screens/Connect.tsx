import { PageHead } from '../components/ui'
import { AgentActivity, ConnectAgent } from '../components/ConnectAgent'
import { useIsOwner } from '../lib/hooks'

export function Connect() {
  const isOwner = useIsOwner()
  return (
    <div className="page" data-testid="connect-page">
      <PageHead eyebrow="Agents" title="Connect an agent" />
      {isOwner ? (
        <>
          <ConnectAgent />
          <AgentActivity />
        </>
      ) : (
        <p className="panel">Only the owner can issue and connect agent keys.</p>
      )}
    </div>
  )
}
