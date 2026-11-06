import { createHash } from 'node:crypto'
import { z } from 'zod'
import { stableHash } from './hash'

/**
 * Two-sided projects, as pure functions. Nothing here touches the database, PayPal or a model.
 *
 * A project is a plan the studio signs and the client approves: stages, what each delivers, its price and its date,
 * plus the two windows both sides live by (how long the client has to review a stage that is paid into a hold, and how
 * long the studio has to send a revision the client asked for). The plan's hash is what both signatures cover. A
 * stage's delivery is a manifest of SHA-256 file fingerprints; the manifest's hash is the proof on the stage's bill, so
 * the signed lock names the exact bytes that were delivered.
 */

export const DATE = /^\d{4}-\d{2}-\d{2}$/

export const StageInputSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  deliverables: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
  amountCents: z.number().int().positive().max(100_000_000),
  dueDate: z.string().regex(DATE),
}).strict()
export type StageInput = z.infer<typeof StageInputSchema>

export const ProjectInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().max(600).default(''),
  clientName: z.string().trim().min(1).max(120),
  clientEmail: z.email().max(200),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).default('USD'),
  category: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  reviewDays: z.number().int().min(1).max(14).default(3),
  reviseDays: z.number().int().min(1).max(14).default(3),
  stages: z.array(StageInputSchema).min(1).max(12),
  brief: z.string().max(20_000).default(''),
  briefSource: z.string().trim().max(200).nullable().default(null),
  questions: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
}).strict()
export type ProjectInput = z.infer<typeof ProjectInputSchema>

/** What both sides sign. Key order is fixed by stableHash, so the same plan always hashes the same. */
export type PlanTerms = {
  projectId: string
  title: string
  summary: string
  clientId: string
  clientName: string
  currency: string
  category: string
  reviewDays: number
  reviseDays: number
  totalCents: number
  stages: Array<{ id: string; title: string; deliverables: string[]; amountCents: number; dueDate: string }>
}

export function planTerms(input: Omit<PlanTerms, 'totalCents'>): PlanTerms {
  return { ...input, totalCents: input.stages.reduce((sum, stage) => sum + stage.amountCents, 0) }
}

export const termsHash = (terms: PlanTerms): string => stableHash(terms)

export type StageDiff = { id: string; title: string; isNew: boolean; was: { title: string; amountCents: number; dueDate: string; deliverables: string[] } | null }

/** What changed between the plan the client last saw and this one, per stage. */
export function planDiff(before: PlanTerms | null, after: PlanTerms): { stages: StageDiff[]; removed: Array<{ title: string; amountCents: number }> } {
  if (!before) return { stages: after.stages.map((stage) => ({ id: stage.id, title: stage.title, isNew: false, was: null })), removed: [] }
  const old = new Map(before.stages.map((stage) => [stage.id, stage]))
  const stages = after.stages.map((stage) => {
    const was = old.get(stage.id)
    if (!was) return { id: stage.id, title: stage.title, isNew: true, was: null }
    const same = was.title === stage.title && was.amountCents === stage.amountCents && was.dueDate === stage.dueDate && JSON.stringify(was.deliverables) === JSON.stringify(stage.deliverables)
    return { id: stage.id, title: stage.title, isNew: false, was: same ? null : { title: was.title, amountCents: was.amountCents, dueDate: was.dueDate, deliverables: was.deliverables } }
  })
  const kept = new Set(after.stages.map((stage) => stage.id))
  return { stages, removed: before.stages.filter((stage) => !kept.has(stage.id)).map((stage) => ({ title: stage.title, amountCents: stage.amountCents })) }
}

// ---------- manifests ----------

export type ManifestFile = { name: string; sha256: string; size: number; mime: string }
export type Manifest = { v: 1; projectId: string; stageId: string; round: number; files: ManifestFile[] }

