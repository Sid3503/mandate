import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { callTool } from '../agents/structured'
import type { AgentModel } from '../agents/model'
import type { Repo } from '../db/repo'
import { paypalRequestId } from '../domain/hash'
import { readTrackingLink, type TrackingLink } from '../domain/tracking'
import { Problem } from '../http/problem'
import type { ModelBudget } from '../ops/budget'
import { DISPUTE_TEXT_MAX, disputeRequestFor, type DisputeDetail, type DisputePort, type DisputeRequest } from '../paypal/disputes'
import { PayPalError } from '../paypal/port'
import type { BooksService } from './books'
import { acceptanceMessage, type Signer } from '../domain/signing'
import type { MandateService } from './mandate'

/**
 * The dispute desk. A client disputes a payment with PayPal; the owner answers with what Mandate can PROVE, and a
 * person approves every answer.
 *
 * What makes the evidence stronger than a screenshot: it comes out of the signed records. The lock on the payment
 * (Ed25519, re-verified now), the owner's approval and how it was given, the client's own signed acceptance of the
 * delivery, the proof link, the capture and its fee, the timeline and the double-entry books for that payment.
 *
 * Three rules this file keeps:
 *   1. HONESTY. A draft states only facts that are in the packet. What is missing is listed as missing, by code, and
 *      is never filled in. The model may only phrase; a check rejects a draft that names an amount, an id, a link or a
 *      claim the packet does not hold, and the code-written template is the fallback.
 *   2. NOBODY BUT A PERSON SENDS. This service has no caller that is not the route, and the route is owner-only and
 *      needs a passkey grant bound to this dispute and this exact text. An agent key never reaches it.
 *   3. ONE SEND. The attempt is written before PayPal is called, with a request id that depends only on the dispute and
 *      the text; a second send of a dispute does nothing (a database rule stops a second `sent` row).
 *
 * Not done on purpose: accepting the claim. That concedes money, so it is not offered here at all.
 */

export type ChecklistItem = { id: string; label: string; present: boolean; detail: string }

export type EvidencePacket = {
  disputeId: string
  builtAt: string
  /** The payment this dispute is about, found by its capture id. Null when Mandate has no such payment. */
  proposalId: string | null
  dispute: { transactionId: string; status: string; reason: string | null; amountCents: number | null; currency: string | null }
  payment: null | {
    captureId: string | null
    amountCents: number
    capturedCents: number | null
    feeCents: number | null
    currency: string
    description: string
    phase: string
    jobId: string | null
    dealId: string | null
    milestone: number | null
    proofUrl: string | null
  }
  /**
   * A carrier tracking link read from the proof URL. `delivered` is always false: Mandate does not ask the carrier,
   * so a URL is never treated as proof the parcel arrived.
   */
  tracking: TrackingLink | null
  lock: null | { verdict: string; keyId: string | null; cartHash: string | null }
  approval: null | { method: string; who: string; how: string; at: string | null; fingerprint: string | null }
  acceptance: null | { status: string; decidedBy: string | null; decidedAt: string | null; milestone: number; signatureValid: boolean | null; keyId: string | null; proofUrl: string }
  timeline: Array<{ at: string; type: string }>
  books: Array<{ seq: number; purpose: string; memo: string; deltaCents: number; at: string }>
  links: { receipt: string | null; verify: string | null }
  checklist: ChecklistItem[]
  /** How many of the checklist items hold. */
  strength: { present: number; total: number }
}

export type DraftRow = { id: string; seq: number; kind: 'draft' | 'edit'; text: string; source: 'model' | 'template' | 'owner'; packetSha256: string | null; actor: string; at: string }
export type SentView = { at: string; request: DisputeRequest; text: string; approvedBy: string; approvedVia: string; approvedAt: string }
type ResponseRow = { id: string; dispute_id: string; seq: number; kind: string; text: string | null; text_sha256: string | null; source: string | null; packet_sha256: string | null; payload_json: string | null; request_id: string | null; actor: string; created_at: string }

export type DisputeListItem = {
  id: string
  transactionId: string
  status: string
  reason: string | null
  amountCents: number | null
  currency: string | null
  openedAt: string | null
  updatedAt: string
  /** When PayPal says the seller must answer by. Null until the dispute has been read from PayPal. */
  respondBy: string | null
  /** Milliseconds from now until then, negative once past. Null when respondBy is. */
  dueInMs: number | null
  /** True under 48 hours (or past) while an answer is still owed. */
  urgent: boolean
  response: 'none' | 'drafted' | 'sent'
  /** True when Mandate has the payment this dispute is about. */
  inRecords: boolean
}

