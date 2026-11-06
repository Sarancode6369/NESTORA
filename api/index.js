import '../server/env.js';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db/index.js';
import { initDatabase } from '../server/db/bootstrap.js';
import { createAiFromEnv } from '../server/ai/index.js';
import { dbConfigFromEnv, explainDbError } from '../server/db/config.js';

let cachedApp = null;

async function getApp() {
  if (!cachedApp) {
    const db = await openDatabase();
    await initDatabase(db, { seed: process.env.SEED_DEMO_DATA !== 'false' });
    const ai = createAiFromEnv();
    cachedApp = createApp({
      db,
      classifier: ai.classifier,
      aiStatus: ai.status,
      groq: ai.groq,
    });
  }
  return cachedApp;
}

export default async function handler(req, res) {
  try {
    const app = await getApp();
    return await app.handler(req, res);
  } catch (e) {
    let cfg = null;
    try { cfg = dbConfigFromEnv(); } catch { /* ignore */ }
    const message = explainDbError(e, cfg);
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Database service unavailable', detail: message }));
  }
}