/** The files of one delivery, in a fixed order, so the same files always give the same hash. */
export function manifestFor(projectId: string, stageId: string, round: number, files: ManifestFile[]): Manifest {
  const sorted = [...files].map((file) => ({ name: file.name, sha256: file.sha256, size: file.size, mime: file.mime }))
    .sort((a, b) => (a.sha256 === b.sha256 ? a.name.localeCompare(b.name) : a.sha256.localeCompare(b.sha256)))
  return { v: 1, projectId, stageId, round, files: sorted }
}

export const manifestHash = (manifest: Manifest): string => stableHash(manifest)

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

// ---------- what a file is ----------

export type Sniffed = { mime: string; kind: 'image' | 'file'; ext: string }

/**
 * What a file really is, from its first bytes, never from its name or the browser's word. Only PNG, JPEG, WebP and GIF
 * are shown as review copies. An SVG can carry script, so it is a sealed file like any other, never drawn in a page.
 */
export function sniff(bytes: Uint8Array, name: string): Sniffed | null {
  const b = (i: number) => bytes[i] ?? -1
  const ascii = (start: number, text: string) => [...text].every((char, index) => b(start + index) === char.charCodeAt(0))
  if (b(0) === 0x89 && ascii(1, 'PNG')) return { mime: 'image/png', kind: 'image', ext: 'png' }
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return { mime: 'image/jpeg', kind: 'image', ext: 'jpg' }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { mime: 'image/webp', kind: 'image', ext: 'webp' }
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { mime: 'image/gif', kind: 'image', ext: 'gif' }
  if (ascii(0, '%PDF-')) return { mime: 'application/pdf', kind: 'file', ext: 'pdf' }
  if (b(0) === 0x50 && b(1) === 0x4b && b(2) === 0x03 && b(3) === 0x04) {
    const lower = name.toLowerCase()
    if (lower.endsWith('.docx')) return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'file', ext: 'docx' }
    if (lower.endsWith('.fig')) return { mime: 'application/octet-stream', kind: 'file', ext: 'fig' }
    return { mime: 'application/zip', kind: 'file', ext: 'zip' }
  }
  if (ascii(4, 'ftyp')) return { mime: 'video/mp4', kind: 'file', ext: 'mp4' }
  if (ascii(0, '8BPS')) return { mime: 'image/vnd.adobe.photoshop', kind: 'file', ext: 'psd' }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 512)).trimStart().toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return { mime: 'image/svg+xml', kind: 'file', ext: 'svg' }
  if (name.toLowerCase().endsWith('.ai') && ascii(0, '%PDF')) return { mime: 'application/postscript', kind: 'file', ext: 'ai' }
  // Plain text files (copy decks, captions) are accepted when every byte is printable text.
  if (bytes.length > 0 && bytes.subarray(0, 4096).every((value) => value === 9 || value === 10 || value === 13 || (value >= 32 && value !== 127))) return { mime: 'text/plain', kind: 'file', ext: 'txt' }
  return null
}

