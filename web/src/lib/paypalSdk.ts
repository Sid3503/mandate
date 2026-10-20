/**
 * PayPal's JavaScript SDK, loaded only when someone is about to pay.
 *
 * The card fields are PayPal-hosted iframes dropped into our own form: the card number never reaches this server,
 * and the page stays ours. The buyer never signs in to PayPal, and never leaves the console to pay.
 *
 * The order the card is submitted against is made by the server from the locked amount, so the browser cannot change
 * what is being paid. The browser holds no authority here: it can submit a card, and the server decides whether the
 * money moves.
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

type SdkInstance = {
  findEligibleMethods(): Promise<{ isEligible(name: string): boolean }>
  createCardFieldsOneTimePaymentSession(): {
    createCardFieldsComponent(options: { type: CardFieldKind; placeholder?: string }): HTMLElement
    submit(orderId: string, options?: unknown): Promise<{ data?: { orderId?: string; liabilityShift?: string; message?: string }; state: string }>
  }
}

type PayPalWindow = Window & {
  paypal?: {
    createInstance(options: { clientToken: string; components: string[]; pageType?: string; testBuyerCountry?: string }): Promise<SdkInstance>
  }
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
  const eligible = methods.isEligible('advanced_cards')
  const session = sdk.createCardFieldsOneTimePaymentSession()
  return {
    eligible,
    async render(container, kind, placeholder) {
      const field = session.createCardFieldsComponent({ type: kind, placeholder })
      container.appendChild(field)
    },
    async submit(orderId, submitOptions) {
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

/** What to tell the buyer when PayPal's card form refuses to send a card. PayPal's own wording is for developers. */
export function cardProblem(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '')
  if (!/invalid card data|empty or invalid/i.test(text)) return 'PayPal could not take this card. Nothing was charged.'
  const field = /card number/i.test(text) ? 'card number' : /expir/i.test(text) ? 'expiry date' : /cvv|security code/i.test(text) ? 'CVV' : null
  return field
    ? `The ${field} is missing or not valid. Check it and try again. Nothing was charged.`
    : 'Check the card number, expiry date and CVV, then try again. Nothing was charged.'
}
