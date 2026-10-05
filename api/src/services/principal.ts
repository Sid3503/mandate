import type { Side } from '../domain/deal'

export type Role = 'owner' | 'proposer'

/**
 * Who is calling. The owner may do everything. A proposer may only ask and read, and is bound to one side of a
 * deal: the studio's own staff and agents are the `seller`; a client's agent is a `buyer` bound to one client.
 * The binding is what keeps each company's limits private: a key cannot claim the other side.
 */
export type Principal =
  | { role: 'owner'; side: null; buyerId: null }
  | { role: 'proposer'; side: 'seller'; buyerId: null }
  | { role: 'proposer'; side: 'buyer'; buyerId: string }

export const OWNER: Principal = { role: 'owner', side: null, buyerId: null }
export const STUDIO: Principal = { role: 'proposer', side: 'seller', buyerId: null }
export const buyerPrincipal = (buyerId: string): Principal => ({ role: 'proposer', side: 'buyer', buyerId })

export type { Side }
