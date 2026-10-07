import { Component, type ErrorInfo, type ReactNode } from 'react'
import { isChunkError, reportClientError } from '../lib/report'

type Props = { scope: string; children: ReactNode; /** Shown instead of a card when the whole app is the thing that failed. */ fullPage?: boolean }
type State = { error: Error | null; reference: string | null }

/**
 * A screen that crashes becomes a card, not a blank page. It says what is true (this screen failed; nothing on it sent
 * anything), gives a reference the log can be searched by, and offers the ways out. A page that could not load because
 * the app was updated underneath it reloads itself, once.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reference: null }

  static getDerivedStateFromError(error: Error): State {
    return { error, reference: null }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isChunkError(error)) {
      // An update was deployed while this tab was open. One automatic reload gets the new files; a second failure is shown.
      try {
        if (sessionStorage.getItem('mandate.reloaded') !== '1') {
          sessionStorage.setItem('mandate.reloaded', '1')
          location.reload()
          return
        }
      } catch {
        // No storage: show the card instead of looping.
      }
    }
    this.setState({ reference: reportClientError(`screen:${this.props.scope}`, error, { componentStack: info.componentStack ?? undefined }) })
  }

  render() {
    const { error, reference } = this.state
    if (!error) return this.props.children
    const stale = isChunkError(error)
    return (
      <div className={this.props.fullPage ? 'page boundary boundary-full' : 'page boundary'} role="alert" data-testid="error-boundary">
        <section className="panel">
          <span className="eyebrow">{stale ? 'The app was updated' : 'This screen hit a problem'}</span>
          <h1 className="boundary-title">{stale ? 'Reload to get the new version' : 'Something went wrong here'}</h1>
          <p>{stale ? 'Mandate was updated while this tab was open, so part of the page could not be loaded.' : 'The screen stopped. Nothing on it sent anything to PayPal, and any request already made is safe in the ledger.'} Your key and your work in other screens are untouched.</p>
          {reference ? <p className="fine">Reference <span className="mono">{reference}</span>. Quote it if you ask for help.</p> : null}
          <div className="row gap-s wrap">
            <button type="button" className="btn btn-ink" onClick={() => location.reload()}>Reload</button>
            {stale ? null : <button type="button" className="btn btn-ghost" onClick={() => this.setState({ error: null, reference: null })}>Try this screen again</button>}
            <a className="btn btn-ghost" href="/app/">Go to Today</a>
          </div>
        </section>
      </div>
    )
  }
}