const URGENT_MS = 48 * 3_600_000
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const money = (cents: number, currency: string) => currency === 'USD' ? `$${(cents / 100).toFixed(2)}` : `${(cents / 100).toFixed(2)} ${currency}`

/** What a step-up grant must be bound to for sending this dispute's response. Server and browser both derive it from this. */
export const disputeSendPayload = (disputeId: string, text: string) => `${disputeId}\n${sha(text)}`

export class DisputeService {
  /** The PayPal side. Null until a real PayPal client (or a test's fake) is attached. */
  port: DisputePort | null
  /** The model that may phrase a draft. Null: the template writes it. */
  model: AgentModel | null = null
  budget: ModelBudget | null = null
  private readonly sending = new Set<string>()

  constructor(
    private readonly db: DatabaseSync,
    private readonly repo: Repo,
    private readonly mandate: MandateService,
    private readonly books: BooksService,
    private readonly signer: Signer,
    private readonly now: () => Date,
    private readonly publicUrl: string,
    port: DisputePort | null,
  ) {
    this.port = port
  }

  // ---------- reading ----------

  /** Disputes Mandate has read. One never read from PayPal before is read now (so its due date shows), up to 20 a call. */
  async list(): Promise<DisputeListItem[]> {
    const unread = this.repo.listDisputes(100).filter((row) => row.status !== 'RESOLVED' && !this.latestSnapshot(row.disputeId)).slice(0, 20)
    for (const row of unread) await this.refresh(row.disputeId)
    return this.listStored()
  }

  private listStored(): DisputeListItem[] {
    const nowMs = this.now().getTime()
    return this.repo.listDisputes(100).map((row) => {
      const snapshot = this.latestSnapshot(row.disputeId)
      const response = this.sentRow(row.disputeId) ? 'sent' : this.latestText(row.disputeId) ? 'drafted' : 'none'
      const respondBy = snapshot?.sellerResponseDueDate ?? null
      const dueInMs = respondBy && !Number.isNaN(Date.parse(respondBy)) ? Date.parse(respondBy) - nowMs : null
      return {
        id: row.disputeId,
        transactionId: row.transactionId,
        status: row.status,
        reason: row.reason,
        amountCents: row.amountCents,
        currency: row.currency,
        openedAt: row.openedAt,
        updatedAt: row.updatedAt,
        respondBy,
        dueInMs,
        urgent: response !== 'sent' && row.status !== 'RESOLVED' && dueInMs !== null && dueInMs < URGENT_MS,
        response,
        inRecords: this.repo.paymentByCapture(row.transactionId) !== null,
      }
    })
  }

  /** One dispute: the facts (refreshed from PayPal when it can be), the packet, the latest text, the history and the send. */
  async detail(id: string) {
    const stored = this.require(id)
    const live = await this.refresh(id)
    const dispute = live.detail
    const packet = this.buildPacket(id)
    const latest = this.latestText(id)
    const sent = this.sentView(id)
    const item = this.listStored().find((row) => row.id === id)!
    return {
      dispute: {
        id,
        status: dispute?.status ?? stored.status,
        stage: dispute?.stage ?? null,
        reason: dispute?.reason ?? stored.reason,
        amountCents: dispute?.amountCents ?? stored.amountCents,
        currency: dispute?.currency ?? stored.currency,
        transactionId: stored.transactionId,
        openedAt: dispute?.createdAt ?? stored.openedAt,
        respondBy: item.respondBy,
        dueInMs: item.dueInMs,
        urgent: item.urgent,
        messages: dispute?.messages ?? [],
        evidences: dispute?.evidences ?? [],
        linkRels: dispute?.linkRels ?? [],
        allowedResponseOptions: dispute?.allowedResponseOptions ?? [],
      },
      /** Whether this read reached PayPal. When it did not, the facts above are the stored summary and `liveError` says why. */
      live: { read: dispute !== null, error: live.error },
      packet,
      draft: latest,
      history: this.history(id),
      sent,
      /** What the passkey grant for sending must be bound to, so the console never has to guess. */
      sendBinding: latest ? disputeSendPayload(id, latest.text) : null,
      verified: 'Built to PayPal\'s documented request shape; not run on a live dispute (the sandbox cannot open one).',
    }
  }

