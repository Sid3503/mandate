import { resolvePayee } from '../domain/gate'
import type { Payee, ProposalCreate, WarrantBody } from '../domain/schemas'
import { Problem } from '../http/problem'
import type { Repo } from '../db/repo'
import type { MandateService, ProposalView } from '../services/mandate'
import { merchantOf, PRODUCT_ID, type CatalogOffer, type CatalogPort, type CatalogProduct } from './channel3'

/**
 * The procurement agent's server half. It can look products up and ask to buy one. Asking to buy is an ordinary
 * contractor-style payment request (`kind: 'payment'`) to a vendor payee, in the `equipment` category, with the
 * product's buy link as its proof. So the rules gate, the locks, the receipts and the audit apply unchanged:
 *
 * - a store that is not a payee on the rules is refused (`payee.unknown`), exactly like a fake vendor;
 * - `equipment` must be an allowed kind of work (`category.missing` otherwise);
 * - the per-payment ceiling, the monthly cap, the automatic line and "paid from settled client money" all hold;
 * - an amount at or over the automatic line waits for the owner's tap.
 *
 * The price is never taken from the caller. The server reads the product again from the catalog at the moment of
 * asking, and the request is for that offer's price, to the cent.
 *
 * Money goes to the vendor payee's PayPal account through the same Payouts path as any payee. In the sandbox that
 * account is a stand-in for the real store: no real merchant is paid, and the console says so.
 */

/** The kind of work a purchase is filed under. Fixed by the server, so a model cannot pick a looser one. */
export const PURCHASE_CATEGORY = 'equipment'

export type ProcureStatus = {
  enabled: boolean
  source: 'channel3' | 'fake' | null
  reason: string | null
  category: string
  categoryAllowed: boolean
  /** Payees on the rules that a store's domain resolves to (their aliases that look like domains). */
  vendors: Array<{ payeeId: string; name: string; merchants: string[] }>
  note: string
}

export type ProcureOption = {
  merchant: string
  priceCents: number
  currency: string
  url: string
  availability: 'InStock' | 'OutOfStock'
  /** The vendor payee this store resolves to on the rules, or null when the rules do not know it. */
  vendor: { payeeId: string; name: string } | null
}

export type ProcureResult = {
  productId: string
  title: string
  brand: string | null
  imageUrl: string | null
  /** The offer the server would buy: in stock, in the rules' currency, inside the budget, a known vendor first, then cheapest. */
  best: ProcureOption | null
  offers: ProcureOption[]
  withinBudget: boolean
  rank: number
  /** Why it is ranked where it is, in a few words. */
  why: string
}

export type PurchaseInput = {
  productId: string
  merchant?: string
  jobId?: string
  fundingCaptureId?: string
  maxPriceCents?: number
  prompt?: string
}

export type PurchaseOutcome = {
  proposal: ProposalView
  product: { productId: string; title: string; imageUrl: string | null }
  offer: ProcureOption
  whatWouldPass: string[]
  note: string
}

type Actor = Parameters<MandateService['proposeAndDispatch']>[2]

const SANDBOX_NOTE = 'Sandbox: the vendor is a PayPal sandbox account standing in for the real store. No real merchant is paid and nothing ships.'
const OFF_REASON = 'Product search is off: set CHANNEL3_API_KEY on the server (a free key from https://trychannel3.com/developers).'

export class ProcureService {
  constructor(
    private readonly catalog: CatalogPort | null,
    private readonly repo: Repo,
    private readonly mandate: MandateService,
  ) {}

  get enabled(): boolean {
    return this.catalog !== null
  }

  status(): ProcureStatus {
    const warrant = this.repo.latestWarrant()?.body ?? null
    return {
      enabled: this.enabled,
      source: this.catalog?.source ?? null,
      reason: this.enabled ? null : OFF_REASON,
      category: PURCHASE_CATEGORY,
      categoryAllowed: Boolean(warrant?.categories.includes(PURCHASE_CATEGORY)),
      vendors: warrant ? vendorsOf(warrant) : [],
      note: SANDBOX_NOTE,
    }
  }

  private need(): CatalogPort {
    if (!this.catalog) throw new Problem(503, 'procure.off', 'Product search is off', OFF_REASON)
    return this.catalog
  }

