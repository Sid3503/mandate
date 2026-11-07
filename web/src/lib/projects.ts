import { request, scopedUrl, upload } from './api'
import type { PayMethod, PaySession } from './types'

/** Two-sided projects: the studio's side and the client's page. Shapes mirror api/src/services/projects.ts. */

export type CheckItem = { label: string; status: 'met' | 'partial' | 'missing' | 'note'; note: string; source: 'rules' | 'ai' }
export type DeliveryCheck = { items: CheckItem[]; met: number; flagged: number; summary: string; checkedAt: string; ai: 'used' | 'skipped' | 'failed'; aiNote: string | null }
export type PlanFlag = { level: 'amber' | 'red'; text: string }
export type StageStatus = 'open' | 'delivered' | 'held' | 'changes' | 'released' | 'cancelled' | 'removed'
export type StageTerms = { id: string; title: string; deliverables: string[]; amountCents: number; dueDate: string }
export type StageDiff = { id: string; title: string; isNew: boolean; was: { title: string; amountCents: number; dueDate: string; deliverables: string[] } | null }
export type PlanDiff = { stages: StageDiff[]; removed: Array<{ title: string; amountCents: number }> }
export type FileView = { id: string; name: string; mime: string; size: number; sha256: string; kind: 'image' | 'file'; width: number | null; height: number | null; round?: number; uploadedAt?: string }

export type DraftedPlan = {
  title: string; summary: string; clientName: string | null; clientEmail: string | null
  stages: Array<{ title: string; description: string; deliverables: string[]; amountCents: number; dueDate: string }>
  questions: string[]; flags: PlanFlag[]; source: 'model' | 'rules'; model: string | null; note: string | null
  categories: string[]; currency: string
}

export type ImportedBrief = { text: string; source: string; pages: number | null; readBy: 'code' | 'model'; model: string | null }

export type StudioStage = {
  id: string; position: number; title: string; description: string; deliverables: string[]; amountCents: number; dueDate: string; status: StageStatus
  milestone: number | null; round: number; reviewEndsAt: string | null; reviseBy: string | null; releasedBy: string | null; workingRound: number
  files: FileView[]
  delivery: { id: string; round: number; manifestHash: string; sentAt: string; check: DeliveryCheck | null; files: Array<{ name: string; sha256: string; size: number; mime: string }> } | null
  rounds: number
  charge: { id: string; phase: string; gate: string; clause: string; detail: string; cartHash: string | null; lockValid: boolean | null; captureId: string | null; capturedCents: number | null; feeCents: number | null; netCents: number | null; orderId: string | null } | null
  hold: { authorizationId: string; status: string; authorizedAt: string; honorUntil: string | null; expiresAt: string | null; payerEmail: string | null; reauthorizedAt: string | null; releasedBy: string | null; releasedAt: string | null; voidReason: string | null } | null
  release: { decidedBy: 'client' | 'review_window'; at: string; manifestHash: string; signatureValid: boolean } | null
  payouts: Array<{ id: string; payeeId: string | null; amountCents: number; phase: string; clause: string }>
  views: { opens: number; closeups: number; last: { file: string; at: string } | null; downloads: number }
  reminders: { count: number; lastAt: string | null }
  request: { note: string; at: string } | null
}

export type StudioProject = {
  id: string; jobId: string; title: string; summary: string; status: 'draft' | 'sent' | 'changes' | 'agreed' | 'done' | 'cancelled'; currency: string; category: string; reviewDays: number; reviseDays: number
  client: { id: string; name: string; email: string | null }
  brief: string; briefSource: string | null; questions: string[]; dealId: string | null
  plan: { version: number; status: 'sent' | 'agreed' | 'changes' | 'superseded'; sentAt: string; decidedAt: string | null; clientNote: string | null; termsHash: string; studioSignatureValid: boolean; clientSignatureValid: boolean | null; diff: PlanDiff | null; unsentChanges: boolean } | null
  link: { url: string | null; createdAt: string; lastSeenAt: string | null; views: number } | null
  money: { totalCents: number; releasedCents: number; heldCents: number; stillCents: number; percent: number }
  stages: StudioStage[]
  requests: Array<{ id: string; stageId: string | null; kind: 'stage_changes' | 'plan_changes'; note: string; at: string; resolvedAt: string | null }>
  activity: Array<{ stageId: string | null; kind: string; text: string; at: string }>
  review: { stars: number; text: string; at: string } | null
  createdAt: string; updatedAt: string
}

export type ProjectsSummary = {
  currency: string; owedCents: number; overdueCents: number; heldCents: number; bankedCents: number; monthCents: number; projectsWithMoney: number
  mostOverdue: { projectId: string; client: string; cents: number } | null
  projects: Array<{ id: string; title: string; client: string; status: StudioProject['status']; currency: string; totalCents: number; owedCents: number; overdueCents: number; heldCents: number; bankedCents: number; stages: Array<{ id: string; title: string; status: StageStatus; overdue: boolean }>; updatedAt: string }>
  activity: Array<{ projectId: string; stageId: string | null; kind: string; text: string; at: string }>
}

