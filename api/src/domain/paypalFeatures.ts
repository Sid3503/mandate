/**
 * What this PayPal app is allowed to do, read from the scopes PayPal puts in its access token.
 *
 * A scope is the app's permission slip: it is only there if the matching feature is ticked on the app in the PayPal
 * developer dashboard. Reading them tells the owner exactly which Mandate features are live, and which one is waiting
 * on a tick box, instead of letting a 403 surface in the middle of a payment.
 */

export type FeatureId = 'orders' | 'refunds' | 'payouts' | 'invoicing' | 'transactions' | 'disputes' | 'webhooks' | 'card_fields'

export type FeatureSpec = {
  id: FeatureId
  label: string
  /** True if any scope matches. */
  scope: RegExp
  /** What Mandate does with it. */
  usedFor: string
  /** What the owner loses while it is off, and what Mandate does instead. */
  without: string
  /** Features Mandate cannot work without. The rest make it better. */
  core: boolean
  /** Dashboard feature name to tick. Null for permissions every app has. */
  tick: string | null
  /**
   * Some PayPal features are a tick on the app, not a scope on the token, so the only honest way to know is to try
   * them. This names the probe; the service runs it and the result decides whether the feature is on.
   */
  probe?: 'client_token'
}

export const FEATURES: FeatureSpec[] = [
  { id: 'orders', label: 'Accept payments (Orders)', scope: /payments\/orders|v1\/payments\/\.\*|payment\/authcapture/, usedFor: 'A client pays the studio through PayPal checkout.', without: 'Clients cannot be billed.', core: true, tick: 'Accept payments' },
  { id: 'refunds', label: 'Refunds', scope: /services\/payments\/refund/, usedFor: 'Give back part or all of a settled payment, through the same rules.', without: 'Refunds cannot be sent.', core: true, tick: 'Accept payments' },
  { id: 'payouts', label: 'Payouts', scope: /payments\/payouts/, usedFor: 'Pay a contractor straight to their own PayPal account.', without: 'Contractors cannot be paid.', core: true, tick: 'Payouts' },
  { id: 'invoicing', label: 'Invoicing', scope: /services\/invoicing/, usedFor: 'Bill a client with a real PayPal invoice, send reminders, and cancel a wrong one.', without: 'Billing falls back to checkout. Nothing breaks, but there is no invoice, reminder or cancel.', core: false, tick: 'Invoicing' },
  { id: 'transactions', label: 'Transaction Search', scope: /reporting\/search\/read/, usedFor: 'Compare the PayPal account with the ledger and flag money that moved without Mandate.', without: 'The PayPal activity view cannot tell you about money that moved outside Mandate.', core: false, tick: 'Transaction search' },
  { id: 'disputes', label: 'Disputes', scope: /disputes\/read-seller/, usedFor: 'Hold back payouts that depend on a client payment the client has disputed.', without: 'A disputed client payment can still fund a payout.', core: false, tick: 'Customer disputes' },
  { id: 'webhooks', label: 'Webhooks', scope: /applications\/webhooks/, usedFor: 'PayPal tells the server when an invoice is paid, a payout finishes or a dispute opens.', without: 'The server learns only when someone presses Check PayPal.', core: false, tick: null },
  { id: 'card_fields', label: 'Pay on your own page (card fields)', scope: /^$/, usedFor: 'A client pays a locked bill with a card inside the console, without leaving the page and without a PayPal account.', without: 'A client who pays has to leave the console and sign in to PayPal.', core: false, tick: 'Advanced Credit and Debit Card Payments', probe: 'client_token' },
]

export const ENABLE_STEPS = (tick: string) => [
  'Open developer.paypal.com/dashboard and sign in.',
  'Go to Apps & Credentials and make sure the Sandbox toggle (not Live) is selected.',
  'Click the name of the app whose Client ID is in your .env.',
  `Scroll to Features (Add-on services and Payment capabilities) and tick ${tick}. Then click Save Changes.`,
  'Come back here and press Check again. If it still says Off, the running server holds an older token: restart it. PayPal usually applies the change at once; Transaction search can take up to 9 hours.',
  'Still off after that? Create a new REST app with the box already ticked before its first token, and put that app\'s Client ID and secret in .env.',
]

export type FeatureStatus = FeatureSpec & { enabled: boolean; steps: string[] }

/**
 * What the app may do, read from its token scopes and from the probes that can only be answered by trying.
 * A probed feature is on when the probe worked, and off when it did not: nothing is assumed.
 */
export function assessFeatures(scopes: string[], probed: Partial<Record<FeatureId, boolean>> = {}): FeatureStatus[] {
  return FEATURES.map((feature) => ({
    ...feature,
    enabled: feature.probe ? probed[feature.id] === true : scopes.some((scope) => feature.scope.test(scope)),
    steps: feature.tick ? ENABLE_STEPS(feature.tick) : [],
  }))
}
