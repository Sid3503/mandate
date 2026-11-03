/**
 * PayPal's JavaScript SDK v6, loaded only when someone is about to pay.
 *
 * The card fields are PayPal-hosted iframes dropped into our own form: the card number never reaches this server,
 * and the page stays ours. PayPal, Venmo and Pay Later are PayPal's own buttons. Each one opens PayPal's window
 * over the page; the buyer approves there and comes back here. The page never sends them to a new tab.
 *
 * The order every method is submitted against is made by the server from the locked amount, so the browser cannot
 * change what is being paid. The browser holds no authority here: it can hand a card over, or say the buyer approved
 * a wallet, and the server decides whether the money moves.
 *
 * The method names are PayPal's v6 ones:
 * https://developer.paypal.com/docsai/reference/sdk/js/v6/reference
 */

export type CardFieldKind = 'number' | 'expiry' | 'cvv'

export type PayResult = {
  state: 'succeeded' | 'canceled' | 'failed'
  orderId?: string
  /** Whether the card issuer covered the payment, which is what decides if it may be captured. */
  liabilityShift?: string
  message?: string
}

export type CardFields = {
  /** False when the buyer may not pay with a card here, so the console can offer another way. */
  eligible: boolean
  /** Puts one field into a container we own. */
  render(container: HTMLElement, kind: CardFieldKind, placeholder: string): Promise<void>
  /** Hands the card to PayPal against the order the server made from the lock. */
  submit(orderId: string, options?: { billingAddress?: { countryCode?: string; postalCode?: string } }): Promise<PayResult>
}

/** A wallet the buyer approves in PayPal's own window. One server order serves all three. */
export type WalletMethod = 'paypal' | 'venmo' | 'paylater'

export type PayLaterDetails = { productCode: string; countryCode: string }

type SessionOptions = {
  onApprove: (data: { orderId?: string }) => Promise<void> | void
  onCancel?: (data: { orderId?: string }) => void
  onError?: (error: unknown) => void
}

type PaymentSession = {
  /** `order` resolves to `{ orderId }`. Call start from the click, with no await before it, or the popup is blocked. */
  start(options: { presentationMode: 'popup' | 'auto' | 'modal' | 'redirect' }, order: Promise<{ orderId: string }>): Promise<void>
}

type EligibleMethods = {
  isEligible(name: string): boolean
  getDetails(name: string): { productCode?: string; countryCode?: string } | undefined
}

type SdkInstance = {
  findEligibleMethods(options?: { currencyCode?: string; countryCode?: string; amount?: string }): Promise<EligibleMethods>
  createCardFieldsOneTimePaymentSession?(): {
    createCardFieldsComponent(options: { type: CardFieldKind; placeholder?: string }): HTMLElement
    submit(orderId: string, options?: unknown): Promise<{ data?: { orderId?: string; liabilityShift?: string; message?: string }; state: string }>
  }
  createPayPalOneTimePaymentSession?(options: SessionOptions): PaymentSession
  createVenmoOneTimePaymentSession?(options: SessionOptions): PaymentSession
  createPayLaterOneTimePaymentSession?(options: SessionOptions): PaymentSession
  /** Present only when the paypal-messages component loaded. Pay Later's own wording, when PayPal will serve it. */
  createPayPalMessages?(options?: { currencyCode?: string }): unknown
}

type PayPalWindow = Window & {
  paypal?: {
    createInstance(options: { clientToken: string; components: string[]; pageType?: string; testBuyerCountry?: string }): Promise<SdkInstance>
  }
}

export type WalletHandlers = {
  onApprove: (data: { orderId?: string }) => Promise<void> | void
  onCancel: (data: { orderId?: string }) => void
  onError: (error: unknown) => void
}

export type WalletCheckout = {
  /** Card fields from the same SDK instance. `eligible` is false when a card cannot be used here. */
  card: CardFields
  eligible: { paypal: boolean; venmo: boolean; paylater: boolean }
  payLater: PayLaterDetails | null
  /** True when this SDK instance can render PayPal's Pay Later message. */
  messages: boolean
  /**
   * Puts PayPal's message into `container`. Returns false when the SDK has no message component, so the page can
   * say "Pay in 4 / Pay Monthly with PayPal" instead. The amount is the locked one, already formatted.
   */
  mountMessage(container: HTMLElement, amount: string, currency: string): boolean
  /**
   * Opens PayPal's window for one wallet. Call this inside the button's click handler, and pass the order promise
   * straight through: an await before start() lets the browser block the popup.
   */
  start(method: WalletMethod, order: Promise<{ orderId: string }>): Promise<void>
}

