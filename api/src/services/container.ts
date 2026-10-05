import type { DatabaseSync } from 'node:sqlite'
import { Repo } from '../db/repo'
import { ephemeralSigner, type Signer } from '../domain/signing'
import type { InvoicePort } from '../paypal/invoices'
import type { PayPalPort } from '../paypal/port'
import { DealService } from './deals'
import { MandateService } from './mandate'

export type Services = {
  repo: Repo
  signer: Signer
  mandate: MandateService
  deals: DealService
}

/** The one place the services are wired together. The HTTP app, the MCP server and the agents all start here. */
export function buildServices(deps: { db: DatabaseSync; paypal: PayPalPort | null; invoices?: InvoicePort | null; now: () => Date; signer?: Signer }): Services {
  const repo = new Repo(deps.db)
  const signer = deps.signer ?? ephemeralSigner()
  const mandate = new MandateService(repo, deps.paypal, deps.now, signer, deps.invoices ?? null)
  const deals = new DealService(repo, signer, deps.now, mandate)
  mandate.prepareSigning()
  return { repo, signer, mandate, deals }
}
