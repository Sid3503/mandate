import { useCallback, useEffect, useRef, useState } from 'react'
import { PayCardFields } from './PayCardFields'
import { Money } from './ui'
import { api, ApiError } from '../lib/api'
import { createWalletCheckout, type PayLaterDetails, type WalletCheckout, type WalletMethod } from '../lib/paypalSdk'
import type { PayMethod, PaySession } from '../lib/types'

/**
 * One way to pay a locked bill, on this page.
 *
 * PayPal, Venmo and Pay Later are PayPal's own buttons. Each opens PayPal's window over the page; the buyer
 * approves there. The card fields sit beside them. The order for every one of them is made by the server from the
 * locked cart. This page never chooses an amount, and it never captures until PayPal says the buyer approved.
 *
 * If PayPal's script cannot be loaded, the old link is still there: open PayPal in a new tab, and come back.
 */

const WALLET_LABEL: Record<WalletMethod, string> = { paypal: 'PayPal', venmo: 'Venmo', paylater: 'Pay Later' }

export function PaySheet({ token, proposalId, amountCents, currency, description, approveUrl, onPaid }: {
  /** The link the buyer holds. Without one, the owner is paying, and the owner key is used. */
  token?: string
  proposalId: string
  amountCents: number
  currency: string
  description: string
  /** The checkout link, shown only when PayPal's script cannot run on this page. */
  approveUrl?: string | null
  onPaid: () => void
}) {
  const [session, setSession] = useState<PaySession | null>(null)
  const [checkout, setCheckout] = useState<WalletCheckout | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState('Opening the payment form…')
  const [busy, setBusy] = useState(false)
  const [cardBusy, setCardBusy] = useState(false)
  const [fallback, setFallback] = useState(false)
  const [finished, setFinished] = useState<'captured' | 'reviewing' | null>(null)
  const [payLaterNote, setPayLaterNote] = useState(false)
  const messageRef = useRef<HTMLDivElement>(null)
  const tail = useRef<Promise<unknown>>(Promise.resolve())
  const busyRef = useRef(false)
  const cardBusyRef = useRef(false)
  cardBusyRef.current = cardBusy

  const openInstrument = useCallback((method: PayMethod) => {
    // One order at a time. A card and a wallet are different orders, and the clicks are queued so they cannot
    // overwrite each other halfway through.
    const run = tail.current.then(() => (token ? api.paySession(token, proposalId, method) : api.paySessionOwner(proposalId, method)))
    tail.current = run.then(() => undefined, () => undefined)
    return run
  }, [token, proposalId])

  const prepareCard = useCallback(() => openInstrument('card'), [openInstrument])

  const handlers = useRef({
    onApprove: async (_data: { orderId?: string }) => undefined as void,
    onCancel: (_data: { orderId?: string }) => undefined as void,
    onError: (_error: unknown) => undefined as void,
  })
  handlers.current = {
    async onApprove() {
      setNotice('Capturing…')
      try {
        const paid = token ? await api.payCapture(token, proposalId) : await api.payCaptureOwner(proposalId)
        if (paid.phase === 'capture_pending') {
          setNotice('PayPal is reviewing this payment')
          setFinished('reviewing')
          return
        }
        setNotice('Captured — receipt updated')
        setFinished('captured')
        onPaid()
      } catch (error) {
        // The server's own sweep is already settling this same payment.
        if (error instanceof ApiError && error.code === 'capture.inflight') {
          setNotice('Captured — receipt updated')
          setFinished('captured')
          onPaid()
          return
        }
        if (error instanceof ApiError && (error.code === 'pay.capture_declined' || error.status === 402)) {
          setNotice('')
          setProblem(error.message || 'PayPal declined the payment. Nothing was charged.')
          return
        }
        setNotice('')
        setProblem(error instanceof ApiError
          ? error.message
          : 'PayPal accepted the payment, but its answer did not reach us. Do not pay again: this page updates by itself once the payment settles.')
      }
    },
    onCancel() {
      setNotice('')
      setProblem('You cancelled. Nothing was charged.')
    },
    onError(error) {
      setNotice('')
      const text = error instanceof Error ? error.message : ''
      setProblem(/declin/i.test(text) ? 'PayPal declined the payment. Nothing was charged.' : 'PayPal could not take this payment. Nothing was charged.')
    },
  }

  useEffect(() => {
    let live = true
    const open = async () => {
      try {
        const made = await openInstrument('card')
        if (!live) return
        setSession(made)
        const sheet = await createWalletCheckout({
          clientToken: made.clientToken,
          environment: made.environment,
          currency: made.currency,
          amount: lockedAmount(made.amountCents),
          handlers: {
            onApprove: (data) => handlers.current.onApprove(data),
            onCancel: (data) => handlers.current.onCancel(data),
            onError: (error) => handlers.current.onError(error),
          },
        })
        if (!live) return
        setCheckout(sheet)
        setNotice('')
        const anyWallet = sheet.eligible.paypal || sheet.eligible.venmo || sheet.eligible.paylater
        if (!sheet.card.eligible && !anyWallet) {
          setProblem('PayPal could not offer a way to pay on this page.')
          setFallback(true)
        }
      } catch (error) {
        if (!live) return
        setNotice('')
        setProblem(error instanceof ApiError ? error.message : 'The payment form could not be opened.')
        setFallback(true)
      }
    }
    void open()
    return () => { live = false }
  }, [openInstrument])

  useEffect(() => {
    if (!checkout?.eligible.paylater) return
    const host = messageRef.current
    if (!checkout.messages || !host) {
      setPayLaterNote(true)
      return
    }
    // The message quotes the locked amount. If PayPal's component will not render, one sentence stands in for it.
    setPayLaterNote(!checkout.mountMessage(host, lockedAmount(amountCents), currency))
  }, [checkout, amountCents, currency])

  const payWith = useCallback((method: WalletMethod) => {
    if (!checkout || busyRef.current || cardBusyRef.current) return
    busyRef.current = true
    setBusy(true)
    setProblem(null)
    setNotice('Waiting for you to approve in the PayPal window…')
    // The order is created inside the promise passed to start(), not before it. Awaiting here would let the
    // browser block the popup, because the click would no longer be the thing that opened the window.
    const order = openInstrument(method).then((made) => ({ orderId: made.orderId }))
    void checkout.start(method, order).catch((error: unknown) => {
      if (error instanceof ApiError) {
        setNotice('')
        setProblem(error.message)
        return
      }
      if (popupBlocked(error)) {
        setNotice('')
        setProblem('Your browser blocked the PayPal window. Allow popups for this site and try again.')
        setFallback(true)
        return
      }
      setNotice('')
      setProblem('PayPal could not open. Nothing was charged.')
    }).finally(() => {
      busyRef.current = false
      setBusy(false)
    })
  }, [checkout, openInstrument])

  if (finished) {
    return (
      <div className="pay-panel" data-testid={finished === 'reviewing' ? 'pay-reviewing' : 'pay-done'} role="status">
        <div className="row between wrap gap-s">
          <strong>{description}</strong>
          <Money cents={amountCents} currency={currency} size="lg" />
        </div>
        <p>{finished === 'reviewing' ? 'PayPal is reviewing this payment' : 'Captured — receipt updated'}</p>
      </div>
    )
  }

  const anyWallet = Boolean(checkout && (checkout.eligible.paypal || checkout.eligible.venmo || checkout.eligible.paylater))

  return (
    <section className="pay-panel" data-testid="pay-sheet" aria-busy={busy || (!checkout && !fallback)}>
      <div className="row between wrap gap-s">
        <strong id={`pay-sheet-${proposalId}`}>{description}</strong>
        <Money cents={amountCents} currency={currency} size="lg" />
      </div>
      <p className="fine">This amount is locked. It will not change while you pay.</p>
      <div className="pay-live" role="status" aria-live="polite">{notice}</div>
      {problem ? <p className="pay-problem" role="alert">{problem}</p> : null}
      {anyWallet && checkout ? (
        <WalletButtons checkout={checkout} payLater={checkout.payLater} onPay={payWith} />
      ) : null}
      {checkout?.eligible.paylater ? (
        <>
          {checkout.messages ? <div ref={messageRef} className="pay-message" /> : null}
          {payLaterNote || !checkout.messages ? <p className="fine pay-note">Pay in 4 / Pay Monthly with PayPal</p> : null}
        </>
      ) : null}
      {anyWallet && checkout?.card.eligible ? <p className="pay-or">or pay by card</p> : null}
      {checkout?.card.eligible && session ? (
        <PayCardFields
          embedded
          token={token}
          proposalId={proposalId}
          amountCents={amountCents}
          currency={currency}
          description={description}
          initialSession={session}
          cardFields={checkout.card}
          prepareCard={prepareCard}
          paused={busy}
          onActivity={setCardBusy}
          onPaid={(result) => {
            if (result?.phase === 'capture_pending') setFinished('reviewing')
            else setFinished('captured')
            onPaid()
          }}
        />
      ) : null}
      {(fallback || !checkout) && approveUrl ? (
        <a className="btn btn-ink" href={approveUrl} target="_blank" rel="noreferrer noopener">Open PayPal ↗</a>
      ) : null}
    </section>
  )
}

