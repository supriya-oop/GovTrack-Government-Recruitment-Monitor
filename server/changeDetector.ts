import crypto from 'node:crypto';
import { db } from './db.ts';
import type { ParsedNotification } from './scrapers/base.ts';

export const TRACKED_FIELDS = [
  'title',
  'organization_name',
  'notification_number',
  'vacancy_count',
  'job_category',
  'qualification',
  'state',
  'application_start_date',
  'application_deadline',
  'exam_date',
  'admit_card_date',
  'result_date',
  'description',
  'pdf_url',
  'source_url',
  'published_date',
  'notification_status',
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

const PRESERVABLE_FIELDS: readonly TrackedField[] = [
  'notification_number',
  'vacancy_count',
  'job_category',
  'qualification',
  'state',
  'application_start_date',
  'application_deadline',
  'exam_date',
  'admit_card_date',
  'result_date',
  'description',
  'pdf_url',
  'published_date',
];

const HISTORY_WORTHY_FIELDS = new Set<string>([
  'exam_date',
  'application_deadline',
  'application_start_date',
  'admit_card_date',
  'result_date',
  'vacancy_count',
  'qualification',
  'notification_status',
]);

export interface FieldDiff {
  field: string;
  old_value: string | null;
  new_value: string | null;
}

export function normalizeStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function resolveNotificationStatus(
  rawStatus: unknown,
  title: unknown,
  description: unknown
): string {
  const s = (normalizeStr(rawStatus) || '').toLowerCase();
  if (s === 'cancelled' || s === 'canceled' || s === 'withdrawn') return 'cancelled';
  if (s === 'removed') return 'removed';
  const combined = `${normalizeStr(title) || ''} ${normalizeStr(description) || ''}`;
  if (/\b(?:cancelled|canceled|withdrawn|annulled)\b/i.test(combined)) {
    return 'cancelled';
  }
  return 'active';
}

export function buildEntityKey(sourceCode: string, item: ParsedNotification): string {
  const notifNo = normalizeStr(item.notification_number);
  if (notifNo) {
    const slug = notifNo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `${sourceCode}::${slug}`;
  }
  const titleNorm = (normalizeStr(item.title) || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${sourceCode}::${titleNorm.slice(0, 120)}`;
}

export function buildSnapshot(record: Record<string, unknown>): Record<string, string | null> {
  const snap: Record<string, string | null> = {};
  for (const field of TRACKED_FIELDS) {
    if (field === 'notification_status') {
      snap[field] = resolveNotificationStatus(
        record.notification_status ?? record.lifecycle_status,
        record.title,
        record.description
      );
    } else {
      snap[field] = normalizeStr(record[field]);
    }
  }
  return snap;
}

export function mergePreservingMissingFields(
  oldSnap: Record<string, string | null>,
  newSnap: Record<string, string | null>
): Record<string, string | null> {
  const merged = { ...newSnap };
  if (merged.notification_status === 'cancelled') {
    return merged;
  }
  for (const field of PRESERVABLE_FIELDS) {
    if (merged[field] === null && oldSnap[field] !== null) {
      merged[field] = oldSnap[field];
    }
  }
  return merged;
}

export function computeContentHash(snapshot: Record<string, string | null>): string {
  const sortedKeys = Object.keys(snapshot).sort();
  const ordered: Record<string, string | null> = {};
  for (const k of sortedKeys) ordered[k] = snapshot[k];
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export function computeFieldDiffs(
  oldSnap: Record<string, string | null>,
  newSnap: Record<string, string | null>
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of TRACKED_FIELDS) {
    const oldVal = oldSnap[field] ?? null;
    const newVal = newSnap[field] ?? null;
    if (oldVal !== newVal) {
      diffs.push({ field, old_value: oldVal, new_value: newVal });
    }
  }
  return diffs;
}

export function classifyFieldChange(
  field: string,
  oldVal: string | null,
  newVal: string | null
): string {
  switch (field) {
    case 'exam_date':
      return 'EXAM DATE CHANGED';
    case 'application_deadline':
      if (
        oldVal &&
        newVal &&
        /^\d{4}-\d{2}-\d{2}$/.test(oldVal) &&
        /^\d{4}-\d{2}-\d{2}$/.test(newVal) &&
        newVal > oldVal
      ) {
        return 'APPLICATION DEADLINE EXTENDED';
      }
      return 'APPLICATION DEADLINE CHANGED';
    case 'application_start_date':
      return 'APPLICATION START CHANGED';
    case 'admit_card_date':
      return 'ADMIT CARD UPDATE';
    case 'result_date':
      return 'RESULT UPDATE';
    case 'vacancy_count':
      return 'VACANCY CHANGED';
    case 'qualification':
      return 'QUALIFICATION CHANGED';
    case 'notification_status':
    case 'lifecycle_status':
      if (newVal === 'cancelled') return 'NOTIFICATION CANCELLED';
      if (newVal === 'removed') return 'VERIFIED REMOVAL';
      return 'NOTIFICATION DETAILS UPDATED';
    case 'pdf_url':
      return 'OFFICIAL PDF UPDATED';
    default:
      return 'NOTIFICATION DETAILS UPDATED';
  }
}

export function getAlertPriorityAndSeverity(
  changeType: string,
  field: string,
  newVal: string | null
): { priority: 'Critical' | 'High' | 'Normal' | 'Low'; severity: 'info' | 'warning' | 'critical' } {
  if (
    changeType === 'REMOVED' ||
    newVal === 'cancelled' ||
    field === 'exam_date' ||
    field === 'application_deadline'
  ) {
    return { priority: 'Critical', severity: 'critical' };
  }
  if (field === 'admit_card_date' || field === 'result_date') {
    return { priority: 'High', severity: 'warning' };
  }
  if (changeType === 'NEW' || field === 'vacancy_count' || field === 'application_start_date') {
    return { priority: 'Normal', severity: 'info' };
  }
  return { priority: 'Low', severity: 'info' };
}

function insertUniqueAlert(params: {
  changeId: number | null;
  sourceId: number;
  notificationId: number | null;
  title: string;
  message: string;
  alertType: string;
  priority: 'Critical' | 'High' | 'Normal' | 'Low';
  severity: 'info' | 'warning' | 'critical';
  dedupKey: string;
  createdAt: string;
}): void {
  const existing = db
    .prepare('SELECT id FROM alerts WHERE dedup_key = ?')
    .get(params.dedupKey);
  if (existing) return;

  db.prepare(
    `INSERT INTO alerts (
      change_id, source_id, notification_id, title, message, alert_type,
      priority, severity, dedup_key, is_read, is_verified, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
  ).run(
    params.changeId,
    params.sourceId,
    params.notificationId,
    params.title,
    params.message,
    params.alertType,
    params.priority,
    params.severity,
    params.dedupKey,
    params.createdAt
  );
}

export function appendMonitoringLog(
  runId: string,
  sourceId: number,
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string
): void {
  db.prepare(
    'INSERT INTO monitoring_logs (run_id, source_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(runId, sourceId, level, message, new Date().toISOString());
}

function saveVersionSnapshot(
  notifId: number,
  versionNumber: number,
  snap: Record<string, string | null>,
  contentHash: string,
  runId: string | null,
  capturedAt: string,
  fallbackOrg: string,
  fallbackUrl: string
): void {
  db.prepare(
    `INSERT INTO notification_versions (
      notification_id, version_number, title, organization_name, notification_number,
      vacancy_count, job_category, qualification, state, application_start_date, application_deadline,
      exam_date, admit_card_date, result_date, description, pdf_url, source_url,
      published_date, notification_status, content_hash, snapshot_json, run_id, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    notifId,
    versionNumber,
    snap.title || 'Untitled Notification',
    snap.organization_name || fallbackOrg,
    snap.notification_number,
    snap.vacancy_count,
    snap.job_category,
    snap.qualification,
    snap.state,
    snap.application_start_date,
    snap.application_deadline,
    snap.exam_date,
    snap.admit_card_date,
    snap.result_date,
    snap.description,
    snap.pdf_url,
    snap.source_url || fallbackUrl,
    snap.published_date,
    snap.notification_status || 'active',
    contentHash,
    JSON.stringify(snap),
    runId,
    capturedAt
  );
}

export interface ApplyCounts {
  parsed_count: number;
  new_count: number;
  updated_count: number;
  duplicate_count: number;
  removed_count: number;
}

export function applyScrapeResults(
  source: Record<string, unknown>,
  parsedItems: ParsedNotification[],
  runId: string,
  isDemoData: boolean,
  allowRemovalCheck = true,
  removalThreshold = 2,
  suppressHistory = false,
  replaceDemoWithLive = !isDemoData
): ApplyCounts {
  const now = new Date().toISOString();
  const counts: ApplyCounts = {
    parsed_count: parsedItems.length,
    new_count: 0,
    updated_count: 0,
    duplicate_count: 0,
    removed_count: 0,
  };

  if (parsedItems.length === 0) {
    return counts;
  }

  const sourceId = Number(source.id);
  const sourceCode = String(source.code);

  // When a portal successfully produces authentic live items, retire prior synthetic demo-seed rows for that source
  if (!isDemoData && replaceDemoWithLive) {
    const incomingKeys = new Set(parsedItems.map((it) => buildEntityKey(sourceCode, it)));
    const demoRows = db
      .prepare('SELECT id, entity_key FROM recruitment_notifications WHERE source_id = ? AND is_demo_data = 1')
      .all(sourceId) as { id: number; entity_key: string }[];
    for (const d of demoRows) {
      if (!incomingKeys.has(String(d.entity_key))) {
        db.prepare('DELETE FROM alerts WHERE notification_id = ?').run(d.id);
        db.prepare('DELETE FROM change_history WHERE notification_id = ?').run(d.id);
        db.prepare('DELETE FROM notification_versions WHERE notification_id = ?').run(d.id);
        db.prepare('DELETE FROM saved_notifications WHERE notification_id = ?').run(d.id);
        db.prepare('DELETE FROM recruitment_notifications WHERE id = ?').run(d.id);
      }
    }
  }

  const existingRows = db
    .prepare('SELECT * FROM recruitment_notifications WHERE source_id = ?')
    .all(sourceId) as Record<string, unknown>[];
  const existingByKey = new Map<string, Record<string, unknown>>();
  for (const row of existingRows) {
    existingByKey.set(String(row.entity_key), row);
  }

  const seenKeys = new Set<string>();

  for (const item of parsedItems) {
    const entityKey = buildEntityKey(sourceCode, item);
    if (seenKeys.has(entityKey)) {
      counts.duplicate_count += 1;
      continue;
    }
    seenKeys.add(entityKey);

    const rawSnap = buildSnapshot(item as unknown as Record<string, unknown>);
    const existing = existingByKey.get(entityKey);

    if (!existing) {
      const newHash = computeContentHash(rawSnap);
      const info = db
        .prepare(
          `INSERT INTO recruitment_notifications (
            source_id, entity_key, content_hash, title, organization_name, notification_number,
            vacancy_count, job_category, qualification, state, application_procedure,
            application_start_date, application_deadline,
            exam_date, admit_card_date, result_date, description, pdf_url, source_url,
            published_date, lifecycle_status, is_removed, missing_count, is_demo_data,
            first_seen_at, last_seen_at, source_updated_at, last_run_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`
        )
        .run(
          sourceId,
          entityKey,
          newHash,
          rawSnap.title || 'Untitled Notification',
          rawSnap.organization_name || String(source.organization_name),
          rawSnap.notification_number,
          rawSnap.vacancy_count,
          rawSnap.job_category,
          rawSnap.qualification,
          rawSnap.state,
          item.application_procedure || null,
          rawSnap.application_start_date,
          rawSnap.application_deadline,
          rawSnap.exam_date,
          rawSnap.admit_card_date,
          rawSnap.result_date,
          rawSnap.description,
          rawSnap.pdf_url,
          rawSnap.source_url || String(source.base_url),
          rawSnap.published_date,
          rawSnap.notification_status || 'active',
          isDemoData ? 1 : 0,
          now,
          now,
          now,
          runId
        );

      const notifId = Number(info.lastInsertRowid);
      saveVersionSnapshot(
        notifId,
        1,
        rawSnap,
        newHash,
        runId,
        now,
        String(source.organization_name),
        String(source.base_url)
      );
      counts.new_count += 1;
    } else {
      const notifId = Number(existing.id);
      const wasRemoved = Boolean(existing.is_removed);
      db.prepare(
        'UPDATE recruitment_notifications SET last_seen_at = ?, last_run_id = ?, missing_count = 0, is_demo_data = ? WHERE id = ?'
      ).run(now, runId, isDemoData ? 1 : 0, notifId);

      if (wasRemoved) {
        db.prepare("UPDATE recruitment_notifications SET is_removed = 0, lifecycle_status = 'active' WHERE id = ?").run(
          notifId
        );
      }

      const oldSnap = buildSnapshot(existing);
      const newSnap = mergePreservingMissingFields(oldSnap, rawSnap);
      const newHash = computeContentHash(newSnap);

      if (String(existing.content_hash) === newHash && !wasRemoved) {
        counts.duplicate_count += 1;
        continue;
      }

      const diffs = computeFieldDiffs(oldSnap, newSnap);
      if (diffs.length === 0 && !wasRemoved) {
        counts.duplicate_count += 1;
        continue;
      }
      if (wasRemoved && diffs.length === 0) {
        diffs.push({ field: 'notification_status', old_value: 'removed', new_value: 'active' });
      }

      const verRow = db
        .prepare('SELECT COALESCE(MAX(version_number), 0) as max_ver FROM notification_versions WHERE notification_id = ?')
        .get(notifId) as { max_ver: number };
      let maxVer = Number(verRow?.max_ver || 0);
      if (maxVer === 0) {
        saveVersionSnapshot(
          notifId,
          1,
          oldSnap,
          String(existing.content_hash),
          existing.last_run_id ? String(existing.last_run_id) : null,
          String(existing.first_seen_at || now),
          String(existing.organization_name),
          String(existing.source_url)
        );
        maxVer = 1;
      }

      const nextLifecycle = newSnap.notification_status === 'cancelled' ? 'cancelled' : 'updated';

      db.prepare(
        `UPDATE recruitment_notifications SET
          content_hash = ?, title = ?, organization_name = ?, notification_number = ?,
          vacancy_count = ?, job_category = ?, qualification = ?, state = ?,
          application_start_date = ?, application_deadline = ?,
          exam_date = ?, admit_card_date = ?, result_date = ?, description = ?, pdf_url = ?,
          source_url = ?, published_date = ?, lifecycle_status = ?, source_updated_at = ?
        WHERE id = ?`
      ).run(
        newHash,
        newSnap.title || String(existing.title),
        newSnap.organization_name || String(existing.organization_name),
        newSnap.notification_number,
        newSnap.vacancy_count,
        newSnap.job_category,
        newSnap.qualification,
        newSnap.state,
        newSnap.application_start_date,
        newSnap.application_deadline,
        newSnap.exam_date,
        newSnap.admit_card_date,
        newSnap.result_date,
        newSnap.description,
        newSnap.pdf_url,
        newSnap.source_url || String(existing.source_url),
        newSnap.published_date,
        nextLifecycle,
        now,
        notifId
      );

      saveVersionSnapshot(
        notifId,
        maxVer + 1,
        newSnap,
        newHash,
        runId,
        now,
        String(existing.organization_name),
        String(existing.source_url)
      );

      const isDemoTransition = Boolean(existing.is_demo_data) && !isDemoData;
      const historyDiffs =
        suppressHistory || isDemoTransition
          ? []
          : diffs.filter(
              (d) =>
                HISTORY_WORTHY_FIELDS.has(d.field) &&
                d.old_value !== null &&
                d.old_value.trim() !== '' &&
                d.new_value !== null &&
                d.new_value.trim() !== ''
            );

      for (const diff of historyDiffs) {
        const label = classifyFieldChange(diff.field, diff.old_value, diff.new_value);
        const changeInfo = db
          .prepare(
            `INSERT INTO change_history (
              run_id, source_id, notification_id, entity_key, notification_title,
              change_type, changed_field, change_label, previous_value, new_value,
              changed_fields_json, before_snapshot_json, after_snapshot_json,
              source_url, is_verified, detected_at
            ) VALUES (?, ?, ?, ?, ?, 'UPDATED', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
          )
          .run(
            runId,
            sourceId,
            notifId,
            entityKey,
            newSnap.title || String(existing.title),
            diff.field,
            label,
            diff.old_value,
            diff.new_value,
            JSON.stringify([diff]),
            JSON.stringify(oldSnap),
            JSON.stringify(newSnap),
            newSnap.source_url || String(existing.source_url),
            now
          );

        const changeId = Number(changeInfo.lastInsertRowid);
        const { priority, severity } = getAlertPriorityAndSeverity('UPDATED', diff.field, diff.new_value);
        insertUniqueAlert({
          changeId,
          sourceId,
          notificationId: notifId,
          title: `${label}: ${newSnap.title || existing.title}`,
          message: `${sourceCode.toUpperCase()} — Previous: ${diff.old_value} → Updated: ${diff.new_value}`,
          alertType: 'UPDATED',
          priority,
          severity,
          dedupKey: `UPD::${entityKey}::${diff.field}::${diff.old_value}::${diff.new_value}`,
          createdAt: now,
        });
      }

      if (historyDiffs.length > 0) {
        counts.updated_count += 1;
      } else {
        counts.duplicate_count += 1;
      }
    }
  }

  if (allowRemovalCheck) {
    for (const existing of existingRows) {
      const entityKey = String(existing.entity_key);
      if (!seenKeys.has(entityKey) && !Boolean(existing.is_removed)) {
        const nextMissing = Number(existing.missing_count || 0) + 1;
        const notifId = Number(existing.id);
        if (nextMissing >= removalThreshold) {
          const oldSnap = buildSnapshot(existing);
          const removedSnap = { ...oldSnap, notification_status: 'removed' };
          const verRow = db
            .prepare('SELECT COALESCE(MAX(version_number), 0) as max_ver FROM notification_versions WHERE notification_id = ?')
            .get(notifId) as { max_ver: number };
          saveVersionSnapshot(
            notifId,
            Number(verRow?.max_ver || 0) + 1,
            removedSnap,
            computeContentHash(removedSnap),
            runId,
            now,
            String(existing.organization_name),
            String(existing.source_url)
          );
          db.prepare(
            "UPDATE recruitment_notifications SET missing_count = ?, is_removed = 1, lifecycle_status = 'removed', source_updated_at = ? WHERE id = ?"
          ).run(nextMissing, now, notifId);
          const changeInfo = db
            .prepare(
              `INSERT INTO change_history (
                run_id, source_id, notification_id, entity_key, notification_title,
                change_type, changed_field, change_label, previous_value, new_value,
                changed_fields_json, before_snapshot_json, after_snapshot_json,
                source_url, is_verified, detected_at
              ) VALUES (?, ?, ?, ?, ?, 'REMOVED', 'notification_status', 'VERIFIED REMOVAL', 'active', 'removed', ?, ?, NULL, ?, 0, ?)`
            )
            .run(
              runId,
              sourceId,
              notifId,
              entityKey,
              String(existing.title),
              JSON.stringify([{ field: 'notification_status', old_value: 'active', new_value: 'removed' }]),
              JSON.stringify(oldSnap),
              String(existing.source_url),
              now
            );
          const changeId = Number(changeInfo.lastInsertRowid);
          insertUniqueAlert({
            changeId,
            sourceId,
            notificationId: notifId,
            title: `Verified Removal: ${existing.title}`,
            message: `${sourceCode.toUpperCase()} listing absent across ${removalThreshold} consecutive healthy checks.`,
            alertType: 'REMOVED',
            priority: 'Critical',
            severity: 'critical',
            dedupKey: `REM::${entityKey}::${runId}`,
            createdAt: now,
          });
          counts.removed_count += 1;
        } else {
          db.prepare('UPDATE recruitment_notifications SET missing_count = ? WHERE id = ?').run(nextMissing, notifId);
        }
      }
    }
  }

  return counts;
}

export function recordFailedScrape(
  source: Record<string, unknown>,
  runId: string,
  triggerType: string,
  modeUsed: string,
  httpStatus: number | null,
  errorMessage: string,
  durationMs: number,
  startedAt: string
): Record<string, unknown> {
  const now = new Date().toISOString();
  const sourceId = Number(source.id);
  const sourceCode = String(source.code);
  const isRateLimited = httpStatus === 403 || httpStatus === 429;
  const freshness = isRateLimited ? 'Rate Limited' : 'Failed';

  db.prepare(
    'UPDATE monitoring_sources SET last_attempted_at = ?, last_http_status = ?, last_error = ?, freshness_status = ? WHERE id = ?'
  ).run(now, httpStatus, errorMessage, freshness, sourceId);

  db.prepare(
    `INSERT INTO scrape_runs (
      run_id, source_id, trigger_type, mode_used, status, http_status,
      parsed_count, new_count, updated_count, duplicate_count, removed_count,
      error_count, duration_ms, error_message, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 1, ?, ?, ?, ?)`
  ).run(
    runId,
    sourceId,
    triggerType,
    modeUsed,
    isRateLimited ? 'rate_limited' : 'error',
    httpStatus,
    durationMs,
    errorMessage,
    startedAt,
    now
  );

  appendMonitoringLog(runId, sourceId, 'ERROR', `${errorMessage} Existing records preserved safely.`);

  insertUniqueAlert({
    changeId: null,
    sourceId,
    notificationId: null,
    title: `Source Check Failed: ${sourceCode.toUpperCase()}`,
    message: `${errorMessage} Existing records preserved safely (stale-data protection).`,
    alertType: 'SOURCE_ERROR',
    priority: isRateLimited ? 'Critical' : 'High',
    severity: isRateLimited ? 'critical' : 'warning',
    dedupKey: `ERR::${sourceCode}::${runId}`,
    createdAt: now,
  });

  return db.prepare('SELECT * FROM scrape_runs WHERE run_id = ?').get(runId) as Record<string, unknown>;
}
