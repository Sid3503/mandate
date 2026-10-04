import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Content security policy for the owner console. Scripts and connections stay on this origin.
 * Styles allow inline because the data grid injects its theme at runtime.
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

export type WebAsset = { body: Uint8Array; type: string; cache: string; encoding: 'br' | 'gzip' | null }

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt'])
const packed = new Map<string, Uint8Array>()

function pack(file: string, mtime: number, raw: Uint8Array, encoding: 'br' | 'gzip'): Uint8Array {
  const key = `${encoding}:${file}:${mtime}`
  let body = packed.get(key)
  if (!body) {
    body = encoding === 'br'
      ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })
      : gzipSync(raw, { level: 9 })
    packed.set(key, body)
  }
  return body
}

/** Resolves a request under /app to a built file, falling back to index.html for client routes. */
export function webAsset(dist: string, requestPath: string, acceptEncoding = ''): WebAsset | null {
  const root = resolve(dist)
  const index = join(root, 'index.html')
  if (!existsSync(index)) return null
  const relative = decodeURIComponent(requestPath.replace(/^\/app\/?/, ''))
  const target = normalize(join(root, relative))
  if (target !== root && !target.startsWith(root + sep)) return null
  const isFile = relative !== '' && existsSync(target) && statSync(target).isFile()
  if (!isFile && extname(relative) !== '') return null
  const file = isFile ? target : index
  const ext = extname(file)
  const hashed = file.startsWith(join(root, 'assets') + sep)
  const raw = readFileSync(file)
  const encoding = COMPRESSIBLE.has(ext) && raw.length > 1024
    ? (/\bbr\b/.test(acceptEncoding) ? 'br' : /\bgzip\b/.test(acceptEncoding) ? 'gzip' : null)
    : null
  return {
    body: encoding ? pack(file, statSync(file).mtimeMs, raw, encoding) : raw,
    type: TYPES[ext] ?? 'application/octet-stream',
    cache: hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    encoding,
  }
}
