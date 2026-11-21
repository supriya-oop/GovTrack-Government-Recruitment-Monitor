from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import json
import math
import platform
import threading
import time
from typing import Any, Dict, List, Optional, Set
from fastapi import Body, Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func
from sqlalchemy.orm import Session

from .auth import (
    create_access_token,
    get_current_user,
    get_optional_user,
    hash_password,
    require_admin,
    verify_password,
)
from .config import CORS_ORIGINS
from .database import Base, SessionLocal, engine, get_db
from .models import (
    Alert,
    Category,
    ChangeHistory,
    MonitoringLog,
    MonitoringSource,
    NotificationVersion,
    RecruitmentNotification,
    SavedNotification,
    ScrapeRun,
    User,
    UserPreferences,
)
from .pdf_extractor import discover_pdf_url_from_html_page, fetch_official_pdf_buffer
from .pdf_generator import build_notification_pdf
from .scheduler import scheduler_state, start_scheduler, stop_scheduler
from .schemas import (
    AdminUserUpdateRequest,
    CategoryCreateRequest,
    LoginRequest,
    PasswordUpdateRequest,
    ProfileUpdateRequest,
    RegisterRequest,
    SaveBookmarkRequest,
    SchedulerUpdateRequest,
    SourceConfigUpdateRequest,
    SourceCreateRequest,
    SourceScrapeRequest,
)
from .scraper_engine import run_source_scrape
from .seed import seed_database

APP_START_TIME = time.monotonic()


def _hydrate_live_sources_in_background() -> None:
    db = SessionLocal()
    try:
        live_count = (
            db.query(func.count(RecruitmentNotification.id))
            .filter(
                RecruitmentNotification.is_removed == False,  # noqa: E712
                RecruitmentNotification.is_demo_data == False,  # noqa: E712
            )
            .scalar()
            or 0
        )
        if live_count > 0:
            return
        source_ids = [
            row[0]
            for row in db.query(MonitoringSource.id)
            .filter(MonitoringSource.is_active == True)  # noqa: E712
            .order_by(MonitoringSource.id.asc())
            .all()
        ]
    finally:
        db.close()

    def _worker(src_id: int) -> None:
        wdb = SessionLocal()
        try:
            src = wdb.query(MonitoringSource).filter(MonitoringSource.id == src_id).first()
            if src:
                run_source_scrape(
                    wdb,
                    src,
                    trigger_type="startup_live_sync",
                    mode_override="live",
                    suppress_history=True,
                    replace_demo_with_live=True,
                )
        except Exception:
            pass
        finally:
            wdb.close()

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(_worker, source_ids))
    scheduler_state["last_run_at"] = datetime.now(timezone.utc).isoformat()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        seed_database(db)
    finally:
        db.close()
    start_scheduler()
    threading.Thread(target=_hydrate_live_sources_in_background, daemon=True).start()
    try:
        yield
    finally:
        stop_scheduler()