  /** Reads the dispute from PayPal and keeps what it said as an appended snapshot, when it changed. */
  private async refresh(id: string): Promise<{ detail: DisputeDetail | null; error: string | null }> {
    if (!this.port) return { detail: null, error: 'PayPal is not connected, so the dispute was not re-read.' }
    try {
      const detail = await this.port.get(id)
      const previous = this.latestSnapshot(id)
      if (!previous || JSON.stringify(previous) !== JSON.stringify(detail)) this.append(id, 'snapshot', { payload: detail, actor: 'system' })
      return { detail, error: null }
    } catch (error) {
      return { detail: this.latestSnapshot(id), error: error instanceof PayPalError ? `PayPal answered ${error.httpStatus}.` : 'PayPal could not be reached.' }
    }
  }

  // ---------- the packet ----------

  buildPacket(id: string): EvidencePacket {
    const stored = this.require(id)
    const snapshot = this.latestSnapshot(id)
    const row = this.repo.paymentByCapture(stored.transactionId)
    const builtAt = this.now().toISOString()
    const base = { disputeId: id, builtAt, dispute: { transactionId: stored.transactionId, status: stored.status, reason: stored.reason, amountCents: stored.amountCents, currency: stored.currency } }
    if (!row) {
      const checklist: ChecklistItem[] = [{ id: 'payment', label: 'The disputed payment is in Mandate\'s records', present: false, detail: `No payment in Mandate has capture ${stored.transactionId}. Nothing here can be cited.` }]
      return { ...base, proposalId: null, payment: null, tracking: null, lock: null, approval: null, acceptance: null, timeline: [], books: [], links: { receipt: null, verify: null }, checklist, strength: { present: 0, total: 1 } }
    }
    const packet = this.mandate.packet(row.id)
    const lockCheck = this.mandate.verifyLock(row.id)
    const journal = this.books.journal({ limit: 100, proposalId: row.id }).data
    // The client's acceptance of this milestone: the one linked to the payment, else the accepted delivery of the milestone.
    const delivery = this.repo.deliveryByProposal(row.id) ?? (row.deal_id && row.milestone !== null ? this.repo.acceptedDelivery(row.deal_id, row.milestone) : null)
    const acceptance = delivery && packet.acceptance && packet.acceptance.id === delivery.id
      ? { status: delivery.status, decidedBy: delivery.decided_by, decidedAt: delivery.decided_at, milestone: delivery.milestone, signatureValid: packet.acceptance.signatureValid, keyId: delivery.key_id, proofUrl: delivery.proof_url }
      : delivery
        ? { status: delivery.status, decidedBy: delivery.decided_by, decidedAt: delivery.decided_at, milestone: delivery.milestone, signatureValid: this.acceptanceValid(delivery), keyId: delivery.key_id, proofUrl: delivery.proof_url }
        : null
    const origin = this.publicUrl.replace(/\/$/, '')
    const locked = lockCheck.locked
    const lock = locked ? { verdict: lockCheck.verdict, keyId: lockCheck.keyId, cartHash: lockCheck.cartHash } : null
    const approval = packet.approvalProof ? { method: packet.approvalProof.method, who: packet.approvalProof.who, how: packet.approvalProof.how, at: packet.approvalProof.at, fingerprint: packet.approvalProof.fingerprint } : null
    const proofUrl = row.evidence_url
    const tracking = readTrackingLink(proofUrl)
    const accepted = acceptance !== null && acceptance.status === 'accepted'
    const checklist: ChecklistItem[] = [
      { id: 'payment', label: 'The disputed payment is in Mandate\'s records', present: true, detail: `${row.kind === 'charge' ? 'Client charge' : 'Payment'} ${row.id}, ${money(row.amount_cents, row.currency)}.` },
      { id: 'capture', label: 'The PayPal capture and its amounts are recorded', present: Boolean(row.capture_id) && row.captured_amount_cents !== null, detail: row.captured_amount_cents !== null ? `Capture ${row.capture_id} took ${money(row.captured_amount_cents, row.currency)}${row.capture_fee_cents !== null ? `, PayPal fee ${money(row.capture_fee_cents, row.currency)}` : ', PayPal stated no fee'}.` : 'No captured amount is recorded.' },
      { id: 'lock', label: 'Signed lock on the payment', present: lockCheck.verdict === 'valid', detail: lockCheck.verdict === 'valid' ? `Ed25519 signature by key ${lockCheck.keyId}, re-verified now: the cart hash matches and the signature is valid.` : lockCheck.verdict === 'not_locked' ? 'The payment was never locked, so there is no signature.' : 'The lock is present but did NOT verify. Do not cite it.' },
      { id: 'approval', label: 'The owner\'s approval, and how it was given', present: approval !== null && approval.method !== 'legacy', detail: approval ? `${approval.who} approved by ${approval.how}${approval.at ? ` at ${approval.at}` : ''}.` : 'No approval is recorded for this payment.' },
      { id: 'acceptance', label: 'The client accepted the delivery, with a signature', present: accepted && acceptance!.signatureValid === true, detail: !delivery ? (row.deal_id ? 'The deal milestone has no delivery on record.' : 'This payment is not from a deal milestone, so there is no delivery acceptance.') : accepted ? (acceptance!.signatureValid === true ? `${acceptance!.decidedBy ?? 'The client'} accepted milestone ${acceptance!.milestone}${acceptance!.decidedAt ? ` at ${acceptance!.decidedAt}` : ''}; signature (key ${acceptance!.keyId}) verifies.` : 'An acceptance is recorded but its signature did NOT verify. Do not cite it.') : `The delivery is ${delivery.status}, not accepted.` },
      { id: 'proof', label: 'A link to the proof of the work', present: Boolean(proofUrl), detail: proofUrl ?? 'No proof link was attached to this payment.' },
      { id: 'tracking', label: 'A carrier tracking link', present: tracking !== null, detail: tracking ? `${tracking.carrier.toUpperCase()} tracking link${tracking.trackingNumber ? ` ${tracking.trackingNumber}` : ''}. This is a link, not a statement that the parcel arrived.` : 'The proof link is not a UPS, FedEx, USPS or DHL tracking page.' },
      { id: 'arrived', label: 'A carrier confirmation the parcel arrived', present: false, detail: 'Mandate does not ask a carrier. A tracking link is never read as arrival.' },
      { id: 'books', label: 'Entries in the books', present: journal.length > 0, detail: journal.length > 0 ? `${journal.length} balanced double-entry ${journal.length === 1 ? 'entry' : 'entries'} for this payment.` : 'The books hold no entry for this payment.' },
      { id: 'timeline', label: 'The timeline of the request', present: packet.events.length > 0, detail: `${packet.events.length} recorded event${packet.events.length === 1 ? '' : 's'}.` },
    ]
    const isPresent = (key: string) => checklist.find((item) => item.id === key)!.present
    return {
      ...base,
      dispute: { ...base.dispute, status: snapshot?.status ?? base.dispute.status },
      proposalId: row.id,
      payment: { captureId: row.capture_id, amountCents: row.amount_cents, capturedCents: row.captured_amount_cents, feeCents: row.capture_fee_cents, currency: row.currency, description: row.description, phase: row.phase, jobId: row.job_id, dealId: row.deal_id, milestone: row.milestone, proofUrl },
      tracking,
      lock: isPresent('lock') || lock ? lock : null,
      approval,
      acceptance: acceptance && accepted && acceptance.signatureValid === true ? acceptance : acceptance,
      timeline: packet.events.map((event) => ({ at: event.createdAt, type: event.type })),
      books: journal.map((entry) => ({ seq: entry.seq, purpose: entry.purpose, memo: entry.memo, deltaCents: entry.deltaCents, at: entry.createdAt })),
      links: locked ? { receipt: `${origin}/app/p/${row.id}`, verify: `${origin}/app/verify?proposal=${row.id}` } : { receipt: `${origin}/app/p/${row.id}`, verify: null },
      checklist,
      strength: { present: checklist.filter((item) => item.present).length, total: checklist.length },
    }
  }

