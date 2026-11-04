/** One money-moving call to PayPal, as the log endpoint returns it (raw rows, snake_case). */
export type LogAttemptRow = {
  id: string
  proposal_id: string
  op: string
  request_id: string
  status: 'started' | 'succeeded' | 'failed' | 'unknown'
  external_id: string | null
  error: string | null
  started_at: string
  finished_at: string | null
}

/** One row of the webhook inbox as the log endpoint returns it. */
export type WebhookEventRow = {
  event_id: string
  event_type: string
  status: string
  attempts: number
  received_at: string
  processed_at: string | null
  error: string | null
}

export type PayPalLog = {
  counts: {
    attempts: number
    attemptsUnknown: number
    attemptsFailed: number
    webhooks: number
    webhooksFailed: number
    webhooksStuck: number
  }
  /** PayPal's webhook id itself is never returned: only whether deliveries are verified. */
  webhookConfigured: boolean
  attempts: LogAttemptRow[]
  webhooks: WebhookEventRow[]
}