  /** Search the catalog and rank what came back against the rules. Read-only: nothing is filed. */
  async search(input: { query: string; maxPriceCents?: number; limit?: number }): Promise<{ query: string; maxPriceCents: number | null; results: ProcureResult[]; note: string }> {
    const catalog = this.need()
    const query = input.query.trim()
    if (query.length < 2) throw new Problem(422, 'procure.query', 'Say what to look for', 'A search needs a few words, e.g. "drawing tablet".')
    const products = await catalog.search({ query, maxPriceCents: input.maxPriceCents, limit: input.limit ?? 8 })
    const warrant = this.repo.latestWarrant()?.body ?? null
    const ranked = products.map((product) => this.option(product, warrant, input.maxPriceCents))
      .sort((a, b) => score(a) - score(b))
      .map((item, index) => ({ ...item, rank: index + 1 }))
    return { query, maxPriceCents: input.maxPriceCents ?? null, results: ranked, note: SANDBOX_NOTE }
  }

  /**
   * Ask to buy one product. The product is read again from the catalog, one offer is chosen, and an ordinary payment
   * request is filed for exactly that offer's price. The rules answer, as they do for every request.
   */
  async propose(input: PurchaseInput, idempotencyKey: string, actor: Actor, runId: string | null = null): Promise<PurchaseOutcome> {
    const catalog = this.need()
    if (!PRODUCT_ID.test(input.productId)) throw new Problem(422, 'procure.product_id', 'Not a product id', 'Use a productId from search_products.')
    const warrant = this.repo.latestWarrant()
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
    const product = await catalog.product(input.productId)
    if (!product) throw new Problem(404, 'procure.product_missing', 'No such product', 'The catalog has no product with that id. Search again and use a productId from the results.')
    const options = this.option(product, warrant.body, input.maxPriceCents)
    const wanted = input.merchant ? merchantOf(input.merchant) : null
    const chosen = wanted ? options.offers.find((item) => item.merchant === wanted && item.availability === 'InStock') ?? null : options.best
    if (!chosen) {
      throw new Problem(409, 'procure.offer_missing', 'Not for sale there', wanted ? `${product.title} is not in stock at ${wanted} right now. Nothing was asked for.` : `${product.title} has no in-stock offer in ${warrant.body.currency} right now. Nothing was asked for.`)
    }
    if (input.maxPriceCents !== undefined && chosen.priceCents > input.maxPriceCents) {
      // The person's own budget, not a rule: nothing is filed, and the price that was read is said.
      throw new Problem(422, 'procure.over_budget', 'Over your budget', `${product.title} costs ${dollars(chosen.priceCents)} at ${chosen.merchant} today, over the ${dollars(input.maxPriceCents)} you set. Nothing was asked for.`)
    }
    const funding = this.funding(warrant.body, chosen.priceCents, input)
    const request: ProposalCreate = {
      kind: 'payment',
      // A store the rules know is named by its payee id; one they do not know is named as the store, and refused as such.
      payee: chosen.vendor?.payeeId ?? chosen.merchant,
      amountCents: chosen.priceCents,
      currency: chosen.currency,
      category: PURCHASE_CATEGORY,
      description: `Buy ${product.title.slice(0, 380)} from ${chosen.merchant} (sandbox vendor stand-in)`.slice(0, 500),
      evidenceUrl: chosen.url,
      prompt: (input.prompt?.trim() || `buy ${product.title}`).slice(0, 4000),
      ...(funding.jobId ? { jobId: funding.jobId } : {}),
      ...(funding.fundingCaptureId ? { fundingCaptureId: funding.fundingCaptureId } : {}),
    }
    const result = await this.mandate.proposeAndDispatch(request, idempotencyKey, actor, runId)
    const proposal = result.body as ProposalView
    return {
      proposal,
      product: { productId: product.id, title: product.title, imageUrl: product.imageUrl },
      offer: chosen,
      whatWouldPass: proposal.gate === 'DENY' ? this.mandate.whatWouldPass(proposal.id).map((item) => item.text) : [],
      note: SANDBOX_NOTE,
    }
  }

