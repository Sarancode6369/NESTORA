#!/usr/bin/env node
// DEVELOPMENT / EVALUATION ONLY. Runs the same app against an in-memory SQLite engine (node:sqlite)
// with the demo township, for machines without MySQL. Data is lost on exit.
// Production and normal development use MySQL: see deployment.md ("npm start").
import '../server/env.js';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db/index.js';
import { initDatabase } from '../server/db/bootstrap.js';
import { createAiFromEnv } from '../server/ai/index.js';

const PORT = Number(process.env.PORT || 3000);
const db = await openDatabase({ engine: 'sqlite' });
await initDatabase(db, { seed: true });
const ai = createAiFromEnv();
const { server } = createApp({ db, classifier: ai.classifier, aiStatus: ai.status, groq: ai.groq });
server.listen(PORT, () => console.log(`NESTORA (SQLite dev engine - NOT for production) at http://localhost:${PORT}`));
