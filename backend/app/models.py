from datetime import datetime, timezone
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship
from .database import Base


def utcnow():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    full_name = Column(String(120), nullable=False)
    email = Column(String(255), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(20), nullable=False, default="user")
    target_exams = Column(String(255), nullable=True, default="UPSC, SSC, IBPS")
    email_alerts_enabled = Column(Boolean, nullable=False, default=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)

    saved_notifications = relationship("SavedNotification", back_populates="user", cascade="all, delete-orphan")
    preferences = relationship("UserPreferences", back_populates="user", uselist=False, cascade="all, delete-orphan")


class UserPreferences(Base):
    __tablename__ = "user_preferences"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False)
    target_organizations = Column(Text, default='["upsc","ssc","ibps"]')
    target_exams = Column(Text, default='["Civil Services","Combined Graduate Level","CRP PO/MT"]')
    qualification = Column(String(120), default="Graduate")
    job_categories = Column(Text, default='["Civil Services","Public Sector Banking","Central Group B & C"]')
    preferred_states = Column(Text, default='["All India"]')
    alert_priorities = Column(Text, default='["Critical","High","Normal","Low"]')
    saved_only_alerts = Column(Boolean, nullable=False, default=False)
    email_alerts_enabled = Column(Boolean, nullable=False, default=True)
    dark_mode = Column(Boolean, nullable=False, default=False)
    dashboard_page_size = Column(Integer, nullable=False, default=10)
    updated_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)

    user = relationship("User", back_populates="preferences")


class Category(Base):
    __tablename__ = "categories"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(120), unique=True, nullable=False)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)


class MonitoringSource(Base):
    __tablename__ = "monitoring_sources"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String(40), unique=True, index=True, nullable=False)
    name = Column(String(160), nullable=False)
    organization_name = Column(String(160), nullable=False)
    base_url = Column(String(500), nullable=False)
    source_type = Column(String(60), nullable=False, default="HTML Scraper")
    parser_key = Column(String(60), nullable=False)
    fixture_filename = Column(String(120), nullable=False)
    scrape_mode = Column(String(20), nullable=False, default="auto")
    crawl_interval_minutes = Column(Integer, nullable=False, default=360)
    rate_limit_seconds = Column(Integer, nullable=False, default=2)
    robots_policy = Column(Text, nullable=False)
    permission_note = Column(Text, nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
    is_demo_data = Column(Boolean, nullable=False, default=True)
    freshness_status = Column(String(30), nullable=False, default="Pending")
    last_attempted_at = Column(DateTime(timezone=True), nullable=True)
    last_successful_at = Column(DateTime(timezone=True), nullable=True)
    last_http_status = Column(Integer, nullable=True)
    last_error = Column(Text, nullable=True)
    last_parsed_count = Column(Integer, nullable=False, default=0)
    last_duplicate_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)

    notifications = relationship("RecruitmentNotification", back_populates="source", cascade="all, delete-orphan")
    scrape_runs = relationship("ScrapeRun", back_populates="source", cascade="all, delete-orphan")
    logs = relationship("MonitoringLog", back_populates="source", cascade="all, delete-orphan")


class RecruitmentNotification(Base):
    __tablename__ = "recruitment_notifications"
    __table_args__ = (UniqueConstraint("source_id", "entity_key", name="uq_source_entity_key"),)

    id = Column(Integer, primary_key=True, index=True)
    source_id = Column(Integer, ForeignKey("monitoring_sources.id", ondelete="CASCADE"), nullable=False, index=True)
    entity_key = Column(String(255), nullable=False, index=True)
    content_hash = Column(String(64), nullable=False)

    title = Column(String(500), nullable=False)
    organization_name = Column(String(200), nullable=False)
    notification_number = Column(String(120), nullable=True)
    vacancy_count = Column(String(80), nullable=True)
    job_category = Column(String(120), nullable=True)
    qualification = Column(String(200), nullable=True)
    state = Column(String(120), nullable=True)
    application_procedure = Column(Text, nullable=True)
    application_start_date = Column(String(40), nullable=True)
    application_deadline = Column(String(40), nullable=True)
    exam_date = Column(String(40), nullable=True)
    admit_card_date = Column(String(40), nullable=True)
    result_date = Column(String(40), nullable=True)
    description = Column(Text, nullable=True)
    pdf_url = Column(String(600), nullable=True)
    source_url = Column(String(600), nullable=False)
    published_date = Column(String(40), nullable=True)

    lifecycle_status = Column(String(30), nullable=False, default="active")
    is_removed = Column(Boolean, nullable=False, default=False)
    missing_count = Column(Integer, nullable=False, default=0)
    is_demo_data = Column(Boolean, nullable=False, default=True)
    first_seen_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    last_seen_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    source_updated_at = Column(DateTime(timezone=True), nullable=True)
    last_run_id = Column(String(64), nullable=True)

    source = relationship("MonitoringSource", back_populates="notifications")
    changes = relationship("ChangeHistory", back_populates="notification", cascade="all, delete-orphan")
    versions = relationship("NotificationVersion", back_populates="notification", cascade="all, delete-orphan")