const scriptUrl = (environment: 'sandbox' | 'live') => environment === 'live'
  ? 'https://www.paypal.com/web-sdk/v6/core'
  : 'https://www.sandbox.paypal.com/web-sdk/v6/core'

const loading = new Map<string, Promise<void>>()

/** Loads PayPal's script once per environment. It is only ever fetched when someone is about to pay. */
function loadScript(environment: 'sandbox' | 'live'): Promise<void> {
  const url = scriptUrl(environment)
  const already = loading.get(url)
  if (already) return already
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.async = true
    script.src = url
    script.onload = () => resolve()
    script.onerror = () => {
      loading.delete(url)
      reject(new Error('PayPal could not be reached'))
    }
    document.head.appendChild(script)
  })
  loading.set(url, promise)
  return promise
}

/**
 * Opens a card form for a locked bill. The client token comes from our own server, so the browser never holds the
 * app's client id and can only do what the server allowed.
 */
/** Card fields from an SDK instance that was loaded with the card-fields component. */
function cardFieldsFrom(sdk: SdkInstance, methods: EligibleMethods): CardFields {
  const eligible = methods.isEligible('advanced_cards') && typeof sdk.createCardFieldsOneTimePaymentSession === 'function'
  const session = eligible ? sdk.createCardFieldsOneTimePaymentSession!() : null
  return {
    eligible: Boolean(session),
    async render(container, kind, placeholder) {
      if (!session) throw new Error('A card cannot be used for this payment here.')
      const field = session.createCardFieldsComponent({ type: kind, placeholder })
      container.appendChild(field)
    },
    async submit(orderId, submitOptions) {
      if (!session) return { state: 'failed', message: 'A card cannot be used for this payment here. Pay on PayPal instead.' }
      let result: Awaited<ReturnType<typeof session.submit>>
      try {
        result = await session.submit(orderId, submitOptions)
      } catch (error) {
        // PayPal checks the card inside its own frames before anything is sent, and throws when a field is empty or
        // not a real card. Nothing reached PayPal's servers, so nothing was charged.
        return { state: 'failed', message: cardProblem(error) }
      }
      const state = result.state === 'succeeded' ? 'succeeded' : result.state === 'canceled' ? 'canceled' : 'failed'
      return {
        state,
        orderId: result.data?.orderId,
        liabilityShift: result.data?.liabilityShift,
        // A refused card (or a failed bank check) comes back as a state, with PayPal's own error as JSON, which is not
        // something to show a buyer.
        message: state === 'failed' ? 'The card was not accepted. Nothing was charged. Try another card.' : undefined,
      }
    },
  }
}

export async function createCardFields(options: { clientToken: string; environment: 'sandbox' | 'live'; testBuyerCountry?: string }): Promise<CardFields> {
  await loadScript(options.environment)
  const paypal = (window as PayPalWindow).paypal
  if (!paypal) throw new Error('PayPal could not be reached')
  const sdk = await paypal.createInstance({
    clientToken: options.clientToken,
    components: ['card-fields'],
    pageType: 'checkout',
    ...(options.testBuyerCountry ? { testBuyerCountry: options.testBuyerCountry } : {}),
  })
  const methods = await sdk.findEligibleMethods()
  return cardFieldsFrom(sdk, methods)
}

const WALLET_COMPONENTS = ['card-fields', 'paypal-payments', 'venmo-payments'] as const

/**
 * One SDK instance for the whole pay sheet: card fields, and PayPal, Venmo and Pay Later.
 *
 * `paypal-payments` covers PayPal and Pay Later. `venmo-payments` covers Venmo. `paypal-messages` is Pay Later's own
 * wording; when this SDK build does not have it, the sheet says "Pay in 4 / Pay Monthly" instead.
 * In the sandbox, `testBuyerCountry` is US so Venmo can be eligible. Venmo is a US payment.
 * https://developer.paypal.com/sdk/js/set-up
 */
