import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { PageHead, Loading, ProblemCard } from '../components/ui'
import { api } from '../lib/api'

export function LiveProof() {
  const query = useQuery({ queryKey: ['live-proof'], queryFn: api.liveProof })

  const files = query.data?.files ?? []

  return (
    <div className="page live-proof">
      <PageHead eyebrow="Recorded PayPal Sandbox Receipts" title="Live proof">
        <Link to="/" className="btn btn-ghost btn-small">Back to console</Link>
      </PageHead>

      <section className="panel" aria-labelledby="h-live-proof" data-testid="live-proof-panel">
        <h2 className="panel-title" id="h-live-proof">Real PayPal Sandbox Evidence</h2>
        <p className="fine">
          Every payment in production and live testing produces cryptographic proof bound to PayPal order IDs,
          capture references, and passkey signatures.
        </p>

        {query.isLoading ? <Loading label="Loading live proof..." /> : null}
        <ProblemCard error={query.error} />

        {files.length > 0 ? (
          <div className="proof-files-grid" data-testid="live-proof-files">
            {files.map((file) => (
              <article key={file.name} className="panel" style={{ marginTop: 12 }}>
                <h3 className="mono small">{file.name}</h3>
                <pre className="mono small" style={{ maxHeight: 240, overflow: 'auto', background: 'var(--panel)', padding: 12 }}>
                  {JSON.stringify(file.content, null, 2)}
                </pre>
              </article>
            ))}
          </div>
        ) : null}

        <div className="empty-state" data-testid="live-proof-empty" style={{ padding: '24px 0', marginTop: files.length > 0 ? 20 : 0 }}>
          <p className="mono" style={{ fontSize: '16px', fontWeight: 600, marginBottom: 8 }}>not added yet: interactive buyer login</p>
          <p className="fine">
            Live PayPal sandbox charge capture requires human buyer login at the approval URL. Steps needing interactive browser authentication remain marked not added yet until verified in a browser session.
          </p>
          <div className="row gap-s wrap" style={{ marginTop: 12 }}>
            <Link to="/verify" className="btn btn-ink btn-small">Verify any receipt here</Link>
            <Link to="/proof" className="btn btn-ghost btn-small">View studio proof lines</Link>
          </div>
        </div>
      </section>
    </div>
  )
}