export type PortalStage = {
  id: string; title: string; description: string; deliverables: string[]; amountCents: number; dueDate: string; status: StageStatus; round: number; reviewEndsAt: string | null; reviseBy: string | null
  files: FileView[]; check: DeliveryCheck | null; manifestHash: string | null; awaitingStudio: boolean
  canPay: boolean; canApprove: boolean; canRequestChanges: boolean; canCancel: boolean; canDownload: boolean
  request: { note: string; at: string } | null
  hold: { status: string; authorizedAt: string; honorUntil: string | null } | null
  receipt: { paidCents: number; heldAt: string | null; approvedAt: string | null; approvedBy: 'client' | 'review_window' | null; paidWith: string | null; paypalCaptureId: string | null; paypalAuthorizationId: string | null; manifestHash: string | null } | null
}

export type PortalView = {
  project: { id: string; title: string; summary: string; client: string; currency: string; reviewDays: number; reviseDays: number; status: StudioProject['status'] }
  studio: { name: string; handle: string | null; headline: string; rating: number | null; reviewCount: number }
  plan: { version: number; status: 'sent' | 'agreed' | 'changes' | 'superseded'; sentAt: string; termsHash: string; totalCents: number; stages: StageTerms[]; diff: PlanDiff | null; note: string | null } | null
  money: { totalCents: number; releasedCents: number; heldCents: number; stillCents: number; approved: number; stages: number }
  stages: PortalStage[]
  review: { stars: number; text: string; at: string } | null
  canReview: boolean
  paypal: { environment: 'sandbox' | 'live' }
}

export type PublicProfile = {
  handle: string; displayName: string; headline: string; bio: string; website: string | null; email: string | null; since: string
  rating: number | null; reviewCount: number
  track: { projectsCompleted: number; stagesPaid: number; clients: number; onTimePercent: number | null }
  reviews: Array<{ id: string; stars: number; text: string; client: string; project: string; at: string; verified: boolean; captures: number }>
}

export type StageInput = { id?: string; title: string; description: string; deliverables: string[]; amountCents: number; dueDate: string }
export type ProjectCreate = { title: string; summary: string; clientName: string; clientEmail: string; currency: string; category: string; reviewDays: number; reviseDays: number; stages: StageInput[]; brief: string; briefSource: string | null; questions: string[] }

const enc = encodeURIComponent

export const projectsApi = {
  summary: () => request<ProjectsSummary>('/v1/projects'),
  draft: (brief: string, rate: string | null) => request<DraftedPlan>('/v1/projects/draft', { method: 'POST', body: { brief, rate } }),
  importBrief: (file: File) => upload<ImportedBrief>('/v1/projects/brief-import', file),
  create: (body: ProjectCreate) => request<StudioProject>('/v1/projects', { method: 'POST', body }),
  get: (id: string) => request<StudioProject>(`/v1/projects/${enc(id)}`),
  editPlan: (id: string, body: { stages: StageInput[]; title?: string; summary?: string; reviewDays?: number; reviseDays?: number }) => request<StudioProject>(`/v1/projects/${enc(id)}/plan`, { method: 'PUT', body }),
  send: (id: string) => request<StudioProject & { resent: boolean }>(`/v1/projects/${enc(id)}/send`, { method: 'POST', body: {} }),
  rotateLink: (id: string) => request<StudioProject>(`/v1/projects/${enc(id)}/link/rotate`, { method: 'POST', body: {} }),
  uploadFile: (id: string, stageId: string, file: File) => upload<StudioProject>(`/v1/projects/${enc(id)}/stages/${enc(stageId)}/files`, file),
  removeFile: (id: string, fileId: string) => request<StudioProject>(`/v1/projects/${enc(id)}/files/${enc(fileId)}`, { method: 'DELETE' }),
  fileUrl: (id: string, fileId: string) => scopedUrl(`/v1/projects/${enc(id)}/files/${enc(fileId)}`),
  check: (id: string, stageId: string) => request<DeliveryCheck>(`/v1/projects/${enc(id)}/stages/${enc(stageId)}/check`, { method: 'POST', body: {} }),
  sendStage: (id: string, stageId: string) => request<StudioProject>(`/v1/projects/${enc(id)}/stages/${enc(stageId)}/send`, { method: 'POST', body: {} }),
  remind: (id: string, stageId: string) => request<{ text: string; tone: 'friendly' | 'firm' | 'final'; source: 'model' | 'rules'; n: number; mailto: string | null }>(`/v1/projects/${enc(id)}/stages/${enc(stageId)}/remind`, { method: 'POST', body: {} }),
  releaseHold: (id: string, stageId: string) => request<StudioProject>(`/v1/projects/${enc(id)}/stages/${enc(stageId)}/release-hold`, { method: 'POST', body: {} }),
  profile: () => request<{ profile: { handle: string; display_name: string; headline: string; bio: string; website: string | null; email: string | null } | null }>('/v1/profile'),
  saveProfile: (body: { handle: string; displayName: string; headline: string; bio: string; website: string | null; email: string | null }) => request<PublicProfile>('/v1/profile', { method: 'PUT', body }),
  publicProfile: (handle: string) => request<PublicProfile>(`/v1/profiles/${enc(handle)}`, { key: '' }),
}

