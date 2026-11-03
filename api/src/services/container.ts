import type { DatabaseSync } from 'node:sqlite'
import { Repo } from '../db/repo'
import { ephemeralSigner, type Signer } from '../domain/signing'
import type { InvoicePort } from '../paypal/invoices'
import type { PayPalPort } from '../paypal/port'
import type { WatchPort } from '../paypal/watch'
import { DealService } from './deals'
import { MandateService } from './mandate'
import { AuditService } from './audit'
import { AskService } from './ask'
import { TodayService } from './today'
import { DEFAULT_SAFETY, SafetyService, type SafetyConfig } from './safety'
import { AgentService } from './agents'
import { ClientKeyService } from './client-keys'
import { ShareService } from './shares'
import { ProjectionService } from './projections'
import { ReceiptService } from './receipt'
import { BooksService } from './books'
import { BreaksService } from './breaks'
import type { CatalogPort } from '../procure/channel3'
import { ProcureService } from '../procure/service'
import { DisputeService } from './disputes'
import { InvoiceDeskService } from './invoiceDesk'
import { createPayPalDisputes, type DisputePort } from '../paypal/disputes'

export type Services = {
  repo: Repo
  signer: Signer
  mandate: MandateService
  deals: DealService
  today: TodayService
  audit: AuditService
  ask: AskService
  safety: SafetyService
  agents: AgentService
  clientKeys: ClientKeyService
  shares: ShareService
  projections: ProjectionService
  receipt: ReceiptService
  books: BooksService
  /** The Breaks desk: where the books and PayPal disagree. Reads and keeps notes; never moves money. */
  breaks: BreaksService
  /** Product search and purchase requests (Channel3). Off, and saying why, when no catalog is configured. */
  procure: ProcureService
  /** The dispute desk: evidence from the signed records, a person approves every response. */
  disputes: DisputeService
  /** The Invoices desk: charges read as invoices, with KPIs and a cash outlook. Reads only. */
  invoiceDesk: InvoiceDeskService
}

import type { ControlStore } from '../control/store'

/** The one place the services are wired together. The HTTP app, the MCP server and the agents all start here. */
export function buildServices(deps: { db: DatabaseSync; paypal: PayPalPort | null; invoices?: InvoicePort | null; watch?: WatchPort | null; publicUrl?: string; now: () => Date; signer?: Signer; safety?: Partial<SafetyConfig>; payeeBook?: boolean; newPayeeWaitHours?: number; onExternalRef?: (kind: string, externalId: string) => void; control?: ControlStore | null; workspaceId?: string; paypalEnvironment?: 'sandbox' | 'live'; /** The product catalog. Null or absent: product search is off. */ catalog?: CatalogPort | null; /** The PayPal disputes API. Absent: built from the real PayPal client when there is one, else off. */ disputes?: DisputePort | null }): Services {
  const repo = new Repo(deps.db)
  const signer = deps.signer ?? ephemeralSigner()
  const safety = new SafetyService(repo, signer, deps.now, deps.safety)
  const agents = new AgentService(repo, deps.now, deps.workspaceId ?? 'ws_default')
  const clientKeys = new ClientKeyService(repo, deps.now, deps.workspaceId ?? 'ws_default')
  const mandate = new MandateService(repo, deps.paypal, deps.now, signer, deps.invoices ?? null, { publicUrl: deps.publicUrl, watch: deps.watch ?? null, safety, agents, payeeBook: deps.payeeBook, newPayeeWaitHours: deps.newPayeeWaitHours, onExternalRef: deps.onExternalRef, paypalEnvironment: deps.paypalEnvironment })
  const deals = new DealService(repo, signer, deps.now, mandate)
  repo.stampEvents = () => (safety.paused() ? { paused: true } : {})
  safety.onResume = async () => {
    await mandate.resumeAutopilot()
    await deals.billAcceptedWhilePaused()
  }
  mandate.prepareSigning()
  const today = new TodayService(repo, deals, mandate, deps.now, () => deps.paypal !== null)
  const audit = new AuditService(repo, mandate, deals, deps.now, safety, signer, deps.control, deps.workspaceId)
  const invoiceDesk = new InvoiceDeskService(repo, mandate, deps.now)
  const ask = new AskService(today, invoiceDesk)
  const shares = new ShareService(repo, mandate, deps.now)
  const projections = new ProjectionService(repo, signer, deps.now)
  const receipt = new ReceiptService(repo, signer, deps.now, deps.publicUrl ?? 'http://localhost:3000')
  // The books read the double-entry journal back: balances, totals and the hash chain, re-walked on every read.
  const books = new BooksService(repo)
  const breaks = new BreaksService(deps.db, repo, mandate, deps.now)
  const procure = new ProcureService(deps.catalog ?? null, repo, mandate)
  const disputes = new DisputeService(deps.db, repo, mandate, books, signer, deps.now, deps.publicUrl ?? 'http://localhost:3000', deps.disputes !== undefined ? deps.disputes : deps.paypal ? createPayPalDisputes(deps.paypal) : null)
  return { repo, signer, mandate, deals, today, audit, ask, safety, agents, clientKeys, shares, projections, receipt, books, breaks, procure, disputes, invoiceDesk }
}
