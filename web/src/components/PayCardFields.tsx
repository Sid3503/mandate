import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { createCardFields, type CardFields } from '../lib/paypalSdk'
import type { PaySession } from '../lib/types'
import { Chip, Money } from './ui'

/**
 * Paying a locked bill on our own page.
 *
 * The amount, the description and the order are the server's: the browser was handed an order id and a browser-safe
 * token, and nothing else. It cannot change a cent, and it cannot capture. The server re-reads the order after the
 * card is submitted and refuses if it no longer matches the lock.
 *
 * The card fields themselves are PayPal-hosted iframes dropped into our own form, so no card number reaches this
 * server and the buyer never leaves the page.
 */
export function PayCardFields({ token, proposalId, amountCents, currency, description, onPaid, embedded = false, paused = false, initialSession = null, cardFields = null, prepareCard, onActivity }: {
  /** The link the buyer holds. Without one, the owner is paying, and the owner key is used. */
  token?: string
  proposalId: string
  amountCents: number
  currency: string
  description: string
  /** `phase` is what the server settled to. `capture_pending` means PayPal is still reviewing it. */
  onPaid: (result?: { phase: string }) => void
  /** The pay sheet around this form already shows the amount and the result. */
  embedded?: boolean
  /** A wallet window is open, so the card button waits. */
  paused?: boolean
  /** A session the sheet already opened, so this form does not open a second one on its own. */
  initialSession?: PaySession | null
  /** Card fields from the sheet's SDK instance. Without them, this form loads its own. */
  cardFields?: CardFields | null
  /** Asks the server for a card order just before the card is sent, so a wallet order opened in between is replaced. */
  prepareCard?: () => Promise<PaySession>
  /** Tells the sheet when the card itself is being submitted, so a wallet button does not open over it. */
  onActivity?: (active: boolean) => void
}) {
  const [session, setSession] = useState<PaySession | null>(initialSession)
  const [fields, setFields] = useState<CardFields | null>(cardFields)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const numberRef = useRef<HTMLDivElement>(null)
  const expiryRef = useRef<HTMLDivElement>(null)
  const cvvRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (initialSession) setSession(initialSession)
  }, [initialSession])

  useEffect(() => { onActivity?.(busy) }, [busy, onActivity])

  useEffect(() => {
    if (cardFields) {
      setFields(cardFields)
      return
    }
    let live = true
    const open = async () => {
      try {
        const made = prepareCard ? await prepareCard() : token ? await api.paySession(token, proposalId) : await api.paySessionOwner(proposalId)
        if (!live) return
        setSession(made)
        const card = await createCardFields({ clientToken: made.clientToken, environment: made.environment })
        if (!live) return
        if (!card.eligible) {
          setProblem('A card cannot be used for this payment here. Pay on PayPal instead.')
          return
        }
        setFields(card)
      } catch (error) {
        if (!live) return
        setProblem(error instanceof ApiError ? error.message : 'The payment form could not be opened.')
      }
    }
    void open()
    return () => { live = false }
  }, [token, proposalId, cardFields, prepareCard])

  // The card fields are PayPal's iframes, and they go into containers this page owns. The containers only exist once
  // the fields are set, so this is a second pass: the first one opens the form, this one puts it on the page.
  useEffect(() => {
    if (!fields) return
    let live = true
    const mount = async () => {
      try {
        await Promise.all([
          fields.render(numberRef.current!, 'number', 'Card number'),
          fields.render(expiryRef.current!, 'expiry', 'MM/YY'),
          fields.render(cvvRef.current!, 'cvv', 'CVV'),
        ])
      } catch {
        if (live) setProblem('The payment form could not be shown. Pay on PayPal instead.')
      }
    }
    void mount()
    return () => { live = false }
  }, [fields])
  const pay = async () => {
    if (!fields || busy || paused) return
    setBusy(true)
    setProblem(null)
    try {
      // A wallet button may have replaced the card order since the form opened. Ask for the card order again, then
      // submit that one. The server still re-reads it before it captures.
      let current = session
      if (prepareCard) {
        try {
          current = await prepareCard()
          setSession(current)
        } catch (error) {
          setProblem(error instanceof ApiError ? error.message : 'The payment form could not be opened.')
          return
        }
      }
      if (!current) return
      // A card PayPal's form will not send (an empty field, a mistyped number) comes back as a failed result with the
      // reason in words the buyer can fix, so a throw here means PayPal itself could not be reached.
      let result: Awaited<ReturnType<CardFields['submit']>>
      try {
        // The payer's country, from their own browser. A wrong country fails the bank's address check, so when it
        // cannot be told, none is sent and PayPal asks the card itself.
        const country = payerCountry()
        result = await fields.submit(current.orderId, country ? { billingAddress: { countryCode: country } } : undefined)
      } catch {
        setProblem('PayPal could not be reached. Nothing was charged.')
        return
      }
      if (result.state === 'canceled') {
        setProblem('You cancelled. Nothing was charged.')
        return
      }
      if (result.state !== 'succeeded') {
        setProblem(result.message ?? 'The card was not accepted. Nothing was charged.')
        return
      }
      // The server captures, after re-reading the order and checking it against the lock. From here the card was
      // accepted, so "nothing was charged" is no longer a promise this page can make: the server's own sweep settles an
      // accepted order even when this call is lost.
      let paid: { phase: string }
      try {
        paid = token ? await api.payCapture(token, proposalId) : await api.payCaptureOwner(proposalId)
      } catch (error) {
        // The server's own sweep is already settling this same payment: it went through, and the page will say so.
        if (error instanceof ApiError && error.code === 'capture.inflight') {
          setDone(true)
          onPaid({ phase: 'captured' })
          return
        }
        // The card's bank refused, or did not finish, its check: nothing was charged, and the buyer can try again.
        if (error instanceof ApiError && (error.code === 'pay.card_not_verified' || error.code === 'pay.card_check_incomplete')) {
          setProblem(error.message)
          return
        }
        setProblem(error instanceof ApiError
          ? error.message
          : 'PayPal accepted the card, but its answer did not reach us. Do not pay again: this page updates by itself once the payment settles.')
        return
      }
      // PayPal accepted the card and is still deciding (an eCheck, a review). Nothing more to pay.
      if (paid.phase === 'capture_pending') {
        setReviewing(true)
        onPaid(paid)
        return
      }
      setDone(true)
      onPaid(paid)
    } finally {
      setBusy(false)
    }
  }

  if (embedded && (done || reviewing)) return null

  if (reviewing) {
    return (
      <div className="pay-panel" data-testid="pay-reviewing" role="status">
        <p>PayPal is reviewing this payment</p>
      </div>
    )
  }

  if (done) {
    return (
      <div className="pay-panel" data-testid="pay-done">
        <Chip tone="auto">Paid</Chip>
        <p className="fine">PayPal confirmed it. The studio has the receipt.</p>
      </div>
    )
  }

  return (
    <div className={embedded ? 'pay-sheet-card' : 'pay-panel'} data-testid="pay-panel">
      {embedded ? null : (
        <>
          <div className="row between wrap gap-s">
            <strong>{description}</strong>
            <Money cents={amountCents} currency={currency} size="lg" />
          </div>
          <p className="fine">This amount is locked. It will not change while you pay.</p>
        </>
      )}
      {problem ? <p className="pay-problem" role="alert">{problem}</p> : null}
      {fields ? (
        <div className="pay-fields">
          <div className="pay-field" ref={numberRef} data-testid="pay-field-number" />
          <div className="row gap-s">
            <div className="pay-field" ref={expiryRef} data-testid="pay-field-expiry" />
            <div className="pay-field" ref={cvvRef} data-testid="pay-field-cvv" />
          </div>
          <button type="button" className="btn btn-lime" onClick={() => void pay()} disabled={busy || paused} data-testid="pay-submit">
            {busy ? 'Paying…' : `Pay ${new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amountCents / 100)}`}
          </button>
          <p className="fine">Your card details go straight to PayPal. They never reach this server, and the amount is the one shown above.</p>
        </div>
      ) : problem ? null : <p className="fine">Opening the payment form…</p>}
    </div>
  )
}

/** The country of the person paying, from their browser's language tag (en-IN → IN). Null when it cannot be told. */
function payerCountry(): string | null {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region
    return region && /^[A-Z]{2}$/.test(region) ? region : null
  } catch {
    return null
  }
}
