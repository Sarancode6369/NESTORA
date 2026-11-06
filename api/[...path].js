
import '../server/env.js';
import { openDatabase } from '../server/db/index.js';
import { initDatabase } from '../server/db/bootstrap.js';
import { createApp } from '../server/app.js';
import { createAiFromEnv } from '../server/ai/index.js';

let appPromise;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET environment variable is required');
      }

      const db = await openDatabase();

      try {
        await initDatabase(db, {
          seed: process.env.SEED_DEMO_DATA !== 'false'
        });

        const ai = createAiFromEnv();

        const app = createApp({
          db,
          classifier: ai.classifier,
          aiStatus: ai.status,
          allowDemoReset: false
        });

        app.purge().catch((err) => {
          console.error('Photo purge failed:', err.message);
        });

        return app;
      } catch (error) {
        await db.close().catch(() => {});
        throw error;
      }
    })();
  }

  try {
    return await appPromise;
  } catch (error) {
    appPromise = null;
    throw error;
  }
}

export default async function handler(req, res) {
  try {
    const app = await getApp();
    await app.handler(req, res);
  } catch (error) {
    console.error('NESTORA API error:', error.message);

    if (!res.headersSent) {
      res.writeHead(500, {
        'Content-Type': 'application/json'
      });
    }

    if (!res.writableEnded) {
      res.end(JSON.stringify({
        error: 'Server initialization failed'
      }));
    }
  }
}
