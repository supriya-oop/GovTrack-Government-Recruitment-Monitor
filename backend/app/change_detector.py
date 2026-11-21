import json
from datetime import datetime, timezone
from typing import Dict, List, Optional
from sqlalchemy.orm import Session

from .diff_core import (
    build_entity_key_from_parts,
    classify_field_change,
    compute_content_hash,
    compute_field_diffs,
    get_alert_priority_and_severity,
    merge_preserving_missing_fields,
    normalize_snapshot,
)
from .models import (
    Alert,
    ChangeHistory,
    MonitoringLog,
    MonitoringSource,
    NotificationVersion,
    RecruitmentNotification,
    SavedNotification,
    ScrapeRun,
)

HISTORY_WORTHY_FIELDS = {
    "exam_date",
    "application_deadline",
    "application_start_date",
    "admit_card_date",
    "result_date",
    "vacancy_count",
    "qualification",
    "notification_status",
}


def append_monitoring_log(db: Session, run_id: str, source_id: int, level: str, message: str) -> None:
    db.add(
        MonitoringLog(
            run_id=run_id,
            source_id=source_id,
            level=level,
            message=message,
            created_at=datetime.now(timezone.utc),
        )
    )


def _insert_unique_alert(
    db: Session,
    *,
    change_id: Optional[int],
    source_id: int,
    notification_id: Optional[int],
    title: str,
    message: str,
    alert_type: str,
    priority: str,
    severity: str,
    dedup_key: str,
    now: datetime,
) -> None:
    exists = db.query(Alert.id).filter(Alert.dedup_key == dedup_key).first()
    if exists:
        return
    db.add(
        Alert(
            change_id=change_id,
            source_id=source_id,
            notification_id=notification_id,
            title=title[:300],
            message=message,
            alert_type=alert_type,
            priority=priority,
            severity=severity,
            dedup_key=dedup_key,
            is_read=False,
            is_verified=False,
            created_at=now,
        )
    )


def _save_version_snapshot(
    db: Session,
    *,
    notif_id: int,
    version_number: int,
    snap: Dict[str, Optional[str]],
    content_hash: str,
    run_id: Optional[str],
    captured_at: datetime,
    fallback_org: str,
    fallback_url: str,
) -> None:
    db.add(
        NotificationVersion(
            notification_id=notif_id,
            version_number=version_number,
            title=snap.get("title") or "Untitled Notification",
            organization_name=snap.get("organization_name") or fallback_org,
            notification_number=snap.get("notification_number"),
            vacancy_count=snap.get("vacancy_count"),
            job_category=snap.get("job_category"),
            qualification=snap.get("qualification"),
            state=snap.get("state"),
            application_start_date=snap.get("application_start_date"),
            application_deadline=snap.get("application_deadline"),
            exam_date=snap.get("exam_date"),
            admit_card_date=snap.get("admit_card_date"),
            result_date=snap.get("result_date"),
            description=snap.get("description"),
            pdf_url=snap.get("pdf_url"),
            source_url=snap.get("source_url") or fallback_url,
            published_date=snap.get("published_date"),
            notification_status=snap.get("notification_status") or "active",
            content_hash=content_hash,
            snapshot_json=json.dumps(snap),
            run_id=run_id,
            captured_at=captured_at,
        )
    )


