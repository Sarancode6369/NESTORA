// Small in-memory sliding-window rate limiter (per process). Good enough for a single instance;
// put a shared limiter (Redis / reverse proxy) in front when running several replicas.
export function createLimiter({ windowMs = 60000, max = 60 } = {}) {
  const hits = new Map();
  let lastSweep = Date.now();
  return {
    hit(key, nowMs = Date.now()) {
      if (nowMs - lastSweep > windowMs * 5) { for (const [k, v] of hits) if (!v.some((t) => nowMs - t < windowMs)) hits.delete(k); lastSweep = nowMs; }
      const arr = (hits.get(key) || []).filter((t) => nowMs - t < windowMs);
      if (arr.length >= max) { hits.set(key, arr); return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (nowMs - arr[0])) / 1000)) }; }
      arr.push(nowMs); hits.set(key, arr);
      return { ok: true, remaining: max - arr.length };
    },
  };
}
