# NESTORA — Setup and deployment

## Prerequisites

* Node.js **22+** (uses built-in `fetch` and `node:test`)
* MySQL **8.0+** (InnoDB, utf8mb4). MariaDB is untested.
* A Groq API key — optional. Without it the app runs in fallback mode (keyword classifier).

## 1. Create the database (once)

Log in to MySQL (it prompts for your password; never put it in a command or in chat):

```powershell
mysql -u root -p
```

```sql
CREATE DATABASE IF NOT EXISTS nestora_db CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
-- optional, recommended for anything beyond a local laptop: a dedicated account instead of root
CREATE USER 'nestora_app'@'localhost' IDENTIFIED BY '<choose-a-strong-password>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON nestora_db.* TO 'nestora_app'@'localhost';
```

For a server, use a host restriction instead of `localhost` as appropriate. After the first run you may revoke `CREATE, ALTER, INDEX`.

## 2. Configure environment variables

The `.env` file lives in the **project root** (next to `package.json`), not in `server/`. The app and every `npm run db:*`
script read it automatically; you do not need `--env-file` or to set variables in the shell. Variables that are already set
in the real environment win over `.env`.

```powershell
Copy-Item .env.example .env        # macOS/Linux: cp .env.example .env
notepad .env                       # replace the placeholders, save
```

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | `mysql://localhost:3306/nestora_db` — host, port, database only; **no user or password in the URL** (add `?ssl=true` for managed MySQL) |
| `DB_USERNAME` | MySQL user, e.g. `root` locally or `nestora_app` |
| `DB_PASSWORD` | that user's password. It is read separately from the URL, so characters like `@ : / #` need no escaping |
| `JWT_SECRET` | long random string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). **Required** when `NODE_ENV=production` |
| `PORT` | HTTP port (default 3000) |
| `GROQ_API_KEY` | Groq key; backend only, never sent to the browser. Empty ⇒ fallback mode |
| `GROQ_MODEL`, `AI_TIMEOUT_MS`, `AI_MIN_CONFIDENCE`, `AI_MAX_CALLS_PER_MIN` | optional AI tuning |
| `SEED_DEMO_DATA` | `false` to skip loading the demo township into an empty database |

`.env` is git-ignored (so are `.env.*`, except `.env.example`). The example file ships placeholder values
(`your_mysql_username`, `your_mysql_password`); the app refuses to start with them and tells you to replace them.

## 3. Install, initialise, run

```powershell
npm install
npm run db:init      # tables + indexes + constraints (idempotent)
npm run db:seed      # demo township, EMPTY database only
npm start            # backend + frontend on http://localhost:3000  (or the PORT in .env)
npm test
```

The frontend is static files in `public/`, served by the same process — there is no separate frontend build.
`npm start` also initialises the schema and loads the demo data into an empty database on boot.

Useful: `npm run db:reset` (wipe + reload demo — destructive), `npm run db:export` (JSON backup),
`node scripts/db.js import-json legacy.json` (migrate an old JSON snapshot into an empty database),
`database/seed.sql` (plain SQL alternative to the seed command, run after `schema.sql`).

`npm run dev:sqlite` is a separate, optional evaluation mode that uses an in-memory SQLite engine (no MySQL needed, data is lost on exit).
MySQL is the default and the only engine `npm start` and `npm run db:*` use.

## 4. Migrating an existing JSON deployment

1. Stop the old app and copy its `data/nestora.json`.
2. `npm run db:init`
3. `node scripts/db.js import-json data/nestora.json`
   (old category *Housekeeping* → *Cleaning*, priority *Critical* → *Emergency*; refuses a non-empty database).
4. Start the new app and verify balances on the dashboard.

## 5. Demo logins

OTP is always `123456`. Residents `9000000001` (Neeraj), `9000000002` (Swati), `9000000003` (Aamir);
help desk `9000000010`; committee `9000000020`; guard `9000000030`.

**Disable demo mode for real use:** set `SEED_DEMO_DATA=false`, do not use the demo accounts, and replace the
demo OTP with a real SMS gateway (see TDD, *Limitations*). The demo OTP is not secure.

## 6. Deployment

* Run behind HTTPS (nginx / Caddy / a managed load balancer). The app sets security headers but does not terminate TLS.
* Set `NODE_ENV=production` and `JWT_SECRET`. This also disables `/api/demo/reset`.
* Keep **one** app instance or share a single MySQL — the app is stateless except for in-memory OTP/rate-limit counters
  (use a sticky session or move them to Redis before scaling out).
* Back up MySQL nightly (`mysqldump --single-transaction nestora`). Visitor photos live in the database and are deleted after 90 days by the hourly job.
* Example systemd unit:

```ini
[Service]
WorkingDirectory=/opt/nestora
EnvironmentFile=/etc/nestora.env
ExecStart=/usr/bin/node server/index.js
Restart=always
User=nestora
```

* Health check: `GET /api/health` → `{ "ok": true, "database": "mysql" }`.
* AI status for staff: `GET /api/ai/status` (mode `groq` or `keyword`, never the key).

## 7. Tests

```bash
npm test
```

## Troubleshooting

* `DATABASE_URL is not set` — there is no `.env` in the project root (`Copy-Item .env.example .env`), or it is empty.
* `DB_PASSWORD in .env is still the example placeholder` — edit `.env` and put your real MySQL password there.
* `MySQL rejected DB_USERNAME / DB_PASSWORD` — wrong credentials; test them with `mysql -u <user> -p`.
* `Cannot reach MySQL at localhost:3306` — start the service (Windows: `Get-Service MySQL80`, then `Start-Service MySQL80` in an Administrator PowerShell).
* `Database "nestora_db" does not exist` — run the `CREATE DATABASE` statement in step 1.
* `The "mysql2" package is not installed` — run `npm install`.
* AI shows *Keyword fallback* on every complaint — `GROQ_API_KEY` is missing, wrong, rate-limited, or the model name is no longer
  offered by Groq; check `GET /api/ai/status` and the server log (errors are logged without keys or complaint text).
