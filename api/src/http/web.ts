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
 *
 * One exception, and only one: PayPal's own hosts, so a client can pay a locked bill on our page with a card. The
 * card fields are PayPal-hosted iframes, so PayPal has to be allowed to run a script, to be framed, and to be talked
 * to. Those hosts are named exactly, the environment decides which set, and nothing else is let in.
 */
const PAYPAL_HOSTS = {
  sandbox: ['https://*.sandbox.paypal.com', 'https://*.paypalobjects.com'],
  live: ['https://*.paypal.com', 'https://*.paypalobjects.com'],
} as const

export function webCsp(environment: 'sandbox' | 'live' = 'sandbox'): string {
  const paypal = PAYPAL_HOSTS[environment].join(' ')
  return [
    "default-src 'self'",
    `script-src 'self' ${paypal}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${paypal}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    `frame-src 'self' ${paypal}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

/** The policy as it stands for a server that has not said which PayPal it uses. */
export const WEB_CSP = webCsp('sandbox')

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
  const rawPath = requestPath.replace(/^\/app\/?/, '')
  if (rawPath.includes('\\') || rawPath.includes('\0') || /%(2e|2f|5c|00)/i.test(rawPath)) return null
  let relative: string
  try {
    relative = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (relative.includes('\\') || relative.includes('\0') || relative.includes('%')) return null
  if (relative.split('/').includes('..')) return null
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
