import sharp from 'sharp'

/**
 * Sealed copies of delivered images. What is guaranteed: the original bytes never leave the server before the client's
 * money is captured. What the client sees before that is made here, on the server, from the original:
 *   - before paying: a small, heavily blurred thumbnail with the seal on it, enough to see that the work exists
 *   - while their money is held: a review copy, at most 1200 px, re-encoded, with their own name, email, the time and a
 *     session code written across the whole image, so any capture of it can be traced to the session that made it
 *   - close-ups: a 300 px square of the original resolution, watermarked the same way, a limited number per session
 * Nothing a browser does can reach the original, because the original is never sent.
 */

const REVIEW_MAX = 1200
const THUMB = 360
export const CLOSEUP = 300

export type Watermark = { client: string; email: string | null; at: string; code: string }

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]!)
}

/** A diagonal, repeated line of text over the whole picture, plus a fine stripe so the copy reads as a copy even where text cannot render. */
function overlay(width: number, height: number, line: string, opacity = 0.42): Buffer {
  const size = Math.max(12, Math.round(Math.min(width, height) / 32))
  const rows: string[] = []
  const step = size * 4
  for (let y = -height; y < height * 2; y += step) {
    rows.push(`<text x="${-width}" y="${y}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="600" fill="white" fill-opacity="${opacity}" stroke="black" stroke-opacity="${opacity * 0.45}" stroke-width="${Math.max(0.6, size / 24)}">${escapeXml(`${line}   ·   `.repeat(Math.ceil((width * 3) / (line.length * size * 0.5)) + 1))}</text>`)
  }
  const stripes = `<pattern id="s" width="${step}" height="${step}" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)"><rect width="${Math.max(1, Math.round(size / 10))}" height="${step}" fill="white" fill-opacity="${opacity * 0.35}"/></pattern>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${stripes}</defs><rect width="100%" height="100%" fill="url(#s)"/><g transform="rotate(-30 ${width / 2} ${height / 2})">${rows.join('')}</g></svg>`
  return Buffer.from(svg)
}

const markLine = (mark: Watermark) => `Review copy · ${mark.client}${mark.email ? ` · ${mark.email}` : ''} · ${mark.at} · ${mark.code}`

export async function imageSize(bytes: Uint8Array): Promise<{ width: number | null; height: number | null }> {
  try {
    const meta = await sharp(bytes, { limitInputPixels: 80_000_000 }).metadata()
    return { width: meta.width ?? null, height: meta.height ?? null }
  } catch {
    return { width: null, height: null }
  }
}

/** Proves an upload is an image sharp can read, so a file that only looks like one is stored as a file, not drawn. */
export async function readableImage(bytes: Uint8Array): Promise<boolean> {
  try {
    const meta = await sharp(bytes, { limitInputPixels: 80_000_000 }).metadata()
    return Boolean(meta.width && meta.height)
  } catch {
    return false
  }
}

/** Before payment: a blurred thumbnail with a seal across it. The work is visibly there and visibly not available. */
export async function sealedThumb(bytes: Uint8Array): Promise<Buffer> {
  const base = sharp(bytes, { limitInputPixels: 80_000_000 }).rotate().resize(THUMB, THUMB, { fit: 'cover' }).blur(14).modulate({ brightness: 1.04, saturation: 0.7 })
  const pixels = await base.jpeg({ quality: 55 }).toBuffer()
  return sharp(pixels).composite([{ input: overlay(THUMB, THUMB, 'Sealed until paid', 0.55) }]).jpeg({ quality: 60 }).toBuffer()
}

/** While money is held: a re-encoded review copy, never larger than 1200 px, marked with who is looking and when. */
export async function reviewCopy(bytes: Uint8Array, mark: Watermark): Promise<Buffer> {
  const resized = await sharp(bytes, { limitInputPixels: 80_000_000 }).rotate().resize(REVIEW_MAX, REVIEW_MAX, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).toBuffer({ resolveWithObject: true })
  const { width, height } = resized.info
  return sharp(resized.data).composite([{ input: overlay(width, height, markLine(mark)) }]).jpeg({ quality: 74, mozjpeg: true }).toBuffer()
}

/** A square of the original at full resolution, centred on the point asked for (0..1 across and down), marked the same way. */
export async function closeup(bytes: Uint8Array, nx: number, ny: number, mark: Watermark): Promise<Buffer> {
  const image = sharp(bytes, { limitInputPixels: 80_000_000 }).rotate()
  const meta = await image.metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  const side = Math.min(CLOSEUP, width, height)
  if (side < 8) throw new Error('image too small')
  const left = Math.min(width - side, Math.max(0, Math.round(nx * width - side / 2)))
  const top = Math.min(height - side, Math.max(0, Math.round(ny * height - side / 2)))
  const crop = await sharp(bytes, { limitInputPixels: 80_000_000 }).rotate().extract({ left, top, width: side, height: side }).flatten({ background: '#ffffff' }).toBuffer()
  return sharp(crop).composite([{ input: overlay(side, side, `${mark.client} · ${mark.code}`, 0.3) }]).jpeg({ quality: 80 }).toBuffer()
}

/** A small copy for a model to look at. Never shown to anyone. */
export async function forModel(bytes: Uint8Array): Promise<Buffer> {
  return sharp(bytes, { limitInputPixels: 80_000_000 }).rotate().resize(768, 768, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 70 }).toBuffer()
}
