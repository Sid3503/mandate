/**
 * Every tool in PayPal's Agent Toolkit, put in a tier. The toolkit is built for a model to call directly. Mandate's
 * position is that no model should, so this is the written-down reason for each one:
 *
 *  - read:         cannot change anything at PayPal.
 *  - propose:      changes state or moves money. An agent may only ASK Mandate for it; the rules and the owner decide.
 *  - out_of_scope: unrelated to a company that bills clients and pays contractors. Never used.
 *
 * `usedByMandate` marks the few the server itself calls, with values it took from a locked cart or from PayPal. A test
 * fails when the toolkit gains a tool that is not listed here, and the toolkit runner refuses any tool not marked used.
 */
export type ToolTier = 'read' | 'propose' | 'out_of_scope'

export type ToolPolicy = { tier: ToolTier; usedByMandate: boolean; area: string; note: string }

const t = (area: string, tier: ToolTier, note: string, usedByMandate = false): ToolPolicy => ({ area, tier, usedByMandate, note })

export const TOOL_TIERS: Record<string, ToolPolicy> = {
  // Invoicing: money in
  create_invoice: t('Invoicing', 'propose', 'Bills a client. Mandate drafts it from a locked charge.', true),
  send_invoice: t('Invoicing', 'propose', 'Sends the bill. Mandate sends only what it drafted from the lock.', true),
  get_invoice: t('Invoicing', 'read', 'Mandate re-reads an invoice and settles only on what PayPal says.', true),
  list_invoices: t('Invoicing', 'read', 'Mandate finds its own invoice by number after a retry.', true),
  send_invoice_reminder: t('Invoicing', 'propose', 'Nudges a client. Owner only, through Mandate.', true),
  cancel_sent_invoice: t('Invoicing', 'propose', 'Voids an unpaid invoice. Owner only, through Mandate.', true),
  delete_invoice: t('Invoicing', 'propose', 'Removes a draft.'),
  search_invoicing: t('Invoicing', 'read', 'Searches invoices.'),
  update_invoicing: t('Invoicing', 'propose', 'Edits an invoice after it was locked, which Mandate forbids.'),
  generate_invoice_number: t('Invoicing', 'read', 'Mandate derives its own number from the proposal id.'),
  generate_invoice_qr_code: t('Invoicing', 'read', 'A QR code for an invoice.'),
  record_payment_for_invoice: t('Invoicing', 'propose', 'Marks an invoice paid without PayPal moving money. Mandate settles only when PayPal reports a real transaction.'),
  record_refund_for_invoice: t('Invoicing', 'propose', 'Records a refund outside the gate.'),
  create_conditional_rules_for_invoice: t('Invoicing', 'propose', 'Changes how an invoice behaves.'),
  setup_invoice_auto_reminders: t('Invoicing', 'propose', 'Schedules reminders.'),
  update_invoice_auto_reminder: t('Invoicing', 'propose', 'Edits reminders.'),
  cancel_invoice_auto_reminder: t('Invoicing', 'propose', 'Cancels reminders.'),
  create_recurring_series: t('Invoicing', 'propose', 'Bills a client repeatedly.'),
  activate_recurring_series: t('Invoicing', 'propose', 'Starts repeated billing.'),
  get_recurring_series: t('Invoicing', 'read', 'Reads a recurring series.'),
  cancel_recurring_series: t('Invoicing', 'propose', 'Stops a recurring series.'),
  delete_recurring_series: t('Invoicing', 'propose', 'Deletes a recurring series.'),
  // Orders and refunds
  create_order: t('Orders', 'propose', 'Opens a checkout. Mandate opens its own from a locked charge through the REST API.'),
  pay_order: t('Orders', 'propose', 'Moves money. Only the server moves money, and only from a lock.'),
  get_order: t('Orders', 'read', 'Reads an order.'),
  create_refund: t('Payments', 'propose', 'Gives money back. Mandate refunds only through a gated refund proposal.'),
  get_refund: t('Payments', 'read', 'Reads a refund.'),
  // Disputes
  list_disputes: t('Disputes', 'read', 'Mandate watches for a client dispute before a payout leaves.', true),
  get_dispute: t('Disputes', 'read', 'Mandate reads which payment a dispute is on.', true),
  accept_dispute_claim: t('Disputes', 'propose', 'Concedes a dispute, which gives money away.'),
  // Reporting
  list_transactions: t('Reporting', 'read', 'Mandate compares the PayPal account with its ledger.', true),
  get_merchant_insights: t('Reporting', 'read', 'Read-only analytics.'),
  // Subscriptions
  create_subscription: t('Subscriptions', 'propose', 'Starts recurring charges.'),
  cancel_subscription: t('Subscriptions', 'propose', 'Stops a subscription.'),
  update_subscription: t('Subscriptions', 'propose', 'Changes a subscription.'),
  update_plan: t('Subscriptions', 'propose', 'Changes a plan.'),
  show_subscription_details: t('Subscriptions', 'read', 'Reads a subscription.'),
  create_subscription_plan: t('Subscriptions', 'out_of_scope', 'Not part of billing a job.'),
  list_subscription_plans: t('Subscriptions', 'read', 'Lists plans.'),
  show_subscription_plan_details: t('Subscriptions', 'read', 'Reads a plan.'),
  // Catalogue and shipping
  create_product: t('Catalogue', 'out_of_scope', 'Mandate bills services, not products.'),
  update_product: t('Catalogue', 'out_of_scope', 'Mandate bills services, not products.'),
  list_products: t('Catalogue', 'read', 'Lists products.'),
  show_product_details: t('Catalogue', 'read', 'Reads a product.'),
  create_shipment_tracking: t('Shipping', 'out_of_scope', 'Mandate does not ship goods.'),
  update_shipment_tracking: t('Shipping', 'out_of_scope', 'Mandate does not ship goods.'),
  get_shipment_tracking: t('Shipping', 'read', 'Reads a tracker.'),
}

export const USED_BY_MANDATE = Object.entries(TOOL_TIERS).filter(([, policy]) => policy.usedByMandate).map(([name]) => name)

/** A summary for the System screen: what an agent can reach in PayPal, which is nothing directly. */
export function toolSummary() {
  const entries = Object.entries(TOOL_TIERS).map(([name, policy]) => ({ name, ...policy }))
  return {
    total: entries.length,
    read: entries.filter((item) => item.tier === 'read').length,
    propose: entries.filter((item) => item.tier === 'propose').length,
    outOfScope: entries.filter((item) => item.tier === 'out_of_scope').length,
    usedByMandate: entries.filter((item) => item.usedByMandate).length,
    agentCanCallDirectly: 0,
    tools: entries,
  }
}