  private acceptanceValid(delivery: NonNullable<ReturnType<Repo['deliveryByProposal']>>): boolean | null {
    return delivery.sig ? this.signer.verify(acceptanceMessage(delivery), delivery.sig, delivery.key_id) : null
  }

  // ---------- drafting ----------

  /**
   * The response text written by code from the packet. Every sentence is conditional on a fact the packet holds. This
   * is both the fallback and the reference the model's draft is checked against.
   */
  templateText(packet: EvidencePacket): string {
    const lines: string[] = []
    const d = packet.dispute
    lines.push(`Response to dispute ${packet.disputeId}${d.reason ? ` (${d.reason})` : ''}${d.amountCents !== null && d.currency ? ` for ${money(d.amountCents, d.currency)}` : ''}.`)
    const payment = packet.payment
    if (payment) {
      const parts = [`The disputed payment is PayPal capture ${payment.captureId ?? d.transactionId}`]
      if (payment.capturedCents !== null) parts.push(`for ${money(payment.capturedCents, payment.currency)}${payment.feeCents !== null ? ` (PayPal fee ${money(payment.feeCents, payment.currency)})` : ''}`)
      lines.push(`${parts.join(' ')}, for: ${payment.description}.`)
    }
    if (packet.lock?.verdict === 'valid') lines.push(`The payment was locked before it was taken, with an Ed25519 signature (key ${packet.lock.keyId}) that verifies against the studio's published key.`)
    if (packet.approval && packet.approval.method !== 'legacy') lines.push(`It was approved by ${packet.approval.who} by ${packet.approval.how}${packet.approval.at ? ` at ${packet.approval.at}` : ''}.`)
    const a = packet.acceptance
    if (a && a.status === 'accepted' && a.signatureValid === true) lines.push(`The client accepted the delivery of milestone ${a.milestone}${a.decidedAt ? ` at ${a.decidedAt}` : ''}, with a signed acceptance (key ${a.keyId}) that verifies.`)
    if (payment?.proofUrl) lines.push(`Proof of the work: ${payment.proofUrl}`)
    const track = packet.tracking
    if (track) lines.push(`A ${track.carrier.toUpperCase()} tracking link is on file${track.trackingNumber ? ` (${track.trackingNumber})` : ''}: ${track.url}. Mandate has not been told the parcel arrived.`)
    if (packet.books.length > 0) lines.push(`The books hold ${packet.books.length} balanced ${packet.books.length === 1 ? 'entry' : 'entries'} for this payment.`)
    if (packet.links.verify && packet.lock?.verdict === 'valid') lines.push(`Anyone can check the signed receipt here: ${packet.links.verify}`)
    return this.withMissing(lines.join('\n'), packet)
  }

