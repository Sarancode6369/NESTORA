# NESTORA — Smart Township Management

Resident app, help desk, bank reconciliation and committee reporting for a gated Pune township
(2,400 apartments, 28 towers, 180 staff). Tagline: *Better Living. Smarter Communities.*

## What it does

| Area | Highlights |
|---|---|
| Resident | OTP sign-in (demo), dashboard, maintenance bill = area × ₹6.50, test-mode UPI/card/net-banking payments, partial payments, receipts, flat ledger, complaints with photos, visitors, guest codes, amenity booking, EN / हिन्दी / मराठी |
| Billing | Monthly bill generation, **configurable** late fees (none / flat / % per month / % per annum — nothing is assumed), oldest-first allocation of payments |
| Bank reconciliation | Upload a bank CSV → matched / partial / needs-review / unmatched / duplicate. Exact amount alone never confirms a match; **duplicate UTRs are blocked in code and by a database unique key**; nothing posts without a reference match or a human approval |
| Complaints | **Groq LLM classification** (category, priority, summary, department, suggested staff, confidence, explanation) with validation, one safe retry, and a deterministic keyword fallback. Safety rules (fire, gas leak, lift stuck, electric shock) escalate to the duty manager **independently of the AI** |
| Help desk | Queue, assignment, status, one-tap category / priority correction with an audit trail, manual-review queue, duplicate links (never closed) |
| Committee | Collections, dues ageing, resolution time, reopen %, monthly CSV report — all computed from database rows |
| Gate | Guard tablet with offline queue (idempotent replay), approvals, 90-day visitor-photo deletion (DPDP) |

## Architecture

```
 Browser (vanilla JS modules, PWA, i18n)         public/
        │  JSON over HTTPS, JWT bearer
        ▼
 HTTP API  server/app.js   routing · JWT · RBAC · validation · rate limits
        │
 Services  billing.js · matching.js · complaints.js · triage.js · analytics.js
        │                       │
        │              AI layer server/ai/  (Groq client → validator → classifier → keyword fallback)
        ▼
 Repositories  server/repos/   (all SQL lives here; parameterised)
        │
 DB adapter  server/db/   MySQL (mysql2) in production · SQLite (node:sqlite) for tests only
        ▼
 MySQL 8  database/schema.sql
```

JSON files are **not** a persistence layer. `database/fixtures/legacy-sample.json` and `scripts/db.js import-json`
exist only to migrate or hand over data.

## Technology

Node.js 22 (ES modules) · MySQL 8 (InnoDB, utf8mb4) · `mysql2` · Groq Chat Completions API · vanilla JS frontend
(no build step) · Canvas scroll-journey landing page · `node:test` for tests.

> The stack is Node/MySQL rather than Spring Boot/React: that is what the existing codebase is built on, and this
> upgrade deliberately keeps it (see `TDD.pdf`, *Assumptions*).

## Quick start

```powershell
npm install                      # installs mysql2
Copy-Item .env.example .env      # macOS/Linux: cp .env.example .env  - then edit .env (project root); names + placeholders only are committed
# create the database once (see deployment.md), then:
npm run db:init                  # create tables (idempotent)
npm run db:seed                  # load the demo township into an EMPTY database
npm start                        # http://localhost:3000
```

`npm start` also initialises the schema and loads demo data into an empty database
(set `SEED_DEMO_DATA=false` to skip). Full instructions: **deployment.md**.

No MySQL on your machine? `npm run dev:sqlite` runs the same app on an in-memory SQLite engine
(evaluation only; data is lost on exit).

## Configuration (names only — see `.env.example`)

`DATABASE_URL`, `DB_USERNAME`, `DB_PASSWORD`, `JWT_SECRET`, `PORT`, `GROQ_API_KEY`
and optional `GROQ_MODEL`, `AI_TIMEOUT_MS`, `AI_MIN_CONFIDENCE`, `AI_MAX_CALLS_PER_MIN`, `SEED_DEMO_DATA`, `NODE_ENV`.

## Database

26 tables, created by `database/schema.sql` (idempotent). Key protections enforced **by the database**:

* `flat_ledger.payment_ref` UNIQUE — a payment reference / UTR can be posted once
* `flat_ledger.receipt_no` UNIQUE, `flat_ledger.bank_txn_id` UNIQUE — no double posting
* `bank_transactions.utr_key` UNIQUE — one live row per UTR (re-imports are stored as `duplicate`)
* `maintenance_bills (flat_no, bill_period)` UNIQUE, CHECK constraints on enums and amounts, foreign keys throughout
* Every state-changing request runs in **one transaction** (payments, bank approvals, complaint creation, …)

