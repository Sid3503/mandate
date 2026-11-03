import { z } from 'zod'
import { Problem } from '../http/problem'

/**
 * Product search for the procurement agent, through Channel3 (https://docs.trychannel3.com/).
 *
 * Two calls are used, exactly as documented:
 * - `POST https://api.trychannel3.com/v1/search` with `{ query, limit, filters: { price: { max_price } } }` finds products.
 * - `GET https://api.trychannel3.com/v1/products/{product_id}` re-reads one product. It is free, and it is what the
 *   server trusts when a purchase is asked for: the price on the request comes from this answer, never from the page
 *   or the model.
 * Both are authenticated with the `x-api-key` header. Prices are in dollars on each retailer offer, not on the product.
 *
 * The key never leaves this file: it is not logged, not put in an error, and not returned to anyone.
 */

/** One retailer's listing of a product: where it is sold, for how much, and whether it is in stock. */
export type CatalogOffer = {
  /** The store's domain, lower case and without "www.", e.g. "bestbuy.com". This is what a vendor payee is matched on. */
  merchant: string
  /** Buy link at that store. It becomes the request's proof. */
  url: string
  priceCents: number
  currency: string
  availability: 'InStock' | 'OutOfStock'
  condition: string | null
}

export type CatalogProduct = {
  id: string
  title: string
  brand: string | null
  description: string | null
  imageUrl: string | null
  offers: CatalogOffer[]
}

export type CatalogSearch = { query: string; maxPriceCents?: number; limit?: number }

/** What the procurement service needs from a catalog. The real one is Channel3; tests use a fixed one. */
export interface CatalogPort {
  readonly source: 'channel3' | 'fake'
  search(input: CatalogSearch): Promise<CatalogProduct[]>
  /** One product, read fresh. Null when the catalog has no product with that id. */
  product(id: string): Promise<CatalogProduct | null>
}

/** Channel3 product ids are short opaque strings. Anything else is refused before it is put in a URL. */
export const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/

// The documented response shapes, read leniently: fields Mandate does not use are ignored, and optional ones may be absent.
const PriceSchema = z.object({ price: z.number().nonnegative(), currency: z.string() }).passthrough()
const OfferSchema = z.object({
  url: z.string(),
  domain: z.string(),
  price: PriceSchema,
  availability: z.string(),
  condition: z.string().nullable().optional(),
}).passthrough()
const ImageSchema = z.object({ url: z.string(), cleaned_url: z.string().nullable().optional(), is_main_image: z.boolean().optional() }).passthrough()
const ProductSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  brands: z.array(z.object({ id: z.string().optional(), name: z.string() }).passthrough()).nullable().optional(),
  images: z.array(ImageSchema).nullable().optional(),
  offers: z.array(OfferSchema).nullable().optional(),
}).passthrough()
const SearchResponseSchema = z.object({ products: z.array(ProductSchema) }).passthrough()

type RawProduct = z.infer<typeof ProductSchema>