def apply_scrape_results(
    db: Session,
    source: MonitoringSource,
    parsed_items: List[Dict[str, Optional[str]]],
    run_id: str,
    is_demo_data: bool,
    allow_removal_check: bool = True,
    removal_threshold: int = 2,
    suppress_history: bool = False,
    replace_demo_with_live: Optional[bool] = None,
) -> Dict[str, int]:
    now = datetime.now(timezone.utc)
    counts = {
        "parsed_count": len(parsed_items),
        "new_count": 0,
        "updated_count": 0,
        "duplicate_count": 0,
        "removed_count": 0,
    }
    if not parsed_items:
        return counts

    should_replace_demo = (not is_demo_data) if replace_demo_with_live is None else replace_demo_with_live
    if not is_demo_data and should_replace_demo:
        incoming_keys = {
            build_entity_key_from_parts(source.code, it.get("notification_number"), it.get("title"))
            for it in parsed_items
        }
        demo_rows = (
            db.query(RecruitmentNotification)
            .filter(RecruitmentNotification.source_id == source.id, RecruitmentNotification.is_demo_data == True)  # noqa: E712
            .all()
        )
        for d in demo_rows:
            if d.entity_key not in incoming_keys:
                db.query(Alert).filter(Alert.notification_id == d.id).delete()
                db.query(ChangeHistory).filter(ChangeHistory.notification_id == d.id).delete()
                db.query(NotificationVersion).filter(NotificationVersion.notification_id == d.id).delete()
                db.query(SavedNotification).filter(SavedNotification.notification_id == d.id).delete()
                db.delete(d)
        db.flush()

    existing_rows = (
        db.query(RecruitmentNotification)
        .filter(RecruitmentNotification.source_id == source.id)
        .all()
    )
    existing_by_key = {row.entity_key: row for row in existing_rows}
    seen_keys = set()

    for item in parsed_items:
        entity_key = build_entity_key_from_parts(
            source.code,
            item.get("notification_number"),
            item.get("title"),
        )
        if entity_key in seen_keys:
            counts["duplicate_count"] += 1
            continue
        seen_keys.add(entity_key)

        raw_snap = normalize_snapshot(item)
        existing = existing_by_key.get(entity_key)

        if not existing:
            new_hash = compute_content_hash(raw_snap)
            notif = RecruitmentNotification(
                source_id=source.id,
                entity_key=entity_key,
                content_hash=new_hash,
                title=raw_snap.get("title") or "Untitled Notification",
                organization_name=raw_snap.get("organization_name") or source.organization_name,
                notification_number=raw_snap.get("notification_number"),
                vacancy_count=raw_snap.get("vacancy_count"),
                job_category=raw_snap.get("job_category"),
                qualification=raw_snap.get("qualification"),
                state=raw_snap.get("state"),
                application_procedure=item.get("application_procedure"),
                application_start_date=raw_snap.get("application_start_date"),
                application_deadline=raw_snap.get("application_deadline"),
                exam_date=raw_snap.get("exam_date"),
                admit_card_date=raw_snap.get("admit_card_date"),
                result_date=raw_snap.get("result_date"),
                description=raw_snap.get("description"),
                pdf_url=raw_snap.get("pdf_url"),
                source_url=raw_snap.get("source_url") or source.base_url,
                published_date=raw_snap.get("published_date"),
                lifecycle_status=raw_snap.get("notification_status") or "active",
                is_removed=False,
                missing_count=0,
                is_demo_data=is_demo_data,
                first_seen_at=now,
                last_seen_at=now,
                source_updated_at=now,
                last_run_id=run_id,
            )
            db.add(notif)
            db.flush()

            _save_version_snapshot(
                db,
                notif_id=notif.id,
                version_number=1,
                snap=raw_snap,
                content_hash=new_hash,
                run_id=run_id,
                captured_at=now,
                fallback_org=source.organization_name,
                fallback_url=source.base_url,
            )
            counts["new_count"] += 1
        else:
            was_demo = bool(existing.is_demo_data)
            existing.last_seen_at = now
            existing.last_run_id = run_id
            existing.missing_count = 0
            existing.is_demo_data = is_demo_data
            was_removed = bool(existing.is_removed)
            if was_removed:
                existing.is_removed = False
                existing.lifecycle_status = "active"

            old_snap = normalize_snapshot(
                {
                    "title": existing.title,
                    "organization_name": existing.organization_name,
                    "notification_number": existing.notification_number,
                    "vacancy_count": existing.vacancy_count,
                    "job_category": existing.job_category,
                    "qualification": existing.qualification,
                    "state": existing.state,
                    "application_start_date": existing.application_start_date,
                    "application_deadline": existing.application_deadline,
                    "exam_date": existing.exam_date,
                    "admit_card_date": existing.admit_card_date,
                    "result_date": existing.result_date,
                    "description": existing.description,
                    "pdf_url": existing.pdf_url,
                    "source_url": existing.source_url,
                    "published_date": existing.published_date,
                    "notification_status": existing.lifecycle_status,
                }
            )
            new_snap = merge_preserving_missing_fields(old_snap, raw_snap)
            new_hash = compute_content_hash(new_snap)

            if existing.content_hash == new_hash and not was_removed:
                counts["duplicate_count"] += 1
                continue

            diffs = compute_field_diffs(old_snap, new_snap)
            if not diffs and not was_removed:
                counts["duplicate_count"] += 1
                continue
            if was_removed and not diffs:
                diffs.append({"field": "notification_status", "old_value": "removed", "new_value": "active"})

            max_ver = (
                db.query(NotificationVersion)
                .filter(NotificationVersion.notification_id == existing.id)
                .count()
            )
            existing.content_hash = new_hash
            existing.title = new_snap.get("title") or existing.title
            existing.organization_name = new_snap.get("organization_name") or existing.organization_name
            existing.notification_number = new_snap.get("notification_number")
            existing.vacancy_count = new_snap.get("vacancy_count")
            existing.job_category = new_snap.get("job_category")
            existing.qualification = new_snap.get("qualification")
            existing.state = new_snap.get("state")
            existing.application_start_date = new_snap.get("application_start_date")
            existing.application_deadline = new_snap.get("application_deadline")
            existing.exam_date = new_snap.get("exam_date")
            existing.admit_card_date = new_snap.get("admit_card_date")
            existing.result_date = new_snap.get("result_date")
            existing.description = new_snap.get("description")
            existing.pdf_url = new_snap.get("pdf_url")
            existing.source_url = new_snap.get("source_url") or existing.source_url
            existing.published_date = new_snap.get("published_date")
            existing.lifecycle_status = "cancelled" if new_snap.get("notification_status") == "cancelled" else "updated"
            existing.source_updated_at = now

            _save_version_snapshot(
                db,
                notif_id=existing.id,
                version_number=max_ver + 1,
                snap=new_snap,
                content_hash=new_hash,
                run_id=run_id,
                captured_at=now,
                fallback_org=existing.organization_name,
                fallback_url=existing.source_url,
            )

            is_demo_transition = was_demo and not is_demo_data
            if suppress_history or is_demo_transition:
                history_diffs = []
            else:
                history_diffs = [
                    d
                    for d in diffs
                    if d["field"] in HISTORY_WORTHY_FIELDS
                    and d.get("old_value")
                    and str(d.get("old_value")).strip()
                    and d.get("new_value")
                    and str(d.get("new_value")).strip()
                ]

            for diff in history_diffs:
                label = classify_field_change(diff["field"], diff["old_value"], diff["new_value"])
                change = ChangeHistory(
                    run_id=run_id,
                    source_id=source.id,
                    notification_id=existing.id,
                    entity_key=entity_key,
                    notification_title=existing.title,
                    change_type="UPDATED",
                    changed_field=diff["field"],
                    change_label=label,
                    previous_value=diff["old_value"],
                    new_value=diff["new_value"],
                    changed_fields_json=json.dumps([diff]),
                    before_snapshot_json=json.dumps(old_snap),
                    after_snapshot_json=json.dumps(new_snap),
                    source_url=existing.source_url,
                    is_verified=False,
                    detected_at=now,
                )
                db.add(change)
                db.flush()
                priority, severity = get_alert_priority_and_severity("UPDATED", diff["field"], diff["new_value"])
                _insert_unique_alert(
                    db,
                    change_id=change.id,
                    source_id=source.id,
                    notification_id=existing.id,
                    title=f"{label}: {existing.title}",
                    message=f"{source.code.upper()} — Previous: {diff['old_value']} → Updated: {diff['new_value']}",
                    alert_type="UPDATED",
                    priority=priority,
                    severity=severity,
                    dedup_key=f"UPD::{entity_key}::{diff['field']}::{diff['old_value']}::{diff['new_value']}",
                    now=now,
                )

            if history_diffs:
                counts["updated_count"] += 1
            else:
                counts["duplicate_count"] += 1

    if allow_removal_check:
        for existing in existing_rows:
            if existing.entity_key not in seen_keys and not existing.is_removed:
                existing.missing_count = (existing.missing_count or 0) + 1
                if existing.missing_count >= removal_threshold:
                    existing.is_removed = True
                    existing.lifecycle_status = "removed"
                    existing.source_updated_at = now
                    old_snap = normalize_snapshot(
                        {
                            "title": existing.title,
                            "organization_name": existing.organization_name,
                            "notification_number": existing.notification_number,
                            "vacancy_count": existing.vacancy_count,
                            "job_category": existing.job_category,
                            "qualification": existing.qualification,
                            "state": existing.state,
                            "application_start_date": existing.application_start_date,
                            "application_deadline": existing.application_deadline,
                            "exam_date": existing.exam_date,
                            "admit_card_date": existing.admit_card_date,
                            "result_date": existing.result_date,
                            "description": existing.description,
                            "pdf_url": existing.pdf_url,
                            "source_url": existing.source_url,
                            "published_date": existing.published_date,
                            "notification_status": existing.lifecycle_status,
                        }
                    )
                    change = ChangeHistory(
                        run_id=run_id,
                        source_id=source.id,
                        notification_id=existing.id,
                        entity_key=existing.entity_key,
                        notification_title=existing.title,
                        change_type="REMOVED",
                        changed_field="notification_status",
                        change_label="VERIFIED REMOVAL",
                        previous_value="active",
                        new_value="removed",
                        changed_fields_json=json.dumps([{"field": "notification_status", "old_value": "active", "new_value": "removed"}]),
                        before_snapshot_json=json.dumps(old_snap),
                        after_snapshot_json=None,
                        source_url=existing.source_url,
                        is_verified=False,
                        detected_at=now,
                    )
                    db.add(change)
                    db.flush()
                    _insert_unique_alert(
                        db,
                        change_id=change.id,
                        source_id=source.id,
                        notification_id=existing.id,
                        title=f"Verified Removal: {existing.title}",
                        message=f"{source.code.upper()} listing absent across {removal_threshold} consecutive healthy checks.",
                        alert_type="REMOVED",
                        priority="Critical",
                        severity="critical",
                        dedup_key=f"REM::{existing.entity_key}::{run_id}",
                        now=now,
                    )
                    counts["removed_count"] += 1

    db.commit()
    return counts