Commands: `npm run db:init | db:seed | db:reset | db:export | db:seed-sql`; `node scripts/db.js import-json <file>`.

## AI complaint classification

1. Safety rules (regex, EN/HI/MR) run first and cannot be changed by the model.
2. The complaint is sent to Groq (`GROQ_API_KEY`, backend only) in JSON mode, temperature 0, with a timeout.
   No name, phone, e-mail or flat number is sent.
3. The answer is **validated** (enums, 0–1 confidence, lengths, staff must be on duty in the chosen department).
4. Invalid → one retry with the errors fed back → still invalid → keyword fallback.
   Network error / timeout / 401 / 429 / 5xx → keyword fallback. No key → keyword fallback (mock mode).
5. Confidence below `AI_MIN_CONFIDENCE` (default 0.6), or disagreement with the resident / keyword engine → *needs manual review*.
6. The AI can raise but never lower an emergency. Complaints are never auto-closed; duplicates are linked, never hidden.
7. Stored per complaint: result, `classification_method` (`groq_ai` / `keyword_fallback` / `manual`), model, confidence, explanation.
   Help-desk corrections are stored in `complaint_corrections` and `audit_logs`.

## API (all under `/api`, JSON; `Authorization: Bearer <jwt>` except public routes)

| Method & path | Roles |
|---|---|
| `POST /auth/request-otp`, `POST /auth/verify-otp` | public |
| `GET /me` | any signed-in |
| `GET /flats`, `GET /flats/:flat/{dashboard,ledger,bills,receipts}` | resident (own flat), help desk |
| `GET/PUT /config`, `POST /bills/generate`, `POST /latefees/apply` | help desk (GET also committee) |
| `POST /payments/checkout`, `POST /payments/:id/complete` | resident |
| `POST /bank/upload`, `GET /bank/transactions`, `POST /bank/transactions/:id/{approve,reject}`, `POST /bank/auto-post` | help desk |
| `POST /complaints`, `GET /complaints`, `GET /complaints/:id` | resident (own), help desk |
| `PATCH /complaints/:id/{category,priority,status,assign}`, `POST /complaints/:id/{confirm,unlink}` | help desk |
| `POST /complaints/:id/{rate,reopen}` | resident (own) |
| `GET /ai/status` | help desk, committee |
| `GET/POST /visitors…`, `/guest-codes…` | resident, guard, help desk (per route) |
| `GET/POST /notices`, `GET /amenities`, `/bookings…` | resident, help desk |
| `GET /analytics`, `GET /reports/monthly.csv`, `GET /audit` | committee, help desk |
| `GET /public/notices`, `GET /public/amenities`, `POST /contact`, `GET /health` | public |

Errors are `{ "error": "message" }` with 400 / 401 / 403 / 404 / 409 / 429; 500 never leaks internals.

## Tests

```bash
npm test          # 96 tests: 95 run on every machine, 1 live-Groq test runs only when GROQ_API_KEY is set
```

Tests execute `database/schema.sql` on an in-memory SQLite engine (real constraints, foreign keys and transactions).
They cover database connectivity, persistence, payment matching, duplicate UTR/payment-reference prevention,
AI classification, invalid-AI handling, API-failure fallback, emergency escalation, low-confidence review and
role-based authorisation. To run the same suite against MySQL, see *Testing* in `TDD.pdf`.

## Demo logins (demo OTP is always `123456`; no SMS is sent)

| Role | Mobile | Notes |
|---|---|---|
| Resident — Neeraj Kulkarni (owner) | 9000000001 | T07-1203, fully paid |
| Resident — Swati Joshi (tenant) | 9000000002 | T12-0408, ₹6,370 overdue 47 days, open water-leak complaint |
| Resident — Aamir Shaikh (owner) | 9000000003 | T21-1601, ₹5,660 outstanding, 18 days overdue |
| Help desk | 9000000010 | complaints, billing, reconciliation |
| Committee | 9000000020 | dashboards and reports |
| Gate guard | 9000000030 | guard tablet |

Names marked "(demo)" and the extra flats are fictional.

## Documents

`TDD.pdf` (technical design) · `deployment.md` (setup & deployment) · `.env.example` (variable names only)
