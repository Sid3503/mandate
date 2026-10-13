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

        {query.isLoading ? <Loading label="Loading live proof…" /> : null}
        <ProblemCard error={query.error} />

        {!query.isLoading && files.length === 0 ? (
          <div className="empty-state" data-testid="live-proof-empty" style={{ padding: '32px 0' }}>
            <p className="mono" style={{ fontSize: '18px', fontWeight: 600, marginBottom: 8 }}>not added yet</p>
            <p className="fine">
              Live PayPal sandbox runs are recorded by human testing. Once added to <code className="mono">docs/live-proof/*.json</code>,
              the verified receipts and PayPal capture IDs will appear here.
            </p>
            <div className="row gap-s wrap" style={{ marginTop: 16 }}>
              <Link to="/verify" className="btn btn-ink btn-small">Verify any receipt here</Link>
              <Link to="/proof" className="btn btn-ghost btn-small">View studio proof lines</Link>
            </div>
          </div>
        ) : null}

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
      </section>
    </div>
  )
}
