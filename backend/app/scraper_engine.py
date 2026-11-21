from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import re
import time
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote, urlparse
import uuid
from sqlalchemy.orm import Session

from .change_detector import append_monitoring_log, apply_scrape_results, record_failed_scrape
from .config import FIXTURES_DIR, SCRAPER_REQUEST_TIMEOUT_SECONDS, SCRAPER_USER_AGENT
from .models import MonitoringSource, ScrapeRun
from .pdf_extractor import (
    enrich_notification_from_pdf,
    extract_text_from_pdf_buffer,
    fetch_official_pdf_buffer,
    fetch_with_retry,
)
from .scrapers import (
    extract_ibps_subpage_dates,
    get_parser,
    parse_kerala_psc_gazette_subpage,
    parse_nta_exam_calendar_pdf_text,
    parse_rbi_detail_html,
    parse_tnpsc_annual_planner_html,
    parse_tnpsc_dashboard_detail_html,
    parse_upsc_detail_html,
)

CAPTCHA_MARKERS = ("captcha", "cf-challenge", "g-recaptcha", "hcaptcha", "access denied")
WAF_MARKERS = ("this page can't be displayed", "the incident id is:", "request blocked by firewall", 'window["bobcmn"]', "/tspd/")

RRB_FALLBACK_MIRRORS = [
    "https://www.rrbcdg.gov.in/",
    "https://www.rrbchennai.gov.in/",
    "https://www.rrbbnc.gov.in/",
    "https://www.rrbkolkata.gov.in/",
    "https://rrbajmer.gov.in/",
    "https://rrbsecunderabad.gov.in/",
]


