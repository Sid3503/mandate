import { inflateRawSync } from 'node:zlib'
import { Problem } from '../http/problem'
import type { AgentModel } from '../agents/model'
import { readImageBrief } from '../agents/projectAgents'

/**
 * A client's brief as it arrived: pasted text, a PDF, a Word file, a plain text file or a screenshot. Text is read by
 * code. A screenshot is read by a model that can see, when there is one, and the freelancer is asked to check it.
 */

const MAX_BYTES = 10 * 1024 * 1024

export type ImportedBrief = { text: string; source: string; pages: number | null; readBy: 'code' | 'model'; model: string | null }

export async function importBrief(file: { name: string; bytes: Uint8Array }, models: Array<AgentModel | null | undefined>): Promise<ImportedBrief> {
  if (file.bytes.length === 0) throw new Problem(422, 'brief.empty', 'The file is empty', 'Attach the brief again.')
  if (file.bytes.length > MAX_BYTES) throw new Problem(413, 'brief.too_large', 'The file is too large', 'A brief can be up to 10 MB.')
  const name = file.name.split(/[\\/]/).pop()!.slice(0, 120)
  const head = file.bytes.subarray(0, 8)
  const ascii = String.fromCharCode(...head)
  if (ascii.startsWith('%PDF-')) {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(file.bytes))
    const { totalPages, text } = await extractText(pdf, { mergePages: true })
    const clean = String(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (clean.length < 10) throw new Problem(422, 'brief.unreadable', 'No text in that PDF', 'It may be a scan. Attach a screenshot of it instead, or paste the text.')
    return { text: clean.slice(0, 20_000), source: name, pages: totalPages, readBy: 'code', model: null }
  }
  if (head[0] === 0x50 && head[1] === 0x4b) {
    const xml = unzipEntry(file.bytes, 'word/document.xml')
    if (!xml) throw new Problem(422, 'brief.unreadable', 'That is not a Word file we can read', 'Attach a .docx, a PDF, or paste the text.')
    let markup = xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n')
    // Strip tags until none are left, so a tag split around another (<sc<x>ript>) cannot survive one pass.
    for (let previous = ''; previous !== markup;) { previous = markup; markup = markup.replace(/<[^<>]*>/g, '') }
    // Entities are decoded in one pass, so "&amp;lt;" stays the text "&lt;" instead of becoming "<". The brief is
    // only ever shown as text and handed to a model as data, never rendered as markup.
    const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    const text = markup.replace(/[<>]/g, '').replace(/&(amp|lt|gt|quot|apos);/g, (_match, name: string) => entities[name]!).replace(/\n{3,}/g, '\n\n').trim()
    if (text.length < 5) throw new Problem(422, 'brief.unreadable', 'That Word file has no text', 'Paste the brief instead.')
    return { text: text.slice(0, 20_000), source: name, pages: null, readBy: 'code', model: null }
  }
  const image = head[0] === 0x89 && ascii.slice(1, 4) === 'PNG' ? 'image/png' : head[0] === 0xff && head[1] === 0xd8 ? 'image/jpeg' : ascii.startsWith('RIFF') ? 'image/webp' : null
  if (image) {
    const read = await readImageBrief(file.bytes, image, models)
    if (!read) throw new Problem(422, 'brief.no_vision', 'Screenshots need an AI model that can see', 'No configured model could read the image. Paste the text of the brief instead.')
    return { text: read.text, source: name, pages: 1, readBy: 'model', model: read.model }
  }
  const sample = file.bytes.subarray(0, 4096)
  const textual = sample.every((value) => value === 9 || value === 10 || value === 13 || value >= 32)
  if (!textual) throw new Problem(415, 'brief.unsupported', 'That kind of file cannot be read', 'Attach a PDF, a Word file, a text file or a screenshot, or paste the text.')
  return { text: new TextDecoder().decode(file.bytes).slice(0, 20_000).trim(), source: name, pages: null, readBy: 'code', model: null }
}

/** Reads one file out of a zip (a .docx is one), from the central directory, inflating it if it is compressed. */
function unzipEntry(bytes: Uint8Array, wanted: string): string | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 66_000); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break }
  }
  if (end < 0) return null
  const count = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  for (let entry = 0; entry < count && offset + 46 <= buffer.length; entry += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null
    const method = buffer.readUInt16LE(offset + 10)
    const compressed = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const local = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (name === wanted) {
      if (buffer.readUInt32LE(local) !== 0x04034b50) return null
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
      const data = buffer.subarray(start, start + compressed)
      if (compressed > 20 * 1024 * 1024) return null
      return (method === 0 ? data : inflateRawSync(data, { maxOutputLength: 40 * 1024 * 1024 })).toString('utf8')
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  return null
}