const https = (value: string | null | undefined): string | null => {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

export const merchantOf = (domain: string): string => domain.trim().toLowerCase().replace(/^www\./, '')

/** A Channel3 product in Mandate's terms: integer cents, a normalised merchant, https links only. */
export function normalise(raw: RawProduct): CatalogProduct {
  const images = raw.images ?? []
  const main = images.find((image) => image.is_main_image) ?? images[0]
  return {
    id: raw.id,
    title: raw.title.trim().slice(0, 300),
    brand: raw.brands?.[0]?.name ?? null,
    description: raw.description?.slice(0, 600) ?? null,
    imageUrl: https(main?.cleaned_url) ?? https(main?.url),
    offers: (raw.offers ?? []).flatMap((offer): CatalogOffer[] => {
      const url = https(offer.url)
      const currency = offer.price.currency.trim().toUpperCase()
      if (!url || !/^[A-Z]{3}$/.test(currency)) return []
      return [{
        merchant: merchantOf(offer.domain),
        url,
        priceCents: Math.round(offer.price.price * 100),
        currency,
        availability: offer.availability === 'InStock' ? 'InStock' : 'OutOfStock',
        condition: offer.condition ?? null,
      }]
    }),
  }
}

export type Channel3Options = {
  apiKey: string
  baseUrl?: string
  timeoutMs?: number
  /** Extra attempts after a 5xx. Nothing else is retried: a 4xx would only say the same again. */
  retries?: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export const CHANNEL3_API = 'https://api.trychannel3.com'

export class Channel3Client implements CatalogPort {
  readonly source = 'channel3' as const
  readonly #key: string
  readonly #base: string
  readonly #timeoutMs: number
  readonly #retries: number
  readonly #fetch: typeof fetch
  readonly #sleep: (ms: number) => Promise<void>

  constructor(options: Channel3Options) {
    this.#key = options.apiKey
    this.#base = (options.baseUrl ?? CHANNEL3_API).replace(/\/$/, '')
    this.#timeoutMs = options.timeoutMs ?? 8_000
    this.#retries = options.retries ?? 2
    this.#fetch = options.fetch ?? fetch
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** Never shows the key, however the client is printed. */
  toJSON() {
    return { source: this.source, baseUrl: this.#base }
  }

  async search(input: CatalogSearch): Promise<CatalogProduct[]> {
    const body: Record<string, unknown> = { query: input.query, limit: Math.min(Math.max(input.limit ?? 8, 1), 30) }
    // Channel3's price filter is in dollars and cents, inclusive, and matches a product when any one offer is in range.
    if (input.maxPriceCents !== undefined) body.filters = { price: { max_price: input.maxPriceCents / 100 }, availability: ['InStock'] }
    const answer = await this.#call('POST', '/v1/search', body)
    const parsed = SearchResponseSchema.safeParse(answer.json)
    if (!parsed.success) throw unreadable()
    return parsed.data.products.map(normalise)
  }

  async product(id: string): Promise<CatalogProduct | null> {
    if (!PRODUCT_ID.test(id)) return null
    const answer = await this.#call('GET', `/v1/products/${encodeURIComponent(id)}`, undefined, true)
    if (answer.status === 404) return null
    const parsed = ProductSchema.safeParse(answer.json)
    if (!parsed.success) throw unreadable()
    return normalise(parsed.data)
  }

  async #call(method: 'GET' | 'POST', path: string, body: unknown, allow404 = false): Promise<{ status: number; json: unknown }> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response
      try {
        response = await this.#fetch(`${this.#base}${path}`, {
          method,
          headers: { 'x-api-key': this.#key, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        })
      } catch (error) {
        const timedOut = (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError'
        throw new Problem(504, timedOut ? 'procure.timeout' : 'procure.unreachable', timedOut ? 'Product search took too long' : 'Product search could not be reached', timedOut ? `Channel3 did not answer within ${this.#timeoutMs / 1000} seconds. Nothing was asked for.` : 'Channel3 could not be reached. Nothing was asked for.')
      }
      if (response.status >= 500 && attempt < this.#retries) {
        await this.#sleep(200 * 2 ** attempt)
        continue
      }
      const text = await response.text().catch(() => '')
      let json: unknown = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = null
      }
      if (response.ok) return { status: response.status, json }
      if (response.status === 404 && allow404) return { status: 404, json }
      throw failureFor(response.status)
    }
  }
}

function unreadable(): Problem {
  return new Problem(502, 'procure.unreadable', 'Product search answered oddly', 'Channel3 answered with something that is not a product list. Nothing was asked for.')
}

/** Channel3's documented failures, in Mandate's words. Channel3's own message is not passed on: it could echo the request. */
function failureFor(status: number): Problem {
  if (status === 401 || status === 403) return new Problem(502, 'procure.auth', 'Product search refused the key', 'Channel3 did not accept CHANNEL3_API_KEY. Check the key on the Channel3 dashboard. Nothing was asked for.')
  if (status === 402) return new Problem(503, 'procure.credits', 'Product search is out of credits', 'The Channel3 account has used its credits. Nothing was asked for.')
  if (status === 429) return new Problem(429, 'procure.rate_limited', 'Product search is busy', 'Channel3 asked us to slow down. Try again in a moment. Nothing was asked for.')
  if (status === 400 || status === 422) return new Problem(422, 'procure.invalid', 'Product search could not use that', 'Channel3 could not run that search. Try different words. Nothing was asked for.')
  if (status >= 500) return new Problem(502, 'procure.unavailable', 'Product search is down', `Channel3 failed (${status}) after retrying. Nothing was asked for.`)
  return new Problem(502, 'procure.unavailable', 'Product search failed', `Channel3 answered ${status}. Nothing was asked for.`)
}

/**
 * A fixed catalog for tests and for development without a key. It behaves like Channel3 where it matters: products
 * have several retailer offers at different prices, some out of stock, and a price filter matches on any offer.
 * Prices can be moved, so a test can show the server reads the price again at purchase time.
 */
export class FakeCatalog implements CatalogPort {
  readonly source = 'fake' as const
  readonly products: CatalogProduct[]
  searches = 0
  lookups = 0

  constructor(products: CatalogProduct[] = FAKE_PRODUCTS) {
    this.products = structuredClone(products)
  }

  setPrice(productId: string, merchant: string, priceCents: number) {
    const offer = this.products.find((item) => item.id === productId)?.offers.find((item) => item.merchant === merchant)
    if (!offer) throw new Error(`no offer ${productId} at ${merchant}`)
    offer.priceCents = priceCents
  }

  async search(input: CatalogSearch): Promise<CatalogProduct[]> {
    this.searches += 1
    const words = input.query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3)
    return structuredClone(this.products.filter((product) => {
      const haystack = `${product.title} ${product.brand ?? ''} ${product.description ?? ''}`.toLowerCase()
      const matches = words.length === 0 || words.some((word) => haystack.includes(word))
      const priced = input.maxPriceCents === undefined || product.offers.some((offer) => offer.availability === 'InStock' && offer.priceCents <= input.maxPriceCents!)
      return matches && priced
    }).slice(0, input.limit ?? 8))
  }

  async product(id: string): Promise<CatalogProduct | null> {
    this.lookups += 1
    const found = this.products.find((product) => product.id === id)
    return found ? structuredClone(found) : null
  }
}

const offer = (merchant: string, priceCents: number, slug: string, availability: CatalogOffer['availability'] = 'InStock'): CatalogOffer => ({
  merchant,
  url: `https://www.buy.trychannel3.com/fake/${merchant}/${slug}`,
  priceCents,
  currency: 'USD',
  availability,
  condition: 'new',
})

export const FAKE_PRODUCTS: CatalogProduct[] = [
  {
    id: 'fake_tablet_medium',
    title: 'Wacom Intuos Medium Wireless Drawing Tablet',
    brand: 'Wacom',
    description: 'Pen tablet with Bluetooth, 4 express keys, battery-free pen.',
    imageUrl: null,
    offers: [offer('bestbuy.com', 19_995, 'intuos-m'), offer('amazon.com', 18_900, 'intuos-m')],
  },
  {
    id: 'fake_tablet_small',
    title: 'XP-Pen Deco Mini7 Drawing Tablet',
    brand: 'XP-Pen',
    description: 'Small pen tablet, 8192 pressure levels.',
    imageUrl: null,
    offers: [offer('bestbuy.com', 4_999, 'deco-mini7'), offer('xp-pen.com', 4_599, 'deco-mini7')],
  },
  {
    id: 'fake_pen_nibs',
    title: 'Wacom Standard Pen Nibs for Drawing Tablet, 10 pack',
    brand: 'Wacom',
    description: 'Replacement nibs for Wacom pens.',
    imageUrl: null,
    offers: [offer('bestbuy.com', 1_299, 'nibs-10')],
  },
  {
    id: 'fake_pen_display',
    title: 'Wacom Cintiq 16 Pen Display Drawing Tablet',
    brand: 'Wacom',
    description: '15.6 inch pen display.',
    imageUrl: null,
    offers: [offer('bestbuy.com', 64_995, 'cintiq-16'), offer('amazon.com', 61_900, 'cintiq-16', 'OutOfStock')],
  },
]

/** The real client when CHANNEL3_API_KEY is set, otherwise nothing: the feature is then off and says why. */
export function catalogFromEnv(env: NodeJS.ProcessEnv): CatalogPort | null {
  const key = env.CHANNEL3_API_KEY?.trim()
  return key ? new Channel3Client({ apiKey: key, baseUrl: env.CHANNEL3_API_URL?.trim() || undefined }) : null
}
