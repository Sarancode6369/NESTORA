// Database configuration comes from the environment only - nothing is hardcoded.
//   DATABASE_URL   mysql://host:3306/nestora   (credentials may be embedded, but prefer the two vars below)
//   DB_USERNAME / DB_PASSWORD   override / supply the credentials
export function dbConfigFromEnv(env = process.env) {
  if (!env.DATABASE_URL) return null;
  // Friendly guard: .env.example ships placeholder values; connecting with them can never work.
  if (/^(your_|replace_|change_?me|<)/i.test(env.DB_PASSWORD || '')) throw new Error('DB_PASSWORD in .env is still the example placeholder. Put your real MySQL password there (the .env file is git-ignored).');
  if (/^(your_|replace_|change_?me|<)/i.test(env.DB_USERNAME || '')) throw new Error('DB_USERNAME in .env is still the example placeholder. Put your MySQL user name there.');
  let u;
  try { u = new URL(env.DATABASE_URL.replace(/^jdbc:/, '')); } catch { throw new Error('DATABASE_URL is not a valid URL (example: mysql://localhost:3306/nestora)'); }
  if (!/^mysql/.test(u.protocol)) throw new Error('DATABASE_URL must start with mysql://');
  return {
    host: u.hostname, port: Number(u.port || 3306), database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: env.DB_USERNAME || decodeURIComponent(u.username) || undefined,
    password: env.DB_PASSWORD ?? (decodeURIComponent(u.password) || undefined),
    ssl: u.searchParams.get('ssl') === 'true',
    sslCa: env.DB_SSL_CA?.replace(/\\n/g, '\n'),
  };
}
export const safeDescribe = (c) => `${c.user || '?'}@${c.host}:${c.port}/${c.database}`; // never prints the password

// Turns a driver / config error into one actionable sentence. Never includes the password.
export function explainDbError(e, cfg = null) {
  const parts = [e, ...(Array.isArray(e?.errors) ? e.errors : [])];
  const code = parts.map((x) => x?.code).find(Boolean) || '';
  const msg = (parts.map((x) => x?.sqlMessage || x?.message).find(Boolean) || String(e)).replace(/using password: (YES|NO)/i, '').trim();
  const where = cfg ? `${cfg.host}:${cfg.port}` : 'the configured host';
  if (code === 'ECONNREFUSED') return `Cannot reach MySQL at ${where}. Is the MySQL80 service running (Windows: Services -> MySQL80 -> Start) and is the port right in DATABASE_URL?`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Host name in DATABASE_URL not found (${where}). Use localhost for a local MySQL.`;
  if (code === 'ER_ACCESS_DENIED_ERROR') return `MySQL rejected DB_USERNAME / DB_PASSWORD${cfg?.user ? ` (user "${cfg.user}")` : ''}. Check the values in your .env file.`;
  if (code === 'ER_BAD_DB_ERROR') return `Database "${cfg?.database || '?'}" does not exist. Create it once:  CREATE DATABASE ${cfg?.database || 'nestora_db'} CHARACTER SET utf8mb4;`;
  if (code === 'ER_DBACCESS_DENIED_ERROR') return `User "${cfg?.user || '?'}" has no access to database "${cfg?.database || '?'}". GRANT ALL ON ${cfg?.database || 'nestora_db'}.* TO that user.`;
  if (code === 'ETIMEDOUT') return `Connecting to MySQL at ${where} timed out. Check the host, port and firewall.`;
  return code ? `${code}: ${msg}` : msg;
}
