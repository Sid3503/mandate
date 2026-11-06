import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { Mark } from '../components/Shell'
import { Chip, Loading } from '../components/ui'
import { ApiError } from '../lib/api'
import { projectsApi, when } from '../lib/projects'

/**
 * A studio's public profile. The track record is counted from payments PayPal processed through Mandate, and a review
 * is shown only when its signature verifies together with the PayPal capture that proves the client paid. Nothing here
 * is a number the studio typed.
 */
export function PublicProfile() {
  const { handle = '' } = useParams()
  const profile = useQuery({ queryKey: ['public-profile', handle], queryFn: () => projectsApi.publicProfile(handle), retry: false })
  const p = profile.data
  return (
    <div className="share-page">
      <header className="share-head"><div className="brand"><Mark size={28} /><span>Mandate</span></div><span className="eyebrow">Verified profile</span></header>
      <main className="portal-main">
        {profile.isLoading ? <Loading label="Opening the profile" /> : null}
        {profile.error ? <section className="panel" role="alert"><h1>{profile.error instanceof ApiError && profile.error.status === 404 ? 'No such profile' : 'Could not load this profile'}</h1></section> : null}
        {p ? (
          <>
            <section className="profile-hero" data-testid="public-profile">
              <span className="studio-avatar big" aria-hidden="true">{p.displayName.slice(0, 1)}</span>
              <h1>{p.displayName}</h1>
              <p className="lede">{p.headline}</p>
              <p className="fine">On Mandate since {new Date(p.since).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>
              <p className="rating-line">{p.rating !== null ? <><span className="stars">{'★'.repeat(Math.round(p.rating))}{'☆'.repeat(5 - Math.round(p.rating))}</span> <b>{p.rating}</b> · {p.reviewCount} verified review{p.reviewCount === 1 ? '' : 's'}</> : <span className="muted">No reviews yet</span>}</p>
              {p.bio ? <p className="profile-bio">{p.bio}</p> : null}
              <p className="profile-bio fine">Every project runs in stages. You see the work before you pay for it, and your payment is held by PayPal until you approve.</p>
              <div className="row gap-s">{p.website ? <a className="btn btn-ghost btn-small" href={p.website} target="_blank" rel="noreferrer noopener">Website</a> : null}{p.email ? <a className="btn btn-ghost btn-small" href={`mailto:${p.email}`}>Email</a> : null}</div>
            </section>
            <section className="panel">
              <div className="row between wrap gap-s"><h2 className="section-title">Track record on Mandate</h2><Chip tone="auto">Verified by Mandate</Chip></div>
              <div className="track-tiles">
                <div><span>Projects completed</span><b>{p.track.projectsCompleted}</b></div>
                <div><span>Stages paid via PayPal</span><b>{p.track.stagesPaid}</b></div>
                <div><span>Clients</span><b>{p.track.clients}</b></div>
                <div><span>Delivered on time</span><b>{p.track.onTimePercent === null ? '—' : `${p.track.onTimePercent}%`}</b></div>
              </div>
              <p className="fine">These numbers come from payments PayPal processed through Mandate, not from anything the studio typed.</p>
            </section>
            <section className="panel">
              <h2 className="section-title">Reviews</h2>
              {p.reviews.length === 0 ? <p className="muted">Only clients who paid can leave a review. None yet.</p> : (
                <ul className="review-list">
                  {p.reviews.map((review) => (
                    <li key={review.id}>
                      <div className="row between wrap gap-s"><span className="stars">{'★'.repeat(review.stars)}{'☆'.repeat(5 - review.stars)}</span><span className="paid-badge">✓ Paid through PayPal</span></div>
                      <p>“{review.text}”</p>
                      <p className="fine">{review.client} · {review.project} · {when(review.at)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}
      </main>
    </div>
  )
}
