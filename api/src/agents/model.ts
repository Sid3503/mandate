import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { createOllama } from 'ai-sdk-ollama'

export type AgentModel = { model: LanguageModel; name: string; provider?: 'bedrock' | 'ollama' }

/**
 * The models behind every agent, called through the Vercel AI SDK. Nothing here has authority: a model is handed
 * tools that can only ask, so swapping the model is a configuration change and never a change in what can be paid.
 *
 * The default is Amazon Bedrock's OpenAI-compatible endpoint. Ollama Cloud (open weights) is kept as the fallback and
 * as the way to compare models.
 */

export const DEFAULT_BEDROCK_MODEL = 'us.openai.gpt-6-luna'
export const DEFAULT_OLLAMA_MODEL = 'gemma4:31b'
export const DEFAULT_OLLAMA_PRIMARY = 'gpt-oss:20b'

export type ModelEnv = {
  [key: string]: string | undefined
  BEDROCK_API_KEY?: string
  BEDROCK_REGION?: string
  AWS_REGION?: string
  OLLAMA_API_KEY?: string
  OLLAMA_BASE_URL?: string
  AGENT_MODEL?: string
  DRAFTER_MODEL?: string
}

/** Bedrock inference profiles look like `us.openai.gpt-6-luna` or `global.openai.gpt-6-sol`; Ollama models like `gemma4:31b`. */
export const isBedrockName = (name: string) => /^(us|eu|apac|global|us-gov)\.|^(openai|anthropic|amazon|meta)\./.test(name)

/**
 * Bedrock's chat endpoint refuses function tools unless `reasoning_effort` is `none` ("Function tools with
 * reasoning_effort are not supported ... set reasoning_effort to 'none'"). Every agent here works through tools, so
 * the request body is given that setting whenever it carries tools. Found by calling the real endpoint.
 */
export function withNoReasoning(fetchImpl: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof init?.body === 'string' && init.body.includes('"tools"')) {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>
        if (Array.isArray(body.tools) && body.tools.length > 0 && body.reasoning_effort === undefined) {
          return fetchImpl(input, { ...init, body: JSON.stringify({ ...body, reasoning_effort: 'none' }) })
        }
      } catch {
        // Not JSON: send it as it is.
      }
    }
    return fetchImpl(input, init)
  }) as typeof fetch
}

export function createBedrockModel(options: { apiKey?: string; region?: string; name?: string }): AgentModel | null {
  if (!options.apiKey) return null
  const name = options.name ?? DEFAULT_BEDROCK_MODEL
  const provider = createOpenAICompatible({
    name: 'bedrock',
    baseURL: `https://bedrock-runtime.${options.region ?? 'us-east-1'}.amazonaws.com/openai/v1`,
    apiKey: options.apiKey,
    fetch: withNoReasoning(),
  })
  return { model: provider.chatModel(name), name, provider: 'bedrock' }
}

export function createAgentModel(options: { apiKey?: string; baseUrl?: string; name?: string }): AgentModel | null {
  if (!options.apiKey) return null
  const name = options.name ?? DEFAULT_OLLAMA_MODEL
  const ollama = createOllama({ baseURL: options.baseUrl ?? 'https://ollama.com', headers: { Authorization: `Bearer ${options.apiKey}` } })
  return { model: ollama(name), name, provider: 'ollama' }
}

/** The model called `name`, on whichever provider that name belongs to, or null if that provider has no key. */
export function modelByName(name: string, env: ModelEnv): AgentModel | null {
  return isBedrockName(name)
    ? createBedrockModel({ apiKey: env.BEDROCK_API_KEY, region: env.BEDROCK_REGION ?? env.AWS_REGION, name })
    : createAgentModel({ apiKey: env.OLLAMA_API_KEY, baseUrl: env.OLLAMA_BASE_URL, name })
}

/**
 * Which model does what.
 *   primary   the clerk, the negotiators and the client's reviewer
 *   drafter   turns the owner's words into draft rules
 *   fallback  tried once if the primary errors
 * With a Bedrock key, Bedrock is primary and drafter, and Ollama (if it has a key) is the fallback. With only an
 * Ollama key, Ollama does everything, as before. With neither, the agents are off and everything else works.
 */
export function buildModels(env: ModelEnv): { primary: AgentModel | null; drafter: AgentModel | null; fallback: AgentModel | null } {
  const bedrock = Boolean(env.BEDROCK_API_KEY)
  const primary = env.AGENT_MODEL ? modelByName(env.AGENT_MODEL, env) : bedrock ? modelByName(DEFAULT_BEDROCK_MODEL, env) : modelByName(DEFAULT_OLLAMA_PRIMARY, env)
  const drafter = env.DRAFTER_MODEL ? modelByName(env.DRAFTER_MODEL, env) : bedrock ? primary : modelByName(DEFAULT_OLLAMA_MODEL, env)
  const fallbackName = bedrock ? (env.OLLAMA_API_KEY ? DEFAULT_OLLAMA_MODEL : 'global.openai.gpt-6-sol') : DEFAULT_OLLAMA_MODEL
  const fallback = modelByName(fallbackName, env)
  return { primary, drafter: drafter ?? primary, fallback: fallback && primary && fallback.name !== primary.name ? fallback : null }
}