class NotificationVersion(Base):
    __tablename__ = "notification_versions"

    id = Column(Integer, primary_key=True, index=True)
    notification_id = Column(
        Integer, ForeignKey("recruitment_notifications.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_number = Column(Integer, nullable=False)
    title = Column(String(500), nullable=False)
    organization_name = Column(String(200), nullable=False)
    notification_number = Column(String(120), nullable=True)
    vacancy_count = Column(String(80), nullable=True)
    job_category = Column(String(120), nullable=True)
    qualification = Column(String(200), nullable=True)
    state = Column(String(120), nullable=True)
    application_start_date = Column(String(40), nullable=True)
    application_deadline = Column(String(40), nullable=True)
    exam_date = Column(String(40), nullable=True)
    admit_card_date = Column(String(40), nullable=True)
    result_date = Column(String(40), nullable=True)
    description = Column(Text, nullable=True)
    pdf_url = Column(String(600), nullable=True)
    source_url = Column(String(600), nullable=False)
    published_date = Column(String(40), nullable=True)
    notification_status = Column(String(30), nullable=False, default="active")
    content_hash = Column(String(64), nullable=False)
    snapshot_json = Column(Text, nullable=False)
    run_id = Column(String(64), nullable=True)
    captured_at = Column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    notification = relationship("RecruitmentNotification", back_populates="versions")


class ChangeHistory(Base):
    __tablename__ = "change_history"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(String(64), nullable=False, index=True)
    source_id = Column(Integer, ForeignKey("monitoring_sources.id", ondelete="CASCADE"), nullable=False, index=True)
    notification_id = Column(Integer, ForeignKey("recruitment_notifications.id", ondelete="CASCADE"), nullable=True, index=True)
    entity_key = Column(String(255), nullable=False)
    notification_title = Column(String(500), nullable=False)
    change_type = Column(String(30), nullable=False, index=True)
    changed_field = Column(String(60), nullable=True, index=True)
    change_label = Column(String(100), nullable=True)
    previous_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    changed_fields_json = Column(Text, nullable=False)
    before_snapshot_json = Column(Text, nullable=True)
    after_snapshot_json = Column(Text, nullable=True)
    source_url = Column(String(600), nullable=False)
    is_verified = Column(Boolean, nullable=False, default=False)
    verified_by = Column(String(120), nullable=True)
    detected_at = Column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    notification = relationship("RecruitmentNotification", back_populates="changes")


class Alert(Base):
    __tablename__ = "alerts"

    id = Column(Integer, primary_key=True, index=True)
    change_id = Column(Integer, ForeignKey("change_history.id", ondelete="CASCADE"), nullable=True)
    source_id = Column(Integer, ForeignKey("monitoring_sources.id", ondelete="CASCADE"), nullable=False)
    notification_id = Column(Integer, ForeignKey("recruitment_notifications.id", ondelete="CASCADE"), nullable=True)
    title = Column(String(300), nullable=False)
    message = Column(Text, nullable=False)
    alert_type = Column(String(30), nullable=False)
    priority = Column(String(20), nullable=False, default="Normal")
    severity = Column(String(20), nullable=False, default="info")
    dedup_key = Column(String(255), nullable=True, index=True)
    is_read = Column(Boolean, nullable=False, default=False)
    is_verified = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)


class SavedNotification(Base):
    __tablename__ = "saved_notifications"
    __table_args__ = (UniqueConstraint("user_id", "notification_id", name="uq_user_saved_notif"),)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    notification_id = Column(Integer, ForeignKey("recruitment_notifications.id", ondelete="CASCADE"), nullable=False)
    notes = Column(Text, nullable=True)
    saved_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)

    user = relationship("User", back_populates="saved_notifications")


class ScrapeRun(Base):
    __tablename__ = "scrape_runs"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(String(64), unique=True, index=True, nullable=False)
    source_id = Column(Integer, ForeignKey("monitoring_sources.id", ondelete="CASCADE"), nullable=False, index=True)
    trigger_type = Column(String(30), nullable=False, default="manual")
    mode_used = Column(String(30), nullable=False, default="fixture")
    status = Column(String(30), nullable=False)
    http_status = Column(Integer, nullable=True)
    parsed_count = Column(Integer, nullable=False, default=0)
    new_count = Column(Integer, nullable=False, default=0)
    updated_count = Column(Integer, nullable=False, default=0)
    duplicate_count = Column(Integer, nullable=False, default=0)
    removed_count = Column(Integer, nullable=False, default=0)
    error_count = Column(Integer, nullable=False, default=0)
    duration_ms = Column(Integer, nullable=False, default=0)
    error_message = Column(Text, nullable=True)
    started_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    completed_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)

    source = relationship("MonitoringSource", back_populates="scrape_runs")


class MonitoringLog(Base):
    __tablename__ = "monitoring_logs"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(String(64), nullable=False, index=True)
    source_id = Column(Integer, ForeignKey("monitoring_sources.id", ondelete="CASCADE"), nullable=False, index=True)
    level = Column(String(20), nullable=False, default="INFO")
    message = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    source = relationship("MonitoringSource", back_populates="logs")