def _check_robots_allowed(base_url: str) -> bool:
    try:
        parsed = urlparse(base_url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        resp = fetch_with_retry(robots_url, timeout=4.0, retries=0)
        if resp.status_code != 200:
            return True
        in_star = False
        for raw_line in resp.text.splitlines():
            line = raw_line.split("#")[0].strip()
            if not line:
                continue
            low = line.lower()
            if low.startswith("user-agent:"):
                in_star = "*" in low.split(":", 1)[1]
            elif in_star and low.replace(" ", "") == "disallow:/":
                return False
        return True
    except Exception:
        return True


def _fetch_html(url: str, timeout: float = 12.0, retries: int = 2) -> Tuple[int, str]:
    resp = fetch_with_retry(
        url,
        timeout=timeout,
        retries=retries,
        headers={"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"},
    )
    return resp.status_code, (resp.text if resp.status_code == 200 else "")


def fetch_ssc_live_items() -> List[Dict[str, Optional[str]]]:
    headers = {
        "User-Agent": SCRAPER_USER_AGENT,
        "Accept": "application/json",
        "Referer": "https://ssc.gov.in/",
    }
    notice_url = (
        "https://ssc.gov.in/api/general-website/portal/notice-boards"
        "?page=1&limit=28&contentType=notice-boards&key=createdAt&order=DESC"
        "&isPaginationRequired=true&isAttachment=true&language=english"
        "&attributes=id,headline,examId,contentType,redirectUrl,createdAt"
    )
    calendar_url = (
        "https://ssc.gov.in/api/general-website/portal/ssc-calendar"
        "?page=1&limit=18&contentType=ssc-calendar&key=createdAt&order=DESC"
        "&isPaginationRequired=false&isAttachment=true&language=english"
        "&attributes=id,headline,examId,examYear,desc,content,contentType,startDate,endDate,language,createdAt"
    )

    def safe_fetch_json(u: str) -> List[Dict]:
        try:
            resp = fetch_with_retry(u, timeout=11.0, retries=1, headers=headers)
            if resp.status_code != 200:
                return []
            payload = resp.json()
            data = payload.get("data") if isinstance(payload, dict) else None
            return data if isinstance(data, list) else []
        except Exception:
            return []

    notices = safe_fetch_json(notice_url)
    calendar = safe_fetch_json(calendar_url)

    cal_by_exam_id: Dict[str, Dict] = {}
    for cal in calendar:
        eid = cal.get("examId")
        if eid and str(eid) not in cal_by_exam_id:
            cal_by_exam_id[str(eid)] = cal

    results: List[Dict[str, Optional[str]]] = []
    seen = set()

    for row in notices:
        raw_headline = row.get("headline") or ""
        title = re.sub(r"\s+", " ", raw_headline).strip()
        if not title or title.lower() in seen:
            continue
        seen.add(title.lower())

        attachments = row.get("attachments") or []
        att = next((a for a in attachments if a.get("path") and re.search(r"\.pdf$", str(a["path"]), re.I)), None)
        if not att and attachments:
            att = attachments[0]
        clean_path = str(att.get("path") or "").replace("\\", "/").lstrip("/") if att and att.get("path") else None
        pdf_url = f"https://ssc.gov.in/api/attachment/{quote(clean_path, safe='/')}" if clean_path else None

        pub_date = str(row["createdAt"])[:10] if row.get("createdAt") else None
        eid = str(row["examId"]) if row.get("examId") else None
        cal_match = cal_by_exam_id.get(eid) if eid else None

        raw_start = row.get("startDate") or (cal_match.get("startDate") if cal_match else None)
        raw_end = row.get("endDate") or (cal_match.get("endDate") if cal_match else None)
        start_date = str(raw_start)[:10] if raw_start else None
        deadline = str(raw_end)[:10] if raw_end else None

        is_admit = bool(re.search(r"admit|admission\s*certificate|city\s*of\s*examination", title, re.I))
        is_result = bool(re.search(r"result|answer\s*key|marks|cut-?off", title, re.I))
        cal_content = str(cal_match.get("content")).strip() if cal_match and cal_match.get("content") else None

        results.append(
            {
                "title": title,
                "organization_name": "Staff Selection Commission (SSC)",
                "notification_number": f"SSC-{eid}" if eid else None,
                "vacancy_count": None,
                "job_category": "Admit Card / City Intimation" if is_admit else ("Result / Answer Key" if is_result else "SSC Notice Board"),
                "qualification": None,
                "state": "All India",
                "application_start_date": start_date,
                "application_deadline": deadline,
                "exam_date": cal_content,
                "admit_card_date": pub_date if is_admit else None,
                "result_date": pub_date if is_result else None,
                "description": f"Official SSC Notice Board update released on {pub_date}." if pub_date else None,
                "pdf_url": pdf_url,
                "source_url": "https://ssc.gov.in/",
                "published_date": pub_date,
            }
        )

    for row in calendar:
        raw_headline = row.get("headline") or ""
        title = re.sub(r"\s+", " ", raw_headline).strip()
        if not title or title.lower() in seen:
            continue
        seen.add(title.lower())

        start_date = str(row["startDate"])[:10] if row.get("startDate") else None
        deadline = str(row["endDate"])[:10] if row.get("endDate") else None
        pub_date = str(row["createdAt"])[:10] if row.get("createdAt") else None
        eid = str(row["examId"]) if row.get("examId") else None
        cal_content = str(row.get("content")).strip() if row.get("content") else None
        desc_parts = [p for p in [row.get("desc"), f"Exam Month: {cal_content}" if cal_content else None] if p]

        results.append(
            {
                "title": title,
                "organization_name": "Staff Selection Commission (SSC)",
                "notification_number": f"SSC-CAL-{eid}" if eid else None,
                "vacancy_count": None,
                "job_category": "SSC Examination Calendar",
                "qualification": None,
                "state": "All India",
                "application_start_date": start_date,
                "application_deadline": deadline,
                "exam_date": cal_content,
                "admit_card_date": None,
                "result_date": None,
                "description": " · ".join(desc_parts) if desc_parts else None,
                "pdf_url": None,
                "source_url": "https://ssc.gov.in/",
                "published_date": pub_date,
            }
        )

    return results[:40]


def _enrich_live_items(
    parser_key: str,
    base_url: str,
    items: List[Dict[str, Optional[str]]],
) -> List[Dict[str, Optional[str]]]:
    if not items:
        return items

    working = list(items)

    if parser_key == "upsc":
        def _upsc_worker(it: Dict[str, Optional[str]]) -> Dict[str, Optional[str]]:
            su = it.get("source_url") or ""
            if not su or su == base_url or "upsc.gov.in/active-examinations/" not in su:
                return it
            try:
                st, txt = _fetch_html(su, timeout=9.0, retries=1)
                if st == 200 and txt:
                    return parse_upsc_detail_html(it, txt)
            except Exception:
                pass
            return it

        with ThreadPoolExecutor(max_workers=4) as pool:
            batch = list(pool.map(_upsc_worker, working[:20]))
        working[: len(batch)] = batch

    elif parser_key == "tnpsc":
        def _tnpsc_worker(it: Dict[str, Optional[str]]) -> Dict[str, Optional[str]]:
            su = it.get("source_url") or ""
            if not su or "notid=" not in su:
                return it
            try:
                st, txt = _fetch_html(su, timeout=9.0, retries=1)
                if st == 200 and txt:
                    return parse_tnpsc_dashboard_detail_html(it, txt, su)
            except Exception:
                pass
            return it

        with ThreadPoolExecutor(max_workers=4) as pool:
            batch = list(pool.map(_tnpsc_worker, working[:20]))
        working[: len(batch)] = batch

        try:
            planner_url = "https://www.tnpsc.gov.in/DynamicPortals/AnnualPlanner/AnnualPlanner.aspx"
            st, txt = _fetch_html(planner_url, timeout=9.0, retries=1)
            if st == 200 and txt:
                planned = parse_tnpsc_annual_planner_html(txt, planner_url)
                for p in planned:
                    p_norm = re.sub(r"[^a-z0-9]", "", (p.get("title") or "").lower())
                    match = next(
                        (
                            w
                            for w in working
                            if p_norm in re.sub(r"[^a-z0-9]", "", (w.get("title") or "").lower())
                            or re.sub(r"[^a-z0-9]", "", (w.get("title") or "").lower()) in p_norm
                        ),
                        None,
                    )
                    if match:
                        if not match.get("exam_date") and p.get("exam_date"):
                            match["exam_date"] = p["exam_date"]
                    else:
                        working.append(p)
        except Exception:
            pass

    elif parser_key == "keralapsc":
        gazette_urls = []
        for it in working:
            su = it.get("source_url") or ""
            if re.search(r"extra-ordinary-gazette-date-", su, re.I) and su not in gazette_urls:
                gazette_urls.append(su)
        gazette_urls = gazette_urls[:2]

        if gazette_urls:
            gazette_items: List[Dict[str, Optional[str]]] = []
            seen_cat = set()
            for g_url in gazette_urls:
                try:
                    st, txt = _fetch_html(g_url, timeout=10.0, retries=1)
                    if st == 200 and txt:
                        for sub in parse_kerala_psc_gazette_subpage(txt, g_url):
                            k = (sub.get("notification_number") or sub.get("title") or "").lower()
                            if k and k not in seen_cat:
                                seen_cat.add(k)
                                gazette_items.append(sub)
                except Exception:
                    pass
            if gazette_items:
                working = gazette_items[:30]

    elif parser_key == "rbi":
        def _rbi_worker(it: Dict[str, Optional[str]]) -> Dict[str, Optional[str]]:
            su = it.get("source_url") or ""
            if not su or "bs_viewcontent.aspx" not in su:
                return it
            try:
                st, txt = _fetch_html(su, timeout=9.0, retries=1)
                if st == 200 and txt:
                    return parse_rbi_detail_html(it, txt, su)
            except Exception:
                pass
            return it

        with ThreadPoolExecutor(max_workers=4) as pool:
            batch = list(pool.map(_rbi_worker, working[:20]))
        working[: len(batch)] = batch

    elif parser_key == "ibps":
        sub_urls: List[str] = []
        candidates = [
            "https://www.ibps.in/index.php/crp-updates",
            "https://www.ibps.in/index.php/recruitment/",
            "https://www.ibps.in/index.php/po-mt-xvi/",
            "https://www.ibps.in/index.php/clerical-cadre-xvi/",
            "https://www.ibps.in/index.php/specialist-officers-xvi/",
            "https://www.ibps.in/index.php/regional-rural-bank-xv/",
            *[
                it.get("source_url") or ""
                for it in working
                if (it.get("source_url") or "") != base_url
                and "ibps.in/index.php/" in (it.get("source_url") or "")
                and not (it.get("source_url") or "").lower().endswith(".pdf")
            ],
        ]
        for u in candidates:
            if u and u not in sub_urls:
                sub_urls.append(u)
        sub_urls = sub_urls[:10]

        extra_discovered: List[Dict[str, Optional[str]]] = []

        def _ibps_sub(sub_u: str) -> List[Dict[str, Optional[str]]]:
            try:
                st, txt = _fetch_html(sub_u, timeout=9.0, retries=1)
                if st == 200 and txt:
                    return extract_ibps_subpage_dates(working, txt, sub_u)
            except Exception:
                pass
            return []

        with ThreadPoolExecutor(max_workers=3) as pool:
            for added in pool.map(_ibps_sub, sub_urls):
                extra_discovered.extend(added)

        existing_titles = {(it.get("title") or "").lower() for it in working}
        for item in extra_discovered:
            t_low = (item.get("title") or "").lower()
            if t_low and t_low not in existing_titles:
                existing_titles.add(t_low)
                working.append(item)
        working = working[:30]

    elif parser_key == "nta":
        cal_url = "https://nta.ac.in/Download/Notice/ExamcalendarRevised.pdf"
        try:
            cal_buf = fetch_official_pdf_buffer(cal_url, base_url, max_bytes=6_000_000, timeout=8.0, retries=0)
            if cal_buf:
                cal_text = extract_text_from_pdf_buffer(cal_buf[0])
                cal_items = parse_nta_exam_calendar_pdf_text(cal_text, cal_url)
                cal_matchers = [
                    (r"ugc[-\s]*net", "ugc"),
                    (r"csir", "csir"),
                    (r"shreshta", "shreshta"),
                    (r"nift", "nift"),
                    (r"swayam", "swayam"),
                    (r"aissee|sainik", "sainik"),
                    (r"cmat", "cmat"),
                    (r"cuet\s*\(?pg\)?", "cuet"),
                    (r"rimc|rashtriya\s+indian\s+military", "rimc"),
                    (r"rashtriya\s+military\s+schools", "rms"),
                    (r"army\s+cadets", "acc"),
                    (r"jee\s*\(?main\)?", "jee"),
                ]
                cal_date_by_key: Dict[str, str] = {}
                for ci in cal_items:
                    if not ci.get("exam_date"):
                        continue
                    for pat, key in cal_matchers:
                        if re.search(pat, ci.get("title") or "", re.I):
                            cal_date_by_key.setdefault(key, ci["exam_date"] or "")
                            break
                for item in working:
                    if not item.get("exam_date"):
                        for pat, key in cal_matchers:
                            if re.search(pat, item.get("title") or "", re.I) and key in cal_date_by_key:
                                item["exam_date"] = cal_date_by_key[key]
                                break
                existing_titles = {(w.get("title") or "").lower() for w in working}
                for ci in cal_items:
                    t_low = (ci.get("title") or "").lower()
                    if t_low and t_low not in existing_titles:
                        existing_titles.add(t_low)
                        working.append(ci)
        except Exception:
            pass
        working = working[:35]

    pdf_targets = working[:28]
    with ThreadPoolExecutor(max_workers=5) as pool:
        enriched = list(pool.map(enrich_notification_from_pdf, pdf_targets))
    working[: len(enriched)] = enriched
    return working


def run_source_scrape(
    db: Session,
    source: MonitoringSource,
    *,
    trigger_type: str = "manual",
    mode_override: Optional[str] = None,
    fixture_override: Optional[str] = None,
    simulate_http_status: Optional[int] = None,
    suppress_history: bool = False,
    replace_demo_with_live: Optional[bool] = None,
) -> ScrapeRun:
    started_at = datetime.now(timezone.utc)
    start_ms = time.monotonic()
    run_id = f"RUN-{uuid.uuid4().hex[:10].upper()}"
    effective_mode = mode_override or source.scrape_mode or "auto"

    append_monitoring_log(db, run_id, source.id, "INFO", f"Starting {trigger_type} check (mode={effective_mode}).")

    if simulate_http_status and simulate_http_status >= 400:
        return record_failed_scrape(
            db,
            source,
            run_id,
            trigger_type,
            "simulated_error",
            simulate_http_status,
            f"Simulated HTTP {simulate_http_status} error from source endpoint.",
            int((time.monotonic() - start_ms) * 1000),
            started_at,
        )

    html_content: Optional[str] = None
    http_status = 200
    is_demo_data = True
    mode_used = "fixture"
    used_url = source.base_url

    if fixture_override:
        safe_name = Path(fixture_override).name
        fixture_path = FIXTURES_DIR / safe_name
        if not fixture_path.exists():
            return record_failed_scrape(
                db,
                source,
                run_id,
                trigger_type,
                "fixture",
                404,
                f"Fixture not found: {safe_name}",
                int((time.monotonic() - start_ms) * 1000),
                started_at,
            )
        if "404" in safe_name:
            return record_failed_scrape(
                db,
                source,
                run_id,
                trigger_type,
                "fixture",
                404,
                f"HTTP 404 Not Found replayed from {safe_name}",
                int((time.monotonic() - start_ms) * 1000),
                started_at,
            )
        html_content = fixture_path.read_text(encoding="utf-8")
        mode_used = "fixture"
        is_demo_data = True
        append_monitoring_log(db, run_id, source.id, "INFO", f"Loaded offline HTML fixture {safe_name} (DEMO DATA).")
    elif effective_mode in ("live", "auto"):
        if not _check_robots_allowed(source.base_url):
            return record_failed_scrape(
                db,
                source,
                run_id,
                trigger_type,
                "live",
                403,
                "Disallowed by robots.txt policy.",
                int((time.monotonic() - start_ms) * 1000),
                started_at,
            )

        candidate_urls = [source.base_url]
        if source.parser_key == "rrbcdg":
            for mirror in RRB_FALLBACK_MIRRORS:
                if mirror not in candidate_urls:
                    candidate_urls.append(mirror)

        live_error: Optional[str] = None
        for idx, target_url in enumerate(candidate_urls):
            per_timeout = 6.0 if (source.parser_key == "rrbcdg" and len(candidate_urls) > 1) else float(SCRAPER_REQUEST_TIMEOUT_SECONDS)
            per_retries = 0 if idx > 0 else 1
            try:
                st, text = _fetch_html(target_url, timeout=per_timeout, retries=per_retries)
                http_status = st
                if st in (403, 429):
                    live_error = f"HTTP {st} received from {target_url}; stopped immediately per respectful crawling policy."
                    break
                if st >= 500:
                    live_error = f"HTTP {st} transient server error from {target_url}."
                    continue
                if st == 200:
                    lower = text[:4000].lower()
                    if any(m in lower for m in WAF_MARKERS):
                        live_error = f"Portal firewall/WAF blocked request on {target_url}; existing data preserved."
                        http_status = 403
                        continue
                    if any(m in lower for m in CAPTCHA_MARKERS):
                        live_error = "Anti-bot / CAPTCHA challenge detected; never bypassing."
                        http_status = 403
                        break
                    html_content = text
                    used_url = target_url
                    mode_used = "live"
                    is_demo_data = False
                    append_monitoring_log(db, run_id, source.id, "INFO", f"Fetched live HTTP 200 response from {target_url} ({len(text)} chars).")
                    break
                live_error = f"Unexpected HTTP {st} from {target_url}."
            except Exception as exc:
                live_error = f"Network error ({target_url}): {str(exc)[:140]}"

        if not html_content:
            if effective_mode == "live":
                return record_failed_scrape(
                    db,
                    source,
                    run_id,
                    trigger_type,
                    "live",
                    http_status or 503,
                    live_error or "Live fetch failed",
                    int((time.monotonic() - start_ms) * 1000),
                    started_at,
                )
            fallback_path = FIXTURES_DIR / source.fixture_filename
            if fallback_path.exists():
                html_content = fallback_path.read_text(encoding="utf-8")
                mode_used = "fixture"
                is_demo_data = True
                http_status = 200
                append_monitoring_log(db, run_id, source.id, "WARN", f"Live request fell back to verified offline fixture ({live_error}).")
            else:
                return record_failed_scrape(
                    db,
                    source,
                    run_id,
                    trigger_type,
                    "auto",
                    http_status or 503,
                    live_error or "Fetch and fixture fallback failed",
                    int((time.monotonic() - start_ms) * 1000),
                    started_at,
                )
    else:
        fixture_path = FIXTURES_DIR / source.fixture_filename
        if not fixture_path.exists():
            return record_failed_scrape(
                db,
                source,
                run_id,
                trigger_type,
                "fixture",
                404,
                f"Missing fixture {source.fixture_filename}",
                int((time.monotonic() - start_ms) * 1000),
                started_at,
            )
        html_content = fixture_path.read_text(encoding="utf-8")
        mode_used = "fixture"
        is_demo_data = True
        append_monitoring_log(db, run_id, source.id, "INFO", f"Loaded baseline offline fixture {source.fixture_filename}.")

    parser = get_parser(source.parser_key)
    if mode_used == "live" and source.parser_key == "ssc":
        parsed_items = fetch_ssc_live_items()
        if not parsed_items and html_content:
            parsed_items = parser.parse(html_content, used_url)
    else:
        parsed_items = parser.parse(html_content or "", used_url)

    if mode_used == "live" and parsed_items:
        parsed_items = _enrich_live_items(source.parser_key, used_url, parsed_items)

    if not parsed_items and mode_used == "live" and effective_mode == "auto":
        fallback_path = FIXTURES_DIR / source.fixture_filename
        if fallback_path.exists():
            html_content = fallback_path.read_text(encoding="utf-8")
            parsed_items = parser.parse(html_content, source.base_url)
            mode_used = "fixture"
            is_demo_data = True
            append_monitoring_log(db, run_id, source.id, "WARN", "Live page returned 0 structured rows (SPA/JS shell); fell back to verified offline fixture.")

    duration_ms = int((time.monotonic() - start_ms) * 1000)
    if not parsed_items:
        return record_failed_scrape(
            db,
            source,
            run_id,
            trigger_type,
            mode_used,
            http_status,
            "Parser returned 0 records (selector/schema mismatch guard). Existing data preserved.",
            duration_ms,
            started_at,
        )

    counts = apply_scrape_results(
        db,
        source,
        parsed_items,
        run_id,
        is_demo_data,
        allow_removal_check=True,
        removal_threshold=2,
        suppress_history=suppress_history,
        replace_demo_with_live=(not is_demo_data) if replace_demo_with_live is None else replace_demo_with_live,
    )
    now = datetime.now(timezone.utc)
    source.last_attempted_at = now
    source.last_successful_at = now
    source.last_http_status = http_status
    source.last_error = None
    source.is_demo_data = is_demo_data
    source.freshness_status = "Healthy"
    source.last_parsed_count = counts["parsed_count"]
    source.last_duplicate_count = counts["duplicate_count"]

    run = ScrapeRun(
        run_id=run_id,
        source_id=source.id,
        trigger_type=trigger_type,
        mode_used=mode_used,
        status="success",
        http_status=http_status,
        parsed_count=counts["parsed_count"],
        new_count=counts["new_count"],
        updated_count=counts["updated_count"],
        duplicate_count=counts["duplicate_count"],
        removed_count=counts["removed_count"],
        error_count=0,
        duration_ms=duration_ms,
        error_message=None,
        started_at=started_at,
        completed_at=now,
    )
    db.add(run)
    append_monitoring_log(
        db,
        run_id,
        source.id,
        "INFO",
        f"Completed ({mode_used}): parsed={counts['parsed_count']}, new={counts['new_count']}, updated={counts['updated_count']}, duplicates={counts['duplicate_count']}, removed={counts['removed_count']}.",
    )
    db.commit()
    db.refresh(run)
    return run
