import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError, api, type ProcureResult, type PurchaseOutcome } from '../lib/api'
import { dollars, parseCents } from '../lib/money'
import { Chip, Empty, GateChip, Money, ProblemCard } from './ui'
import type { Gate } from '../lib/types'

const gateOf = (value: string): Gate => (value === 'AUTO' || value === 'NEEDS_APPROVAL' || value === 'DENY' || value === 'DUAL_TAP' ? value : 'DENY')

/**
 * Buy equipment from the catalog. The price on the card is the catalog's. Asking files that price with the rules;
 * the button does not send an amount.
 */
export function BuyPanel() {
  const status = useQuery({ queryKey: ['procure'], queryFn: () => api.procureStatus() })
  const [query, setQuery] = useState('drawing tablet')
  const [budget, setBudget] = useState('')
  const [results, setResults] = useState<ProcureResult[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<unknown>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [asked, setAsked] = useState<Record<string, PurchaseOutcome | { error: ApiError }>>({})

  const search = async () => {
    setSearching(true)
    setSearchError(null)
    try {
      const max = budget.trim() ? parseCents(budget) : null
      if (budget.trim() && max === null) {
        setSearchError(new ApiError(422, 'procure.max', 'Budget is not a price', 'Write a budget like 20 or 20.00.', {}))
        return
      }
      const found = await api.procureSearch(query.trim(), max ?? undefined)
      setResults(found.results)
      setNote(found.note)
    } catch (error) {
      setResults(null)
      setSearchError(error)
    } finally {
      setSearching(false)
    }
  }

  const buy = async (item: ProcureResult) => {
    if (!item.best) return
    setBusyId(item.productId)
    try {
      const outcome = await api.procurePropose({
        productId: item.productId,
        merchant: item.best.merchant,
        maxPriceCents: budget.trim() ? parseCents(budget) ?? undefined : undefined,
        prompt: `buy ${item.title}`,
      })
      setAsked((current) => ({ ...current, [item.productId]: outcome }))
    } catch (error) {
      setAsked((current) => ({ ...current, [item.productId]: { error: error instanceof ApiError ? error : new ApiError(0, 'error', 'Could not ask', 'The request did not go through.', {}) } }))
    } finally {
      setBusyId(null)
    }
  }

  if (status.isLoading) return null
  if (status.isError) return <section className="panel"><ProblemCard error={status.error} onRetry={() => void status.refetch()} /></section>
  if (!status.data?.enabled) {
    return (
      <section className="panel" aria-label="Buy equipment">
        <span className="eyebrow">Buy equipment</span>
        <Empty title="Product search is off">CHANNEL3_API_KEY is not set.</Empty>
      </section>
    )
  }

  return (
    <section className="panel" aria-label="Buy equipment">
      <span className="eyebrow">Buy equipment</span>
      <p className="fine">Search the catalog, then ask the rules to buy one. The price is read from the catalog at the moment of asking. You do not type an amount.</p>
      <p className="fine">Sandbox: the vendor PayPal account is a stand-in for the real store. No real merchant is paid and nothing ships.</p>
      <form className="field-row" onSubmit={(event) => { event.preventDefault(); void search() }}>
        <label className="field"><span>Look for</span><input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} /></label>
        <label className="field"><span>Budget (optional)</span><input value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" placeholder="20.00" /></label>
      </form>
      <button type="button" className="btn btn-lime" disabled={searching || query.trim().length < 2} onClick={() => void search()}>{searching ? 'Searching…' : 'Search'}</button>
      {searchError ? <ProblemCard error={searchError} /> : null}
      {results && results.length === 0 ? <p className="fine">Nothing matched.</p> : null}
      {results && results.length > 0 ? (
        <ul className="buy-grid">
          {results.map((item) => {
            const verdict = asked[item.productId]
            const offer = item.best
            return (
              <li key={item.productId} className="product-card">
                {item.imageUrl ? <img src={item.imageUrl} alt="" /> : <span className="product-photo" aria-hidden="true">No image</span>}
                <strong>{item.title}</strong>
                <span className="fine">{item.brand ?? 'No brand'}</span>
                {offer ? <Money cents={offer.priceCents} /> : <span className="fine">Not in stock</span>}
                <span className="fine">{offer ? offer.merchant : 'No store'}</span>
                {offer?.vendor ? <Chip tone="auto">{offer.vendor.name}</Chip> : offer ? <Chip tone="muted">Not on your rules</Chip> : null}
                <p className="fine">{item.why}</p>
                <button type="button" className="btn btn-ink btn-small" disabled={!offer || busyId === item.productId} onClick={() => void buy(item)}>{busyId === item.productId ? 'Asking…' : 'Ask to buy'}</button>
                {verdict && 'proposal' in verdict ? (
                  <div className="product-verdict">
                    <GateChip gate={gateOf(verdict.proposal.gate)} />
                    <span className="mono small">{verdict.proposal.clause}</span>
                    <p className="fine">{verdict.proposal.detail}</p>
                    <p className="fine">Filed at {dollars(verdict.proposal.amountCents)}, the catalog price.</p>
                  </div>
                ) : null}
                {verdict && 'error' in verdict ? <ProblemCard error={verdict.error} /> : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {note ? <p className="fine">{note}</p> : null}
    </section>
  )
}
