import type { Repo } from '../db/repo'
import { live, type LiveEvent } from './live'

/**
 * A message to the owner's own channel (Slack, Discord, Zapier, Make: anything with an incoming webhook) when something
 * needs them, so they do not have to keep a console open. It says WHAT needs attention and links to the console. It
 * never carries a key, never carries an approval and can never move money: the person still opens the console and taps.
 *
 * The address is a secret (Slack and Discord put the token in the path), so it is never logged or returned. A failure to
 * send is remembered for the System page and never reaches the money path.
 */
export type NotifyStatus = { enabled: boolean; lastSentAt: string | null; lastError: string | null; sent: number }

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>

export class Notifier {
  private sent = 0
  private lastSentAt: string | null = null
  private lastError: string | null = null
  private readonly told = new Set<string>()
  private stop: (() => void) | null = null

  constructor(private readonly options: { url: string | null; repo: Repo; consoleUrl: string; now: () => Date; fetch?: Fetch }) {}

  get enabled(): boolean {
    return this.options.url !== null
  }

  status(): NotifyStatus {
    return { enabled: this.enabled, lastSentAt: this.lastSentAt, lastError: this.lastError, sent: this.sent }
  }

  start(): void {
    if (!this.enabled || this.stop) return
    this.stop = live.subscribe((event) => this.onEvent(event))
  }

  close(): void {
    this.stop?.()
    this.stop = null
  }

  /** One message the owner can use to check their webhook is wired up. */
  async test(): Promise<NotifyStatus> {
    await this.send('Mandate: test message. If you can read this, the owner\'s webhook is connected.', this.options.consoleUrl)
    return this.status()
  }

  private onEvent(event: LiveEvent): void {
    if (event.type !== 'changed') return
    // The event is published while a write may still be open. Look one tick later, when it is committed.
    setTimeout(() => void this.consider(event).catch(() => undefined), 0)
  }

  private async consider(event: Extract<LiveEvent, { type: 'changed' }>): Promise<void> {
    if (event.scope === 'safety' && (event.what === 'safety.paused' || event.what === 'agent.suspended')) {
      const state = this.options.repo.safetyState()
      const key = `${event.what}:${state.since ?? event.at}`
      if (this.firstTime(key)) await this.send(event.what === 'agent.suspended' ? 'Mandate: an agent was suspended after repeated refusals.' : `Mandate is paused${state.reason ? `: ${state.reason}` : ''}. Nothing automatic runs until you resume it.`, `${this.options.consoleUrl}/system`)
      return
    }
    if (event.scope !== 'ledger' || !event.id) return
    const row = this.options.repo.proposal(event.id)
    if (!row) return
    const who = this.nameOf(row.payee_id)
    const amount = `$${(row.amount_cents / 100).toFixed(2)}`
    const link = `${this.options.consoleUrl}/p/${row.id}`
    if (event.what === 'proposal.created' && row.gate === 'NEEDS_APPROVAL' && row.phase === 'pending_approval') {
      if (this.firstTime(`${row.id}:needs`)) await this.send(`Mandate: ${this.kindWords(row.kind)} ${who} ${amount} needs your tap.`, link)
    } else if (event.what === 'payout.failed' || event.what === 'payout.unclaimed') {
      if (this.firstTime(`${row.id}:${event.what}`)) await this.send(event.what === 'payout.failed' ? `Mandate: PayPal failed the ${amount} payout to ${who}.` : `Mandate: the ${amount} payout to ${who} is unclaimed. They need a PayPal account to receive it.`, link)
    }
  }

  private kindWords(kind: string): string {
    return kind === 'charge' ? 'billing' : kind === 'refund' ? 'a refund to' : 'paying'
  }

  private nameOf(partyId: string | null): string {
    const body = this.options.repo.latestWarrant()?.body
    return [...(body?.payees ?? []), ...(body?.clients ?? [])].find((party) => party.id === partyId)?.displayName ?? 'someone'
  }

  private firstTime(key: string): boolean {
    if (this.told.has(key)) return false
    this.told.add(key)
    if (this.told.size > 2_000) this.told.delete(this.told.values().next().value as string)
    return true
  }

  private async send(text: string, link: string): Promise<void> {
    if (!this.options.url) return
    const send = this.options.fetch ?? ((url, init) => fetch(url, init))
    try {
      // `text` is what Slack reads, `content` is what Discord reads, and `mandate` is for Zapier and anything else.
      const response = await send(this.options.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `${text} ${link}`, content: `${text} ${link}`, mandate: { message: text, url: link, at: this.options.now().toISOString() } }), signal: AbortSignal.timeout(5_000) })
      if (!response.ok) throw new Error(`the webhook answered ${response.status}`)
      this.sent += 1
      this.lastSentAt = this.options.now().toISOString()
      this.lastError = null
    } catch (error) {
      // Never the address: only what went wrong.
      this.lastError = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[address]').slice(0, 160) : 'the message could not be sent'
    }
  }
}