/**
 * The link token, as it may appear in a path: an id, a tilde, a base64url secret, and nothing else. Anything else in the
 * address bar becomes a token that matches no link, so it can never shape a URL the page builds.
 */
function tok(token: string): string {
  return /^[A-Za-z0-9_-]{1,40}~[A-Za-z0-9_-]{1,80}$/.test(token) ? encodeURIComponent(token) : 'invalid~invalid'
}

/** The client's page. The link in the address bar is the only key, so no stored key is ever sent with these. */
export const portalApi = {
  view: (token: string) => request<PortalView>(`/v1/portal/${tok(token)}`, { key: '' }),
  agree: (token: string, version: number) => request<PortalView>(`/v1/portal/${tok(token)}/plan/agree`, { method: 'POST', body: { version }, key: '' }),
  askPlanChanges: (token: string, note: string) => request<PortalView>(`/v1/portal/${tok(token)}/plan/changes`, { method: 'POST', body: { note }, key: '' }),
  paySession: (token: string, stageId: string, instrument: PayMethod) => request<PaySession>(`/v1/portal/${tok(token)}/stages/${enc(stageId)}/pay/session`, { method: 'POST', body: { instrument }, key: '' }),
  payConfirm: (token: string, stageId: string) => request<PortalView>(`/v1/portal/${tok(token)}/stages/${enc(stageId)}/pay/confirm`, { method: 'POST', body: {}, key: '' }),
  approve: (token: string, stageId: string) => request<PortalView>(`/v1/portal/${tok(token)}/stages/${enc(stageId)}/approve`, { method: 'POST', body: {}, key: '' }),
  changes: (token: string, stageId: string, note: string) => request<PortalView>(`/v1/portal/${tok(token)}/stages/${enc(stageId)}/changes`, { method: 'POST', body: { note }, key: '' }),
  cancel: (token: string, stageId: string) => request<PortalView>(`/v1/portal/${tok(token)}/stages/${enc(stageId)}/cancel`, { method: 'POST', body: {}, key: '' }),
  openFile: (token: string, fileId: string) => request<{ session: string; expiresAt: string; closeupsLeft: number; width: number | null; height: number | null; name: string }>(`/v1/portal/${tok(token)}/files/${enc(fileId)}/session`, { method: 'POST', body: {}, key: '' }),
  review: (token: string, stars: number, text: string) => request<PortalView>(`/v1/portal/${tok(token)}/review`, { method: 'POST', body: { stars, text }, key: '' }),
  thumbUrl: (token: string, fileId: string) => scopedUrl(`/v1/portal/${tok(token)}/files/${enc(fileId)}/thumb`),
  reviewUrl: (token: string, code: string) => scopedUrl(`/v1/portal/${tok(token)}/review/${enc(code)}`),
  closeupUrl: (token: string, code: string, x: number, y: number) => scopedUrl(`/v1/portal/${tok(token)}/review/${enc(code)}/closeup?x=${x.toFixed(4)}&y=${y.toFixed(4)}`),
  downloadUrl: (token: string, fileId: string) => scopedUrl(`/v1/portal/${tok(token)}/files/${enc(fileId)}/download`),
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`
  return `${Math.round(size / 104857.6) / 10} MB`
}

export function when(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—'
  const date = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso)
  return date.toLocaleString('en-US', withTime ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' })
}

export function addDaysIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

export function daysFromToday(date: string): number {
  return Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`)) / 86_400_000)
}

/** A stage's status in the studio's words. */
export const STAGE_WORDS: Record<StageStatus, { label: string; tone: 'deny' | 'auto' | 'need' | 'ink' | 'muted' }> = {
  open: { label: 'Not delivered', tone: 'muted' },
  delivered: { label: 'Delivered · awaiting payment', tone: 'need' },
  held: { label: 'Held by PayPal · in review', tone: 'ink' },
  changes: { label: 'Changes asked · money held', tone: 'need' },
  released: { label: 'Paid', tone: 'auto' },
  cancelled: { label: 'Cancelled · not charged', tone: 'muted' },
  removed: { label: 'Removed', tone: 'muted' },
}

/** The check's tally in words, naming only what is there: "1 incomplete", "3 delivered · 1 not delivered". */
export function checkTally(check: DeliveryCheck): string {
  const count = (status: CheckItem['status']) => check.items.filter((item) => item.status === status).length
  const parts = [[count('met'), 'delivered'], [count('missing'), 'not delivered'], [count('partial'), 'incomplete']] as const
  const said = parts.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`)
  return said.length > 0 ? said.join(' · ') : `${check.items.length} note${check.items.length === 1 ? '' : 's'}`
}