app = FastAPI(title="GovTrack API (FastAPI)", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _today_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _diff_days(from_iso: str, to_iso: str) -> int:
    a = datetime.strptime(from_iso, "%Y-%m-%d").date()
    b = datetime.strptime(to_iso, "%Y-%m-%d").date()
    return (b - a).days


def _is_iso(val: Optional[str]) -> bool:
    if not val or len(val) < 10:
        return False
    s = val[:10]
    return s[4] == "-" and s[7] == "-" and s[:4].isdigit() and s[5:7].isdigit() and s[8:10].isdigit()


def _safe_json_obj(raw: Optional[str], fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except Exception:
        return fallback


def _real_change_filters():
    return [
        ChangeHistory.previous_value.isnot(None),
        func.trim(ChangeHistory.previous_value) != "",
        ChangeHistory.new_value.isnot(None),
        func.trim(ChangeHistory.new_value) != "",
        ChangeHistory.change_type != "NEW",
    ]


def compute_status_label(row: RecruitmentNotification) -> str:
    if row.is_removed:
        return "Removed"
    if row.lifecycle_status == "cancelled":
        return "Cancelled"
    today = _today_iso()
    start = row.application_start_date[:10] if _is_iso(row.application_start_date) else None
    deadline = row.application_deadline[:10] if _is_iso(row.application_deadline) else None
    exam = row.exam_date[:10] if _is_iso(row.exam_date) else None
    admit = row.admit_card_date[:10] if _is_iso(row.admit_card_date) else None
    result = row.result_date[:10] if _is_iso(row.result_date) else None

    if result and result <= today:
        return "Result Released"
    if admit and admit <= today and (not exam or exam >= today):
        return "Admit Card Released"
    if start and start > today:
        return "Opening Soon"
    if deadline and deadline >= today:
        return "Closing Soon" if _diff_days(today, deadline) <= 7 else "Applications Open"
    if exam and exam >= today:
        return "Upcoming Exam"
    if deadline and deadline < today:
        return "Closed"
    return "Active Notice"


def _serialize_notification(row: RecruitmentNotification, saved_ids: Optional[Set[int]] = None) -> Dict[str, Any]:
    today = _today_iso()
    deadline = row.application_deadline[:10] if _is_iso(row.application_deadline) else None
    exam = row.exam_date[:10] if _is_iso(row.exam_date) else None
    return {
        "id": row.id,
        "source_id": row.source_id,
        "source_code": row.source.code if row.source else None,
        "source_name": row.source.name if row.source else None,
        "freshness_status": row.source.freshness_status if row.source else None,
        "entity_key": row.entity_key,
        "content_hash": row.content_hash,
        "title": row.title,
        "organization_name": row.organization_name,
        "notification_number": row.notification_number,
        "vacancy_count": row.vacancy_count,
        "job_category": row.job_category,
        "qualification": row.qualification,
        "state": row.state,
        "application_procedure": row.application_procedure,
        "application_start_date": row.application_start_date,
        "application_deadline": row.application_deadline,
        "exam_date": row.exam_date,
        "admit_card_date": row.admit_card_date,
        "result_date": row.result_date,
        "description": row.description,
        "pdf_url": row.pdf_url,
        "source_url": row.source_url,
        "published_date": row.published_date,
        "lifecycle_status": row.lifecycle_status,
        "is_removed": bool(row.is_removed),
        "is_demo_data": bool(row.is_demo_data),
        "first_seen_at": row.first_seen_at.isoformat() if row.first_seen_at else None,
        "last_seen_at": row.last_seen_at.isoformat() if row.last_seen_at else None,
        "source_updated_at": row.source_updated_at.isoformat() if row.source_updated_at else None,
        "status_label": compute_status_label(row),
        "days_to_deadline": _diff_days(today, deadline) if deadline else None,
        "days_to_exam": _diff_days(today, exam) if exam else None,
        "is_saved": (row.id in saved_ids) if saved_ids else False,
    }


def _serialize_source(db: Session, src: MonitoringSource) -> Dict[str, Any]:
    interval_mins = src.crawl_interval_minutes or 360
    base_dt = src.last_attempted_at or datetime.now(timezone.utc)
    next_sched = (base_dt + timedelta(minutes=interval_mins)).isoformat()
    notif_count = (
        db.query(func.count(RecruitmentNotification.id))
        .filter(RecruitmentNotification.source_id == src.id, RecruitmentNotification.is_removed == False)  # noqa: E712
        .scalar()
        or 0
    )
    changes_count = (
        db.query(func.count(ChangeHistory.id))
        .filter(ChangeHistory.source_id == src.id, *_real_change_filters())
        .scalar()
        or 0
    )
    return {
        "id": src.id,
        "code": src.code,
        "name": src.name,
        "organization_name": src.organization_name,
        "base_url": src.base_url,
        "source_type": src.source_type,
        "parser_key": src.parser_key,
        "fixture_filename": src.fixture_filename,
        "scrape_mode": src.scrape_mode,
        "crawl_interval_minutes": src.crawl_interval_minutes,
        "rate_limit_seconds": src.rate_limit_seconds,
        "robots_policy": src.robots_policy,
        "permission_note": src.permission_note,
        "is_active": bool(src.is_active),
        "is_demo_data": bool(src.is_demo_data),
        "freshness_status": src.freshness_status,
        "last_attempted_at": src.last_attempted_at.isoformat() if src.last_attempted_at else None,
        "last_successful_at": src.last_successful_at.isoformat() if src.last_successful_at else None,
        "last_http_status": src.last_http_status,
        "last_error": src.last_error,
        "last_parsed_count": src.last_parsed_count,
        "last_duplicate_count": src.last_duplicate_count,
        "notifications_count": int(notif_count),
        "changes_count": int(changes_count),
        "next_scheduled_at": next_sched,
    }


def _serialize_run(r: ScrapeRun, src: Optional[MonitoringSource] = None) -> Dict[str, Any]:
    source_obj = src or r.source
    return {
        "id": r.id,
        "run_id": r.run_id,
        "source_id": r.source_id,
        "source_code": source_obj.code if source_obj else None,
        "source_name": source_obj.name if source_obj else None,
        "trigger_type": r.trigger_type,
        "mode_used": r.mode_used,
        "status": r.status,
        "http_status": r.http_status,
        "parsed_count": r.parsed_count,
        "new_count": r.new_count,
        "updated_count": r.updated_count,
        "duplicate_count": r.duplicate_count,
        "removed_count": r.removed_count,
        "error_count": r.error_count,
        "duration_ms": r.duration_ms,
        "error_message": r.error_message,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
    }


def _serialize_change(c: ChangeHistory, src: Optional[MonitoringSource] = None) -> Dict[str, Any]:
    return {
        "id": c.id,
        "run_id": c.run_id,
        "source_id": c.source_id,
        "source_code": src.code if src else None,
        "source_name": src.name if src else None,
        "organization_name": src.organization_name if src else None,
        "notification_id": c.notification_id,
        "entity_key": c.entity_key,
        "notification_title": c.notification_title,
        "change_type": c.change_type,
        "changed_field": c.changed_field,
        "change_label": c.change_label,
        "previous_value": c.previous_value,
        "new_value": c.new_value,
        "changed_fields": _safe_json_obj(c.changed_fields_json, []),
        "before_snapshot": _safe_json_obj(c.before_snapshot_json, None),
        "after_snapshot": _safe_json_obj(c.after_snapshot_json, None),
        "source_url": c.source_url,
        "is_verified": bool(c.is_verified),
        "verified_by": c.verified_by,
        "detected_at": c.detected_at.isoformat() if c.detected_at else None,
    }


def _safe_json_list(raw: Optional[str], fallback: List[str]) -> List[str]:
    if not raw:
        return fallback
    try:
        val = json.loads(raw)
        if isinstance(val, list):
            return [str(x) for x in val]
    except Exception:
        pass
    return [s.strip() for s in str(raw).split(",") if s.strip()] or fallback


def _get_preferences(db: Session, user: Optional[User]) -> Dict[str, Any]:
    pref = db.query(UserPreferences).filter(UserPreferences.user_id == user.id).first() if user else None
    if not pref:
        return {
            "target_organizations": ["upsc", "ssc", "ibps", "sbi", "rbi"],
            "target_exams": ["Civil Services", "Combined Graduate Level", "Probationary Officer", "Grade B"],
            "qualification": "Graduate",
            "job_categories": ["Civil Services", "Public Sector Banking", "Central Group B & C", "Regulatory Bodies"],
            "preferred_states": ["All India"],
            "alert_priorities": ["Critical", "High", "Normal", "Low"],
            "saved_only_alerts": False,
            "email_alerts_enabled": True,
            "dark_mode": False,
            "dashboard_page_size": 10,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    return {
        "target_organizations": _safe_json_list(pref.target_organizations, []),
        "target_exams": _safe_json_list(pref.target_exams, []),
        "qualification": pref.qualification or "Graduate",
        "job_categories": _safe_json_list(pref.job_categories, []),
        "preferred_states": _safe_json_list(pref.preferred_states, ["All India"]),
        "alert_priorities": _safe_json_list(pref.alert_priorities, ["Critical", "High", "Normal", "Low"]),
        "saved_only_alerts": bool(pref.saved_only_alerts),
        "email_alerts_enabled": bool(pref.email_alerts_enabled),
        "dark_mode": bool(pref.dark_mode),
        "dashboard_page_size": pref.dashboard_page_size or 10,
        "updated_at": pref.updated_at.isoformat() if pref.updated_at else datetime.now(timezone.utc).isoformat(),
    }


def _score_match(notif: RecruitmentNotification, prefs: Dict[str, Any]):
    reasons: List[str] = []
    score = 0
    src_code = (notif.source.code if notif.source else "").lower()
    title = (notif.title or "").lower()
    cat = (notif.job_category or "").lower()
    qual = (notif.qualification or "").lower()
    state = (notif.state or "").lower()

    if any(o.lower() == src_code for o in prefs["target_organizations"]):
        score += 35
        reasons.append(f"Target organization ({src_code.upper()})")
    for kw in prefs["target_exams"]:
        if kw.strip() and kw.strip().lower() in title:
            score += 30
            reasons.append(f'Matches target exam "{kw.strip()}"')
            break
    if cat and any(c.lower() in cat or cat in c.lower() for c in prefs["job_categories"]):
        score += 20
        reasons.append(f"Category match ({notif.job_category})")
    pref_qual = prefs["qualification"].lower()
    if qual and (pref_qual in qual or ("graduate" in pref_qual and any(t in qual for t in ("graduate", "12th", "10th", "diploma")))):
        score += 15
        reasons.append(f"Qualification compatible ({notif.qualification})")
    if state and any(s.lower() == "all india" or s.lower() in state or state == "all india" for s in prefs["preferred_states"]):
        score += 10
        reasons.append(f"Location match ({notif.state})")
    return score, reasons


def _serialize_user(u: User) -> Dict[str, Any]:
    return {
        "id": u.id,
        "full_name": u.full_name,
        "email": u.email,
        "role": u.role,
        "target_exams": u.target_exams,
        "email_alerts_enabled": bool(u.email_alerts_enabled),
        "is_active": bool(u.is_active),
        "created_at": u.created_at.isoformat() if u.created_at else None,
    }


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "GovTrack API (FastAPI)", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.post("/api/auth/register", status_code=201)
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    clean_email = payload.email.strip().lower()
    if db.query(User).filter(User.email == clean_email).first():
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    user = User(
        full_name=payload.full_name.strip(),
        email=clean_email,
        password_hash=hash_password(payload.password),
        role="user",
        target_exams=payload.target_exams or "UPSC, SSC, IBPS",
        email_alerts_enabled=True,
        is_active=True,
    )
    db.add(user)
    db.flush()
    db.add(UserPreferences(user_id=user.id))
    db.commit()
    db.refresh(user)
    return {"access_token": create_access_token(user), "token_type": "bearer", "user": _serialize_user(user)}


@app.post("/api/auth/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    clean_email = payload.email.strip().lower()
    user = db.query(User).filter(User.email == clean_email).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is deactivated")
    return {"access_token": create_access_token(user), "token_type": "bearer", "user": _serialize_user(user)}


@app.get("/api/auth/me")
def me(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    data = _serialize_user(current_user)
    data["preferences"] = _get_preferences(db, current_user)
    return data


@app.get("/api/profile")
def get_profile(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"user": _serialize_user(current_user), "preferences": _get_preferences(db, current_user)}


@app.put("/api/profile")
def update_profile(payload: ProfileUpdateRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if payload.full_name is not None:
        current_user.full_name = payload.full_name.strip()
    if payload.target_exams is not None:
        current_user.target_exams = ", ".join(payload.target_exams) if isinstance(payload.target_exams, list) else str(payload.target_exams)
    if payload.email_alerts_enabled is not None:
        current_user.email_alerts_enabled = payload.email_alerts_enabled

    pref = db.query(UserPreferences).filter(UserPreferences.user_id == current_user.id).first()
    if not pref:
        pref = UserPreferences(user_id=current_user.id)
        db.add(pref)
    if payload.target_organizations is not None:
        pref.target_organizations = json.dumps(payload.target_organizations)
    if payload.target_exams is not None:
        pref.target_exams = json.dumps(
            payload.target_exams
            if isinstance(payload.target_exams, list)
            else [s.strip() for s in str(payload.target_exams).split(",") if s.strip()]
        )
    if payload.qualification is not None:
        pref.qualification = payload.qualification
    if payload.job_categories is not None:
        pref.job_categories = json.dumps(payload.job_categories)
    if payload.preferred_states is not None:
        pref.preferred_states = json.dumps(payload.preferred_states)
    if payload.alert_priorities is not None:
        pref.alert_priorities = json.dumps(payload.alert_priorities)
    if payload.saved_only_alerts is not None:
        pref.saved_only_alerts = payload.saved_only_alerts
    if payload.email_alerts_enabled is not None:
        pref.email_alerts_enabled = payload.email_alerts_enabled
    if payload.dark_mode is not None:
        pref.dark_mode = payload.dark_mode
    if payload.dashboard_page_size is not None:
        pref.dashboard_page_size = payload.dashboard_page_size
    pref.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(current_user)
    return {"user": _serialize_user(current_user), "preferences": _get_preferences(db, current_user)}


@app.put("/api/profile/password")
def update_password(payload: PasswordUpdateRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")
    current_user.password_hash = hash_password(payload.new_password)
    db.commit()
    return {"status": "updated"}


@app.get("/api/dashboard")
def dashboard(current_user: Optional[User] = Depends(get_optional_user), db: Session = Depends(get_db)):
    today = _today_iso()
    saved_ids = (
        {r.notification_id for r in db.query(SavedNotification).filter(SavedNotification.user_id == current_user.id).all()}
        if current_user
        else set()
    )
    prefs = _get_preferences(db, current_user)

    all_active = db.query(RecruitmentNotification).filter(RecruitmentNotification.is_removed == False).all()  # noqa: E712
    non_cancelled = [n for n in all_active if n.lifecycle_status != "cancelled"]

    cutoff_7d = datetime.now(timezone.utc) - timedelta(days=7)
    new_recent_cnt = sum(
        1
        for n in all_active
        if n.first_seen_at and (n.first_seen_at.replace(tzinfo=timezone.utc) if n.first_seen_at.tzinfo is None else n.first_seen_at) >= cutoff_7d
    )

    total_changes = db.query(func.count(ChangeHistory.id)).filter(*_real_change_filters()).scalar() or 0
    unread_alerts = db.query(func.count(Alert.id)).filter(Alert.is_read == False).scalar() or 0  # noqa: E712

    sources = db.query(MonitoringSource).order_by(MonitoringSource.id.asc()).all()
    src_by_id = {s.id: s for s in sources}
    healthy_sources = sum(1 for s in sources if s.is_active and s.freshness_status == "Healthy")
    failed_sources = sum(1 for s in sources if s.is_active and s.freshness_status in ("Failed", "Rate Limited"))

    upcoming_deadlines = sorted(
        [n for n in non_cancelled if _is_iso(n.application_deadline) and n.application_deadline[:10] >= today],
        key=lambda x: x.application_deadline or "9999-12-31",
    )[:8]
    upcoming_exams = sorted(
        [n for n in non_cancelled if _is_iso(n.exam_date) and n.exam_date[:10] >= today],
        key=lambda x: x.exam_date or "9999-12-31",
    )[:8]
    latest = sorted(
        all_active,
        key=lambda x: (x.published_date or (x.first_seen_at.isoformat()[:10] if x.first_seen_at else ""), x.id),
        reverse=True,
    )[:8]
    recent_changes = (
        db.query(ChangeHistory)
        .filter(*_real_change_filters())
        .order_by(ChangeHistory.detected_at.desc(), ChangeHistory.id.desc())
        .limit(10)
        .all()
    )

    by_org = []
    for s in sources:
        cnt = sum(1 for n in all_active if n.source_id == s.id)
        by_org.append({"code": s.code, "name": s.name, "organization_name": s.organization_name, "count": cnt})
    by_org.sort(key=lambda x: (x["count"], x["code"]), reverse=True)

    month_counts: Dict[str, int] = {}
    for n in all_active:
        m = (n.published_date or (n.first_seen_at.isoformat()[:7] if n.first_seen_at else "2026-11"))[:7]
        month_counts[m] = month_counts.get(m, 0) + 1
    trends = [{"month": k, "count": v} for k, v in sorted(month_counts.items())[-12:]]

    change_dist_map: Dict[str, Dict[str, Any]] = {}
    for c in db.query(ChangeHistory).filter(*_real_change_filters()).all():
        lbl = c.change_label or c.change_type
        if lbl not in change_dist_map:
            change_dist_map[lbl] = {"label": lbl, "change_type": c.change_type, "count": 0}
        change_dist_map[lbl]["count"] += 1

    deadline_months: Dict[str, Dict[str, Any]] = {}
    for n in non_cancelled:
        if _is_iso(n.application_deadline) and n.application_deadline[:10] >= today:
            d10 = n.application_deadline[:10]
            m = d10[:7]
            if m not in deadline_months:
                deadline_months[m] = {"month": m, "count": 0, "next_date": d10}
            deadline_months[m]["count"] += 1
            if d10 < deadline_months[m]["next_date"]:
                deadline_months[m]["next_date"] = d10

    recs = []
    for n in non_cancelled:
        score, reasons = _score_match(n, prefs)
        if score > 0:
            item = _serialize_notification(n, saved_ids)
            item["match_score"] = score
            item["match_reasons"] = reasons
            recs.append(item)
    recs.sort(key=lambda x: x["match_score"], reverse=True)

    recent_runs = db.query(ScrapeRun).order_by(ScrapeRun.completed_at.desc()).limit(10).all()

    return {
        "stats": {
            "total_active_notifications": len(non_cancelled),
            "new_notifications_discovered": new_recent_cnt,
            "new_change_events": 0,
            "total_changes_detected": int(total_changes),
            "upcoming_deadlines_count": sum(1 for n in non_cancelled if _is_iso(n.application_deadline) and n.application_deadline[:10] >= today),
            "upcoming_exams_count": sum(1 for n in non_cancelled if _is_iso(n.exam_date) and n.exam_date[:10] >= today),
            "unread_alerts_count": int(unread_alerts),
            "healthy_sources_count": healthy_sources,
            "failed_sources_count": failed_sources,
            "total_sources_count": len(sources),
            "demo_records_count": sum(1 for n in non_cancelled if n.is_demo_data),
            "live_records_count": sum(1 for n in non_cancelled if not n.is_demo_data),
        },
        "charts": {
            "by_organization": by_org,
            "trends_over_time": trends,
            "change_types_distribution": sorted(change_dist_map.values(), key=lambda x: x["count"], reverse=True),
            "upcoming_deadlines_timeline": [deadline_months[k] for k in sorted(deadline_months.keys())[:8]],
        },
        "upcoming_deadlines": [_serialize_notification(n, saved_ids) for n in upcoming_deadlines],
        "upcoming_examinations": [_serialize_notification(n, saved_ids) for n in upcoming_exams],
        "latest_notifications": [_serialize_notification(n, saved_ids) for n in latest],
        "recent_changes": [_serialize_change(c, src_by_id.get(c.source_id)) for c in recent_changes],
        "sources": [_serialize_source(db, s) for s in sources],
        "recommendations": recs[:6],
        "recent_runs": [_serialize_run(r, src_by_id.get(r.source_id)) for r in recent_runs],
    }


@app.get("/api/opportunities")
def get_opportunities(current_user: Optional[User] = Depends(get_optional_user), db: Session = Depends(get_db)):
    today = _today_iso()
    saved_ids = (
        {r.notification_id for r in db.query(SavedNotification).filter(SavedNotification.user_id == current_user.id).all()}
        if current_user
        else set()
    )
    prefs = _get_preferences(db, current_user)
    all_active = db.query(RecruitmentNotification).filter(RecruitmentNotification.is_removed == False).all()  # noqa: E712

    matched = []
    for n in all_active:
        score, reasons = _score_match(n, prefs)
        if score >= 25:
            item = _serialize_notification(n, saved_ids)
            item["match_score"] = score
            item["match_reasons"] = reasons
            matched.append(item)
    matched.sort(key=lambda x: x["match_score"], reverse=True)

    approaching_deadlines = sorted(
        [
            n
            for n in matched
            if _is_iso(n.get("application_deadline"))
            and str(n["application_deadline"])[:10] >= today
            and (n.get("days_to_deadline") if isinstance(n.get("days_to_deadline"), int) else 999) <= 21
        ],
        key=lambda x: str(x["application_deadline"]),
    )
    upcoming_exams = sorted(
        [n for n in matched if _is_iso(n.get("exam_date")) and str(n["exam_date"])[:10] >= today],
        key=lambda x: str(x["exam_date"]),
    )

    saved_changes: List[Dict[str, Any]] = []
    if saved_ids:
        src_by_id = {s.id: s for s in db.query(MonitoringSource).all()}
        ch_rows = (
            db.query(ChangeHistory)
            .filter(ChangeHistory.notification_id.in_(list(saved_ids)), *_real_change_filters())
            .order_by(ChangeHistory.detected_at.desc(), ChangeHistory.id.desc())
            .limit(20)
            .all()
        )
        saved_changes = [_serialize_change(c, src_by_id.get(c.source_id)) for c in ch_rows]

    return {
        "preferences": prefs,
        "matched_notifications": matched,
        "approaching_deadlines": approaching_deadlines,
        "upcoming_exams": upcoming_exams,
        "saved_changes": saved_changes,
        "summary": {
            "total_matched": len(matched),
            "approaching_deadlines_count": len(approaching_deadlines),
            "upcoming_exams_count": len(upcoming_exams),
            "saved_changes_count": len(saved_changes),
        },
    }


@app.get("/api/calendar")
def get_calendar(source_code: str = "", event_type: str = "", db: Session = Depends(get_db)):
    today = _today_iso()
    query = db.query(RecruitmentNotification).join(MonitoringSource).filter(RecruitmentNotification.is_removed == False)  # noqa: E712
    if source_code.strip():
        query = query.filter(MonitoringSource.code == source_code.strip().lower())
    rows = query.all()

    et_filter = event_type.strip().lower()
    events: List[Dict[str, Any]] = []
    for row in rows:
        status_label = compute_status_label(row)
        candidates = [
            ("deadline", "Application Deadline", row.application_deadline),
            ("exam", "Examination Date", row.exam_date),
            ("admit_card", "Admit Card Release", row.admit_card_date),
            ("result", "Result Date", row.result_date),
        ]
        for c_type, c_label, raw_val in candidates:
            if not raw_val or not _is_iso(raw_val):
                continue
            if et_filter and et_filter != c_type:
                continue
            date_str = str(raw_val)[:10]
            days = _diff_days(today, date_str)
            events.append(
                {
                    "id": f"{row.id}-{c_type}",
                    "notification_id": row.id,
                    "title": row.title,
                    "organization_name": row.organization_name,
                    "source_code": row.source.code if row.source else "",
                    "event_type": c_type,
                    "event_label": c_label,
                    "date": date_str,
                    "days_remaining": days,
                    "is_upcoming": days >= 0 and row.lifecycle_status != "cancelled",
                    "status_label": status_label,
                }
            )
    events.sort(key=lambda x: x["date"])
    return {
        "events": events,
        "upcoming_events": [e for e in events if e["is_upcoming"]],
        "today": today,
    }


@app.get("/api/notifications")
def list_notifications(
    q: str = "",
    source_code: str = "",
    category: str = "",
    qualification: str = "",
    state: str = "",
    app_status: str = "",
    status_filter: str = "",
    sort: str = "newest",
    page: int = Query(1, ge=1),
    page_size: int = Query(12, ge=1, le=50),
    current_user: Optional[User] = Depends(get_optional_user),
    db: Session = Depends(get_db),
):
    saved_ids = (
        {r.notification_id for r in db.query(SavedNotification).filter(SavedNotification.user_id == current_user.id).all()}
        if current_user
        else set()
    )
    query = db.query(RecruitmentNotification).join(MonitoringSource)
    sf = status_filter.strip().lower()
    if sf == "removed":
        query = query.filter(RecruitmentNotification.is_removed == True)  # noqa: E712
    elif sf == "cancelled":
        query = query.filter(RecruitmentNotification.lifecycle_status == "cancelled")
    elif sf != "all":
        query = query.filter(RecruitmentNotification.is_removed == False)  # noqa: E712

    if source_code:
        query = query.filter(MonitoringSource.code == source_code.strip().lower())
    if category:
        query = query.filter(RecruitmentNotification.job_category == category)

    rows = query.all()
    items = [_serialize_notification(r, saved_ids) for r in rows]

    if q.strip():
        ql = q.strip().lower()
        items = [
            it
            for it in items
            if ql in (it["title"] or "").lower()
            or ql in (it["organization_name"] or "").lower()
            or ql in (it["notification_number"] or "").lower()
            or ql in (it["description"] or "").lower()
            or ql in (it["job_category"] or "").lower()
        ]
    if qualification:
        items = [it for it in items if qualification.lower() in (it["qualification"] or "").lower()]
    if state:
        items = [it for it in items if state.lower() in (it["state"] or "").lower()]
    if app_status:
        items = [it for it in items if it["status_label"].lower() == app_status.lower()]

    today = _today_iso()
    if sf == "open":
        items = [it for it in items if it["status_label"] in ("Applications Open", "Closing Soon")]
    elif sf == "closing_soon":
        items = [it for it in items if it["status_label"] == "Closing Soon"]
    elif sf == "upcoming_exam":
        items = [it for it in items if _is_iso(it.get("exam_date")) and str(it["exam_date"])[:10] >= today]

    if sort == "deadline":
        items.sort(key=lambda x: str(x["application_deadline"])[:10] if _is_iso(x.get("application_deadline")) else "9999-12-31")
    elif sort == "exam_date":
        items.sort(key=lambda x: str(x["exam_date"])[:10] if _is_iso(x.get("exam_date")) else "9999-12-31")
    else:
        items.sort(key=lambda x: (x["published_date"] or (x["first_seen_at"][:10] if x["first_seen_at"] else ""), x["id"]), reverse=True)

    total = len(items)
    total_pages = max(1, math.ceil(total / page_size))
    offset = (page - 1) * page_size

    orgs = [
        {"code": s.code, "organization_name": s.organization_name}
        for s in db.query(MonitoringSource).order_by(MonitoringSource.organization_name.asc()).all()
    ]
    categories = [
        r[0]
        for r in db.query(RecruitmentNotification.job_category)
        .filter(RecruitmentNotification.job_category.isnot(None))
        .distinct()
        .order_by(RecruitmentNotification.job_category.asc())
        .all()
    ]
    qualifications = [
        r[0]
        for r in db.query(RecruitmentNotification.qualification)
        .filter(RecruitmentNotification.qualification.isnot(None))
        .distinct()
        .order_by(RecruitmentNotification.qualification.asc())
        .all()
    ]
    states = [
        r[0]
        for r in db.query(RecruitmentNotification.state)
        .filter(RecruitmentNotification.state.isnot(None))
        .distinct()
        .order_by(RecruitmentNotification.state.asc())
        .all()
    ]

    return {
        "items": items[offset : offset + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "filters": {
            "organizations": orgs,
            "categories": categories,
            "qualifications": qualifications,
            "states": states,
        },
    }


@app.get("/api/notifications/{notif_id}")
def get_notification(notif_id: int, current_user: Optional[User] = Depends(get_optional_user), db: Session = Depends(get_db)):
    row = db.query(RecruitmentNotification).filter(RecruitmentNotification.id == notif_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Notification not found")
    saved_ids = (
        {r.notification_id for r in db.query(SavedNotification).filter(SavedNotification.user_id == current_user.id).all()}
        if current_user
        else set()
    )
    versions = (
        db.query(NotificationVersion)
        .filter(NotificationVersion.notification_id == notif_id)
        .order_by(NotificationVersion.version_number.desc())
        .all()
    )
    changes = (
        db.query(ChangeHistory)
        .filter(ChangeHistory.notification_id == notif_id, *_real_change_filters())
        .order_by(ChangeHistory.detected_at.desc(), ChangeHistory.id.desc())
        .all()
    )
    related = (
        db.query(RecruitmentNotification)
        .filter(RecruitmentNotification.id != notif_id, RecruitmentNotification.is_removed == False, RecruitmentNotification.source_id == row.source_id)  # noqa: E712
        .order_by(RecruitmentNotification.published_date.desc())
        .limit(4)
        .all()
    )
    src = row.source
    return {
        "notification": _serialize_notification(row, saved_ids),
        "versions": [
            {
                "id": v.id,
                "notification_id": v.notification_id,
                "version_number": v.version_number,
                "title": v.title,
                "organization_name": v.organization_name,
                "notification_number": v.notification_number,
                "vacancy_count": v.vacancy_count,
                "job_category": v.job_category,
                "qualification": v.qualification,
                "state": v.state,
                "application_start_date": v.application_start_date,
                "application_deadline": v.application_deadline,
                "exam_date": v.exam_date,
                "admit_card_date": v.admit_card_date,
                "result_date": v.result_date,
                "description": v.description,
                "pdf_url": v.pdf_url,
                "source_url": v.source_url,
                "published_date": v.published_date,
                "notification_status": v.notification_status,
                "content_hash": v.content_hash,
                "run_id": v.run_id,
                "captured_at": v.captured_at.isoformat(),
                "snapshot": _safe_json_obj(v.snapshot_json, {}),
            }
            for v in versions
        ],
        "changes": [_serialize_change(c, src) for c in changes],
        "related": [_serialize_notification(r, saved_ids) for r in related],
    }


@app.get("/api/notifications/{notif_id}/pdf")
def export_notification_pdf(notif_id: int, db: Session = Depends(get_db)):
    row = db.query(RecruitmentNotification).filter(RecruitmentNotification.id == notif_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Notification not found")
    pdf_bytes = build_notification_pdf(_serialize_notification(row))
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="govtrack-notification-{notif_id}.pdf"'},
    )


@app.get("/api/notifications/{notif_id}/official-pdf")
def proxy_official_pdf(notif_id: int, db: Session = Depends(get_db)):
    row = db.query(RecruitmentNotification).filter(RecruitmentNotification.id == notif_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Notification not found")
    source_code = row.source.code if row.source else "gov"
    target_pdf_url = row.pdf_url

    if not target_pdf_url and row.source_url:
        discovered = discover_pdf_url_from_html_page(row.source_url, timeout=7.0)
        if discovered:
            target_pdf_url = discovered
            row.pdf_url = discovered
            db.commit()

    if target_pdf_url:
        fetched = fetch_official_pdf_buffer(target_pdf_url, row.source_url, max_bytes=25_000_000, timeout=10.0, retries=1)
        if fetched:
            pdf_content, _ = fetched
            return Response(
                content=pdf_content,
                media_type="application/pdf",
                headers={
                    "Content-Disposition": f'inline; filename="official-{source_code}-{notif_id}.pdf"',
                    "Cache-Control": "public, max-age=3600",
                    "X-PDF-Origin": "official-source",
                },
            )

    pdf_bytes = build_notification_pdf(_serialize_notification(row))
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="govtrack-official-notice-{source_code}-{notif_id}.pdf"',
            "X-PDF-Origin": "govtrack-verified-summary",
        },
    )


@app.get("/api/changes")
def list_changes(
    change_type: str = "",
    source_code: str = "",
    changed_field: str = "",
    q: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=50),
    db: Session = Depends(get_db),
):
    query = db.query(ChangeHistory).join(MonitoringSource).filter(*_real_change_filters())
    if change_type:
        query = query.filter((ChangeHistory.change_type == change_type) | (ChangeHistory.change_label == change_type))
    if source_code:
        query = query.filter(MonitoringSource.code == source_code.strip().lower())
    if changed_field:
        query = query.filter(ChangeHistory.changed_field == changed_field)
    rows = query.order_by(ChangeHistory.detected_at.desc(), ChangeHistory.id.desc()).all()
    src_by_id = {s.id: s for s in db.query(MonitoringSource).all()}
    if q.strip():
        ql = q.strip().lower()
        rows = [
            r
            for r in rows
            if ql in r.notification_title.lower()
            or ql in (r.change_label or "").lower()
            or ql in (src_by_id.get(r.source_id).organization_name.lower() if src_by_id.get(r.source_id) else "")
        ]
    total = len(rows)
    offset = (page - 1) * page_size
    return {
        "items": [_serialize_change(r, src_by_id.get(r.source_id)) for r in rows[offset : offset + page_size]],
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": max(1, math.ceil(total / page_size)),
    }


@app.post("/api/changes/{change_id}/verify")
def verify_change(change_id: int, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    row = db.query(ChangeHistory).filter(ChangeHistory.id == change_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Change record not found")
    row.is_verified = True
    row.verified_by = admin.email
    db.query(Alert).filter(Alert.change_id == change_id).update({"is_verified": True})
    db.commit()
    return {"status": "verified", "verified_by": admin.email}


@app.post("/api/demo/run-change-detection")
def demo_run_change_detection(
    payload: Optional[Dict[str, Any]] = Body(default=None),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    body = payload or {}
    req_fixture = str(body["fixture"]) if body.get("fixture") else None
    req_source = str(body["source_code"]) if body.get("source_code") else None
    if req_source and req_fixture:
        src = db.query(MonitoringSource).filter(MonitoringSource.code == req_source).first()
        if not src:
            raise HTTPException(status_code=404, detail="Source not found")
        run = run_source_scrape(db, src, trigger_type="demo_fixture", mode_override="fixture", fixture_override=req_fixture)
        return {"runs": [_serialize_run(run, src)], "demo_data": True}

    runs = []
    for code, fixture in (("upsc", "upsc_v2_updated.html"), ("ssc", "ssc_v2_updated.html"), ("ibps", "ibps_v2_updated.html")):
        src = db.query(MonitoringSource).filter(MonitoringSource.code == code).first()
        if src:
            run = run_source_scrape(db, src, trigger_type="demo_fixture", mode_override="fixture", fixture_override=fixture)
            runs.append(_serialize_run(run, src))
    return {"runs": runs, "demo_data": True}


@app.get("/api/alerts")
def list_alerts(
    unread_only: bool = False,
    alert_type: str = "",
    priority: str = "",
    source_code: str = "",
    q: str = "",
    db: Session = Depends(get_db),
):
    query = db.query(Alert).join(MonitoringSource)
    if unread_only:
        query = query.filter(Alert.is_read == False)  # noqa: E712
    if alert_type:
        query = query.filter(Alert.alert_type == alert_type)
    if priority:
        query = query.filter(Alert.priority == priority)
    if source_code.strip():
        query = query.filter(MonitoringSource.code == source_code.strip().lower())
    items = query.order_by(Alert.created_at.desc(), Alert.id.desc()).limit(100).all()
    if q.strip():
        ql = q.strip().lower()
        items = [a for a in items if ql in (a.title or "").lower() or ql in (a.message or "").lower()]
    src_by_id = {s.id: s for s in db.query(MonitoringSource).all()}
    unread_count = db.query(func.count(Alert.id)).filter(Alert.is_read == False).scalar() or 0  # noqa: E712
    return {
        "items": [
            {
                "id": a.id,
                "change_id": a.change_id,
                "source_id": a.source_id,
                "source_code": src_by_id.get(a.source_id).code if src_by_id.get(a.source_id) else None,
                "organization_name": src_by_id.get(a.source_id).organization_name if src_by_id.get(a.source_id) else None,
                "notification_id": a.notification_id,
                "title": a.title,
                "message": a.message,
                "alert_type": a.alert_type,
                "priority": a.priority,
                "severity": a.severity,
                "is_read": bool(a.is_read),
                "is_verified": bool(a.is_verified),
                "created_at": a.created_at.isoformat(),
            }
            for a in items
        ],
        "unread_count": int(unread_count),
    }


@app.post("/api/alerts/{alert_id}/read")
def mark_alert_read(
    alert_id: int,
    payload: Optional[Dict[str, Any]] = Body(default=None),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    alert = db.query(Alert).filter(Alert.id == alert_id).first()
    next_read = False if (payload and payload.get("is_read") is False) else True
    if alert:
        alert.is_read = next_read
        db.commit()
    return {"status": "read" if next_read else "unread", "is_read": next_read}


@app.post("/api/alerts/read-all")
def mark_all_read(_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(Alert).filter(Alert.is_read == False).update({"is_read": True})  # noqa: E712
    db.commit()
    return {"status": "all_read"}


@app.delete("/api/alerts/{alert_id}")
def delete_alert(alert_id: int, _user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(Alert).filter(Alert.id == alert_id).delete()
    db.commit()
    return {"status": "deleted"}


@app.get("/api/sources")
def list_sources(db: Session = Depends(get_db)):
    return [_serialize_source(db, s) for s in db.query(MonitoringSource).order_by(MonitoringSource.id.asc()).all()]


# IMPORTANT: Register static /api/sources/scrape-all-live BEFORE /api/sources/{source_id}... routes
@app.post("/api/sources/scrape-all-live")
def scrape_all_live(_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    source_ids = [
        row[0]
        for row in db.query(MonitoringSource.id)
        .filter(MonitoringSource.is_active == True)  # noqa: E712
        .order_by(MonitoringSource.id.asc())
        .all()
    ]

    def _worker(src_id: int) -> Optional[Dict[str, Any]]:
        wdb = SessionLocal()
        try:
            src = wdb.query(MonitoringSource).filter(MonitoringSource.id == src_id).first()
            if not src:
                return None
            run = run_source_scrape(wdb, src, trigger_type="manual_live_all", mode_override="live")
            return _serialize_run(run, src)
        finally:
            wdb.close()

    with ThreadPoolExecutor(max_workers=4) as pool:
        runs = [r for r in pool.map(_worker, source_ids) if r is not None]

    scheduler_state["last_run_at"] = datetime.now(timezone.utc).isoformat()
    return {"total_sources": len(source_ids), "runs": runs}


@app.get("/api/sources/{source_id}/logs")
def source_logs(source_id: int, db: Session = Depends(get_db)):
    src = db.query(MonitoringSource).filter(MonitoringSource.id == source_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
    runs = db.query(ScrapeRun).filter(ScrapeRun.source_id == source_id).order_by(ScrapeRun.started_at.desc()).limit(20).all()
    logs = (
        db.query(MonitoringLog)
        .filter(MonitoringLog.source_id == source_id)
        .order_by(MonitoringLog.created_at.desc(), MonitoringLog.id.desc())
        .limit(60)
        .all()
    )
    return {
        "source": _serialize_source(db, src),
        "runs": [_serialize_run(r, src) for r in runs],
        "logs": [
            {
                "id": l.id,
                "run_id": l.run_id,
                "source_id": l.source_id,
                "source_code": src.code,
                "source_name": src.name,
                "level": l.level,
                "message": l.message,
                "created_at": l.created_at.isoformat(),
            }
            for l in logs
        ],
    }


@app.post("/api/sources/{source_id}/scrape")
def scrape_source(
    source_id: int,
    payload: Optional[SourceScrapeRequest] = Body(default=None),
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    src = db.query(MonitoringSource).filter(MonitoringSource.id == source_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
    req = payload or SourceScrapeRequest()
    run = run_source_scrape(
        db,
        src,
        trigger_type="manual",
        mode_override=req.mode,
        fixture_override=req.fixture,
        simulate_http_status=req.simulate_status,
    )
    return _serialize_run(run, src)


@app.post("/api/sources", status_code=201)
def create_source(payload: SourceCreateRequest, _admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    code = payload.code.strip().lower()
    if db.query(MonitoringSource).filter(MonitoringSource.code == code).first():
        raise HTTPException(status_code=409, detail="Source code already exists")
    src = MonitoringSource(
        code=code,
        name=payload.name,
        organization_name=payload.organization_name,
        base_url=payload.base_url,
        source_type=payload.source_type,
        parser_key=payload.parser_key or code,
        fixture_filename=payload.fixture_filename or f"{code}.html",
        scrape_mode=payload.scrape_mode,
        crawl_interval_minutes=payload.crawl_interval_minutes,
        rate_limit_seconds=payload.rate_limit_seconds,
        robots_policy=payload.robots_policy or "Respect robots.txt",
        permission_note=payload.permission_note or "Official portal",
    )
    db.add(src)
    db.commit()
    db.refresh(src)
    return _serialize_source(db, src)


@app.patch("/api/sources/{source_id}")
def update_source(source_id: int, payload: SourceConfigUpdateRequest, _admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    src = db.query(MonitoringSource).filter(MonitoringSource.id == source_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
    for field in ("name", "base_url", "source_type", "is_active", "scrape_mode", "crawl_interval_minutes", "rate_limit_seconds"):
        val = getattr(payload, field)
        if val is not None:
            setattr(src, field, val)
    if payload.is_active is False:
        src.freshness_status = "Disabled"
    elif payload.is_active is True and src.freshness_status == "Disabled":
        src.freshness_status = "Pending"
    db.commit()
    db.refresh(src)
    return _serialize_source(db, src)


@app.delete("/api/sources/{source_id}")
def delete_source(source_id: int, _admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    src = db.query(MonitoringSource).filter(MonitoringSource.id == source_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
    db.delete(src)
    db.commit()
    return {"status": "deleted"}


@app.get("/api/saved")
def list_saved(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(SavedNotification).filter(SavedNotification.user_id == current_user.id).order_by(SavedNotification.saved_at.desc()).all()
    saved_ids = {r.notification_id for r in rows}
    items = []
    for r in rows:
        notif = db.query(RecruitmentNotification).filter(RecruitmentNotification.id == r.notification_id).first()
        if notif:
            data = _serialize_notification(notif, saved_ids)
            data["notes"] = r.notes or ""
            data["saved_at"] = r.saved_at.isoformat()
            items.append(data)
    saved_alerts: List[Dict[str, Any]] = []
    if saved_ids:
        src_by_id = {s.id: s for s in db.query(MonitoringSource).all()}
        alert_rows = (
            db.query(Alert)
            .filter(Alert.notification_id.in_(list(saved_ids)))
            .order_by(Alert.created_at.desc())
            .limit(30)
            .all()
        )
        saved_alerts = [
            {
                "id": a.id,
                "change_id": a.change_id,
                "source_id": a.source_id,
                "source_code": src_by_id.get(a.source_id).code if src_by_id.get(a.source_id) else None,
                "organization_name": src_by_id.get(a.source_id).organization_name if src_by_id.get(a.source_id) else None,
                "notification_id": a.notification_id,
                "title": a.title,
                "message": a.message,
                "alert_type": a.alert_type,
                "priority": a.priority,
                "severity": a.severity,
                "is_read": bool(a.is_read),
                "is_verified": bool(a.is_verified),
                "created_at": a.created_at.isoformat(),
            }
            for a in alert_rows
        ]
    return {"items": items, "saved_alerts": saved_alerts}


@app.post("/api/saved/{notification_id}", status_code=201)
def save_notification(
    notification_id: int,
    payload: Optional[SaveBookmarkRequest] = Body(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = (
        db.query(SavedNotification)
        .filter(SavedNotification.user_id == current_user.id, SavedNotification.notification_id == notification_id)
        .first()
    )
    notes = payload.notes if payload else None
    if existing:
        if notes is not None:
            existing.notes = notes
            db.commit()
        return {"status": "updated", "notification_id": notification_id}
    db.add(SavedNotification(user_id=current_user.id, notification_id=notification_id, notes=notes))
    db.commit()
    return {"status": "saved", "notification_id": notification_id}


@app.delete("/api/saved/{notification_id}")
def delete_saved(notification_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(SavedNotification).filter(
        SavedNotification.user_id == current_user.id,
        SavedNotification.notification_id == notification_id,
    ).delete()
    db.commit()
    return {"status": "removed", "notification_id": notification_id}


@app.get("/api/admin/system-health")
def admin_system_health(_admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    total_sources = db.query(func.count(MonitoringSource.id)).scalar() or 0
    healthy_sources = (
        db.query(func.count(MonitoringSource.id))
        .filter(MonitoringSource.is_active == True, MonitoringSource.freshness_status == "Healthy")  # noqa: E712
        .scalar()
        or 0
    )
    failed_sources = (
        db.query(func.count(MonitoringSource.id))
        .filter(MonitoringSource.is_active == True, MonitoringSource.freshness_status.in_(["Failed", "Rate Limited"]))  # noqa: E712
        .scalar()
        or 0
    )
    disabled_sources = (
        db.query(func.count(MonitoringSource.id))
        .filter(MonitoringSource.is_active == False)  # noqa: E712
        .scalar()
        or 0
    )
    total_runs = db.query(func.count(ScrapeRun.id)).scalar() or 0
    failed_runs = db.query(func.count(ScrapeRun.id)).filter(ScrapeRun.status != "success").scalar() or 0
    total_notifications = db.query(func.count(RecruitmentNotification.id)).scalar() or 0
    total_changes = db.query(func.count(ChangeHistory.id)).filter(*_real_change_filters()).scalar() or 0
    unverified_changes = (
        db.query(func.count(ChangeHistory.id))
        .filter(ChangeHistory.is_verified == False, *_real_change_filters())  # noqa: E712
        .scalar()
        or 0
    )
    total_users = db.query(func.count(User.id)).scalar() or 0

    return {
        "total_sources": int(total_sources),
        "healthy_sources": int(healthy_sources),
        "failed_sources": int(failed_sources),
        "disabled_sources": int(disabled_sources),
        "total_runs": int(total_runs),
        "failed_runs": int(failed_runs),
        "total_notifications": int(total_notifications),
        "total_changes": int(total_changes),
        "unverified_changes": int(unverified_changes),
        "total_users": int(total_users),
        "scheduler": {
            "intervalMinutes": scheduler_state["interval_minutes"],
            "enabled": scheduler_state["enabled"],
            "lastRunAt": scheduler_state["last_run_at"],
        },
        "node_version": f"Python {platform.python_version()}",
        "uptime_seconds": round(time.monotonic() - APP_START_TIME),
    }


@app.get("/api/admin/runs")
def admin_runs(_admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    src_by_id = {s.id: s for s in db.query(MonitoringSource).all()}
    runs = db.query(ScrapeRun).order_by(ScrapeRun.started_at.desc()).limit(50).all()
    return [_serialize_run(r, src_by_id.get(r.source_id)) for r in runs]


@app.get("/api/admin/logs")
def admin_logs(level: str = "", _admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    query = db.query(MonitoringLog)
    if level.strip():
        query = query.filter(MonitoringLog.level == level.strip().upper())
    logs = query.order_by(MonitoringLog.created_at.desc(), MonitoringLog.id.desc()).limit(120).all()
    src_by_id = {s.id: s for s in db.query(MonitoringSource).all()}
    return [
        {
            "id": l.id,
            "run_id": l.run_id,
            "source_id": l.source_id,
            "source_code": src_by_id.get(l.source_id).code if src_by_id.get(l.source_id) else None,
            "source_name": src_by_id.get(l.source_id).name if src_by_id.get(l.source_id) else None,
            "level": l.level,
            "message": l.message,
            "created_at": l.created_at.isoformat(),
        }
        for l in logs
    ]


@app.get("/api/admin/failures")
def admin_failures(_admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    src_by_id = {s.id: s for s in db.query(MonitoringSource).all()}
    runs = db.query(ScrapeRun).filter(ScrapeRun.status != "success").order_by(ScrapeRun.started_at.desc()).limit(50).all()
    out = []
    for r in runs:
        d = _serialize_run(r, src_by_id.get(r.source_id))
        d["base_url"] = src_by_id[r.source_id].base_url if r.source_id in src_by_id else None
        out.append(d)
    return out


@app.get("/api/admin/users")
def admin_users(_admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return [_serialize_user(u) for u in db.query(User).order_by(User.id.asc()).all()]


@app.patch("/api/admin/users/{user_id}")
def admin_update_user(user_id: int, payload: AdminUserUpdateRequest, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if payload.role in ("user", "admin"):
        target.role = payload.role
    if payload.is_active is not None:
        if target.id == admin.id and not payload.is_active:
            raise HTTPException(status_code=400, detail="Cannot deactivate your own admin account.")
        target.is_active = payload.is_active
    db.commit()
    return _serialize_user(target)


@app.get("/api/admin/categories")
def admin_categories(_admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return [{"id": c.id, "name": c.name, "description": c.description} for c in db.query(Category).order_by(Category.name.asc()).all()]


@app.post("/api/admin/categories", status_code=201)
def admin_create_category(payload: CategoryCreateRequest, _admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    if db.query(Category).filter(Category.name == payload.name.strip()).first():
        raise HTTPException(status_code=409, detail="Category already exists")
    cat = Category(name=payload.name.strip(), description=payload.description)
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return {"id": cat.id, "name": cat.name, "description": cat.description}


@app.delete("/api/admin/categories/{cat_id}")
def admin_delete_category(cat_id: int, _admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    db.query(Category).filter(Category.id == cat_id).delete()
    db.commit()
    return {"status": "deleted"}


@app.delete("/api/admin/notifications/{notif_id}")
def admin_delete_notification(notif_id: int, _admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    row = db.query(RecruitmentNotification).filter(RecruitmentNotification.id == notif_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Notification not found")
    db.delete(row)
    db.commit()
    return {"status": "deleted"}


@app.get("/api/admin/scheduler")
def admin_get_scheduler(_admin: User = Depends(require_admin)):
    return {
        "intervalMinutes": scheduler_state["interval_minutes"],
        "enabled": scheduler_state["enabled"],
        "lastRunAt": scheduler_state["last_run_at"],
    }


@app.put("/api/admin/scheduler")
def admin_update_scheduler(payload: SchedulerUpdateRequest, _admin: User = Depends(require_admin)):
    if payload.interval_minutes is not None:
        scheduler_state["interval_minutes"] = payload.interval_minutes
    if payload.enabled is not None:
        scheduler_state["enabled"] = payload.enabled
    return {
        "intervalMinutes": scheduler_state["interval_minutes"],
        "enabled": scheduler_state["enabled"],
        "lastRunAt": scheduler_state["last_run_at"],
    }


@app.post("/api/admin/scrape-all")
def admin_scrape_all(
    payload: Optional[Dict[str, Any]] = Body(default=None),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    mode = str((payload or {}).get("mode") or "live")
    source_ids = [
        row[0]
        for row in db.query(MonitoringSource.id)
        .filter(MonitoringSource.is_active == True)  # noqa: E712
        .order_by(MonitoringSource.id.asc())
        .all()
    ]
    runs = []
    for src_id in source_ids:
        src = db.query(MonitoringSource).filter(MonitoringSource.id == src_id).first()
        if src:
            run = run_source_scrape(db, src, trigger_type="admin_batch", mode_override=mode)
            runs.append(_serialize_run(run, src))
    scheduler_state["last_run_at"] = datetime.now(timezone.utc).isoformat()
    return {"runs": runs}
