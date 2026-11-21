import json
from datetime import datetime, timezone
from sqlalchemy import or_
from sqlalchemy.orm import Session
from .auth import hash_password
from .models import (
    Alert,
    Category,
    ChangeHistory,
    MonitoringSource,
    NotificationVersion,
    RecruitmentNotification,
    SavedNotification,
    ScrapeRun,
    User,
    UserPreferences,
)

DEFAULT_SOURCES = [
    ("upsc", "UPSC Active Examinations & Notifications", "Union Public Service Commission (UPSC)", "https://upsc.gov.in/active-examinations/", "HTML Scraper", "upsc", "upsc.html"),
    ("ssc", "SSC Latest Recruitment Notices", "Staff Selection Commission (SSC)", "https://ssc.gov.in/", "REST API + HTML", "ssc", "ssc.html"),
    ("ibps", "IBPS CRP Banking Recruitments", "Institute of Banking Personnel Selection (IBPS)", "https://www.ibps.in/", "HTML Scraper", "ibps", "ibps.html"),
    ("sbi", "SBI Careers — Current Openings", "State Bank of India (SBI)", "https://sbi.co.in/web/careers/current-openings", "HTML Scraper", "sbi", "sbi.html"),
    ("rrbcdg", "RRB — Railway Recruitment Notices", "Railway Recruitment Board (RRB)", "https://www.rrbcdg.gov.in/", "HTML Scraper", "rrbcdg", "rrbcdg.html"),
    ("employmentnews", "Employment News — Weekly Government Gazette", "Employment News (Ministry of I&B)", "https://employmentnews.gov.in/NewEmp/AllJobs.aspx?k=All", "ASP.NET HTML", "employmentnews", "employmentnews.html"),
    ("nta", "NTA Public Notices & Entrance Examinations", "National Testing Agency (NTA)", "https://nta.ac.in/", "HTML Scraper", "nta", "nta.html"),
    ("tnpsc", "TNPSC Annual Planner & Notifications", "Tamil Nadu Public Service Commission (TNPSC)", "https://tnpsc.gov.in/web/examdashboard/index.aspx", "ASP.NET HTML", "tnpsc", "tnpsc.html"),
    ("keralapsc", "Kerala PSC Gazette Notifications", "Kerala Public Service Commission (KPSC)", "https://www.keralapsc.gov.in/notifications", "HTML Scraper", "keralapsc", "keralapsc.html"),
    ("rpsc", "RPSC Recruitment Advertisements & Press Notes", "Rajasthan Public Service Commission (RPSC)", "https://rpsc.rajasthan.gov.in/advertisements", "HTML Scraper", "rpsc", "rpsc.html"),
    ("tnusrb", "TNUSRB Uniformed Services Recruitment", "Tamil Nadu Uniformed Services Recruitment Board (TNUSRB)", "https://www.tnusrb.tn.gov.in/", "HTML Scraper", "tnusrb", "tnusrb.html"),
    ("rbi", "RBI Opportunities — Current Vacancies", "Reserve Bank of India (RBI)", "https://opportunities.rbi.org.in/Scripts/Vacancies.aspx", "ASP.NET HTML", "rbi", "rbi.html"),
    ("indiapost", "India Post GDS Online Engagement", "India Post — Department of Posts", "https://indiapostgdsonline.gov.in/", "HTML Scraper", "indiapost", "indiapost.html"),
]

LEGACY_URLS = {
    "https://upsc.gov.in/examinations/active-examinations",
    "https://www.nta.ac.in/NoticeBoard",
    "https://www.tnpsc.gov.in/English/Notification.aspx",
    "https://www.indiapost.gov.in/",
}

DEFAULT_CATEGORIES = [
    ("Civil Services", "UPSC Civil Services, IFS, Engineering Services, CDS & NDA"),
    ("Public Sector Banking", "IBPS PO/Clerk/SO, SBI PO/Clerk/SO & Regional Rural Banks"),
    ("Central Group B & C", "SSC CGL, CHSL, MTS, GD Constable & Selection Posts"),
    ("State Civil Services", "TNPSC, Kerala PSC, RPSC & State Public Service Commissions"),
    ("Defence & Police", "TNUSRB Sub-Inspector, Police Constable, CAPF & Defence"),
    ("Railway Recruitment", "RRB NTPC, ALP, Technician, JE & Group D Notices"),
    ("Higher Education & Testing", "NTA UGC-NET, CUET, JEE, NEET & Fellowship Examinations"),
    ("Postal Services", "India Post Gramin Dak Sevak (GDS) & Postal Circle Openings"),
    ("Regulatory Bodies", "RBI Grade B, Assistant & Central Regulatory Notices"),
    ("Employment Gazette", "Weekly Central & PSU Notices via Employment News"),
]


