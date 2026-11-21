import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.SQLITE_DB_PATH
  ? path.resolve(process.cwd(), process.env.SQLITE_DB_PATH)
  : path.resolve(process.cwd(), 'govtrack.db');

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

export function initSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      target_exams TEXT DEFAULT 'UPSC, SSC, IBPS',
      email_alerts_enabled INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      target_organizations TEXT DEFAULT '["upsc","ssc","ibps"]',
      target_exams TEXT DEFAULT '["Civil Services","Combined Graduate Level","CRP PO/MT"]',
      qualification TEXT DEFAULT 'Graduate',
      job_categories TEXT DEFAULT '["Civil Services","Public Sector Banking","Central Group B & C"]',
      preferred_states TEXT DEFAULT '["All India"]',
      alert_priorities TEXT DEFAULT '["Critical","High","Normal","Low"]',
      saved_only_alerts INTEGER NOT NULL DEFAULT 0,
      email_alerts_enabled INTEGER NOT NULL DEFAULT 1,
      dark_mode INTEGER NOT NULL DEFAULT 0,
      dashboard_page_size INTEGER NOT NULL DEFAULT 10,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monitoring_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      organization_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'HTML Scraper',
      parser_key TEXT NOT NULL,
      fixture_filename TEXT NOT NULL,
      scrape_mode TEXT NOT NULL DEFAULT 'auto',
      crawl_interval_minutes INTEGER NOT NULL DEFAULT 360,
      rate_limit_seconds INTEGER NOT NULL DEFAULT 2,
      robots_policy TEXT NOT NULL,
      permission_note TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_demo_data INTEGER NOT NULL DEFAULT 1,
      freshness_status TEXT NOT NULL DEFAULT 'Pending',
      last_attempted_at TEXT,
      last_successful_at TEXT,
      last_http_status INTEGER,
      last_error TEXT,
      last_parsed_count INTEGER NOT NULL DEFAULT 0,
      last_duplicate_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recruitment_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES monitoring_sources(id) ON DELETE CASCADE,
      entity_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      organization_name TEXT NOT NULL,
      notification_number TEXT,
      vacancy_count TEXT,
      job_category TEXT,
      qualification TEXT,
      state TEXT,
      application_procedure TEXT,
      application_start_date TEXT,
      application_deadline TEXT,
      exam_date TEXT,
      admit_card_date TEXT,
      result_date TEXT,
      description TEXT,
      pdf_url TEXT,
      source_url TEXT NOT NULL,
      published_date TEXT,
      lifecycle_status TEXT NOT NULL DEFAULT 'active',
      is_removed INTEGER NOT NULL DEFAULT 0,
      missing_count INTEGER NOT NULL DEFAULT 0,
      is_demo_data INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      source_updated_at TEXT,
      last_run_id TEXT,
      UNIQUE(source_id, entity_key)
    );

    CREATE TABLE IF NOT EXISTS notification_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notification_id INTEGER NOT NULL REFERENCES recruitment_notifications(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      organization_name TEXT NOT NULL,
      notification_number TEXT,
      vacancy_count TEXT,
      job_category TEXT,
      qualification TEXT,
      state TEXT,
      application_start_date TEXT,
      application_deadline TEXT,
      exam_date TEXT,
      admit_card_date TEXT,
      result_date TEXT,
      description TEXT,
      pdf_url TEXT,
      source_url TEXT NOT NULL,
      published_date TEXT,
      notification_status TEXT NOT NULL DEFAULT 'active',
      content_hash TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      run_id TEXT,
      captured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS change_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      source_id INTEGER NOT NULL REFERENCES monitoring_sources(id) ON DELETE CASCADE,
      notification_id INTEGER REFERENCES recruitment_notifications(id) ON DELETE CASCADE,
      entity_key TEXT NOT NULL,
      notification_title TEXT NOT NULL,
      change_type TEXT NOT NULL,
      changed_field TEXT,
      change_label TEXT,
      previous_value TEXT,
      new_value TEXT,
      changed_fields_json TEXT NOT NULL,
      before_snapshot_json TEXT,
      after_snapshot_json TEXT,
      source_url TEXT NOT NULL,
      is_verified INTEGER NOT NULL DEFAULT 0,
      verified_by TEXT,
      detected_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id INTEGER REFERENCES change_history(id) ON DELETE CASCADE,
      source_id INTEGER NOT NULL REFERENCES monitoring_sources(id) ON DELETE CASCADE,
      notification_id INTEGER REFERENCES recruitment_notifications(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'Normal',
      severity TEXT NOT NULL DEFAULT 'info',
      dedup_key TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saved_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      notification_id INTEGER NOT NULL REFERENCES recruitment_notifications(id) ON DELETE CASCADE,
      notes TEXT,
      saved_at TEXT NOT NULL,
      UNIQUE(user_id, notification_id)
    );

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      source_id INTEGER NOT NULL REFERENCES monitoring_sources(id) ON DELETE CASCADE,
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      mode_used TEXT NOT NULL DEFAULT 'fixture',
      status TEXT NOT NULL,
      http_status INTEGER,
      parsed_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      removed_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monitoring_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      source_id INTEGER NOT NULL REFERENCES monitoring_sources(id) ON DELETE CASCADE,
      level TEXT NOT NULL DEFAULT 'INFO',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const ensureCol = (table: string, col: string, def: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def};`);
    }
  };

  ensureCol('monitoring_sources', 'source_type', "TEXT NOT NULL DEFAULT 'HTML Scraper'");
  ensureCol('recruitment_notifications', 'qualification', 'TEXT');
  ensureCol('recruitment_notifications', 'state', 'TEXT');
  ensureCol('recruitment_notifications', 'application_procedure', 'TEXT');
  ensureCol('notification_versions', 'qualification', 'TEXT');
  ensureCol('notification_versions', 'state', 'TEXT');
  ensureCol('change_history', 'changed_field', 'TEXT');
  ensureCol('change_history', 'change_label', 'TEXT');
  ensureCol('change_history', 'previous_value', 'TEXT');
  ensureCol('change_history', 'new_value', 'TEXT');
  ensureCol('alerts', 'priority', "TEXT NOT NULL DEFAULT 'Normal'");
  ensureCol('alerts', 'dedup_key', 'TEXT');
}
