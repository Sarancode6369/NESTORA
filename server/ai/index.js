import { groqConfigFromEnv, createGroqClient } from './groq.js';
import { createClassifier } from './classifier.js';

// Builds the classifier + a status() function from environment variables. The key never leaves this closure.
export function createAiFromEnv(env = process.env, { fetchImpl, logger } = {}) {
  const cfg = groqConfigFromEnv(env);
  const groq = createGroqClient({ apiKey: cfg.apiKey, model: cfg.model, timeoutMs: cfg.timeoutMs, ...(fetchImpl ? { fetchImpl } : {}) });
  const classifier = createClassifier({ groq, minConfidence: cfg.minConfidence, maxCallsPerMinute: cfg.maxCallsPerMinute, ...(logger ? { logger } : {}) });
  const status = () => ({ mode: groq.configured ? 'groq' : 'keyword', provider: groq.configured ? 'groq' : null, model: groq.configured ? groq.model : null, keyConfigured: groq.configured, minConfidence: cfg.minConfidence, timeoutMs: cfg.timeoutMs, fallback: 'keyword' });
  return { classifier, status, groq, config: { ...cfg, apiKey: undefined } };
}
