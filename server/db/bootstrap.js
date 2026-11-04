// Database lifecycle: create schema, load the sample township, wipe & reseed (demo reset), JSON export.
// The sample data is generated in code (server/seed.js) and imported through the same importer that handles
// legacy JSON snapshots. JSON is only an import / export format here - nothing reads it at runtime.
import { applySchema } from './index.js';
import { importLegacy } from './import.js';
import { seedDatabase } from '../seed.js';

// Children first so foreign keys never block the wipe.
export const TABLES_DELETE_ORDER = [
  'complaint_corrections', 'complaint_ratings', 'complaint_history', 'complaint_photos', 'complaints',
  'flat_ledger', 'payment_sessions', 'bank_transactions', 'bank_statements', 'maintenance_bills',
  'bookings', 'amenities', 'guest_codes', 'visitors', 'notices', 'enquiries', 'notifications', 'audit_logs',
  'users', 'staff', 'flat_upi_ids', 'flats', 'roles', 'app_settings', 'counters',
];

export async function userCount(db) { const [x] = await db.query('SELECT COUNT(*) AS n FROM users'); return Number(x.n); }

export async function initDatabase(db, { seed = true, now = new Date() } = {}) {
  await applySchema(db);
  if (seed && (await userCount(db)) === 0) await db.transaction((tx) => importLegacy(tx, seedDatabase(now), { importedAt: now.toISOString() }));
  return { seeded: seed && (await userCount(db)) > 0 };
}

export async function wipeAll(db) { await db.transaction(async (tx) => { for (const t of TABLES_DELETE_ORDER) await tx.query(`DELETE FROM ${t}`); }); }

export async function resetDemo(db, now = new Date()) {
  await db.transaction(async (tx) => {
    for (const t of TABLES_DELETE_ORDER) await tx.query(`DELETE FROM ${t}`);
    await importLegacy(tx, seedDatabase(now), { importedAt: now.toISOString() });
  });
}

export async function importJsonSnapshot(db, snapshot) {
  await applySchema(db);
  if ((await userCount(db)) > 0) throw new Error('Database is not empty. Import refuses to merge into existing data.');
  return db.transaction((tx) => importLegacy(tx, snapshot));
}
