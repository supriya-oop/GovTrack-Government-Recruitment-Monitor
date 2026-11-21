from datetime import datetime, timezone
from apscheduler.schedulers.background import BackgroundScheduler
from .config import SCHEDULER_INTERVAL_MINUTES
from .database import SessionLocal
from .models import MonitoringSource

scheduler = BackgroundScheduler()
scheduler_state = {
    "interval_minutes": SCHEDULER_INTERVAL_MINUTES,
    "enabled": True,
    "last_run_at": None,
}


def scheduled_scrape_job():
    if not scheduler_state["enabled"]:
        return
    from .scraper_engine import run_source_scrape

    db = SessionLocal()
    try:
        sources = db.query(MonitoringSource).filter(MonitoringSource.is_active == True).all()  # noqa: E712
        for src in sources:
            run_source_scrape(db, src, trigger_type="scheduler", mode_override=src.scrape_mode or "live")
        scheduler_state["last_run_at"] = datetime.now(timezone.utc).isoformat()
    finally:
        db.close()


def start_scheduler():
    if not scheduler.running:
        scheduler.add_job(
            scheduled_scrape_job,
            "interval",
            minutes=scheduler_state["interval_minutes"],
            id="govtrack_periodic_monitor",
            replace_existing=True,
        )
        scheduler.start()


def stop_scheduler():
    if scheduler.running:
        scheduler.shutdown(wait=False)