def seed_database(db: Session) -> None:
    now = datetime.now(timezone.utc)

    admin = db.query(User).filter(User.email == "admin@govtrack.in").first()
    if not admin:
        admin = User(
            full_name="GovTrack Administrator",
            email="admin@govtrack.in",
            password_hash=hash_password("Admin@2026"),
            role="admin",
            target_exams="UPSC, SSC, IBPS, RBI, TNPSC",
            email_alerts_enabled=True,
            is_active=True,
            created_at=now,
        )
        db.add(admin)
        db.flush()

    aspirant = db.query(User).filter(User.email == "aspirant@govtrack.in").first()
    if not aspirant:
        aspirant = User(
            full_name="Priya Nair (Aspirant)",
            email="aspirant@govtrack.in",
            password_hash=hash_password("Aspirant@2026"),
            role="user",
            target_exams="UPSC Civil Services, SSC CGL, IBPS PO, SBI PO",
            email_alerts_enabled=True,
            is_active=True,
            created_at=now,
        )
        db.add(aspirant)
        db.flush()

    for user in (admin, aspirant):
        if not db.query(UserPreferences).filter(UserPreferences.user_id == user.id).first():
            db.add(
                UserPreferences(
                    user_id=user.id,
                    target_organizations=json.dumps(["upsc", "ssc", "ibps", "sbi", "rbi"]),
                    target_exams=json.dumps(["Civil Services", "Combined Graduate Level", "Probationary Officer", "Grade B"]),
                    qualification="Graduate",
                    job_categories=json.dumps(["Civil Services", "Public Sector Banking", "Central Group B & C", "Regulatory Bodies"]),
                    preferred_states=json.dumps(["All India", "Tamil Nadu", "Kerala"]),
                    alert_priorities=json.dumps(["Critical", "High", "Normal"]),
                    saved_only_alerts=False,
                    email_alerts_enabled=True,
                    dark_mode=False,
                    dashboard_page_size=10,
                    updated_at=now,
                )
            )

    for cat_name, cat_desc in DEFAULT_CATEGORIES:
        if not db.query(Category).filter(Category.name == cat_name).first():
            db.add(Category(name=cat_name, description=cat_desc, created_at=now))

    for code, name, org_name, base_url, source_type, parser_key, fixture_filename in DEFAULT_SOURCES:
        existing_src = db.query(MonitoringSource).filter(MonitoringSource.code == code).first()
        if not existing_src:
            db.add(
                MonitoringSource(
                    code=code,
                    name=name,
                    organization_name=org_name,
                    base_url=base_url,
                    source_type=source_type,
                    parser_key=parser_key,
                    fixture_filename=fixture_filename,
                    scrape_mode="live",
                    crawl_interval_minutes=360,
                    rate_limit_seconds=2,
                    robots_policy="Respect robots.txt · User-Agent GovTrackMonitor/1.0 · Max 1 req/2s",
                    permission_note="Public government portal · Academic monitoring & link attribution only.",
                    is_active=True,
                    is_demo_data=False,
                    freshness_status="Pending",
                    created_at=now,
                )
            )
        else:
            if existing_src.base_url in LEGACY_URLS:
                existing_src.base_url = base_url
            existing_src.source_type = source_type
            existing_src.fixture_filename = fixture_filename
            if existing_src.scrape_mode == "auto":
                existing_src.scrape_mode = "live"

    db.commit()

    # Clean up legacy demo notifications and unverified NEW/empty change-history noise
    demo_ids = [
        r[0]
        for r in db.query(RecruitmentNotification.id).filter(RecruitmentNotification.is_demo_data == True).all()  # noqa: E712
    ]
    if demo_ids:
        db.query(Alert).filter(Alert.notification_id.in_(demo_ids)).delete(synchronize_session=False)
        db.query(ChangeHistory).filter(ChangeHistory.notification_id.in_(demo_ids)).delete(synchronize_session=False)
        db.query(NotificationVersion).filter(NotificationVersion.notification_id.in_(demo_ids)).delete(synchronize_session=False)
        db.query(SavedNotification).filter(SavedNotification.notification_id.in_(demo_ids)).delete(synchronize_session=False)
        db.query(RecruitmentNotification).filter(RecruitmentNotification.id.in_(demo_ids)).delete(synchronize_session=False)

    fixture_run_ids = [
        r[0]
        for r in db.query(ScrapeRun.run_id)
        .filter(or_(ScrapeRun.mode_used == "fixture", ScrapeRun.trigger_type == "demo_fixture"))
        .all()
    ]
    bad_change_query = db.query(ChangeHistory.id).filter(
        or_(
            ChangeHistory.previous_value.is_(None),
            ChangeHistory.previous_value == "",
            ChangeHistory.new_value.is_(None),
            ChangeHistory.new_value == "",
            ChangeHistory.change_type == "NEW",
            *(
                [ChangeHistory.run_id.in_(fixture_run_ids)]
                if fixture_run_ids
                else []
            ),
        )
    )
    bad_change_ids = [r[0] for r in bad_change_query.all()]
    if bad_change_ids:
        db.query(Alert).filter(Alert.change_id.in_(bad_change_ids)).delete(synchronize_session=False)
        db.query(ChangeHistory).filter(ChangeHistory.id.in_(bad_change_ids)).delete(synchronize_session=False)
    db.query(Alert).filter(Alert.alert_type == "NEW").delete(synchronize_session=False)
    db.commit()
