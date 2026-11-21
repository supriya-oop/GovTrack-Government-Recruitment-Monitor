import { db, initSchema } from './db.ts';
import { hashPassword } from './auth.ts';

export const ALLOWED_SOURCE_CODES = [
  'upsc',
  'ssc',
  'ibps',
  'sbi',
  'rrbcdg',
  'employmentnews',
  'nta',
  'tnpsc',
  'keralapsc',
  'rpsc',
  'tnusrb',
  'rbi',
  'indiapost',
] as const;

export const DEFAULT_SOURCES = [
  {
    code: 'upsc',
    name: 'UPSC Active Examinations & Notifications',
    organization_name: 'Union Public Service Commission (UPSC)',
    base_url: 'https://upsc.gov.in/active-examinations/',
    source_type: 'HTML Scraper',
    parser_key: 'upsc',
    fixture_filename: 'upsc.html',
    scrape_mode: 'live',
    crawl_interval_minutes: 360,
    rate_limit_seconds: 2,
    robots_policy: 'Respect robots.txt · User-Agent GovTrackMonitor/1.0 · Max 1 req/2s',
    permission_note: 'Official Government Portal · Academic monitoring & link attribution only.',
  },
  {
    code: 'ssc',
    name: 'SSC Latest Recruitment Notices',
    organization_name: 'Staff Selection Commission (SSC)',
    base_url: 'https://ssc.gov.in/',
    source_type: 'REST API + HTML',
    parser_key: 'ssc',
    fixture_filename: 'ssc.html',
    scrape_mode: 'live',
    crawl_interval_minutes: 360,
    rate_limit_seconds: 2,
    robots_policy: 'Respect robots.txt · Public JSON/HTML portal · Rate limited 2s',
    permission_note: 'Official SSC recruitment portal · Official PDFs linked directly.',
  },
  {
    code: 'ibps',
    name: 'IBPS CRP Banking Recruitments',
    organization_name: 'Institute of Banking Personnel Selection (IBPS)',
    base_url: 'https://www.ibps.in/',
    source_type: 'HTML Scraper',
    parser_key: 'ibps',
    fixture_filename: 'ibps.html',
    scrape_mode: 'live',
    crawl_interval_minutes: 360,
    rate_limit_seconds: 2,
    robots_policy: 'Respect robots.txt · Public notice links · Stop immediately on 403/429',
    permission_note: 'Official banking exam portal · Links directly to ibps.in.',
  },
  {
    code: 'sbi',
    name: 'SBI Careers — Current Openings',
    organization_name: 'State Bank of India (SBI)',
    base_url: 'https://sbi.co.in/web/careers/current-openings',
    source_type: 'HTML Scraper',
    parser_key: 'sbi',
    fixture_filename: 'sbi.html',
    scrape_mode: 'live',
    crawl_interval_minutes: 360,
    rate_limit_seconds: 2,
    robots_policy: 'Respect robots.txt · Public SBI Careers notices · Rate limited 2s',
    permission_note: 'Official SBI Careers portal · Attribution and PDF link preserved.',
  },
  {
    code: 'rrbcdg',
    name: 'RRB — Railway Recruitment Notices',
    organization_name: 'Railway Recruitment Board (RRB)',
    base_url: 'https://www.rrbcdg.gov.in/',
    source_type: 'HTML Scraper',
    parser_key: 'rrbcdg',
    fixture_filename: 'rrbcdg.html',
    scrape_mode: 'live',
    crawl_interval_minutes: 360,
    rate_limit_seconds: 2,
    robots_policy: 'Respect robots.txt · Official Ministry of Railways RRB portal',
    permission_note: 'Official government railway recruitment portal · Links directly to CEN notices.',
  },
  {
    code: 'employmentnews',
    name: 'Employment News — Weekly Government Gazette',
    organization_name: 'Employment News (Ministry of I&B)',
    base_url: 'https://employmentnews.gov.in/NewEmp/AllJobs.aspx?k=All',
    source_type: 'ASP.NET HTML',
    parser_key: 'employmentnews',
    fixture_filename: 'employmentnews.html',
    scrape_mode: 'live',
    crawl_interval_minutes: 360,
    rate_limit_seconds: 2,
    robots_policy: 'Respect robots.txt · Official Ministry of I&B publication · Rate limited 2s',
    permission_note: 'Official weekly Government of India recruitment gazette.',
  },
  {
    code: 'nta',
    name: 'NTA Public Notices & Entrance Examinations',
    organization_name: 'National Testing Agency (NTA)',
    base_url: 'https://nta.ac.in/',
    source_type: 'HTML Scraper',
    parser_key: 'nta',
    fixture_filename: 'nta.html',
    scrape_mode: 'live',
    crawl_interval_minutes: 360,
    rate_limit_seconds: 2,
    robots_policy: 'Respect robots.txt · Public NTA archive · Rate limited 2s',
    permission_note: 'Official National Testing Agency public notices.',
  },
  {
    code: 'tnpsc',
    name: 'TNPSC Annual Planner & Notifications',
    organization_name: 'Tamil Nadu Public Service Commission (TNPSC)',
    base_url: 'https://tnpsc.gov.in/web/examdashboard/index.aspx',
    source_type: 'ASP.NET HTML',
    parser_key: 'tnpsc',
    fixture_filename: 'tnpsc.html',
    scrape_mode: 'live',
    crawl_interval_minutes: 360,
    rate_limit_seconds: 2,
    robots_policy: 'Respect robots.txt · Public notifications table · Rate limited 2s',
    permission_note: 'Official Tamil Nadu state recruitment board.',
  },
  {
    code: 'keralapsc',
    name: 'Kerala PSC Gazette Notifications',
    organization_name: 'Kerala Public Service Commission (KPSC)',
    base_url: 'https://www.keralapsc.gov.in/notifications',
    source_type: 'HTML Scraper',
    parser_key: 'keralapsc',
    fixture_filename: 'keralapsc.html',
    scrape_mode: 'live',
    crawl_interval_minutes: 360,
    rate_limit_seconds: 2,
    robots_policy: 'Respect robots.txt · Public gazette notifications · Rate limited 2s',
    permission_note: 'Official Kerala Public Service Commission portal.',
  },
  {
    code: 'rpsc',
    name: 'RPSC Recruitment Advertisements & Press Notes',
    organization_name: 'Rajasthan Public Service Commission (RPSC)',
    base_url: 'https://rpsc.rajasthan.gov.in/advertisements',
    source_type: 'HTML Scraper',
    parser_key: 'rpsc',
    fixture_filename: 'rpsc.html',
    scrape_mode: 'live',
    crawl_interval_minutes: 360,
    rate_limit_seconds: 2,
    robots_policy: 'Respect robots.txt · Public RPSC advertisements · Stop immediately on 403',
    permission_note: 'Official Rajasthan Public Service Commission portal.',
  },
  {
    code: 'tnusrb',
    name: 'TNUSRB Uniformed Services Recruitment',
    organization_name: 'Tamil Nadu Uniformed Services Recruitment Board (TNUSRB)',
    base_url: 'https://www.tnusrb.tn.gov.in/',
    source_type: 'HTML Scraper',
    parser_key: 'tnusrb',
    fixture_filename: 'tnusrb.html',
    scrape_mode: 'live',
    crawl_interval_minutes: 360,
    rate_limit_seconds: 2,
    robots_policy: 'Respect robots.txt · Public recruitment announcements · Rate limited 2s',
    permission_note: 'Official Tamil Nadu Uniformed Services Recruitment Board.',
  },
  {
    code: 'rbi',
    name: 'RBI Opportunities — Current Vacancies',
    organization_name: 'Reserve Bank of India (RBI)',
    base_url: 'https://opportunities.rbi.org.in/Scripts/Vacancies.aspx',
    source_type: 'ASP.NET HTML',
    parser_key: 'rbi',
    fixture_filename: 'rbi.html',
    scrape_mode: 'live',
    crawl_interval_minutes: 360,
    rate_limit_seconds: 2,
    robots_policy: 'Respect robots.txt · Public RBI vacancies table · Rate limited 2s',
    permission_note: 'Official Reserve Bank of India recruitment opportunities portal.',
  },
  {
    code: 'indiapost',
    name: 'India Post GDS Online Engagement',
    organization_name: 'India Post — Department of Posts',
    base_url: 'https://indiapostgdsonline.gov.in/',
    source_type: 'HTML Scraper',
    parser_key: 'indiapost',
    fixture_filename: 'indiapost.html',
    scrape_mode: 'live',
    crawl_interval_minutes: 360,
    rate_limit_seconds: 2,
    robots_policy: 'Respect robots.txt · Public Department of Posts portal · Rate limited 2s',
    permission_note: 'Official Department of Posts public engagement notices.',
  },
];

