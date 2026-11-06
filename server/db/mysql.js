// Production adapter: MySQL 8 through mysql2/promise. Credentials come only from the environment.
export async function openMysql(cfg) {
  let mysql;
  try { mysql = (await import('mysql2/promise')).default; }
  catch { throw new Error('mysql2 is not installed. Run "npm install" (it is a declared dependency).'); }
  const pool = mysql.createPool({
    host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password,
    waitForConnections: true, connectionLimit: cfg.poolSize || 10, charset: 'utf8mb4',
    decimalNumbers: true, dateStrings: true, timezone: 'Z', multipleStatements: false,
    ssl: cfg.ssl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
  });
  const make = (conn) => ({
    async query(sql, params = []) {
      const [rows] = await conn.query(sql, params);
      return Array.isArray(rows) ? rows : { affectedRows: rows.affectedRows };
    },
  });
  const adapter = {
    engine: 'mysql',
    ...make(pool),
    async exec(sql) { await pool.query(sql); },
    async transaction(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const out = await fn(make(conn));
        await conn.commit();
        return out;
      } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    },
    async close() { await pool.end(); },
  };
  return adapter;
}
