-- NESTORA relational schema (MySQL 8.0+, InnoDB, utf8mb4).
--
-- Conventions
--   * Business identifiers keep the human-readable ids the app already used
--     (U-001, BILL-0001, CMP-0001 ...). They are generated from the `counters` table inside the
--     same transaction that inserts the row, so they are gap-free and race-safe.
--   * Money is DECIMAL(12,2). Timestamps are DATETIME(3) in UTC. Calendar days are DATE.
--   * Every constraint that protects money lives here, not only in application code:
--       - uq_ledger_receipt        one receipt number per payment
--       - uq_ledger_payment_ref    a payment reference (test session id, UTR) can be posted once
--       - uq_ledger_bank_txn       one bank transaction can be posted to a ledger once
--       - uq_bank_txn_utr          a UTR has exactly one canonical bank-transaction row
--   * The file is written to be portable: the automated test-suite executes it unchanged on an
--     in-memory SQLite engine, so every statement here is exercised by `npm test`.
--     Indexes are therefore separate CREATE INDEX statements and there is no AUTO_INCREMENT.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version      VARCHAR(64)  NOT NULL,
  applied_at   DATETIME(3)  NOT NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS counters (
  name           VARCHAR(40) NOT NULL,
  current_value  BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key    VARCHAR(60)  NOT NULL,
  setting_value  VARCHAR(255) NOT NULL,
  updated_at     DATETIME(3)  NOT NULL,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS roles (
  code         VARCHAR(20) NOT NULL,
  description  VARCHAR(120) NOT NULL,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS flats (
  flat_no      VARCHAR(12)   NOT NULL,
  tower        SMALLINT      NOT NULL,
  area_sqft    DECIMAL(8,2)  NOT NULL,
  payment_ref  VARCHAR(40)   NULL,
  is_demo      TINYINT(1)    NOT NULL DEFAULT 0,
  PRIMARY KEY (flat_no),
  CONSTRAINT uq_flats_payment_ref UNIQUE (payment_ref),
  CONSTRAINT ck_flats_area CHECK (area_sqft > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS flat_upi_ids (
  upi_id   VARCHAR(80) NOT NULL,
  flat_no  VARCHAR(12) NOT NULL,
  PRIMARY KEY (upi_id),
  CONSTRAINT fk_upi_flat FOREIGN KEY (flat_no) REFERENCES flats (flat_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id          VARCHAR(12)  NOT NULL,
  name        VARCHAR(100) NOT NULL,
  phone       CHAR(10)     NOT NULL,
  role        VARCHAR(20)  NOT NULL,
  flat_no     VARCHAR(12)  NULL,
  relation    VARCHAR(20)  NULL,
  is_demo     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_users_phone UNIQUE (phone),
  CONSTRAINT fk_users_role FOREIGN KEY (role) REFERENCES roles (code),
  CONSTRAINT fk_users_flat FOREIGN KEY (flat_no) REFERENCES flats (flat_no),
  CONSTRAINT ck_users_relation CHECK (relation IS NULL OR relation IN ('owner','tenant','family'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS staff (
  id       VARCHAR(12)  NOT NULL,
  name     VARCHAR(100) NOT NULL,
  team     VARCHAR(20)  NOT NULL,
  phone    CHAR(10)     NOT NULL,
  on_duty  TINYINT(1)   NOT NULL DEFAULT 1,
  is_demo  TINYINT(1)   NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  CONSTRAINT ck_staff_team CHECK (team IN ('Plumbing','Electrical','Lift','Security','Cleaning','Civil','Other','Duty'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------------ billing & ledger
CREATE TABLE IF NOT EXISTS maintenance_bills (
  id          VARCHAR(16)   NOT NULL,
  flat_no     VARCHAR(12)   NOT NULL,
  bill_period CHAR(7)       NOT NULL,
  area_sqft   DECIMAL(8,2)  NOT NULL,
  rate        DECIMAL(8,2)  NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  issue_date  DATE          NOT NULL,
  due_date    DATE          NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_bill_flat_period UNIQUE (flat_no, bill_period),
  CONSTRAINT fk_bill_flat FOREIGN KEY (flat_no) REFERENCES flats (flat_no),
  CONSTRAINT ck_bill_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Test-mode checkout sessions (no card data is ever stored).
CREATE TABLE IF NOT EXISTS payment_sessions (
  id          VARCHAR(16)   NOT NULL,
  flat_no     VARCHAR(12)   NOT NULL,
  user_id     VARCHAR(12)   NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  status      VARCHAR(12)   NOT NULL,
  mode        VARCHAR(8)    NOT NULL DEFAULT 'TEST',
  receipt_no  VARCHAR(24)   NULL,
  created_at  DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_ps_flat FOREIGN KEY (flat_no) REFERENCES flats (flat_no),
  CONSTRAINT fk_ps_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT ck_ps_status CHECK (status IN ('created','paid','failed')),
  CONSTRAINT ck_ps_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX ix_ps_user ON payment_sessions (user_id);

-- ------------------------------------------------------------------ bank reconciliation
CREATE TABLE IF NOT EXISTS bank_statements (
  id             VARCHAR(16)  NOT NULL,
  filename       VARCHAR(200) NOT NULL,
  uploaded_at    DATETIME(3)  NOT NULL,
  uploaded_by    VARCHAR(12)  NULL,
  total_rows     INT          NOT NULL DEFAULT 0,
  ignored_debits INT          NOT NULL DEFAULT 0,
  parse_errors   JSON         NULL,
  status_counts  JSON         NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_bs_user FOREIGN KEY (uploaded_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bank_transactions (
  id               VARCHAR(16)   NOT NULL,
  statement_id     VARCHAR(16)   NOT NULL,
  line_no          INT           NULL,
  txn_date         DATE          NOT NULL,
  description      VARCHAR(500)  NULL,
  reference        VARCHAR(120)  NULL,
  utr_key          VARCHAR(80)   NULL,
  upi_id           VARCHAR(80)   NULL,
  amount           DECIMAL(12,2) NOT NULL,
  status           VARCHAR(14)   NOT NULL,
  flat_no          VARCHAR(12)   NULL,
  confidence       DECIMAL(4,2)  NOT NULL DEFAULT 0,
  reasons          JSON          NULL,
  suggested        JSON          NULL,
  fingerprint      VARCHAR(40)   NOT NULL,
  posted_receipt   VARCHAR(24)   NULL,
  posted_flat      VARCHAR(12)   NULL,
  rejected         TINYINT(1)    NOT NULL DEFAULT 0,
  reject_reason    VARCHAR(200)  NULL,
  reviewed_by      VARCHAR(12)   NULL,
  reviewed_at      DATETIME(3)   NULL,
  created_at       DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  -- utr_key is filled only on the canonical row for a UTR. Re-imports are stored as status
  -- 'duplicate' with utr_key NULL, so the same UTR can never be live twice.
  CONSTRAINT uq_bank_txn_utr UNIQUE (utr_key),
  CONSTRAINT fk_bt_statement FOREIGN KEY (statement_id) REFERENCES bank_statements (id),
  CONSTRAINT fk_bt_flat FOREIGN KEY (flat_no) REFERENCES flats (flat_no),
  CONSTRAINT fk_bt_posted_flat FOREIGN KEY (posted_flat) REFERENCES flats (flat_no),
  CONSTRAINT fk_bt_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id),
  CONSTRAINT ck_bt_status CHECK (status IN ('matched','partial','unmatched','needs_review','duplicate')),
  CONSTRAINT ck_bt_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX ix_bt_status ON bank_transactions (status);
CREATE INDEX ix_bt_fingerprint ON bank_transactions (fingerprint);
CREATE INDEX ix_bt_statement ON bank_transactions (statement_id);
CREATE INDEX ix_bt_flat ON bank_transactions (flat_no);


-- Flat-wise ledger. kind = bill | late_fee (charges) or payment (credits).
CREATE TABLE IF NOT EXISTS flat_ledger (
  id           VARCHAR(16)   NOT NULL,
  flat_no      VARCHAR(12)   NOT NULL,
  kind         VARCHAR(10)   NOT NULL,
  entry_date   DATE          NOT NULL,
  due_date     DATE          NULL,
  amount       DECIMAL(12,2) NOT NULL,
  bill_id      VARCHAR(16)   NULL,
  bill_period  CHAR(7)       NULL,
  method       VARCHAR(30)   NULL,
  reference    VARCHAR(80)   NULL,
  payment_ref  VARCHAR(80)   NULL,
  receipt_no   VARCHAR(24)   NULL,
  bank_txn_id  VARCHAR(16)   NULL,
  note         VARCHAR(255)  NULL,
  created_at   DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_ledger_receipt UNIQUE (receipt_no),
  CONSTRAINT uq_ledger_payment_ref UNIQUE (payment_ref),
  CONSTRAINT uq_ledger_bank_txn UNIQUE (bank_txn_id),
  CONSTRAINT fk_ledger_flat FOREIGN KEY (flat_no) REFERENCES flats (flat_no),
  CONSTRAINT fk_ledger_bill FOREIGN KEY (bill_id) REFERENCES maintenance_bills (id),
  CONSTRAINT fk_ledger_bank_txn FOREIGN KEY (bank_txn_id) REFERENCES bank_transactions (id),
  CONSTRAINT ck_ledger_kind CHECK (kind IN ('bill','late_fee','payment')),
  CONSTRAINT ck_ledger_amount CHECK (amount > 0),
  CONSTRAINT ck_ledger_payment_shape CHECK (kind <> 'payment' OR receipt_no IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX ix_ledger_flat_date ON flat_ledger (flat_no, entry_date);
CREATE INDEX ix_ledger_kind_date ON flat_ledger (kind, entry_date);
CREATE INDEX ix_ledger_bill ON flat_ledger (bill_id);

-- ------------------------------------------------------------------ complaints
CREATE TABLE IF NOT EXISTS complaints (
  id                    VARCHAR(12)   NOT NULL,
  flat_no               VARCHAR(12)   NOT NULL,
  tower                 SMALLINT      NOT NULL,
  title                 VARCHAR(120)  NOT NULL,
  description           VARCHAR(2000) NOT NULL,
  resident_category     VARCHAR(12)   NULL,
  category              VARCHAR(12)   NOT NULL,
  priority              VARCHAR(10)   NOT NULL,
  status                VARCHAR(14)   NOT NULL,
  summary               VARCHAR(300)  NULL,
  suggested_department  VARCHAR(20)   NULL,
  ai_category           VARCHAR(12)   NULL,
  ai_priority           VARCHAR(10)   NULL,
  ai_confidence         DECIMAL(4,2)  NULL,
  ai_explanation        VARCHAR(1000) NULL,
  classification_method VARCHAR(20)   NOT NULL,
  classification_model  VARCHAR(60)   NULL,
  needs_review          TINYINT(1)    NOT NULL DEFAULT 0,
  review_reasons        JSON          NULL,
  safety_rules          JSON          NULL,
  category_confirmed_by VARCHAR(12)   NULL,
  assignee_id           VARCHAR(12)   NULL,
  escalated_to          VARCHAR(12)   NULL,
  created_at            DATETIME(3)   NOT NULL,
  created_by            VARCHAR(12)   NULL,
  respond_by            DATETIME(3)   NOT NULL,
  first_response_at     DATETIME(3)   NULL,
  resolved_at           DATETIME(3)   NULL,
  linked_to             VARCHAR(12)   NULL,
  linked_similarity     DECIMAL(4,2)  NULL,
  reopen_count          INT           NOT NULL DEFAULT 0,
  is_demo               TINYINT(1)    NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  CONSTRAINT fk_cmp_flat FOREIGN KEY (flat_no) REFERENCES flats (flat_no),
  CONSTRAINT fk_cmp_assignee FOREIGN KEY (assignee_id) REFERENCES staff (id),
  CONSTRAINT fk_cmp_escalated FOREIGN KEY (escalated_to) REFERENCES staff (id),
  CONSTRAINT fk_cmp_creator FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT fk_cmp_link FOREIGN KEY (linked_to) REFERENCES complaints (id),
  CONSTRAINT ck_cmp_category CHECK (category IN ('Plumbing','Electrical','Lift','Security','Cleaning','Civil','Other')),
  CONSTRAINT ck_cmp_priority CHECK (priority IN ('Low','Medium','High','Emergency')),
  CONSTRAINT ck_cmp_status CHECK (status IN ('open','assigned','in_progress','resolved','reopened','escalated')),
  CONSTRAINT ck_cmp_method CHECK (classification_method IN ('groq_ai','keyword_fallback','manual')),
  CONSTRAINT ck_cmp_conf CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX ix_cmp_flat ON complaints (flat_no);
CREATE INDEX ix_cmp_status ON complaints (status);
CREATE INDEX ix_cmp_category ON complaints (category, priority);
CREATE INDEX ix_cmp_assignee ON complaints (assignee_id, status);
CREATE INDEX ix_cmp_created ON complaints (created_at);
CREATE INDEX ix_cmp_link ON complaints (linked_to);
CREATE INDEX ix_cmp_review ON complaints (needs_review, status);

CREATE TABLE IF NOT EXISTS complaint_photos (
  complaint_id  VARCHAR(12) NOT NULL,
  seq           INT         NOT NULL,
  data_uri      MEDIUMTEXT  NOT NULL,
  PRIMARY KEY (complaint_id, seq),
  CONSTRAINT fk_cph_complaint FOREIGN KEY (complaint_id) REFERENCES complaints (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every state change, assignment, link, escalation and classification event (append-only).
CREATE TABLE IF NOT EXISTS complaint_history (
  complaint_id  VARCHAR(12)  NOT NULL,
  seq           INT          NOT NULL,
  event_at      DATETIME(3)  NOT NULL,
  actor         VARCHAR(100) NOT NULL,
  action        VARCHAR(30)  NOT NULL,
  detail        VARCHAR(600) NULL,
  PRIMARY KEY (complaint_id, seq),
  CONSTRAINT fk_chi_complaint FOREIGN KEY (complaint_id) REFERENCES complaints (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Audit trail of human corrections to what the AI / fallback classifier decided.
CREATE TABLE IF NOT EXISTS complaint_corrections (
  id            VARCHAR(16)  NOT NULL,
  complaint_id  VARCHAR(12)  NOT NULL,
  field_name    VARCHAR(20)  NOT NULL,
  old_value     VARCHAR(40)  NULL,
  new_value     VARCHAR(40)  NOT NULL,
  method_before VARCHAR(20)  NULL,
  corrected_by  VARCHAR(12)  NOT NULL,
  corrected_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_cco_complaint FOREIGN KEY (complaint_id) REFERENCES complaints (id),
  CONSTRAINT fk_cco_user FOREIGN KEY (corrected_by) REFERENCES users (id),
  CONSTRAINT ck_cco_field CHECK (field_name IN ('category','priority'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX ix_cco_complaint ON complaint_corrections (complaint_id);

CREATE TABLE IF NOT EXISTS complaint_ratings (
  complaint_id  VARCHAR(12)  NOT NULL,
  rating        TINYINT      NOT NULL,
  comment_text  VARCHAR(300) NULL,
  rated_at      DATETIME(3)  NOT NULL,
  PRIMARY KEY (complaint_id),
  CONSTRAINT fk_cra_complaint FOREIGN KEY (complaint_id) REFERENCES complaints (id),
  CONSTRAINT ck_cra_rating CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------------ gate, community
CREATE TABLE IF NOT EXISTS visitors (
  id             VARCHAR(12)  NOT NULL,
  flat_no        VARCHAR(12)  NOT NULL,
  name           VARCHAR(100) NOT NULL,
  phone          VARCHAR(10)  NULL,
  purpose        VARCHAR(60)  NULL,
  photo_uri      MEDIUMTEXT   NULL,
  photo_deleted  TINYINT(1)   NOT NULL DEFAULT 0,
  status         VARCHAR(12)  NOT NULL,
  client_id      VARCHAR(60)  NULL,
  guest_code     CHAR(6)      NULL,
  created_at     DATETIME(3)  NOT NULL,
  created_by     VARCHAR(12)  NULL,
  decided_at     DATETIME(3)  NULL,
  decided_by     VARCHAR(12)  NULL,
  entry_at       DATETIME(3)  NULL,
  exit_at        DATETIME(3)  NULL,
  is_demo        TINYINT(1)   NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  CONSTRAINT uq_visitor_client UNIQUE (client_id),
  CONSTRAINT fk_vis_flat FOREIGN KEY (flat_no) REFERENCES flats (flat_no),
  CONSTRAINT ck_vis_status CHECK (status IN ('pending','approved','preapproved','denied','inside','exited'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX ix_vis_flat_created ON visitors (flat_no, created_at);
CREATE INDEX ix_vis_created ON visitors (created_at);

CREATE TABLE IF NOT EXISTS guest_codes (
  code        CHAR(6)      NOT NULL,
  flat_no     VARCHAR(12)  NOT NULL,
  guest_name  VARCHAR(100) NOT NULL,
  valid_date  DATE         NOT NULL,
  used        TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME(3)  NOT NULL,
  created_by  VARCHAR(12)  NOT NULL,
  PRIMARY KEY (code),
  CONSTRAINT fk_gc_flat FOREIGN KEY (flat_no) REFERENCES flats (flat_no),
  CONSTRAINT fk_gc_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX ix_gc_flat ON guest_codes (flat_no);

CREATE TABLE IF NOT EXISTS notices (
  id         VARCHAR(12)   NOT NULL,
  title      VARCHAR(100)  NOT NULL,
  body       VARCHAR(1000) NOT NULL,
  posted_at  DATETIME(3)   NOT NULL,
  posted_by  VARCHAR(100)  NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX ix_notices_posted ON notices (posted_at);

CREATE TABLE IF NOT EXISTS amenities (
  id          VARCHAR(12)   NOT NULL,
  name        VARCHAR(80)   NOT NULL,
  open_hour   TINYINT       NOT NULL,
  close_hour  TINYINT       NOT NULL,
  slot_hours  TINYINT       NOT NULL,
  fee         DECIMAL(10,2) NOT NULL DEFAULT 0,
  rules       VARCHAR(400)  NULL,
  PRIMARY KEY (id),
  CONSTRAINT ck_am_hours CHECK (open_hour < close_hour AND slot_hours > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bookings (
  id            VARCHAR(12)   NOT NULL,
  amenity_id    VARCHAR(12)   NOT NULL,
  flat_no       VARCHAR(12)   NOT NULL,
  booking_date  DATE          NOT NULL,
  start_hour    TINYINT       NOT NULL,
  end_hour      TINYINT       NOT NULL,
  fee           DECIMAL(10,2) NOT NULL DEFAULT 0,
  fee_status    VARCHAR(12)   NOT NULL DEFAULT 'payable',
  status        VARCHAR(12)   NOT NULL,
  -- slot_key is set only while status = 'booked' so a slot can be held by one booking at a time.
  slot_key      VARCHAR(40)   NULL,
  created_at    DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_booking_slot UNIQUE (slot_key),
  CONSTRAINT fk_bk_amenity FOREIGN KEY (amenity_id) REFERENCES amenities (id),
  CONSTRAINT fk_bk_flat FOREIGN KEY (flat_no) REFERENCES flats (flat_no),
  CONSTRAINT ck_bk_status CHECK (status IN ('booked','cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX ix_bk_flat ON bookings (flat_no, booking_date);

CREATE TABLE IF NOT EXISTS enquiries (
  id          VARCHAR(12)   NOT NULL,
  created_at  DATETIME(3)   NOT NULL,
  name        VARCHAR(80)   NOT NULL,
  phone       VARCHAR(10)   NULL,
  message     VARCHAR(1000) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notifications (
  id          VARCHAR(12)   NOT NULL,
  created_at  DATETIME(3)   NOT NULL,
  channel     VARCHAR(20)   NOT NULL,
  recipient   VARCHAR(40)   NOT NULL,
  message     VARCHAR(500)  NOT NULL,
  is_mock     TINYINT(1)    NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX ix_notif_created ON notifications (created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          VARCHAR(12)  NOT NULL,
  created_at  DATETIME(3)  NOT NULL,
  actor       VARCHAR(20)  NOT NULL,
  action      VARCHAR(40)  NOT NULL,
  detail      JSON         NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX ix_audit_created ON audit_logs (created_at);
CREATE INDEX ix_audit_action ON audit_logs (action);