  /** Appends, by code, what the packet does not hold. This is never left to the model, so a gap is always named. */
  private withMissing(text: string, packet: EvidencePacket): string {
    const missing = packet.checklist.filter((item) => !item.present && item.id !== 'timeline').map((item) => item.label.replace(/^The /, 'the '))
    const full = missing.length > 0 ? `${text}\nNot available in our records: ${missing.join('; ')}.` : text
    return full.length > DISPUTE_TEXT_MAX ? `${full.slice(0, DISPUTE_TEXT_MAX - 1)}…` : full
  }

  /**
   * Looks for anything in a draft that the packet does not hold: an amount, a long id, a link or a date that is not in
   * it, or a claim (signed, accepted, passkey) whose checklist item is missing. Returns the complaint, or null.
   * A guard, not a proof: the owner reads the text before it goes, and the checklist sits beside it.
   */
  unsupportedClaim(text: string, packet: EvidencePacket): string | null {
    const corpus = JSON.stringify(packet)
    const allowedMoney = new Set<string>()
    const addMoney = (cents: number | null | undefined, currency: string | null | undefined) => { if (typeof cents === 'number' && currency) allowedMoney.add(money(cents, currency)) }
    addMoney(packet.dispute.amountCents, packet.dispute.currency)
    addMoney(packet.payment?.amountCents, packet.payment?.currency)
    addMoney(packet.payment?.capturedCents, packet.payment?.currency)
    addMoney(packet.payment?.feeCents, packet.payment?.currency)
    for (const entry of packet.books) addMoney(Math.abs(entry.deltaCents), packet.payment?.currency)
    for (const found of text.match(/\$\d[\d,]*(?:\.\d{2})?/g) ?? []) {
      const normal = /\.\d{2}$/.test(found) ? found.replace(/,/g, '') : `${found.replace(/,/g, '')}.00`
      if (!allowedMoney.has(normal)) return `the amount ${found} is not in the packet.`
    }
    for (const found of text.match(/https?:\/\/[^\s)]+/g) ?? []) {
      if (!corpus.includes(found.replace(/[.,;]+$/, ''))) return `the link ${found} is not in the packet.`
    }
    for (const found of text.match(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g) ?? []) {
      if (!corpus.includes(found)) return `the date ${found} is not in the packet.`
    }
    for (const found of text.match(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{10,}\b/g) ?? []) {
      if (!corpus.includes(found)) return `the identifier ${found} is not in the packet.`
    }
    const has = (id: string) => packet.checklist.find((item) => item.id === id)?.present === true
    if (/\b(signed|signature|ed25519)\b/i.test(text) && !has('lock') && !has('acceptance')) return 'it speaks of a signature, but the packet holds no valid signature.'
    if (/\bclient (has )?(accepted|signed off|approved the delivery)\b|\baccepted the delivery\b/i.test(text) && !has('acceptance')) return 'it says the client accepted the delivery, but the packet holds no valid acceptance.'
    if (/\bpasskey\b/i.test(text) && packet.approval?.method !== 'passkey') return 'it says a passkey approved the payment, but the packet does not say that.'
    if (/\b(approved|authori[sz]ed) by\b/i.test(text) && !has('approval')) return 'it speaks of an approval, but the packet holds none.'
    if (/\bproof of (the )?(work|delivery)\b/i.test(text) && !has('proof')) return 'it cites proof of the work, but the packet holds no proof link.'
    // "delivered" and "proof of delivery" are claims about a parcel. A tracking URL is not that claim, and the
    // arrived item is never present, because Mandate does not ask the carrier.
    if (/\bdelivered\b|\bproof of delivery\b|\bsigned for\b/i.test(text) && !has('arrived')) return 'it says the parcel arrived, but the packet holds no carrier confirmation.'
    return null
  }

  /** Writes a fresh draft: the model's wording when it is available and passes the check, the template otherwise. */
  async draft(id: string, actor: string): Promise<DraftRow> {
    this.require(id)
    if (this.sentRow(id)) throw new Problem(409, 'dispute.already_sent', 'This dispute already has a response', 'A response was sent for this dispute. It cannot be drafted again.')
    const packet = this.buildPacket(id)
    const template = this.templateText(packet)
    let text = template
    let source: 'model' | 'template' = 'template'
    if (this.model && this.budget?.reserve() == null) {
      try {
        const result = await callTool({
          model: this.model,
          system: 'You write the seller\'s response to a PayPal payment dispute, in plain business English, from a packet of verified facts. Use ONLY facts that are in the packet. Never invent an amount, id, date, link, tracking number or event. If something is not in the packet, do not mention it: a code-written list of what is missing is added after your text. Never say a person or the client did something the packet does not show. Under 1500 characters. Do not accept the claim, offer a refund or promise anything.',
          user: `Packet (JSON, the only facts you may use):\n${JSON.stringify({ dispute: packet.dispute, payment: packet.payment, tracking: packet.tracking, lock: packet.lock, approval: packet.approval, acceptance: packet.acceptance, books: packet.books.length, verifyLink: packet.links.verify, missing: packet.checklist.filter((item) => !item.present).map((item) => item.id) })}\n\nThe code-written version, for reference:\n${template}`,
          name: 'write_response',
          description: 'Write the response text.',
          schema: z.object({ text: z.string().min(20).max(1500) }),
          attempts: 2,
          timeoutMs: 40_000,
          validate: (value) => this.unsupportedClaim(value.text, packet),
        })
        this.budget?.correct(result.usage.inputTokens ?? 0, result.usage.outputTokens ?? 0)
        // A last attempt that still failed the check comes back as "leftover": it is not used.
        if (!result.leftover) {
          text = this.withMissing(result.value.text.trim(), packet)
          source = 'model'
        }
      } catch {
        // The model could not be reached or kept failing the check. The template stands, and says nothing less true.
      }
    }
    return this.append(id, 'draft', { text, source, packetSha256: sha(JSON.stringify({ ...packet, builtAt: null })), actor })
  }

  /** The owner's own edit. It is a new row, so every earlier version stays. */
  edit(id: string, text: string, actor: string): DraftRow {
    this.require(id)
    if (this.sentRow(id)) throw new Problem(409, 'dispute.already_sent', 'This dispute already has a response', 'A response was sent for this dispute. It cannot be edited.')
    const clean = this.cleanText(text)
    return this.append(id, 'edit', { text: clean, source: 'owner', packetSha256: null, actor })
  }

  private cleanText(text: string): string {
    const clean = text.trim()
    if (clean.length < 1) throw new Problem(400, 'request.invalid', 'Request is invalid', 'The response cannot be empty.')
    if (clean.length > DISPUTE_TEXT_MAX) throw new Problem(400, 'request.invalid', 'Request is invalid', `PayPal takes at most ${DISPUTE_TEXT_MAX} characters. This is ${clean.length}.`)
    return clean
  }

  // ---------- sending ----------

  /**
   * Sends the approved text. The route has already checked the passkey grant, which is bound to this dispute and this
   * exact text. Here: the text must be what the owner approved, the dispute must be one PayPal still lets the seller
   * answer, the attempt is written BEFORE the call, and a second send does nothing.
   */
  async send(id: string, text: string, approver: { actor: string; via: string }): Promise<{ replayed: boolean; sent: SentView }> {
    this.require(id)
    const already = this.sentView(id)
    if (already) return { replayed: true, sent: already }
    if (!this.port) throw new Problem(503, 'paypal.unconfigured', 'PayPal is not connected', 'Disputes are answered through PayPal, and this server has no PayPal client. Nothing was sent.')
    const clean = this.cleanText(text)
    const packet = this.buildPacket(id)
    if (!packet.proposalId) throw new Problem(409, 'dispute.no_payment', 'Mandate has no record of this payment', `Capture ${packet.dispute.transactionId} is not a payment Mandate made, so there is no evidence to cite and the attempt cannot be recorded. Nothing was sent.`)
    if (this.sending.has(id)) throw new Problem(409, 'dispute.inflight', 'A response is already being sent', 'Wait for it to finish.')
    this.sending.add(id)
    try {
      // Read the dispute again at the moment of sending: PayPal decides what it will take, so the stage is PayPal's.
      let live: DisputeDetail
      try {
        live = await this.port.get(id)
      } catch (error) {
        throw new Problem(502, 'paypal.upstream', 'PayPal did not answer', error instanceof PayPalError ? `PayPal answered ${error.httpStatus} when the dispute was read. Nothing was sent.` : 'The dispute could not be read, so nothing was sent.')
      }
      const needsRel = live.stage === 'INQUIRY' ? 'send-message' : 'provide-evidence'
      if (live.status === 'RESOLVED' || !live.linkRels.includes(needsRel)) {
        throw new Problem(409, 'dispute.not_open', 'PayPal is not taking a response', `PayPal's dispute shows no ${needsRel} link (status ${live.status}, stage ${live.stage}). Nothing was sent.`)
      }
      const textHash = sha(clean)
      const requestId = paypalRequestId(`dispute:${id}:${textHash}`)
      const request = disputeRequestFor(live.stage, id, clean, requestId)
      const nowIso = this.now().toISOString()
      // The owner's yes, as a row of its own, then the attempt, both written before PayPal hears anything.
      const approval = this.append(id, 'approval', { text: clean, source: null, packetSha256: null, payload: { request, approvedVia: approver.via }, requestId, actor: approver.actor })
      const attemptId = randomUUID()
      this.repo.startAttempt({ id: attemptId, proposalId: packet.proposalId, op: 'dispute_response', requestId, now: nowIso })
      try {
        if (live.stage === 'INQUIRY') await this.port.sendMessage(id, clean, requestId)
        else await this.port.provideEvidence(id, { evidenceType: 'OTHER', notes: clean }, requestId)
        this.repo.finishAttempt(attemptId, 'succeeded', id, null, this.now().toISOString())
      } catch (error) {
        const definitive = error instanceof PayPalError && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408 && error.httpStatus !== 429
        const why = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : 'error'
        this.repo.finishAttempt(attemptId, definitive ? 'failed' : 'unknown', null, why, this.now().toISOString())
        this.append(id, 'failed', { text: null, source: null, packetSha256: null, payload: { request, error: why, definitive }, requestId, actor: approver.actor })
        throw new Problem(definitive ? 409 : 502, 'dispute.send_failed', 'PayPal did not take the response', `${definitive ? 'PayPal refused it' : 'PayPal could not be reached, so it may or may not have arrived'}. ${definitive ? 'Nothing was sent.' : 'Sending again repeats the same request id.'}`, { retryable: !definitive })
      }
      this.append(id, 'sent', { text: clean, source: null, packetSha256: null, payload: { request }, requestId, actor: approver.actor })
      this.repo.insertEvent(randomUUID(), packet.proposalId, 'dispute.responded', null, { disputeId: id, requestId, path: request.path, textSha256: textHash }, this.now().toISOString())
      void approval
      return { replayed: false, sent: this.sentView(id)! }
    } finally {
      this.sending.delete(id)
    }
  }

  /** True once a response for this dispute has gone. */
  alreadySent(id: string): boolean {
    return this.sentRow(id) !== null
  }

  // ---------- the appended rows ----------

  private require(id: string) {
    const row = this.repo.disputeById(id)
    if (!row) throw new Problem(404, 'dispute.missing', 'No such dispute', 'Mandate has not read a dispute with that id. Check for new disputes from the System page.')
    return row
  }

  private rows(id: string): ResponseRow[] {
    return this.db.prepare('SELECT * FROM dispute_responses WHERE dispute_id = ? ORDER BY seq').all(id) as ResponseRow[]
  }

  private append(id: string, kind: 'snapshot', input: { payload: unknown; actor: string }): void
  private append(id: string, kind: 'draft' | 'edit', input: { text: string; source: 'model' | 'template' | 'owner'; packetSha256: string | null; actor: string }): DraftRow
  private append(id: string, kind: 'approval' | 'sent' | 'failed', input: { text: string | null; source: null; packetSha256: null; payload: unknown; requestId: string; actor: string }): void
  private append(id: string, kind: ResponseRow['kind'], input: { text?: string | null; source?: string | null; packetSha256?: string | null; payload?: unknown; requestId?: string; actor: string }): DraftRow | void {
    const seq = ((this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM dispute_responses WHERE dispute_id = ?').get(id) as { n: number }).n) + 1
    const rowId = randomUUID()
    const at = this.now().toISOString()
    this.db.prepare(`INSERT INTO dispute_responses (id, dispute_id, seq, kind, text, text_sha256, source, packet_sha256, payload_json, request_id, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rowId, id, seq, kind, input.text ?? null, input.text ? sha(input.text) : null, input.source ?? null, input.packetSha256 ?? null, input.payload === undefined ? null : JSON.stringify(input.payload), input.requestId ?? null, input.actor, at)
    if (kind === 'draft' || kind === 'edit') return { id: rowId, seq, kind, text: input.text!, source: input.source as DraftRow['source'], packetSha256: input.packetSha256 ?? null, actor: input.actor, at }
  }

  private latestSnapshot(id: string): DisputeDetail | null {
    const row = this.db.prepare(`SELECT payload_json FROM dispute_responses WHERE dispute_id = ? AND kind = 'snapshot' ORDER BY seq DESC LIMIT 1`).get(id) as { payload_json: string } | undefined
    return row ? JSON.parse(row.payload_json) as DisputeDetail : null
  }

  private latestText(id: string): DraftRow | null {
    const row = this.db.prepare(`SELECT * FROM dispute_responses WHERE dispute_id = ? AND kind IN ('draft', 'edit') ORDER BY seq DESC LIMIT 1`).get(id) as ResponseRow | undefined
    return row ? { id: row.id, seq: row.seq, kind: row.kind as 'draft' | 'edit', text: row.text ?? '', source: (row.source ?? 'template') as DraftRow['source'], packetSha256: row.packet_sha256, actor: row.actor, at: row.created_at } : null
  }

  private sentRow(id: string): ResponseRow | null {
    return (this.db.prepare(`SELECT * FROM dispute_responses WHERE dispute_id = ? AND kind = 'sent'`).get(id) as ResponseRow | undefined) ?? null
  }

  private sentView(id: string): SentView | null {
    const sent = this.sentRow(id)
    if (!sent) return null
    const approval = [...this.rows(id)].reverse().find((row) => row.kind === 'approval' && row.request_id === sent.request_id)
    const payload = JSON.parse(sent.payload_json ?? '{}') as { request: DisputeRequest }
    const via = approval?.payload_json ? (JSON.parse(approval.payload_json) as { approvedVia?: string }).approvedVia ?? 'unknown' : 'unknown'
    return { at: sent.created_at, request: payload.request, text: sent.text ?? '', approvedBy: approval?.actor ?? sent.actor, approvedVia: via, approvedAt: approval?.created_at ?? sent.created_at }
  }

  /** Every appended row, oldest first, without the bulky snapshots' bodies. */
  history(id: string) {
    return this.rows(id).filter((row) => row.kind !== 'snapshot').map((row) => ({ seq: row.seq, kind: row.kind, source: row.source, actor: row.actor, at: row.created_at, textSha256: row.text_sha256, requestId: row.request_id }))
  }
}
