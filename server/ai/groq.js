// Minimal Groq (OpenAI-compatible) chat client built on fetch. The API key is read from the backend environment
// only, is sent only in the Authorization header, and is never logged, returned to callers or put in error text.
export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEFAULT_MODEL = 'openai/gpt-oss-120b'; // llama-3.3-70b-versatile was retired by Groq in Aug 2026; override with GROQ_MODEL

export class AiError extends Error {
  // kind: 'not_configured' | 'timeout' | 'network' | 'auth' | 'rate_limited' | 'http' | 'empty'
  constructor(kind, message, status) { super(message); this.name = 'AiError'; this.kind = kind; this.status = status; }
}

export function groqConfigFromEnv(env = process.env) {
  const apiKey = (env.GROQ_API_KEY || '').trim();
  return {
    apiKey: apiKey || null,
    model: (env.GROQ_MODEL || DEFAULT_MODEL).trim(),
    timeoutMs: Math.min(30000, Math.max(500, Number(env.AI_TIMEOUT_MS) || 15000)),
    minConfidence: Math.min(1, Math.max(0, env.AI_MIN_CONFIDENCE !== undefined && env.AI_MIN_CONFIDENCE !== '' ? Number(env.AI_MIN_CONFIDENCE) : 0.6)),
    maxCallsPerMinute: Number(env.AI_MAX_CALLS_PER_MIN) || 30,
  };
}

export function createGroqClient({ apiKey, model = DEFAULT_MODEL, timeoutMs = 15000, fetchImpl = globalThis.fetch, url = GROQ_URL } = {}) {
  const configured = !!apiKey;
  const isGptOss = /^openai\/gpt-oss/.test(model);
  async function post(messages, { jsonMode }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const body = { model, messages, temperature: 0, max_completion_tokens: 1200, ...(jsonMode ? { response_format: { type: 'json_object' } } : {}), ...(isGptOss ? { reasoning_effort: 'low' } : {}) };
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw new AiError('timeout', `Groq request timed out after ${timeoutMs} ms`);
      throw new AiError('network', 'Could not reach the Groq API'); // deliberately drops e.message: it may echo the URL / headers
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      let detail = ''; try { detail = String((await res.json())?.error?.message || '').slice(0, 200); } catch { /* ignore */ }
      if (res.status === 401 || res.status === 403) throw new AiError('auth', 'Groq rejected the API key', res.status);
      if (res.status === 429) throw new AiError('rate_limited', 'Groq rate limit reached', res.status);
      const err = new AiError('http', `Groq returned HTTP ${res.status}`, res.status); err.detail = detail; throw err;
    }
    let data; try { data = await res.json(); } catch { throw new AiError('empty', 'Groq returned a non-JSON body'); }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new AiError('empty', 'Groq returned an empty completion');
    return content;
  }
  return {
    configured, model,
    // Returns the raw text of the first completion. JSON mode is requested by default; if the model rejects response_format the
    // request is repeated once without it (the strict validator downstream still guards the result).
    // For freeform conversational chat, pass { jsonMode: false } to skip response_format entirely.
    async complete(messages, { jsonMode = true } = {}) {
      if (!configured) throw new AiError('not_configured', 'GROQ_API_KEY is not set');
      if (!jsonMode) return await post(messages, { jsonMode: false });
      try { return await post(messages, { jsonMode: true }); }
      catch (e) { if (e.kind === 'http' && e.status === 400 && /response_format|json/i.test(e.detail || '')) return post(messages, { jsonMode: false }); throw e; }
    },
  };
}
