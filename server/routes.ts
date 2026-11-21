import { Router, type Request, type Response } from 'express';
import type { SQLInputValue } from 'node:sqlite';
import { db } from './db.ts';
import {
  createAccessToken,
  hashPassword,
  mapUserRow,
  optionalAuth,
  requireAdmin,
  requireAuth,
  verifyPassword,
  type AuthedRequest,
} from './auth.ts';
import { runSourceScrape } from './scraperEngine.ts';
import { buildNotificationPdf } from './pdfGenerator.ts';
import { discoverPdfUrlFromHtmlPage, fetchOfficialPdfBuffer } from './pdfExtractor.ts';

export const schedulerConfig = {
  intervalMinutes: Number(process.env.SCRAPE_INTERVAL_MINUTES || 360),
  enabled: true,
  lastRunAt: null as string | null,
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function diffDays(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}

export function computeStatusLabel(row: Record<string, unknown>): string {
  if (row.is_removed) return 'Removed';
  if (row.lifecycle_status === 'cancelled') return 'Cancelled';
  const today = todayIso();
  const start = row.application_start_date ? String(row.application_start_date).slice(0, 10) : null;
  const deadline = row.application_deadline ? String(row.application_deadline).slice(0, 10) : null;
  const exam = row.exam_date ? String(row.exam_date).slice(0, 10) : null;
  const admit = row.admit_card_date ? String(row.admit_card_date).slice(0, 10) : null;
  const result = row.result_date ? String(row.result_date).slice(0, 10) : null;

  const isIso = (s: string | null): s is string => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s));

  if (isIso(result) && result <= today) return 'Result Released';
  if (isIso(admit) && admit <= today && (!isIso(exam) || exam >= today)) return 'Admit Card Released';
  if (isIso(start) && start > today) return 'Opening Soon';
  if (isIso(deadline) && deadline >= today) {
    const days = diffDays(today, deadline);
    return days <= 7 ? 'Closing Soon' : 'Applications Open';
  }
  if (isIso(exam) && exam >= today) return 'Upcoming Exam';
  if (isIso(deadline) && deadline < today) return 'Closed';
  return 'Active Notice';
}

function enrichNotificationRow(row: Record<string, unknown>, savedIds?: Set<number>): Record<string, unknown> {
  const statusLabel = computeStatusLabel(row);
  const today = todayIso();
  const deadline = row.application_deadline ? String(row.application_deadline).slice(0, 10) : null;
  const exam = row.exam_date ? String(row.exam_date).slice(0, 10) : null;
  const daysToDeadline =
    deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? diffDays(today, deadline) : null;
  const daysToExam =
    exam && /^\d{4}-\d{2}-\d{2}$/.test(exam) ? diffDays(today, exam) : null;

  return {
    ...row,
    is_removed: Boolean(row.is_removed),
    is_demo_data: Boolean(row.is_demo_data),
    status_label: statusLabel,
    days_to_deadline: daysToDeadline,
    days_to_exam: daysToExam,
    is_saved: savedIds ? savedIds.has(Number(row.id)) : false,
  };
}

function getSavedSet(userId?: number): Set<number> {
  if (!userId) return new Set<number>();
  const rows = db
    .prepare('SELECT notification_id FROM saved_notifications WHERE user_id = ?')
    .all(userId) as { notification_id: number }[];
  return new Set(rows.map((r) => Number(r.notification_id)));
}

function safeJsonArray(raw: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return fallback;
}

function getUserPreferences(userId?: number) {
  const row = userId
    ? (db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined)
    : undefined;

  if (!row) {
    return {
      target_organizations: ['upsc', 'ssc', 'sbi', 'ibps', 'rrbcdg'],
      target_exams: ['Civil Services', 'Combined Graduate Level', 'Probationary Officer', 'Grade B'],
      qualification: 'Graduate',
      job_categories: ['Civil Services', 'Public Sector Banking', 'Central Group B & C', 'Regulatory Bodies'],
      preferred_states: ['All India'],
      alert_priorities: ['Critical', 'High', 'Normal', 'Low'],
      saved_only_alerts: false,
      email_alerts_enabled: true,
      dark_mode: false,
      dashboard_page_size: 10,
      updated_at: new Date().toISOString(),
    };
  }

  return {
    target_organizations: safeJsonArray(row.target_organizations, []),
    target_exams: safeJsonArray(row.target_exams, []),
    qualification: row.qualification ? String(row.qualification) : 'Graduate',
    job_categories: safeJsonArray(row.job_categories, []),
    preferred_states: safeJsonArray(row.preferred_states, ['All India']),
    alert_priorities: safeJsonArray(row.alert_priorities, ['Critical', 'High', 'Normal', 'Low']),
    saved_only_alerts: Boolean(row.saved_only_alerts),
    email_alerts_enabled: Boolean(row.email_alerts_enabled),
    dark_mode: Boolean(row.dark_mode),
    dashboard_page_size: Number(row.dashboard_page_size || 10),
    updated_at: String(row.updated_at || new Date().toISOString()),
  };
}

function scoreNotificationMatch(
  notif: Record<string, unknown>,
  prefs: ReturnType<typeof getUserPreferences>
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const sourceCode = String(notif.source_code || '').toLowerCase();
  const title = String(notif.title || '').toLowerCase();
  const cat = String(notif.job_category || '').toLowerCase();
  const qual = String(notif.qualification || '').toLowerCase();
  const state = String(notif.state || '').toLowerCase();

  if (prefs.target_organizations.some((o) => o.toLowerCase() === sourceCode)) {
    score += 35;
    reasons.push(`Target organization (${sourceCode.toUpperCase()})`);
  }

  for (const examKw of prefs.target_exams) {
    if (examKw.trim() && title.includes(examKw.trim().toLowerCase())) {
      score += 30;
      reasons.push(`Matches target exam "${examKw.trim()}"`);
      break;
    }
  }

  if (prefs.job_categories.some((c) => cat && (cat.includes(c.toLowerCase()) || c.toLowerCase().includes(cat)))) {
    score += 20;
    reasons.push(`Category match (${notif.job_category})`);
  }

  const prefQual = prefs.qualification.toLowerCase();
  if (qual) {
    if (
      qual.includes(prefQual) ||
      (prefQual.includes('graduate') && /10th|12th|diploma|graduate|any degree|bachelor/i.test(qual)) ||
      (prefQual.includes('post graduate') && /graduate|master|post graduate|10th|12th/i.test(qual)) ||
      (prefQual.includes('12th') && /10th|12th/i.test(qual))
    ) {
      score += 15;
      reasons.push(`Qualification compatible (${notif.qualification})`);
    }
  }

  if (
    state &&
    prefs.preferred_states.some(
      (s) => s.toLowerCase() === 'all india' || state.includes(s.toLowerCase()) || state === 'all india'
    )
  ) {
    score += 10;
    reasons.push(`Location match (${notif.state})`);
  }

  return { score, reasons };
}

function enrichSourceRow(row: Record<string, unknown>): Record<string, unknown> {
  const intervalMins = Number(row.crawl_interval_minutes || 360);
  const lastAttempt = row.last_attempted_at ? new Date(String(row.last_attempted_at)) : null;
  const nextScheduled = lastAttempt
    ? new Date(lastAttempt.getTime() + intervalMins * 60 * 1000).toISOString()
    : new Date(Date.now() + intervalMins * 60 * 1000).toISOString();

  const notifCount = db
    .prepare('SELECT COUNT(*) as cnt FROM recruitment_notifications WHERE source_id = ? AND is_removed = 0')
    .get(Number(row.id)) as { cnt: number };
  const changesCount = db
    .prepare('SELECT COUNT(*) as cnt FROM change_history WHERE source_id = ?')
    .get(Number(row.id)) as { cnt: number };

  return {
    ...row,
    is_active: Boolean(row.is_active),
    is_demo_data: Boolean(row.is_demo_data),
    notifications_count: Number(notifCount?.cnt || 0),
    changes_count: Number(changesCount?.cnt || 0),
    next_scheduled_at: nextScheduled,
  };
}