  private option(product: CatalogProduct, warrant: WarrantBody | null, maxPriceCents: number | undefined): Omit<ProcureResult, 'rank'> {
    const offers = product.offers.map((offer): ProcureOption => ({ ...pick(offer), vendor: vendorFor(warrant, offer.merchant) }))
    const currency = warrant?.currency ?? 'USD'
    const usable = offers.filter((item) => item.availability === 'InStock' && item.currency === currency)
    const inBudget = usable.filter((item) => maxPriceCents === undefined || item.priceCents <= maxPriceCents)
    const order = (a: ProcureOption, b: ProcureOption) => Number(Boolean(b.vendor)) - Number(Boolean(a.vendor)) || a.priceCents - b.priceCents
    const best = [...(inBudget.length > 0 ? inBudget : usable)].sort(order)[0] ?? null
    const withinBudget = best !== null && (maxPriceCents === undefined || best.priceCents <= maxPriceCents)
    const why = !best ? 'not in stock'
      : !withinBudget ? `over budget at ${dollars(best.priceCents)}`
      : best.vendor ? `${dollars(best.priceCents)} at ${best.merchant}, a vendor on your rules`
      : `${dollars(best.priceCents)} at ${best.merchant}, which is not on your rules`
    return { productId: product.id, title: product.title, brand: product.brand, imageUrl: product.imageUrl, best, offers, withinBudget, why }
  }

  /**
   * The client payment a purchase is paid from, when the rules say payments need one. The caller may name it. If not,
   * the job is the one the caller named, or the one whose client the person's own words name; and the payment is
   * that job's settled one with the most left. If none can be found, none is cited, and the rules say so.
   */
  private funding(warrant: WarrantBody, cents: number, input: PurchaseInput): { jobId?: string; fundingCaptureId?: string } {
    if (!warrant.fundingRequired) return input.jobId ? { jobId: input.jobId } : {}
    if (input.fundingCaptureId) return { fundingCaptureId: input.fundingCaptureId, ...(input.jobId ? { jobId: input.jobId } : {}) }
    const jobIds = [...new Set(this.mandate.listProposals(100, null).data.map((row) => row.jobId).filter((id): id is string => Boolean(id)))]
    const words = (input.prompt ?? '').toLowerCase()
    const named = (party: Payee) => [party.displayName, ...party.aliases].some((name) => name.length >= 3 && words.includes(name.toLowerCase()))
    const jobs = jobIds.flatMap((id) => {
      try {
        return [this.mandate.job(id)]
      } catch {
        return []
      }
    })
    const candidates = input.jobId ? jobs.filter((job) => job.jobId === input.jobId) : jobs.filter((job) => job.client && named(job.client))
    const charges = candidates.flatMap((job) => job.charges.filter((row) => row.captureId && row.fundableCents > 0).map((row) => ({ jobId: job.jobId, captureId: row.captureId!, left: row.fundableCents })))
    const best = charges.find((row) => row.left >= cents) ?? charges.sort((a, b) => b.left - a.left)[0]
    if (best) return { jobId: best.jobId, fundingCaptureId: best.captureId }
    return input.jobId ? { jobId: input.jobId } : {}
  }
}

const pick = (offer: CatalogOffer) => ({ merchant: offer.merchant, priceCents: offer.priceCents, currency: offer.currency, url: offer.url, availability: offer.availability })

/** Best first: an in-budget offer from a known vendor, then in-budget elsewhere, then over budget, then out of stock; cheaper first within each. */
function score(item: Omit<ProcureResult, 'rank'>): number {
  if (!item.best) return 4e9
  const tier = !item.withinBudget ? 2 : item.best.vendor ? 0 : 1
  return tier * 1e9 + item.best.priceCents
}

function vendorFor(warrant: WarrantBody | null, merchant: string): { payeeId: string; name: string } | null {
  if (!warrant) return null
  const payee = resolvePayee(warrant, merchant) ?? resolvePayee(warrant, `www.${merchant}`)
  return payee ? { payeeId: payee.id, name: payee.displayName } : null
}

function vendorsOf(warrant: WarrantBody): ProcureStatus['vendors'] {
  return warrant.payees
    .map((payee) => ({ payeeId: payee.id, name: payee.displayName, merchants: payee.aliases.filter((alias) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(alias)).map(merchantOf) }))
    .filter((vendor) => vendor.merchants.length > 0)
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`