function WalletButtons({ checkout, payLater, onPay }: {
  checkout: WalletCheckout
  payLater: PayLaterDetails | null
  onPay: (method: WalletMethod) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = host.current
    if (!root) return
    const items: Array<{ method: WalletMethod; tag: string; testId: string }> = []
    if (checkout.eligible.paypal) items.push({ method: 'paypal', tag: 'paypal-button', testId: 'pay-paypal' })
    if (checkout.eligible.venmo) items.push({ method: 'venmo', tag: 'venmo-button', testId: 'pay-venmo' })
    if (checkout.eligible.paylater) items.push({ method: 'paylater', tag: payLaterTag(), testId: 'pay-paylater' })
    const stops: Array<() => void> = []
    for (const item of items) {
      const wrap = document.createElement('div')
      wrap.className = 'pay-wallet'
      wrap.dataset.testid = item.testId
      const button = document.createElement(item.tag) as HTMLElement & { productCode?: string; countryCode?: string }
      button.setAttribute('type', 'pay')
      button.setAttribute('aria-label', WALLET_LABEL[item.method])
      if (item.method === 'paylater' && payLater) {
        button.productCode = payLater.productCode
        button.countryCode = payLater.countryCode
      }
      const click = () => onPay(item.method)
      button.addEventListener('click', click)
      wrap.appendChild(button)
      root.appendChild(wrap)
      stops.push(() => button.removeEventListener('click', click))
    }
    return () => {
      for (const stop of stops) stop()
      root.replaceChildren()
    }
  }, [checkout, payLater, onPay])
  return <div ref={host} className="pay-methods" role="group" aria-label="Ways to pay" />
}

/** The setup guide's tag, unless this SDK build registered the shorter reference name instead. */
function payLaterTag(): string {
  if (typeof customElements !== 'undefined' && customElements.get('paylater-button') && !customElements.get('paypal-pay-later-button')) return 'paylater-button'
  return 'paypal-pay-later-button'
}

/** The locked cents as a PayPal amount string. Integer arithmetic, so the browser cannot round it. */
function lockedAmount(cents: number): string {
  const negative = cents < 0
  const absolute = Math.abs(cents)
  return `${negative ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

/** PayPal reports a blocked popup as a recoverable error, or says so in the message. */
function popupBlocked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { isRecoverable?: boolean; code?: string; name?: string; message?: string }
  const text = `${record.code ?? ''} ${record.name ?? ''} ${record.message ?? ''}`.toLowerCase()
  return record.isRecoverable === true || text.includes('popup') || text.includes('blocked')
}
