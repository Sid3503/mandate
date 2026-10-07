/**
 * What can be known about a proof link without opening it. The client's agent cannot open the link (it would be
 * fetching an arbitrary address on behalf of another company), so the harness works out the facts in code and hands
 * them to the model as facts. A clear-cut case never needs a model at all.
 */
export type ProofAssessment = {
  url: string
  https: boolean
  host: string
  kind: 'design' | 'document' | 'code' | 'video' | 'storage' | 'unknown'
  pathDepth: number
  flags: Array<'homepage' | 'shortener' | 'login' | 'placeholder' | 'tracking' | 'ip_address' | 'not_https'>
  /** reject: nothing could be delivered at this address. plausible: a specific item on a host that holds this kind of work. weak: anything else. */
  verdict: 'reject' | 'plausible' | 'weak'
  summary: string
}

const KINDS: Array<[ProofAssessment['kind'], RegExp]> = [
  ['design', /(^|\.)(figma\.com|dribbble\.com|behance\.net|canva\.com|framer\.com|invisionapp\.com|adobe\.com|miro\.com)$/],
  ['document', /(^|\.)(docs\.google\.com|notion\.so|notion\.site|dropbox\.com|paper\.dropbox\.com|airtable\.com|coda\.io)$/],
  ['code', /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codesandbox\.io|stackblitz\.com|vercel\.app|netlify\.app)$/],
  ['video', /(^|\.)(loom\.com|youtube\.com|youtu\.be|vimeo\.com|wistia\.com)$/],
  ['storage', /(^|\.)(drive\.google\.com|box\.com|wetransfer\.com|s3\.amazonaws\.com|cloudfront\.net|onedrive\.live\.com|1drv\.ms)$/],
]
const SHORTENERS = /(^|\.)(bit\.ly|t\.co|tinyurl\.com|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at)$/
const PLACEHOLDER_HOSTS = /(^|\.)(example\.(com|org|net)|localhost|test|invalid)$/
const LOGIN_PATH = /^\/(login|signin|sign-in|sign_in|auth|account|register|signup|sign-up)(\/|$)/i
const TRACKING_QUERY = /(^|&)(utm_[a-z]+|fbclid|gclid|mc_eid|ref)=/i

export function assessProof(input: string): ProofAssessment {
  let url: URL | null = null
  try {
    url = new URL(input.trim())
  } catch {
    url = null
  }
  if (!url) return { url: input, https: false, host: '', kind: 'unknown', pathDepth: 0, flags: ['not_https'], verdict: 'reject', summary: 'not a valid web address' }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const segments = url.pathname.split('/').filter(Boolean)
  const flags: ProofAssessment['flags'] = []
  if (url.protocol !== 'https:') flags.push('not_https')
  if (SHORTENERS.test(host)) flags.push('shortener')
  if (PLACEHOLDER_HOSTS.test(host) || /\b(placeholder|lorem|dummy|tbd|todo)\b/i.test(url.pathname)) flags.push('placeholder')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) flags.push('ip_address')
  if (LOGIN_PATH.test(url.pathname)) flags.push('login')
  if (segments.length === 0 && !url.hash.replace('#', '')) flags.push('homepage')
  if (TRACKING_QUERY.test(url.search.replace(/^\?/, '')) && segments.length === 0) flags.push('tracking')
  const kind = KINDS.find(([, pattern]) => pattern.test(host))?.[0] ?? 'unknown'
  const hard = flags.some((flag) => flag === 'not_https' || flag === 'shortener' || flag === 'login' || flag === 'placeholder' || flag === 'ip_address' || flag === 'homepage' || flag === 'tracking')
  const verdict: ProofAssessment['verdict'] = hard ? 'reject' : kind !== 'unknown' && segments.length >= 1 ? 'plausible' : 'weak'
  const why = hard
    ? `rejected before any model is asked: ${flags.map((flag) => ({ not_https: 'not https', shortener: 'a link shortener', login: 'a login page', placeholder: 'a placeholder', ip_address: 'a bare IP address', homepage: 'the site\'s home page, not a specific file', tracking: 'a tracking link to a home page' })[flag]).join(', ')}`
    : kind !== 'unknown'
      ? `a specific ${kind} item on ${host}`
      : `an address on ${host}, which is not a host known to hold this kind of work`
  return { url: url.toString(), https: url.protocol === 'https:', host, kind, pathDepth: segments.length, flags, verdict, summary: why }
}
