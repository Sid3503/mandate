/** Account ids, in the words the books screen uses. */
export function accountWords(account: string): string {
  if (account === 'paypal:balance') return 'PayPal balance'
  if (account === 'income:client_payments') return 'Client payments'
  if (account === 'income:refunds') return 'Refunds'
  if (account === 'income:reversals') return 'Reversals'
  if (account === 'expense:paypal_fees') return 'PayPal fees'
  if (account.startsWith('expense:payouts:')) return `Paid to ${account.slice('expense:payouts:'.length)}`
  return account
}

/** Journal purposes, in the same words. */
export function purposeWords(purpose: string): string {
  const words: Record<string, string> = {
    receipt: 'Client payment',
    capture_fee: 'PayPal fee',
    reversal: 'Reversal',
    payout: 'Contractor payout',
    payout_fee: 'Payout fee',
    refund: 'Refund',
  }
  return words[purpose] ?? purpose
}