def record_failed_scrape(
    db: Session,
    source: MonitoringSource,
    run_id: str,
    trigger_type: str,
    mode_used: str,
    http_status: Optional[int],
    error_message: str,
    duration_ms: int,
    started_at: datetime,
) -> ScrapeRun:
    now = datetime.now(timezone.utc)
    is_rate_limited = http_status in (403, 429)
    source.last_attempted_at = now
    source.last_http_status = http_status
    source.last_error = error_message
    source.freshness_status = "Rate Limited" if is_rate_limited else "Failed"

    run = ScrapeRun(
        run_id=run_id,
        source_id=source.id,
        trigger_type=trigger_type,
        mode_used=mode_used,
        status="rate_limited" if is_rate_limited else "error",
        http_status=http_status,
        parsed_count=0,
        new_count=0,
        updated_count=0,
        duplicate_count=0,
        removed_count=0,
        error_count=1,
        duration_ms=duration_ms,
        error_message=error_message,
        started_at=started_at,
        completed_at=now,
    )
    db.add(run)
    append_monitoring_log(db, run_id, source.id, "ERROR", f"{error_message} Existing records preserved safely.")
    _insert_unique_alert(
        db,
        change_id=None,
        source_id=source.id,
        notification_id=None,
        title=f"Source Check Failed: {source.code.upper()}",
        message=f"{error_message} Existing records preserved safely (stale-data protection).",
        alert_type="SOURCE_ERROR",
        priority="Critical" if is_rate_limited else "High",
        severity="critical" if is_rate_limited else "warning",
        dedup_key=f"ERR::{source.code}::{run_id}",
        now=now,
    )
    db.commit()
    db.refresh(run)
    return run