/** A file name a client can see and a browser can save: no path, no control characters. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').trim().slice(0, 120)
  return cleaned || 'file'
}

// ---------- the delivery check: facts the server can prove from the files ----------

export type CheckStatus = 'met' | 'partial' | 'missing' | 'note'
export type CheckItem = { label: string; status: CheckStatus; note: string; source: 'rules' | 'ai' }
export type DeliveryCheck = { items: CheckItem[]; met: number; flagged: number; summary: string; checkedAt: string; ai: 'used' | 'skipped' | 'failed'; aiNote: string | null }

export type FileFacts = { name: string; mime: string; size: number; sha256: string; width: number | null; height: number | null; kind: 'image' | 'file' }

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }
const VISUAL = /\b(concepts?|logos?|mock-?ups?|screens?|graphics?|posts?|banners?|images?|photos?|illustrations?|icons?|designs?|slides?|templates?|variations?|frames?|thumbnails?|flyers?|posters?|stickers?|labels?|options?|routes?|directions?|renders?)\b/i
const FORMATS: Array<{ label: string; test: RegExp; match: (file: FileFacts) => boolean }> = [
  { label: 'SVG', test: /\bsvg\b/i, match: (file) => file.mime === 'image/svg+xml' },
  { label: 'PDF', test: /\bpdf\b/i, match: (file) => file.mime === 'application/pdf' },
  { label: 'PNG', test: /\bpng\b/i, match: (file) => file.kind === 'image' },
  { label: 'JPG', test: /\bjpe?g\b/i, match: (file) => file.kind === 'image' },
  { label: 'MP4', test: /\b(mp4|video)\b/i, match: (file) => file.mime === 'video/mp4' },
  { label: 'PSD', test: /\bpsd\b/i, match: (file) => file.mime === 'image/vnd.adobe.photoshop' },
  { label: 'ZIP', test: /\bzip\b/i, match: (file) => file.mime === 'application/zip' },
]

/** How many of something a deliverable promises ("3 logo concepts", "six posts"), or null when it does not say. */
export function promisedCount(text: string): number | null {
  if (!VISUAL.test(text)) return null
  const match = /(?:^|\s)(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:[a-z-]+\s+){0,3}?(concepts?|logos?|mock-?ups?|screens?|graphics?|posts?|banners?|images?|photos?|illustrations?|icons?|designs?|slides?|templates?|variations?|frames?|thumbnails?|flyers?|posters?|stickers?|labels?|options?|routes?|directions?|renders?)\b/i.exec(text)
  if (!match) return null
  const raw = match[1]!.toLowerCase()
  const n = /\d/.test(raw) ? Number(raw) : WORDS[raw]
  return n && n >= 1 && n <= 30 ? n : null
}

const SIZE = /(\d{3,4})\s*[x×]\s*(\d{3,4})/

/**
 * Checks a delivery against what the plan promised, with facts read from the files: counts, formats, pixel sizes,
 * duplicates and empty files. It never judges taste, and it never says a stage is good: it says what is there.
 */
export function ruleCheck(deliverables: string[], files: FileFacts[]): CheckItem[] {
  const items: CheckItem[] = []
  if (files.length === 0) return [{ label: 'Files', status: 'missing', note: 'Nothing has been uploaded for this stage yet.', source: 'rules' }]
  const images = files.filter((file) => file.kind === 'image' || file.mime === 'image/svg+xml')
  for (const deliverable of deliverables) {
    const count = promisedCount(deliverable)
    if (count && count > 1) {
      items.push(images.length >= count
        ? { label: deliverable, status: 'met', note: `${count} expected, ${images.length} image${images.length === 1 ? '' : 's'} uploaded.`, source: 'rules' }
        : { label: deliverable, status: images.length === 0 ? 'missing' : 'partial', note: `${count} expected, ${images.length} image${images.length === 1 ? '' : 's'} uploaded.`, source: 'rules' })
    }
    for (const format of FORMATS) {
      if (!format.test.test(deliverable)) continue
      const found = files.filter(format.match)
      items.push(found.length > 0
        ? { label: deliverable, status: 'met', note: `${format.label} file${found.length === 1 ? '' : 's'} included (${found.map((file) => file.name).slice(0, 2).join(', ')}).`, source: 'rules' }
        : { label: deliverable, status: 'missing', note: `${format.label} promised, none uploaded.`, source: 'rules' })
    }
    const size = SIZE.exec(deliverable)
    if (size) {
      const [w, h] = [Number(size[1]), Number(size[2])]
      const sized = images.filter((image) => image.width && image.height)
      const small = sized.filter((image) => image.width! < w || image.height! < h)
      if (sized.length > 0) {
        items.push(small.length === 0
          ? { label: deliverable, status: 'met', note: `All ${sized.length} image${sized.length === 1 ? ' is' : 's are'} at least ${w}×${h}.`, source: 'rules' }
          : { label: deliverable, status: 'partial', note: `${small[0]!.name} is ${small[0]!.width}×${small[0]!.height}, smaller than ${w}×${h}.`, source: 'rules' })
      }
    }
  }
  const tiny = images.filter((image) => image.kind === 'image' && image.width && image.height && Math.max(image.width, image.height) < 800)
  if (tiny.length > 0) items.push({ label: 'Image resolution', status: 'partial', note: `${tiny[0]!.name} is ${tiny[0]!.width}×${tiny[0]!.height}. That is small for final artwork.`, source: 'rules' })
  const seen = new Map<string, string>()
  for (const file of files) {
    const before = seen.get(file.sha256)
    if (before) items.push({ label: 'Duplicates', status: 'partial', note: `${file.name} is the same file as ${before}.`, source: 'rules' })
    else seen.set(file.sha256, file.name)
  }
  const empty = files.filter((file) => file.size < 2048 && file.kind === 'image')
  if (empty.length > 0) items.push({ label: 'Empty files', status: 'partial', note: `${empty[0]!.name} is only ${empty[0]!.size} bytes.`, source: 'rules' })
  if (items.length === 0) items.push({ label: 'Files', status: 'note', note: `${files.length} file${files.length === 1 ? '' : 's'} uploaded. The plan names nothing the files can be counted or measured against.`, source: 'rules' })
  return items
}