export async function createWalletCheckout(options: {
  clientToken: string
  environment: 'sandbox' | 'live'
  currency: string
  /** The locked amount, already a PayPal string ("150.00"). The browser does not decide it. */
  amount: string
  handlers: WalletHandlers
}): Promise<WalletCheckout> {
  await loadScript(options.environment)
  const paypal = (window as PayPalWindow).paypal
  if (!paypal) throw new Error('PayPal could not be reached')
  const buyer = options.environment === 'sandbox' ? { testBuyerCountry: 'US' } : {}
  const callbacks: SessionOptions = {
    onApprove: (data) => options.handlers.onApprove(data),
    onCancel: (data) => options.handlers.onCancel(data),
    onError: (error) => options.handlers.onError(error),
  }
  // Messages are optional. A build that rejects the component still has the buttons and the card fields.
  let sdk: SdkInstance | null = null
  let messages = false
  const attempts = [
    [...WALLET_COMPONENTS, 'paypal-messages'],
    [...WALLET_COMPONENTS],
    ['paypal-payments', 'venmo-payments'],
  ]
  let lastError: unknown
  for (const components of attempts) {
    try {
      sdk = await paypal.createInstance({
        clientToken: options.clientToken,
        components,
        pageType: 'checkout',
        ...buyer,
      })
      messages = components.includes('paypal-messages') && typeof sdk.createPayPalMessages === 'function'
      break
    } catch (error) {
      lastError = error
      sdk = null
    }
  }
  if (!sdk) throw lastError instanceof Error ? lastError : new Error('PayPal could not be reached')
  const methods = await sdk.findEligibleMethods({
    currencyCode: options.currency,
    amount: options.amount,
    // Venmo is offered in the US. The sandbox does not know where the tester is, so say so.
    ...(options.environment === 'sandbox' ? { countryCode: 'US' } : {}),
  })
  const sessionFor = (create: ((options: SessionOptions) => PaymentSession) | undefined, name: string): PaymentSession | null => {
    if (!methods.isEligible(name) || !create) return null
    try {
      return create(callbacks)
    } catch {
      return null
    }
  }
  const sessions: Record<WalletMethod, PaymentSession | null> = {
    paypal: sessionFor(sdk.createPayPalOneTimePaymentSession?.bind(sdk), 'paypal'),
    venmo: sessionFor(sdk.createVenmoOneTimePaymentSession?.bind(sdk), 'venmo'),
    paylater: sessionFor(sdk.createPayLaterOneTimePaymentSession?.bind(sdk), 'paylater'),
  }
  const details = methods.isEligible('paylater') ? methods.getDetails('paylater') : undefined
  const payLater = details?.productCode && details.countryCode ? { productCode: details.productCode, countryCode: details.countryCode } : null
  if (messages) {
    try {
      sdk.createPayPalMessages?.({ currencyCode: options.currency })
    } catch {
      messages = false
    }
  }
  return {
    card: cardFieldsFrom(sdk, methods),
    eligible: { paypal: Boolean(sessions.paypal), venmo: Boolean(sessions.venmo), paylater: Boolean(sessions.paylater) },
    payLater,
    messages,
    mountMessage(container, amount, currency) {
      if (!messages) return false
      // <paypal-message> is PayPal's v6 messages component. auto-bootstrap fills it from the locked amount.
      const element = document.createElement('paypal-message')
      element.setAttribute('auto-bootstrap', '')
      element.setAttribute('amount', amount)
      element.setAttribute('currency-code', currency)
      container.replaceChildren(element)
      return true
    },
    start(method, order) {
      const session = sessions[method]
      if (!session) return Promise.reject(new Error('That way to pay is not available here.'))
      // popup, not a redirect: the buyer stays on this page. A blocked popup rejects, and the sheet says so.
      return session.start({ presentationMode: 'popup' }, order)
    },
  }
}

/** What to tell the buyer when PayPal's card form refuses to send a card. PayPal's own wording is for developers. */
export function cardProblem(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '')
  if (!/invalid card data|empty or invalid/i.test(text)) return 'PayPal could not take this card. Nothing was charged.'
  const field = /card number/i.test(text) ? 'card number' : /expir/i.test(text) ? 'expiry date' : /cvv|security code/i.test(text) ? 'CVV' : null
  return field
    ? `The ${field} is missing or not valid. Check it and try again. Nothing was charged.`
    : 'Check the card number, expiry date and CVV, then try again. Nothing was charged.'
}