export function createApiRouter(): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'GovTrack API (Node.js)', timestamp: new Date().toISOString() });
  });

  // ==========================================
  // AUTHENTICATION & PROFILE
  // ==========================================
  router.post('/auth/register', (req: Request, res: Response) => {
    const { full_name, email, password, target_exams } = req.body || {};
    if (!full_name || String(full_name).trim().length < 2) {
      res.status(400).json({ detail: 'Full name must be at least 2 characters.' });
      return;
    }
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      res.status(400).json({ detail: 'Valid email address is required.' });
      return;
    }
    if (!password || String(password).length < 6) {
      res.status(400).json({ detail: 'Password must be at least 6 characters.' });
      return;
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
    if (existing) {
      res.status(409).json({ detail: 'An account with this email already exists.' });
      return;
    }
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO users (full_name, email, password_hash, role, target_exams, email_alerts_enabled, is_active, created_at)
         VALUES (?, ?, ?, 'user', ?, 1, 1, ?)`
      )
      .run(
        String(full_name).trim(),
        cleanEmail,
        hashPassword(String(password)),
        target_exams ? String(target_exams) : 'UPSC, SSC, IBPS',
        now
      );
    const userId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO user_preferences (
        user_id, target_organizations, target_exams, qualification, job_categories,
        preferred_states, alert_priorities, saved_only_alerts, email_alerts_enabled,
        dark_mode, dashboard_page_size, updated_at
      ) VALUES (?, ?, ?, 'Graduate', ?, ?, ?, 0, 1, 0, 10, ?)`
    ).run(
      userId,
      JSON.stringify(['upsc', 'ssc', 'sbi', 'ibps']),
      JSON.stringify(
        target_exams
          ? String(target_exams)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : ['Civil Services', 'CGL', 'PO']
      ),
      JSON.stringify(['Civil Services', 'Public Sector Banking', 'Central Group B & C']),
      JSON.stringify(['All India']),
      JSON.stringify(['Critical', 'High', 'Normal']),
      now
    );

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;
    const user = mapUserRow(row);
    const access_token = createAccessToken(user);
    res.status(201).json({ access_token, token_type: 'bearer', user });
  });

  router.post('/auth/login', (req: Request, res: Response) => {
    const { email, password } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail) as Record<string, unknown> | undefined;
    if (!row || !verifyPassword(String(password || ''), String(row.password_hash))) {
      res.status(401).json({ detail: 'Invalid email or password' });
      return;
    }
    if (!row.is_active) {
      res.status(403).json({ detail: 'Account is deactivated' });
      return;
    }
    const user = mapUserRow(row);
    const access_token = createAccessToken(user);
    res.json({ access_token, token_type: 'bearer', user });
  });

  router.get('/auth/me', requireAuth, (req: AuthedRequest, res: Response) => {
    res.json({
      ...req.user,
      preferences: getUserPreferences(req.user!.id),
    });
  });

  router.get('/profile', requireAuth, (req: AuthedRequest, res: Response) => {
    res.json({
      user: req.user,
      preferences: getUserPreferences(req.user!.id),
    });
  });

  router.put('/profile', requireAuth, (req: AuthedRequest, res: Response) => {
    const body = req.body || {};
    const userId = req.user!.id;
    const now = new Date().toISOString();

    const fullName = body.full_name !== undefined ? String(body.full_name).trim() : req.user!.full_name;
    const targetExamsStr = Array.isArray(body.target_exams)
      ? body.target_exams.join(', ')
      : body.target_exams !== undefined
        ? String(body.target_exams)
        : req.user!.target_exams;
    const emailAlerts =
      body.email_alerts_enabled !== undefined ? (body.email_alerts_enabled ? 1 : 0) : req.user!.email_alerts_enabled ? 1 : 0;

    db.prepare('UPDATE users SET full_name = ?, target_exams = ?, email_alerts_enabled = ? WHERE id = ?').run(
      fullName || req.user!.full_name,
      targetExamsStr,
      emailAlerts,
      userId
    );

    const currentPrefs = getUserPreferences(userId);
    const nextPrefs = {
      target_organizations: body.target_organizations !== undefined ? safeJsonArray(body.target_organizations) : currentPrefs.target_organizations,
      target_exams: body.target_exams !== undefined ? safeJsonArray(body.target_exams) : currentPrefs.target_exams,
      qualification: body.qualification !== undefined ? String(body.qualification) : currentPrefs.qualification,
      job_categories: body.job_categories !== undefined ? safeJsonArray(body.job_categories) : currentPrefs.job_categories,
      preferred_states: body.preferred_states !== undefined ? safeJsonArray(body.preferred_states) : currentPrefs.preferred_states,
      alert_priorities: body.alert_priorities !== undefined ? safeJsonArray(body.alert_priorities) : currentPrefs.alert_priorities,
      saved_only_alerts: body.saved_only_alerts !== undefined ? Boolean(body.saved_only_alerts) : currentPrefs.saved_only_alerts,
      email_alerts_enabled: body.email_alerts_enabled !== undefined ? Boolean(body.email_alerts_enabled) : currentPrefs.email_alerts_enabled,
      dark_mode: body.dark_mode !== undefined ? Boolean(body.dark_mode) : currentPrefs.dark_mode,
      dashboard_page_size: body.dashboard_page_size !== undefined ? Math.min(50, Math.max(5, Number(body.dashboard_page_size))) : currentPrefs.dashboard_page_size,
    };

    const prefRow = db.prepare('SELECT id FROM user_preferences WHERE user_id = ?').get(userId);
    if (prefRow) {
      db.prepare(
        `UPDATE user_preferences SET
          target_organizations = ?, target_exams = ?, qualification = ?, job_categories = ?,
          preferred_states = ?, alert_priorities = ?, saved_only_alerts = ?,
          email_alerts_enabled = ?, dark_mode = ?, dashboard_page_size = ?, updated_at = ?
        WHERE user_id = ?`
      ).run(
        JSON.stringify(nextPrefs.target_organizations),
        JSON.stringify(nextPrefs.target_exams),
        nextPrefs.qualification,
        JSON.stringify(nextPrefs.job_categories),
        JSON.stringify(nextPrefs.preferred_states),
        JSON.stringify(nextPrefs.alert_priorities),
        nextPrefs.saved_only_alerts ? 1 : 0,
        nextPrefs.email_alerts_enabled ? 1 : 0,
        nextPrefs.dark_mode ? 1 : 0,
        nextPrefs.dashboard_page_size,
        now,
        userId
      );
    } else {
      db.prepare(
        `INSERT INTO user_preferences (
          user_id, target_organizations, target_exams, qualification, job_categories,
          preferred_states, alert_priorities, saved_only_alerts, email_alerts_enabled,
          dark_mode, dashboard_page_size, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        userId,
        JSON.stringify(nextPrefs.target_organizations),
        JSON.stringify(nextPrefs.target_exams),
        nextPrefs.qualification,
        JSON.stringify(nextPrefs.job_categories),
        JSON.stringify(nextPrefs.preferred_states),
        JSON.stringify(nextPrefs.alert_priorities),
        nextPrefs.saved_only_alerts ? 1 : 0,
        nextPrefs.email_alerts_enabled ? 1 : 0,
        nextPrefs.dark_mode ? 1 : 0,
        nextPrefs.dashboard_page_size,
        now
      );
    }

    const updatedUser = mapUserRow(
      db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>
    );
    res.json({ user: updatedUser, preferences: getUserPreferences(userId) });
  });

  router.put('/profile/password', requireAuth, (req: AuthedRequest, res: Response) => {
    const { current_password, new_password } = req.body || {};
    if (!new_password || String(new_password).length < 6) {
      res.status(400).json({ detail: 'New password must be at least 6 characters.' });
      return;
    }
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as Record<string, unknown>;
    if (!verifyPassword(String(current_password || ''), String(row.password_hash))) {
      res.status(400).json({ detail: 'Current password is incorrect.' });
      return;
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      hashPassword(String(new_password)),
      req.user!.id
    );
    res.json({ status: 'updated' });
  });

  // ==========================================
  // DASHBOARD & ANALYTICS
  // ==========================================
  router.get('/dashboard', optionalAuth, (req: AuthedRequest, res: Response) => {
    const today = todayIso();
    const savedIds = getSavedSet(req.user?.id);
    const prefs = getUserPreferences(req.user?.id);

    const activeCount = (
      db
        .prepare("SELECT COUNT(*) as cnt FROM recruitment_notifications WHERE is_removed = 0 AND lifecycle_status != 'cancelled'")
        .get() as { cnt: number }
    ).cnt;

    const newDiscoveredRow = db
      .prepare("SELECT COUNT(*) as cnt FROM recruitment_notifications WHERE is_removed = 0 AND is_demo_data = 0 AND date(first_seen_at) >= date('now', '-7 days')")
      .get() as { cnt: number };
    const newRecentRow = newDiscoveredRow;
    const totalChanges = (
      db
        .prepare(
          "SELECT COUNT(*) as cnt FROM change_history WHERE previous_value IS NOT NULL AND TRIM(previous_value) != '' AND new_value IS NOT NULL AND TRIM(new_value) != '' AND change_type != 'NEW'"
        )
        .get() as { cnt: number }
    ).cnt;
    const upcomingDeadlinesCount = (
      db
        .prepare("SELECT COUNT(*) as cnt FROM recruitment_notifications WHERE is_removed = 0 AND lifecycle_status != 'cancelled' AND application_deadline GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND application_deadline >= ?")
        .get(today) as { cnt: number }
    ).cnt;
    const upcomingExamsCount = (
      db
        .prepare("SELECT COUNT(*) as cnt FROM recruitment_notifications WHERE is_removed = 0 AND lifecycle_status != 'cancelled' AND exam_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND exam_date >= ?")
        .get(today) as { cnt: number }
    ).cnt;
    const unreadAlerts = (db.prepare('SELECT COUNT(*) as cnt FROM alerts WHERE is_read = 0').get() as { cnt: number }).cnt;
    const healthySources = (
      db.prepare("SELECT COUNT(*) as cnt FROM monitoring_sources WHERE is_active = 1 AND freshness_status = 'Healthy'").get() as { cnt: number }
    ).cnt;
    const failedSources = (
      db
        .prepare("SELECT COUNT(*) as cnt FROM monitoring_sources WHERE is_active = 1 AND freshness_status IN ('Failed', 'Rate Limited')")
        .get() as { cnt: number }
    ).cnt;

    const upcomingDeadlinesRaw = db
      .prepare(
        `SELECT n.*, s.code as source_code, s.name as source_name
         FROM recruitment_notifications n
         JOIN monitoring_sources s ON s.id = n.source_id
         WHERE n.is_removed = 0 AND n.lifecycle_status != 'cancelled'
           AND n.application_deadline GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
           AND n.application_deadline >= ?
         ORDER BY n.application_deadline ASC
         LIMIT 8`
      )
      .all(today) as Record<string, unknown>[];

    const upcomingExamsRaw = db
      .prepare(
        `SELECT n.*, s.code as source_code, s.name as source_name
         FROM recruitment_notifications n
         JOIN monitoring_sources s ON s.id = n.source_id
         WHERE n.is_removed = 0 AND n.lifecycle_status != 'cancelled'
           AND n.exam_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
           AND n.exam_date >= ?
         ORDER BY n.exam_date ASC
         LIMIT 8`
      )
      .all(today) as Record<string, unknown>[];

    const latestNotificationsRaw = db
      .prepare(
        `SELECT n.*, s.code as source_code, s.name as source_name
         FROM recruitment_notifications n
         JOIN monitoring_sources s ON s.id = n.source_id
         WHERE n.is_removed = 0
         ORDER BY COALESCE(n.published_date, substr(n.first_seen_at, 1, 10)) DESC, n.id DESC
         LIMIT 8`
      )
      .all() as Record<string, unknown>[];

    const recentChanges = db
      .prepare(
        `SELECT c.*, s.code as source_code, s.organization_name
         FROM change_history c
         JOIN monitoring_sources s ON s.id = c.source_id
         WHERE c.previous_value IS NOT NULL
           AND TRIM(c.previous_value) != ''
           AND c.new_value IS NOT NULL
           AND TRIM(c.new_value) != ''
           AND c.change_type != 'NEW'
         ORDER BY c.detected_at DESC, c.id DESC
         LIMIT 10`
      )
      .all() as Record<string, unknown>[];

    const sourcesRaw = db.prepare('SELECT * FROM monitoring_sources ORDER BY id ASC').all() as Record<string, unknown>[];
    const sources = sourcesRaw.map(enrichSourceRow);

    // Chart 1: Notifications by Organization
    const byOrganization = db
      .prepare(
        `SELECT s.code, s.name, s.organization_name, COUNT(n.id) as count
         FROM monitoring_sources s
         LEFT JOIN recruitment_notifications n ON n.source_id = s.id AND n.is_removed = 0
         GROUP BY s.id
         ORDER BY count DESC, s.code ASC`
      )
      .all() as Record<string, unknown>[];

    // Chart 2: Recruitment trends over time (by published month / first_seen month)
    const trendsOverTime = db
      .prepare(
        `SELECT substr(COALESCE(published_date, first_seen_at), 1, 7) as month, COUNT(*) as count
         FROM recruitment_notifications
         WHERE is_removed = 0
         GROUP BY month
         ORDER BY month ASC
         LIMIT 12`
      )
      .all() as Record<string, unknown>[];

    // Chart 3: Change types distribution
    const changeTypesDist = db
      .prepare(
        `SELECT COALESCE(change_label, change_type) as label, change_type, COUNT(*) as count
         FROM change_history
         WHERE previous_value IS NOT NULL
           AND TRIM(previous_value) != ''
           AND new_value IS NOT NULL
           AND TRIM(new_value) != ''
           AND change_type != 'NEW'
         GROUP BY COALESCE(change_label, change_type), change_type
         ORDER BY count DESC`
      )
      .all() as Record<string, unknown>[];

    // Chart 4: Upcoming deadlines timeline (grouped by month)
    const deadlinesTimeline = db
      .prepare(
        `SELECT substr(application_deadline, 1, 7) as month, COUNT(*) as count, MIN(application_deadline) as next_date
         FROM recruitment_notifications
         WHERE is_removed = 0 AND lifecycle_status != 'cancelled'
           AND application_deadline GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
           AND application_deadline >= ?
         GROUP BY month
         ORDER BY month ASC
         LIMIT 8`
      )
      .all(today) as Record<string, unknown>[];

    // Personalized recommendations
    const allActive = db
      .prepare(
        `SELECT n.*, s.code as source_code, s.name as source_name
         FROM recruitment_notifications n
         JOIN monitoring_sources s ON s.id = n.source_id
         WHERE n.is_removed = 0 AND n.lifecycle_status != 'cancelled'`
      )
      .all() as Record<string, unknown>[];

    const recommendations = allActive
      .map((n) => {
        const { score, reasons } = scoreNotificationMatch(n, prefs);
        return {
          ...enrichNotificationRow(n, savedIds),
          match_score: score,
          match_reasons: reasons,
        };
      })
      .filter((r) => r.match_score > 0)
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, 6);

    const recentRuns = db
      .prepare(
        `SELECT r.*, s.code as source_code, s.name as source_name
         FROM scrape_runs r
         JOIN monitoring_sources s ON s.id = r.source_id
         ORDER BY r.completed_at DESC
         LIMIT 10`
      )
      .all() as Record<string, unknown>[];

    res.json({
      stats: {
        total_active_notifications: Number(activeCount),
        new_notifications_discovered: Number(newDiscoveredRow.cnt > 0 ? newDiscoveredRow.cnt : newRecentRow.cnt),
        new_change_events: Number(newDiscoveredRow.cnt),
        total_changes_detected: Number(totalChanges),
        upcoming_deadlines_count: Number(upcomingDeadlinesCount),
        upcoming_exams_count: Number(upcomingExamsCount),
        unread_alerts_count: Number(unreadAlerts),
        healthy_sources_count: Number(healthySources),
        failed_sources_count: Number(failedSources),
        total_sources_count: sources.length,
        demo_records_count: allActive.filter((r) => Boolean(r.is_demo_data)).length,
        live_records_count: allActive.filter((r) => !Boolean(r.is_demo_data)).length,
      },
      charts: {
        by_organization: byOrganization,
        trends_over_time: trendsOverTime,
        change_types_distribution: changeTypesDist,
        upcoming_deadlines_timeline: deadlinesTimeline,
      },
      upcoming_deadlines: upcomingDeadlinesRaw.map((r) => enrichNotificationRow(r, savedIds)),
      upcoming_examinations: upcomingExamsRaw.map((r) => enrichNotificationRow(r, savedIds)),
      latest_notifications: latestNotificationsRaw.map((r) => enrichNotificationRow(r, savedIds)),
      recent_changes: recentChanges.map((c) => ({
        ...c,
        changed_fields: JSON.parse(String(c.changed_fields_json || '[]')),
        is_verified: Boolean(c.is_verified),
      })),
      sources,
      recommendations,
      recent_runs: recentRuns,
    });
  });

  // ==========================================
  // PERSONALIZED OPPORTUNITIES TRACKER
  // ==========================================
  router.get('/opportunities', optionalAuth, (req: AuthedRequest, res: Response) => {
    const today = todayIso();
    const savedIds = getSavedSet(req.user?.id);
    const prefs = getUserPreferences(req.user?.id);

    const allActive = db
      .prepare(
        `SELECT n.*, s.code as source_code, s.name as source_name
         FROM recruitment_notifications n
         JOIN monitoring_sources s ON s.id = n.source_id
         WHERE n.is_removed = 0`
      )
      .all() as Record<string, unknown>[];

    const matched = allActive
      .map((n) => {
        const { score, reasons } = scoreNotificationMatch(n, prefs);
        const enriched = enrichNotificationRow(n, savedIds);
        return {
          ...enriched,
          application_deadline: enriched.application_deadline ? String(enriched.application_deadline) : null,
          exam_date: enriched.exam_date ? String(enriched.exam_date) : null,
          days_to_deadline: typeof enriched.days_to_deadline === 'number' ? enriched.days_to_deadline : null,
          match_score: score,
          match_reasons: reasons,
        };
      })
      .filter((r) => r.match_score >= 25)
      .sort((a, b) => b.match_score - a.match_score);

    const approachingDeadlines = matched
      .filter(
        (n) =>
          n.application_deadline &&
          /^\d{4}-\d{2}-\d{2}$/.test(n.application_deadline) &&
          n.application_deadline >= today &&
          (n.days_to_deadline ?? 999) <= 21
      )
      .sort((a, b) => String(a.application_deadline).localeCompare(String(b.application_deadline)));

    const upcomingExams = matched
      .filter(
        (n) =>
          n.exam_date &&
          /^\d{4}-\d{2}-\d{2}$/.test(n.exam_date) &&
          n.exam_date >= today
      )
      .sort((a, b) => String(a.exam_date).localeCompare(String(b.exam_date)));

    let savedChanges: Record<string, unknown>[] = [];
    if (savedIds.size > 0) {
      const idList = Array.from(savedIds);
      const placeholders = idList.map(() => '?').join(',');
      savedChanges = db
        .prepare(
          `SELECT c.*, s.code as source_code, s.organization_name
           FROM change_history c
           JOIN monitoring_sources s ON s.id = c.source_id
           WHERE c.notification_id IN (${placeholders})
             AND c.previous_value IS NOT NULL
             AND TRIM(c.previous_value) != ''
             AND c.new_value IS NOT NULL
             AND TRIM(c.new_value) != ''
             AND c.change_type != 'NEW'
           ORDER BY c.detected_at DESC
           LIMIT 20`
        )
        .all(...idList) as Record<string, unknown>[];
    }

    res.json({
      preferences: prefs,
      matched_notifications: matched,
      approaching_deadlines: approachingDeadlines,
      upcoming_exams: upcomingExams,
      saved_changes: savedChanges.map((c) => ({
        ...c,
        changed_fields: JSON.parse(String(c.changed_fields_json || '[]')),
        is_verified: Boolean(c.is_verified),
      })),
      summary: {
        total_matched: matched.length,
        approaching_deadlines_count: approachingDeadlines.length,
        upcoming_exams_count: upcomingExams.length,
        saved_changes_count: savedChanges.length,
      },
    });
  });

  // ==========================================
  // SMART DEADLINE TRACKER / CALENDAR
  // ==========================================
  router.get('/calendar', optionalAuth, (req: AuthedRequest, res: Response) => {
    const sourceCode = String(req.query.source_code || '').trim().toLowerCase();
    const eventType = String(req.query.event_type || '').trim().toLowerCase();
    const today = todayIso();

    const where: string[] = ['n.is_removed = 0'];
    const params: SQLInputValue[] = [];
    if (sourceCode) {
      where.push('s.code = ?');
      params.push(sourceCode);
    }

    const rows = db
      .prepare(
        `SELECT n.*, s.code as source_code, s.name as source_name
         FROM recruitment_notifications n
         JOIN monitoring_sources s ON s.id = n.source_id
         WHERE ${where.join(' AND ')}`
      )
      .all(...params) as Record<string, unknown>[];

    const events: {
      id: string;
      notification_id: number;
      title: string;
      organization_name: string;
      source_code: string;
      event_type: 'deadline' | 'exam' | 'admit_card' | 'result';
      event_label: string;
      date: string;
      days_remaining: number;
      is_upcoming: boolean;
      status_label: string;
    }[] = [];

    for (const row of rows) {
      const statusLabel = computeStatusLabel(row);
      const candidates: { type: 'deadline' | 'exam' | 'admit_card' | 'result'; label: string; raw: unknown }[] = [
        { type: 'deadline', label: 'Application Deadline', raw: row.application_deadline },
        { type: 'exam', label: 'Examination Date', raw: row.exam_date },
        { type: 'admit_card', label: 'Admit Card Release', raw: row.admit_card_date },
        { type: 'result', label: 'Result Date', raw: row.result_date },
      ];
      for (const c of candidates) {
        if (!c.raw) continue;
        const dateStr = String(c.raw).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
        if (eventType && eventType !== c.type) continue;
        const days = diffDays(today, dateStr);
        events.push({
          id: `${row.id}-${c.type}`,
          notification_id: Number(row.id),
          title: String(row.title),
          organization_name: String(row.organization_name),
          source_code: String(row.source_code),
          event_type: c.type,
          event_label: c.label,
          date: dateStr,
          days_remaining: days,
          is_upcoming: days >= 0 && row.lifecycle_status !== 'cancelled',
          status_label: statusLabel,
        });
      }
    }

    events.sort((a, b) => a.date.localeCompare(b.date));
    res.json({
      events,
      upcoming_events: events.filter((e) => e.is_upcoming),
      today,
    });
  });

  // ==========================================
  // RECRUITMENT NOTIFICATIONS
  // ==========================================
  router.get('/notifications', optionalAuth, (req: AuthedRequest, res: Response) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const sourceCode = String(req.query.source_code || '').trim().toLowerCase();
    const category = String(req.query.category || '').trim();
    const qualification = String(req.query.qualification || '').trim();
    const state = String(req.query.state || '').trim();
    const appStatus = String(req.query.app_status || '').trim();
    const statusFilter = String(req.query.status_filter || '').trim().toLowerCase();
    const sort = String(req.query.sort || 'newest').trim();
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(50, Math.max(1, Number(req.query.page_size || 12)));

    const savedIds = getSavedSet(req.user?.id);
    const where: string[] = ['1=1'];
    const params: SQLInputValue[] = [];

    if (sourceCode) {
      where.push('s.code = ?');
      params.push(sourceCode);
    }
    if (category) {
      where.push('n.job_category = ?');
      params.push(category);
    }
    if (qualification) {
      where.push('LOWER(COALESCE(n.qualification, \'\')) LIKE ?');
      params.push(`%${qualification.toLowerCase()}%`);
    }
    if (state) {
      where.push('LOWER(COALESCE(n.state, \'\')) LIKE ?');
      params.push(`%${state.toLowerCase()}%`);
    }
    if (statusFilter === 'removed') {
      where.push('n.is_removed = 1');
    } else if (statusFilter === 'cancelled') {
      where.push("n.lifecycle_status = 'cancelled'");
    } else if (statusFilter !== 'all') {
      where.push('n.is_removed = 0');
    }
    if (q) {
      const like = `%${q}%`;
      where.push(
        '(LOWER(n.title) LIKE ? OR LOWER(n.organization_name) LIKE ? OR LOWER(COALESCE(n.notification_number, \'\')) LIKE ? OR LOWER(COALESCE(n.description, \'\')) LIKE ? OR LOWER(COALESCE(n.job_category, \'\')) LIKE ?)'
      );
      params.push(like, like, like, like, like);
    }

    const rows = db
      .prepare(
        `SELECT n.*, s.code as source_code, s.name as source_name, s.freshness_status
         FROM recruitment_notifications n
         JOIN monitoring_sources s ON s.id = n.source_id
         WHERE ${where.join(' AND ')}`
      )
      .all(...params) as Record<string, unknown>[];

    let items = rows.map((r) => enrichNotificationRow(r, savedIds));

    if (appStatus) {
      items = items.filter((item) => String(item.status_label).toLowerCase() === appStatus.toLowerCase());
    }
    if (statusFilter === 'open') {
      items = items.filter(
        (item) => item.status_label === 'Applications Open' || item.status_label === 'Closing Soon'
      );
    } else if (statusFilter === 'closing_soon') {
      items = items.filter((item) => item.status_label === 'Closing Soon');
    } else if (statusFilter === 'upcoming_exam') {
      items = items.filter(
        (item) =>
          item.exam_date &&
          /^\d{4}-\d{2}-\d{2}$/.test(String(item.exam_date)) &&
          String(item.exam_date) >= todayIso()
      );
    }

    // Dynamic sorting
    if (sort === 'deadline') {
      items.sort((a, b) => {
        const da = a.application_deadline && /^\d{4}-\d{2}-\d{2}$/.test(String(a.application_deadline))
          ? String(a.application_deadline)
          : '9999-12-31';
        const dbDate = b.application_deadline && /^\d{4}-\d{2}-\d{2}$/.test(String(b.application_deadline))
          ? String(b.application_deadline)
          : '9999-12-31';
        return da.localeCompare(dbDate);
      });
    } else if (sort === 'exam_date') {
      items.sort((a, b) => {
        const ea = a.exam_date && /^\d{4}-\d{2}-\d{2}$/.test(String(a.exam_date))
          ? String(a.exam_date)
          : '9999-12-31';
        const eb = b.exam_date && /^\d{4}-\d{2}-\d{2}$/.test(String(b.exam_date))
          ? String(b.exam_date)
          : '9999-12-31';
        return ea.localeCompare(eb);
      });
    } else {
      items.sort((a, b) => {
        const pa = String(a.published_date || String(a.first_seen_at).slice(0, 10));
        const pb = String(b.published_date || String(b.first_seen_at).slice(0, 10));
        if (pb !== pa) return pb.localeCompare(pa);
        return Number(b.id) - Number(a.id);
      });
    }

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;
    const paged = items.slice(offset, offset + pageSize);

    // Filter options from DB
    const orgs = db
      .prepare('SELECT code, organization_name FROM monitoring_sources ORDER BY organization_name ASC')
      .all() as Record<string, unknown>[];
    const categories = db
      .prepare('SELECT DISTINCT job_category FROM recruitment_notifications WHERE job_category IS NOT NULL ORDER BY job_category ASC')
      .all() as { job_category: string }[];
    const qualifications = db
      .prepare('SELECT DISTINCT qualification FROM recruitment_notifications WHERE qualification IS NOT NULL ORDER BY qualification ASC')
      .all() as { qualification: string }[];
    const states = db
      .prepare('SELECT DISTINCT state FROM recruitment_notifications WHERE state IS NOT NULL ORDER BY state ASC')
      .all() as { state: string }[];

    res.json({
      items: paged,
      total,
      page,
      page_size: pageSize,
      total_pages: totalPages,
      filters: {
        organizations: orgs,
        categories: categories.map((c) => c.job_category),
        qualifications: qualifications.map((qItem) => qItem.qualification),
        states: states.map((sItem) => sItem.state),
      },
    });
  });

  router.get('/notifications/:id', optionalAuth, (req: AuthedRequest, res: Response) => {
    const id = Number(req.params.id);
    const row = db
      .prepare(
        `SELECT n.*, s.code as source_code, s.name as source_name, s.freshness_status, s.base_url as source_base_url, s.source_type
         FROM recruitment_notifications n
         JOIN monitoring_sources s ON s.id = n.source_id
         WHERE n.id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({ detail: 'Notification not found' });
      return;
    }

    const savedIds = getSavedSet(req.user?.id);
    const versions = db
      .prepare('SELECT * FROM notification_versions WHERE notification_id = ? ORDER BY version_number DESC')
      .all(id) as Record<string, unknown>[];

    const changes = db
      .prepare(
        `SELECT * FROM change_history
         WHERE notification_id = ?
           AND previous_value IS NOT NULL
           AND TRIM(previous_value) != ''
           AND new_value IS NOT NULL
           AND TRIM(new_value) != ''
           AND change_type != 'NEW'
         ORDER BY detected_at DESC, id DESC`
      )
      .all(id) as Record<string, unknown>[];

    const relatedRaw = db
      .prepare(
        `SELECT n.*, s.code as source_code, s.name as source_name
         FROM recruitment_notifications n
         JOIN monitoring_sources s ON s.id = n.source_id
         WHERE n.id != ? AND n.is_removed = 0 AND (n.source_id = ? OR n.job_category = ?)
         ORDER BY n.published_date DESC
         LIMIT 4`
      )
      .all(id, Number(row.source_id), row.job_category ? String(row.job_category) : null) as Record<string, unknown>[];

    res.json({
      notification: enrichNotificationRow(row, savedIds),
      versions: versions.map((v) => ({
        ...v,
        snapshot: JSON.parse(String(v.snapshot_json || '{}')),
      })),
      changes: changes.map((c) => ({
        ...c,
        changed_fields: JSON.parse(String(c.changed_fields_json || '[]')),
        before_snapshot: c.before_snapshot_json ? JSON.parse(String(c.before_snapshot_json)) : null,
        after_snapshot: c.after_snapshot_json ? JSON.parse(String(c.after_snapshot_json)) : null,
        is_verified: Boolean(c.is_verified),
      })),
      related: relatedRaw.map((r) => enrichNotificationRow(r, savedIds)),
    });
  });

  router.get('/notifications/:id/pdf', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const row = db
      .prepare('SELECT * FROM recruitment_notifications WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Notification not found' });
      return;
    }
    const pdfBuffer = buildNotificationPdf(row);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="govtrack-notification-${id}.pdf"`);
    res.send(pdfBuffer);
  });

  router.get('/notifications/:id/official-pdf', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const row = db
      .prepare(
        `SELECT n.*, s.code as source_code
         FROM recruitment_notifications n
         JOIN monitoring_sources s ON s.id = n.source_id
         WHERE n.id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Notification not found' });
      return;
    }

    const sourceCode = String(row.source_code || 'gov');
    let targetPdfUrl = row.pdf_url ? String(row.pdf_url) : null;
    const sourceUrl = row.source_url ? String(row.source_url) : null;

    if (!targetPdfUrl && sourceUrl) {
      targetPdfUrl = await discoverPdfUrlFromHtmlPage(sourceUrl, { timeoutMs: 6000, retries: 0 });
      if (targetPdfUrl) {
        db.prepare('UPDATE recruitment_notifications SET pdf_url = ? WHERE id = ?').run(targetPdfUrl, id);
      }
    }

    if (targetPdfUrl) {
      const fetched = await fetchOfficialPdfBuffer(targetPdfUrl, sourceUrl, 25_000_000, {
        timeoutMs: 7500,
        retries: 0,
      });
      if (fetched) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="official-${sourceCode}-${id}.pdf"`);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('X-PDF-Origin', 'official-source');
        res.send(fetched.buffer);
        return;
      }
    }

    // Verified summary fallback when remote portal blocks proxy/is offline or circular has no direct PDF
    const fallbackPdf = buildNotificationPdf(row);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="govtrack-official-notice-${sourceCode}-${id}.pdf"`);
    res.setHeader('X-PDF-Origin', 'govtrack-verified-summary');
    res.send(fallbackPdf);
  });

  // ==========================================
  // REAL CHANGE HISTORY
  // ==========================================
  router.get('/changes', (req: Request, res: Response) => {
    const changeType = String(req.query.change_type || '').trim();
    const sourceCode = String(req.query.source_code || '').trim().toLowerCase();
    const changedField = String(req.query.changed_field || '').trim();
    const q = String(req.query.q || '').trim().toLowerCase();
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(50, Math.max(1, Number(req.query.page_size || 20)));

    const where: string[] = [
      "c.previous_value IS NOT NULL",
      "TRIM(c.previous_value) != ''",
      "c.new_value IS NOT NULL",
      "TRIM(c.new_value) != ''",
      "c.change_type != 'NEW'",
    ];
    const params: SQLInputValue[] = [];

    if (changeType) {
      where.push('(c.change_type = ? OR c.change_label = ?)');
      params.push(changeType, changeType);
    }
    if (sourceCode) {
      where.push('s.code = ?');
      params.push(sourceCode);
    }
    if (changedField) {
      where.push('c.changed_field = ?');
      params.push(changedField);
    }
    if (q) {
      const like = `%${q}%`;
      where.push('(LOWER(c.notification_title) LIKE ? OR LOWER(COALESCE(c.change_label, \'\')) LIKE ? OR LOWER(s.organization_name) LIKE ?)');
      params.push(like, like, like);
    }

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) as cnt
           FROM change_history c
           JOIN monitoring_sources s ON s.id = c.source_id
           WHERE ${where.join(' AND ')}`
        )
        .get(...params) as { cnt: number }
    ).cnt;

    const rows = db
      .prepare(
        `SELECT c.*, s.code as source_code, s.name as source_name, s.organization_name
         FROM change_history c
         JOIN monitoring_sources s ON s.id = c.source_id
         WHERE ${where.join(' AND ')}
         ORDER BY c.detected_at DESC, c.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];

    res.json({
      items: rows.map((r) => ({
        ...r,
        changed_fields: JSON.parse(String(r.changed_fields_json || '[]')),
        before_snapshot: r.before_snapshot_json ? JSON.parse(String(r.before_snapshot_json)) : null,
        after_snapshot: r.after_snapshot_json ? JSON.parse(String(r.after_snapshot_json)) : null,
        is_verified: Boolean(r.is_verified),
      })),
      total: Number(total),
      page,
      page_size: pageSize,
      total_pages: Math.max(1, Math.ceil(Number(total) / pageSize)),
    });
  });

  router.post('/changes/:id/verify', requireAdmin, (req: AuthedRequest, res: Response) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT id FROM change_history WHERE id = ?').get(id);
    if (!row) {
      res.status(404).json({ detail: 'Change record not found' });
      return;
    }
    db.prepare('UPDATE change_history SET is_verified = 1, verified_by = ? WHERE id = ?').run(req.user!.email, id);
    db.prepare('UPDATE alerts SET is_verified = 1 WHERE change_id = ?').run(id);
    res.json({ status: 'verified', verified_by: req.user!.email });
  });

  // Explicit Demo Change-Detection Simulation (replays real v2 updated offline HTML fixtures)
  router.post('/demo/run-change-detection', requireAuth, async (req: AuthedRequest, res: Response) => {
    const requestedFixture = req.body?.fixture ? String(req.body.fixture) : null;
    const requestedSource = req.body?.source_code ? String(req.body.source_code) : null;

    if (requestedSource && requestedFixture) {
      const src = db.prepare('SELECT * FROM monitoring_sources WHERE code = ?').get(requestedSource) as Record<string, unknown> | undefined;
      if (!src) {
        res.status(404).json({ detail: 'Source not found' });
        return;
      }
      const run = await runSourceScrape(src, {
        triggerType: 'demo_fixture',
        modeOverride: 'fixture',
        fixtureOverride: requestedFixture,
      });
      res.json({ runs: [run], demo_data: true });
      return;
    }

    const demoTargets = [
      { code: 'upsc', fixture: 'upsc_v2_updated.html' },
      { code: 'ssc', fixture: 'ssc_v2_updated.html' },
      { code: 'ibps', fixture: 'ibps_v2_updated.html' },
    ];
    const runs = [];
    for (const target of demoTargets) {
      const src = db.prepare('SELECT * FROM monitoring_sources WHERE code = ?').get(target.code) as Record<string, unknown> | undefined;
      if (src) {
        runs.push(
          await runSourceScrape(src, {
            triggerType: 'demo_fixture',
            modeOverride: 'fixture',
            fixtureOverride: target.fixture,
          })
        );
      }
    }
    res.json({ runs, demo_data: true });
  });

  // ==========================================
  // ALERTS CENTER
  // ==========================================
  router.get('/alerts', optionalAuth, (req: Request, res: Response) => {
    const unreadOnly = String(req.query.unread_only || '') === 'true';
    const alertType = String(req.query.alert_type || '').trim();
    const priority = String(req.query.priority || '').trim();
    const sourceCode = String(req.query.source_code || '').trim().toLowerCase();
    const q = String(req.query.q || '').trim().toLowerCase();

    const where: string[] = ['1=1'];
    const params: SQLInputValue[] = [];

    if (unreadOnly) where.push('a.is_read = 0');
    if (alertType) {
      where.push('a.alert_type = ?');
      params.push(alertType);
    }
    if (priority) {
      where.push('a.priority = ?');
      params.push(priority);
    }
    if (sourceCode) {
      where.push('s.code = ?');
      params.push(sourceCode);
    }
    if (q) {
      const like = `%${q}%`;
      where.push('(LOWER(a.title) LIKE ? OR LOWER(a.message) LIKE ?)');
      params.push(like, like);
    }

    const items = db
      .prepare(
        `SELECT a.*, s.code as source_code, s.organization_name
         FROM alerts a
         JOIN monitoring_sources s ON s.id = a.source_id
         WHERE ${where.join(' AND ')}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 100`
      )
      .all(...params) as Record<string, unknown>[];

    const unreadCount = (db.prepare('SELECT COUNT(*) as cnt FROM alerts WHERE is_read = 0').get() as { cnt: number }).cnt;

    res.json({
      items: items.map((a) => ({
        ...a,
        is_read: Boolean(a.is_read),
        is_verified: Boolean(a.is_verified),
      })),
      unread_count: Number(unreadCount),
    });
  });

  router.post('/alerts/:id/read', requireAuth, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const nextRead = req.body?.is_read === false ? 0 : 1;
    db.prepare('UPDATE alerts SET is_read = ? WHERE id = ?').run(nextRead, id);
    res.json({ status: nextRead ? 'read' : 'unread', is_read: Boolean(nextRead) });
  });

  router.post('/alerts/read-all', requireAuth, (_req: Request, res: Response) => {
    db.prepare('UPDATE alerts SET is_read = 1 WHERE is_read = 0').run();
    res.json({ status: 'all_read' });
  });

  router.delete('/alerts/:id', requireAuth, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
    res.json({ status: 'deleted' });
  });

  // ==========================================
  // MONITORING SOURCES
  // ==========================================
  router.get('/sources', (_req: Request, res: Response) => {
    const rows = db.prepare('SELECT * FROM monitoring_sources ORDER BY id ASC').all() as Record<string, unknown>[];
    res.json(rows.map(enrichSourceRow));
  });

  router.get('/sources/:id/logs', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const src = db.prepare('SELECT * FROM monitoring_sources WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!src) {
      res.status(404).json({ detail: 'Source not found' });
      return;
    }
    const runs = db
      .prepare('SELECT * FROM scrape_runs WHERE source_id = ? ORDER BY started_at DESC LIMIT 20')
      .all(id) as Record<string, unknown>[];
    const logs = db
      .prepare('SELECT * FROM monitoring_logs WHERE source_id = ? ORDER BY created_at DESC, id DESC LIMIT 60')
      .all(id) as Record<string, unknown>[];
    res.json({
      source: enrichSourceRow(src),
      runs,
      logs,
    });
  });

  router.post('/sources/:id/scrape', requireAuth, async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const src = db.prepare('SELECT * FROM monitoring_sources WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!src) {
      res.status(404).json({ detail: 'Source not found' });
      return;
    }
    const { mode, fixture, simulate_status } = req.body || {};
    const run = await runSourceScrape(src, {
      triggerType: 'manual',
      modeOverride: mode ? String(mode) : null,
      fixtureOverride: fixture ? String(fixture) : null,
      simulateHttpStatus: simulate_status ? Number(simulate_status) : null,
    });
    res.json(run);
  });

  router.post('/sources/scrape-all-live', requireAuth, async (_req: Request, res: Response) => {
    const sources = db
      .prepare('SELECT * FROM monitoring_sources WHERE is_active = 1 ORDER BY id ASC')
      .all() as Record<string, unknown>[];
    const runs = await Promise.all(
      sources.map((src) =>
        runSourceScrape(src, {
          triggerType: 'manual_live_all',
          modeOverride: 'live',
        })
      )
    );
    schedulerConfig.lastRunAt = new Date().toISOString();
    res.json({
      total_sources: sources.length,
      runs,
    });
  });

  router.post('/sources', requireAdmin, (req: Request, res: Response) => {
    const body = req.body || {};
    const code = String(body.code || '').trim().toLowerCase();
    const name = String(body.name || '').trim();
    const org = String(body.organization_name || '').trim();
    const baseUrl = String(body.base_url || '').trim();
    const parserKey = String(body.parser_key || code).trim();
    if (!code || !name || !org || !baseUrl) {
      res.status(400).json({ detail: 'code, name, organization_name, and base_url are required.' });
      return;
    }
    const exists = db.prepare('SELECT id FROM monitoring_sources WHERE code = ?').get(code);
    if (exists) {
      res.status(409).json({ detail: 'A monitoring source with this code already exists.' });
      return;
    }
    const info = db
      .prepare(
        `INSERT INTO monitoring_sources (
          code, name, organization_name, base_url, source_type, parser_key, fixture_filename,
          scrape_mode, crawl_interval_minutes, rate_limit_seconds, robots_policy, permission_note,
          is_active, is_demo_data, freshness_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'Pending', ?)`
      )
      .run(
        code,
        name,
        org,
        baseUrl,
        String(body.source_type || 'HTML Scraper'),
        parserKey,
        String(body.fixture_filename || `${code}.html`),
        String(body.scrape_mode || 'auto'),
        Number(body.crawl_interval_minutes || 360),
        Number(body.rate_limit_seconds || 2),
        String(body.robots_policy || 'Respect robots.txt · User-Agent GovTrackMonitor/1.0'),
        String(body.permission_note || 'Public official government portal.'),
        new Date().toISOString()
      );
    const created = db.prepare('SELECT * FROM monitoring_sources WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>;
    res.status(201).json(enrichSourceRow(created));
  });

  router.patch('/sources/:id', requireAdmin, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const src = db.prepare('SELECT * FROM monitoring_sources WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!src) {
      res.status(404).json({ detail: 'Source not found' });
      return;
    }
    const body = req.body || {};
    const nextActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : Number(src.is_active);
    const nextMode = body.scrape_mode !== undefined ? String(body.scrape_mode) : String(src.scrape_mode);
    const nextInterval =
      body.crawl_interval_minutes !== undefined ? Number(body.crawl_interval_minutes) : Number(src.crawl_interval_minutes);
    const nextRate = body.rate_limit_seconds !== undefined ? Number(body.rate_limit_seconds) : Number(src.rate_limit_seconds);
    const nextName = body.name !== undefined ? String(body.name) : String(src.name);
    const nextUrl = body.base_url !== undefined ? String(body.base_url) : String(src.base_url);
    const nextType = body.source_type !== undefined ? String(body.source_type) : String(src.source_type);
    const nextFreshness = nextActive === 0 ? 'Disabled' : src.freshness_status === 'Disabled' ? 'Pending' : String(src.freshness_status);

    db.prepare(
      `UPDATE monitoring_sources SET
        name = ?, base_url = ?, source_type = ?, is_active = ?, scrape_mode = ?,
        crawl_interval_minutes = ?, rate_limit_seconds = ?, freshness_status = ?
      WHERE id = ?`
    ).run(nextName, nextUrl, nextType, nextActive, nextMode, nextInterval, nextRate, nextFreshness, id);

    const updated = db.prepare('SELECT * FROM monitoring_sources WHERE id = ?').get(id) as Record<string, unknown>;
    res.json(enrichSourceRow(updated));
  });

  router.delete('/sources/:id', requireAdmin, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const src = db.prepare('SELECT id FROM monitoring_sources WHERE id = ?').get(id);
    if (!src) {
      res.status(404).json({ detail: 'Source not found' });
      return;
    }
    db.prepare('DELETE FROM monitoring_sources WHERE id = ?').run(id);
    res.json({ status: 'deleted' });
  });

  // ==========================================
  // SAVED NOTIFICATIONS
  // ==========================================
  router.get('/saved', requireAuth, (req: AuthedRequest, res: Response) => {
    const userId = req.user!.id;
    const rows = db
      .prepare(
        `SELECT sv.id as saved_id, sv.notes, sv.saved_at, n.*, s.code as source_code, s.name as source_name
         FROM saved_notifications sv
         JOIN recruitment_notifications n ON n.id = sv.notification_id
         JOIN monitoring_sources s ON s.id = n.source_id
         WHERE sv.user_id = ?
         ORDER BY sv.saved_at DESC`
      )
      .all(userId) as Record<string, unknown>[];

    const notifIds = rows.map((r) => Number(r.id));
    let savedAlerts: Record<string, unknown>[] = [];
    if (notifIds.length > 0) {
      const placeholders = notifIds.map(() => '?').join(',');
      savedAlerts = db
        .prepare(
          `SELECT a.*, s.code as source_code, s.organization_name
           FROM alerts a
           JOIN monitoring_sources s ON s.id = a.source_id
           WHERE a.notification_id IN (${placeholders})
           ORDER BY a.created_at DESC
           LIMIT 30`
        )
        .all(...notifIds) as Record<string, unknown>[];
    }

    const savedSet = new Set(notifIds);
    res.json({
      items: rows.map((r) => ({
        ...enrichNotificationRow(r, savedSet),
        saved_id: Number(r.saved_id),
        notes: r.notes ? String(r.notes) : '',
        saved_at: String(r.saved_at),
      })),
      saved_alerts: savedAlerts.map((a) => ({
        ...a,
        is_read: Boolean(a.is_read),
        is_verified: Boolean(a.is_verified),
      })),
    });
  });

  router.post('/saved/:notificationId', requireAuth, (req: AuthedRequest, res: Response) => {
    const notificationId = Number(req.params.notificationId);
    const notif = db.prepare('SELECT id FROM recruitment_notifications WHERE id = ?').get(notificationId);
    if (!notif) {
      res.status(404).json({ detail: 'Notification not found' });
      return;
    }
    const notes = req.body?.notes !== undefined ? String(req.body.notes) : null;
    const existing = db
      .prepare('SELECT id FROM saved_notifications WHERE user_id = ? AND notification_id = ?')
      .get(req.user!.id, notificationId) as { id: number } | undefined;

    if (existing) {
      if (notes !== null) {
        db.prepare('UPDATE saved_notifications SET notes = ? WHERE id = ?').run(notes, existing.id);
      }
      res.json({ status: 'updated', notification_id: notificationId });
      return;
    }

    db.prepare('INSERT INTO saved_notifications (user_id, notification_id, notes, saved_at) VALUES (?, ?, ?, ?)').run(
      req.user!.id,
      notificationId,
      notes,
      new Date().toISOString()
    );
    res.status(201).json({ status: 'saved', notification_id: notificationId });
  });

  router.delete('/saved/:notificationId', requireAuth, (req: AuthedRequest, res: Response) => {
    const notificationId = Number(req.params.notificationId);
    db.prepare('DELETE FROM saved_notifications WHERE user_id = ? AND notification_id = ?').run(
      req.user!.id,
      notificationId
    );
    res.json({ status: 'removed', notification_id: notificationId });
  });

  // ==========================================
  // ADMIN PANEL (Strict Role Guard)
  // ==========================================
  router.get('/admin/system-health', requireAdmin, (_req: Request, res: Response) => {
    const totalSources = (db.prepare('SELECT COUNT(*) as cnt FROM monitoring_sources').get() as { cnt: number }).cnt;
    const healthySources = (
      db.prepare("SELECT COUNT(*) as cnt FROM monitoring_sources WHERE is_active = 1 AND freshness_status = 'Healthy'").get() as { cnt: number }
    ).cnt;
    const failedSources = (
      db.prepare("SELECT COUNT(*) as cnt FROM monitoring_sources WHERE is_active = 1 AND freshness_status IN ('Failed', 'Rate Limited')").get() as { cnt: number }
    ).cnt;
    const disabledSources = (
      db.prepare('SELECT COUNT(*) as cnt FROM monitoring_sources WHERE is_active = 0').get() as { cnt: number }
    ).cnt;
    const totalRuns = (db.prepare('SELECT COUNT(*) as cnt FROM scrape_runs').get() as { cnt: number }).cnt;
    const failedRuns = (db.prepare("SELECT COUNT(*) as cnt FROM scrape_runs WHERE status != 'success'").get() as { cnt: number }).cnt;
    const totalNotifications = (db.prepare('SELECT COUNT(*) as cnt FROM recruitment_notifications').get() as { cnt: number }).cnt;
    const totalChanges = (db.prepare('SELECT COUNT(*) as cnt FROM change_history').get() as { cnt: number }).cnt;
    const unverifiedChanges = (db.prepare('SELECT COUNT(*) as cnt FROM change_history WHERE is_verified = 0').get() as { cnt: number }).cnt;
    const totalUsers = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt;

    res.json({
      total_sources: Number(totalSources),
      healthy_sources: Number(healthySources),
      failed_sources: Number(failedSources),
      disabled_sources: Number(disabledSources),
      total_runs: Number(totalRuns),
      failed_runs: Number(failedRuns),
      total_notifications: Number(totalNotifications),
      total_changes: Number(totalChanges),
      unverified_changes: Number(unverifiedChanges),
      total_users: Number(totalUsers),
      scheduler: schedulerConfig,
      node_version: process.version,
      uptime_seconds: Math.round(process.uptime()),
    });
  });

  router.get('/admin/runs', requireAdmin, (_req: Request, res: Response) => {
    const runs = db
      .prepare(
        `SELECT r.*, s.code as source_code, s.name as source_name
         FROM scrape_runs r
         JOIN monitoring_sources s ON s.id = r.source_id
         ORDER BY r.started_at DESC
         LIMIT 50`
      )
      .all() as Record<string, unknown>[];
    res.json(runs);
  });

  router.get('/admin/logs', requireAdmin, (req: Request, res: Response) => {
    const level = String(req.query.level || '').trim().toUpperCase();
    const where = level ? 'WHERE l.level = ?' : '';
    const logs = db
      .prepare(
        `SELECT l.*, s.code as source_code, s.name as source_name
         FROM monitoring_logs l
         JOIN monitoring_sources s ON s.id = l.source_id
         ${where}
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT 120`
      )
      .all(...(level ? [level] : [])) as Record<string, unknown>[];
    res.json(logs);
  });

  router.get('/admin/failures', requireAdmin, (_req: Request, res: Response) => {
    const failures = db
      .prepare(
        `SELECT r.*, s.code as source_code, s.name as source_name, s.base_url
         FROM scrape_runs r
         JOIN monitoring_sources s ON s.id = r.source_id
         WHERE r.status != 'success'
         ORDER BY r.started_at DESC
         LIMIT 50`
      )
      .all() as Record<string, unknown>[];
    res.json(failures);
  });

  router.get('/admin/users', requireAdmin, (_req: Request, res: Response) => {
    const rows = db.prepare('SELECT * FROM users ORDER BY id ASC').all() as Record<string, unknown>[];
    res.json(rows.map(mapUserRow));
  });

  router.patch('/admin/users/:userId', requireAdmin, (req: AuthedRequest, res: Response) => {
    const targetId = Number(req.params.userId);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as Record<string, unknown> | undefined;
    if (!target) {
      res.status(404).json({ detail: 'User not found' });
      return;
    }
    const { role, is_active } = req.body || {};
    if (role !== undefined) {
      if (role !== 'admin' && role !== 'user') {
        res.status(400).json({ detail: 'Role must be user or admin.' });
        return;
      }
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
    }
    if (is_active !== undefined) {
      if (targetId === req.user!.id && !is_active) {
        res.status(400).json({ detail: 'Cannot deactivate your own admin account.' });
        return;
      }
      db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, targetId);
    }
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as Record<string, unknown>;
    res.json(mapUserRow(updated));
  });

  router.get('/admin/scheduler', requireAdmin, (_req: Request, res: Response) => {
    res.json(schedulerConfig);
  });

  router.put('/admin/scheduler', requireAdmin, (req: Request, res: Response) => {
    const { interval_minutes, enabled } = req.body || {};
    if (interval_minutes !== undefined) {
      schedulerConfig.intervalMinutes = Math.max(15, Number(interval_minutes));
    }
    if (enabled !== undefined) {
      schedulerConfig.enabled = Boolean(enabled);
    }
    res.json(schedulerConfig);
  });

  router.post('/admin/scrape-all', requireAdmin, async (req: Request, res: Response) => {
    const mode = req.body?.mode ? String(req.body.mode) : 'auto';
    const sources = db
      .prepare('SELECT * FROM monitoring_sources WHERE is_active = 1 ORDER BY id ASC')
      .all() as Record<string, unknown>[];
    const runs = [];
    for (const src of sources) {
      runs.push(await runSourceScrape(src, { triggerType: 'admin_batch', modeOverride: mode }));
    }
    schedulerConfig.lastRunAt = new Date().toISOString();
    res.json({ runs });
  });

  router.get('/admin/categories', requireAdmin, (_req: Request, res: Response) => {
    const cats = db.prepare('SELECT * FROM categories ORDER BY name ASC').all();
    res.json(cats);
  });

  router.post('/admin/categories', requireAdmin, (req: Request, res: Response) => {
    const name = String(req.body?.name || '').trim();
    const description = req.body?.description ? String(req.body.description).trim() : null;
    if (!name) {
      res.status(400).json({ detail: 'Category name is required.' });
      return;
    }
    const exists = db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
    if (exists) {
      res.status(409).json({ detail: 'Category already exists.' });
      return;
    }
    const info = db
      .prepare('INSERT INTO categories (name, description, created_at) VALUES (?, ?, ?)')
      .run(name, description, new Date().toISOString());
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid));
  });

  router.delete('/admin/categories/:id', requireAdmin, (req: Request, res: Response) => {
    db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
    res.json({ status: 'deleted' });
  });

  router.delete('/admin/notifications/:id', requireAdmin, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const exists = db.prepare('SELECT id FROM recruitment_notifications WHERE id = ?').get(id);
    if (!exists) {
      res.status(404).json({ detail: 'Notification not found' });
      return;
    }
    db.prepare('DELETE FROM recruitment_notifications WHERE id = ?').run(id);
    res.json({ status: 'deleted' });
  });

  return router;
}