export const DEFAULT_CATEGORIES = [
  { name: 'Civil Services', description: 'UPSC Civil Services, IFS, Engineering Services, CDS & NDA' },
  { name: 'Public Sector Banking', description: 'IBPS PO/Clerk/SO, SBI PO/Clerk/SO & Regional Rural Banks' },
  { name: 'Central Group B & C', description: 'SSC CGL, CHSL, MTS, GD Constable & Selection Posts' },
  { name: 'State Civil Services', description: 'TNPSC, Kerala PSC, RPSC & State Public Service Commissions' },
  { name: 'Defence & Police', description: 'TNUSRB Sub-Inspector, Police Constable, CAPF & Defence' },
  { name: 'Railway Recruitment', description: 'RRB NTPC, ALP, Technician, JE & Group D Notices' },
  { name: 'Higher Education & Testing', description: 'NTA UGC-NET, CUET, JEE, NEET & Fellowship Examinations' },
  { name: 'Postal Services', description: 'India Post Gramin Dak Sevak (GDS) & Postal Circle Openings' },
  { name: 'Regulatory Bodies', description: 'RBI Grade B, Assistant & Central Regulatory Notices' },
  { name: 'Employment Gazette', description: 'Weekly Central & PSU Notices via Employment News' },
];

export async function seedDatabase(): Promise<void> {
  initSchema();
  const now = new Date().toISOString();

  // Ensure default users
  const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@govtrack.in') as { id: number } | undefined;
  let adminId = adminExists?.id;
  if (!adminId) {
    const info = db
      .prepare(
        `INSERT INTO users (full_name, email, password_hash, role, target_exams, email_alerts_enabled, is_active, created_at)
         VALUES (?, ?, ?, 'admin', ?, 1, 1, ?)`
      )
      .run('GovTrack Administrator', 'admin@govtrack.in', hashPassword('Admin@2026'), 'UPSC, SSC, SBI, IBPS, RRB, NTA, TNPSC', now);
    adminId = Number(info.lastInsertRowid);
  }

  const aspirantExists = db.prepare('SELECT id FROM users WHERE email = ?').get('aspirant@govtrack.in') as { id: number } | undefined;
  let aspirantId = aspirantExists?.id;
  if (!aspirantId) {
    const info = db
      .prepare(
        `INSERT INTO users (full_name, email, password_hash, role, target_exams, email_alerts_enabled, is_active, created_at)
         VALUES (?, ?, ?, 'user', ?, 1, 1, ?)`
      )
      .run('Priya Nair (Aspirant)', 'aspirant@govtrack.in', hashPassword('Aspirant@2026'), 'UPSC Civil Services, SSC CGL, IBPS PO, SBI PO, TNPSC', now);
    aspirantId = Number(info.lastInsertRowid);
  }

  for (const uid of [adminId, aspirantId]) {
    if (!uid) continue;
    const prefExists = db.prepare('SELECT id FROM user_preferences WHERE user_id = ?').get(uid);
    if (!prefExists) {
      db.prepare(
        `INSERT INTO user_preferences (
          user_id, target_organizations, target_exams, qualification, job_categories,
          preferred_states, alert_priorities, saved_only_alerts, email_alerts_enabled,
          dark_mode, dashboard_page_size, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 0, 10, ?)`
      ).run(
        uid,
        JSON.stringify(['upsc', 'ssc', 'sbi', 'ibps', 'rrbcdg']),
        JSON.stringify(['Civil Services', 'Combined Graduate Level', 'Probationary Officer', 'Group IV']),
        'Graduate',
        JSON.stringify(['Civil Services', 'Public Sector Banking', 'Central Group B & C', 'State Civil Services']),
        JSON.stringify(['All India', 'Tamil Nadu']),
        JSON.stringify(['Critical', 'High', 'Normal']),
        now
      );
    }
  }

  // Ensure categories
  for (const cat of DEFAULT_CATEGORIES) {
    const exists = db.prepare('SELECT id FROM categories WHERE name = ?').get(cat.name);
    if (!exists) {
      db.prepare('INSERT INTO categories (name, description, created_at) VALUES (?, ?, ?)').run(
        cat.name,
        cat.description,
        now
      );
    }
  }

  const LEGACY_URLS = new Set([
    'https://upsc.gov.in/examinations/active-examinations',
    'https://www.nta.ac.in/NoticeBoard',
    'https://www.tnpsc.gov.in/English/Notification.aspx',
    'https://www.indiapost.gov.in/',
  ]);

  // Ensure all 13 official monitoring sources exist in live mode (preserve user-added sources)
  for (const src of DEFAULT_SOURCES) {
    const existing = db.prepare('SELECT id, base_url FROM monitoring_sources WHERE code = ?').get(src.code) as
      | { id: number; base_url: string }
      | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO monitoring_sources (
          code, name, organization_name, base_url, source_type, parser_key, fixture_filename,
          scrape_mode, crawl_interval_minutes, rate_limit_seconds, robots_policy, permission_note,
          is_active, is_demo_data, freshness_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, 1, 0, 'Pending', ?)`
      ).run(
        src.code,
        src.name,
        src.organization_name,
        src.base_url,
        src.source_type,
        src.parser_key,
        src.fixture_filename,
        src.crawl_interval_minutes,
        src.rate_limit_seconds,
        src.robots_policy,
        src.permission_note,
        now
      );
    } else {
      const nextUrl = LEGACY_URLS.has(String(existing.base_url)) ? src.base_url : String(existing.base_url);
      db.prepare(
        `UPDATE monitoring_sources
         SET source_type = ?, fixture_filename = ?, base_url = ?, scrape_mode = 'live', is_demo_data = 0
         WHERE id = ?`
      ).run(src.source_type, src.fixture_filename, nextUrl, existing.id);
    }
  }

  // 3. Purge ALL demo notifications (is_demo_data = 1) so only live official data is shown
  const demoNotifs = db
    .prepare('SELECT id FROM recruitment_notifications WHERE is_demo_data = 1')
    .all() as { id: number }[];
  for (const d of demoNotifs) {
    db.prepare('DELETE FROM alerts WHERE notification_id = ?').run(d.id);
    db.prepare('DELETE FROM change_history WHERE notification_id = ?').run(d.id);
    db.prepare('DELETE FROM notification_versions WHERE notification_id = ?').run(d.id);
    db.prepare('DELETE FROM saved_notifications WHERE notification_id = ?').run(d.id);
    db.prepare('DELETE FROM recruitment_notifications WHERE id = ?').run(d.id);
  }

  // 4. Purge any change_history rows without a known previous_value or from demo/NEW/noise events
  const invalidChangeIds = db
    .prepare(
      `SELECT id FROM change_history
       WHERE previous_value IS NULL
          OR TRIM(previous_value) = ''
          OR new_value IS NULL
          OR TRIM(new_value) = ''
          OR change_type = 'NEW'
          OR run_id IN (SELECT run_id FROM scrape_runs WHERE mode_used = 'fixture' OR trigger_type = 'demo_fixture')`
    )
    .all() as { id: number }[];
  for (const ch of invalidChangeIds) {
    db.prepare('DELETE FROM alerts WHERE change_id = ?').run(ch.id);
    db.prepare('DELETE FROM change_history WHERE id = ?').run(ch.id);
  }
  db.prepare("DELETE FROM alerts WHERE alert_type = 'NEW'").run();
  db.prepare('DELETE FROM alerts WHERE change_id IS NOT NULL AND change_id NOT IN (SELECT id FROM change_history)').run();
  db.prepare(
    "DELETE FROM alerts WHERE notification_id IS NOT NULL AND notification_id NOT IN (SELECT id FROM recruitment_notifications)"
  ).run();
}
