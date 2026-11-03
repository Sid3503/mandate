import { ApiError, apiRequest, apiSignStep } from './api'

export type DisputeListItem = {
  id: string
  transactionId: string
  status: string
  reason: string | null
  amountCents: number | null
  currency: string | null
  openedAt: string | null
  updatedAt: string
  respondBy: string | null
  dueInMs: number | null
  urgent: boolean
  response: 'none' | 'drafted' | 'sent'
  inRecords: boolean
}

export type ChecklistItem = { id: string; label: string; present: boolean; detail: string }

export type DisputeRequest = { method: 'POST'; path: string; body: Record<string, unknown>; requestId: string }

export type DisputeDetail = {
  dispute: { id: string; status: string; stage: string | null; reason: string | null; amountCents: number | null; currency: string | null; transactionId: string; openedAt: string | null; respondBy: string | null; dueInMs: number | null; urgent: boolean; messages: Array<{ postedBy: string; at: string | null; content: string }>; linkRels: string[] }
  live: { read: boolean; error: string | null }
  packet: {
    proposalId: string | null
    checklist: ChecklistItem[]
    strength: { present: number; total: number }
    links: { receipt: string | null; verify: string | null }
    payment: { captureId: string | null; capturedCents: number | null; feeCents: number | null; currency: string; proofUrl: string | null } | null
  }
  draft: { kind: 'draft' | 'edit'; text: string; source: 'model' | 'template' | 'owner'; at: string } | null
  history: Array<{ seq: number; kind: string; source: string | null; actor: string; at: string }>
  sent: { at: string; request: DisputeRequest; text: string; approvedBy: string; approvedVia: string; approvedAt: string } | null
  verified: string
}

/** The same digest the server derives: sha256 of the text, joined to the dispute id. */
async function sendPayload(id: string, text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return `${id}\n${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export const disputesApi = {
  list: () => apiRequest<{ data: DisputeListItem[] }>('/v1/disputes'),
  get: (id: string) => apiRequest<DisputeDetail>(`/v1/disputes/${encodeURIComponent(id)}`),
  draft: (id: string) => apiRequest<{ text: string }>(`/v1/disputes/${encodeURIComponent(id)}/draft`, { method: 'POST' }),
  save: (id: string, text: string) => apiRequest<{ text: string }>(`/v1/disputes/${encodeURIComponent(id)}/draft`, { method: 'PUT', body: { text } }),
  /** Sends with the owner's passkey: tries once, and when the server asks for a signature, signs this dispute and this exact text. */
  send: async (id: string, text: string) => {
    const path = `/v1/disputes/${encodeURIComponent(id)}/send`
    try {
      return await apiRequest<{ replayed: boolean; sent: NonNullable<DisputeDetail['sent']> }>(path, { method: 'POST', body: { text } })
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'auth/stepup-required') throw error
      return apiSignStep('dispute.send', await sendPayload(id, text), { id, text }, (grant) => apiRequest<{ replayed: boolean; sent: NonNullable<DisputeDetail['sent']> }>(path, { method: 'POST', headers: { 'x-mandate-stepup': grant }, body: { text } }))
    }
  },
}

/** "2d 4h", "5h 10m", "under a minute", or "overdue by 3h". */
export function dueWords(ms: number | null): string {
  if (ms === null) return 'due date not read yet'
  const late = ms < 0
  const minutes = Math.floor(Math.abs(ms) / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const text = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : minutes > 0 ? `${minutes}m` : 'under a minute'
  return late ? `overdue by ${text}` : `response due in ${text}`
}