/**
 * Joins the rules' facts and a model's look. The model may only add doubt: it can flag what the rules let through, but
 * it can never turn a rule's "missing" or "partial" into "met", and its lines are labelled as the model's.
 */
export function mergeCheck(rules: CheckItem[], ai: CheckItem[], at: string, aiState: DeliveryCheck['ai'], aiNote: string | null): DeliveryCheck {
  const flaggedByRules = new Set(rules.filter((item) => item.status === 'missing' || item.status === 'partial').map((item) => item.label))
  const extra = ai.filter((item) => (item.status === 'partial' || item.status === 'missing' || item.status === 'note') && !flaggedByRules.has(item.label))
  const items = [...rules, ...extra]
  const flagged = items.filter((item) => item.status === 'missing' || item.status === 'partial').length
  const met = items.filter((item) => item.status === 'met').length
  const summary = flagged === 0 ? 'Everything the plan promised that can be checked is here.' : `${flagged} thing${flagged === 1 ? '' : 's'} to look at: ${items.filter((item) => item.status === 'missing').length} not delivered, ${items.filter((item) => item.status === 'partial').length} incomplete.`
  return { items, met, flagged, summary, checkedAt: at, ai: aiState, aiNote }
}

// ---------- facts in a brief, read by code ----------

/** The budget a brief states, in whole cents, when it states one plainly. */
export function statedBudgetCents(brief: string): number | null {
  const near = /(budget|pay|spend|price|up to|around|about|max(?:imum)?)[^\n$€£₦₹\d]{0,30}(?:US\$|\$|€|£|₦|₹|usd\s*|eur\s*|gbp\s*)?\s?(\d{1,3}(?:[,\s]\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(k\b)?/i.exec(brief)
  const plain = near ?? /(?:US\$|\$|€|£|₦|₹)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(brief)
  if (!plain) return null
  const whole = (near ? near[2] : plain[1])!.replace(/[,\s]/g, '')
  const fraction = near ? near[3] : plain[2]
  let cents = Number(whole) * 100 + (fraction ? Number(fraction.padEnd(2, '0')) : 0)
  if (near?.[4]) cents *= 1000
  return Number.isFinite(cents) && cents > 0 ? cents : null
}

/** The time a brief allows, in days from today, when it says so plainly ("in 3 weeks", "within 10 days"). */
export function statedDeadlineDays(brief: string): number | null {
  const match = /(?:in|within|over|next|by)\s+(?:the\s+next\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month)s?/i.exec(brief)
  if (!match) return null
  const raw = match[1]!.toLowerCase()
  const n = /\d/.test(raw) ? Number(raw) : WORDS[raw]
  if (!n) return null
  const unit = match[2]!.toLowerCase()
  return unit === 'day' ? n : unit === 'week' ? n * 7 : n * 30
}

/** Every number written in the brief, so a count in the plan that the client never wrote can be pointed out. */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>()
  const lower = text.toLowerCase()
  for (const match of lower.matchAll(/\b(\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g)) {
    const raw = match[1]!
    const before = lower.slice(Math.max(0, match.index! - 2), match.index!)
    const after = lower.slice(match.index! + raw.length, match.index! + raw.length + 8)
    // A duration ("3 weeks") or a sum of money ("$1,400") is not a count of things to deliver.
    if (/^\s*(day|week|month|year|hour|min)/.test(after) || /[$€£₦₹,.]\s*$/.test(before) || /^[,.]\d/.test(after) || /^\s*(k\b|usd|eur|gbp|dollars?)/.test(after)) continue
    const n = /\d/.test(raw) ? Number(raw) : WORDS[raw]
    if (n) out.add(n)
  }
  return out
}

export type PlanFlag = { level: 'amber' | 'red'; text: string }

/**
 * What code says about a drafted plan before anyone sends it: over the stated budget, past the stated deadline, a count
 * the brief never asked for, dates out of order. The model drafts; code reads it back against the client's own words.
 */
export function planFlags(brief: string, stages: Array<{ title: string; deliverables: string[]; amountCents: number; dueDate: string }>, todayIso: string): PlanFlag[] {
  const flags: PlanFlag[] = []
  const total = stages.reduce((sum, stage) => sum + stage.amountCents, 0)
  const budget = statedBudgetCents(brief)
  if (budget && total > budget) flags.push({ level: 'red', text: `The plan totals ${(total / 100).toFixed(2)}, which is ${((total - budget) / 100).toFixed(2)} over the ${(budget / 100).toFixed(2)} budget the brief states.` })
  const deadline = statedDeadlineDays(brief)
  const last = stages.map((stage) => stage.dueDate).sort().at(-1)
  if (deadline && last) {
    const limit = new Date(Date.parse(`${todayIso.slice(0, 10)}T00:00:00Z`) + deadline * 86_400_000).toISOString().slice(0, 10)
    if (last > limit) flags.push({ level: 'red', text: `The last stage is due ${last}, after the ${deadline}-day deadline in the brief (${limit}).` })
  }
  for (let index = 1; index < stages.length; index += 1) {
    if (stages[index]!.dueDate < stages[index - 1]!.dueDate) flags.push({ level: 'amber', text: `${stages[index]!.title} is due before the stage that comes ahead of it.` })
  }
  if (stages.some((stage) => stage.dueDate < todayIso.slice(0, 10))) flags.push({ level: 'red', text: 'A stage is due in the past.' })
  const said = numbersIn(brief)
  for (const stage of stages) {
    for (const deliverable of stage.deliverables) {
      const count = promisedCount(deliverable)
      if (count && count > 1 && !said.has(count)) flags.push({ level: 'amber', text: `"${deliverable}" is a count the brief does not state. Check it is what you want to promise.` })
    }
  }
  return flags
}

// ---------- the money a freelancer is owed ----------

export type StageMoney = { amountCents: number; status: string; dueDate: string; chargePhase: string | null; capturedCents: number; capturedAt: string | null }

/** Owed is every stage of an approved plan not yet released; overdue is the part past its date; held is what PayPal reserved. */
export function owedSummary(stages: StageMoney[], todayIso: string, monthStartIso: string) {
  let owedCents = 0
  let overdueCents = 0
  let heldCents = 0
  let bankedCents = 0
  let monthCents = 0
  for (const stage of stages) {
    if (stage.status === 'cancelled' || stage.status === 'removed') continue
    if (stage.status === 'released') {
      bankedCents += stage.capturedCents
      if (stage.capturedAt && stage.capturedAt >= monthStartIso) monthCents += stage.capturedCents
      continue
    }
    owedCents += stage.amountCents
    if (stage.status === 'held' || stage.status === 'changes') heldCents += stage.amountCents
    else if (stage.dueDate < todayIso.slice(0, 10)) overdueCents += stage.amountCents
  }
  return { owedCents, overdueCents, heldCents, bankedCents, monthCents }
}

/** The tone a reminder takes: each one sent makes the next one firmer. */
export function reminderTone(sent: number): 'friendly' | 'firm' | 'final' {
  return sent === 0 ? 'friendly' : sent === 1 ? 'firm' : 'final'
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString()
}
