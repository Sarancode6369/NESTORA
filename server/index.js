import './env.js'; // must be first: loads .env into process.env
import { createApp } from './app.js';
import { openDatabase } from './db/index.js';
import { initDatabase } from './db/bootstrap.js';
import { dbConfigFromEnv, safeDescribe, explainDbError } from './db/config.js';
import { createAiFromEnv } from './ai/index.js';

const PORT = Number(process.env.PORT || 3000);

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('JWT_SECRET must be set in production');
  process.exit(1);
}

let db;
try {
  db = await openDatabase();
  // Creates tables when missing; loads the demo township only into an EMPTY database (set SEED_DEMO_DATA=false to skip).
  const { seeded } = await initDatabase(db, { seed: process.env.SEED_DEMO_DATA !== 'false' });
  console.log(`Database ready: ${safeDescribe(dbConfigFromEnv())}${seeded ? '' : ' (no demo data loaded)'}`);
} catch (e) {
  let cfg = null; try { cfg = dbConfigFromEnv(); } catch { /* reported below */ }
  console.error(`Cannot start: ${explainDbError(e, cfg)}`);
  process.exit(1);
}

const ai = createAiFromEnv();
console.log(ai.groq.configured ? `AI complaint triage: Groq (${ai.groq.model}), keyword fallback if unavailable` : 'AI complaint triage: GROQ_API_KEY not set - deterministic keyword classifier in use');
const { server, purge } = createApp({ db, classifier: ai.classifier, aiStatus: ai.status, groq: ai.groq });
purge().catch((e) => console.error('photo purge failed:', e.message));
setInterval(() => purge().catch((e) => console.error('photo purge failed:', e.message)), 3600 * 1000).unref();
server.listen(PORT, () => console.log(`NESTORA running at http://localhost:${PORT}  (demo OTP login; test-mode payments)`));

const shutdown = () => { server.close(() => db.close().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
