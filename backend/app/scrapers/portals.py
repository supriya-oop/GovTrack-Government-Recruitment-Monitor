import re
from typing import Dict, List, Optional
from bs4 import BeautifulSoup
from .base import (
    BasePortalParser,
    clean_text,
    is_public_http_url,
    normalize_human_date,
    normalize_us_date,
    resolve_url,
    text_or_none,
)


def parse_upsc_detail_html(item: Dict[str, Optional[str]], html: str) -> Dict[str, Optional[str]]:
    soup = BeautifulSoup(html, "lxml")
    nxt = dict(item)
    details: List[str] = []

    if not nxt.get("notification_number"):
        body_text = soup.body.get_text(" ", strip=True) if soup.body else soup.get_text(" ", strip=True)
        m = re.search(r"Examination Notice No:\s*([A-Z0-9/()-]+)", body_text, re.I)
        if m and m.group(1) != "—":
            nxt["notification_number"] = clean_text(m.group(1))

    for col in soup.select(".exam-detail-card .col-lg, .exam-detail-card > div"):
        children = [c for c in col.find_all(recursive=False)]
        if len(children) < 2:
            continue
        label = text_or_none(children[0]) or ""
        value = text_or_none(children[1]) or ""
        if not label or not value:
            continue

        if re.search(r"date of notification", label, re.I):
            iso = normalize_human_date(value)
            if iso:
                nxt["published_date"] = iso
                if not nxt.get("application_start_date"):
                    nxt["application_start_date"] = iso
        elif re.search(r"date of upload", label, re.I) and not nxt.get("published_date"):
            iso = normalize_human_date(value)
            if iso:
                nxt["published_date"] = iso
        elif re.search(r"commencement of examination", label, re.I):
            iso = normalize_human_date(value)
            if iso:
                nxt["exam_date"] = iso
        elif re.search(r"last date for submission", label, re.I):
            iso = normalize_human_date(value)
            nxt["application_deadline"] = iso
            if not iso:
                nxt["application_start_date"] = None
        elif re.search(r"duration of examination", label, re.I):
            details.append(f"Duration: {value}")

    doc_labels: List[str] = []
    for tr in soup.select("table tr"):
        tds = tr.find_all("td")
        if len(tds) < 2:
            continue
        doc_type = text_or_none(tds[0]) or ""
        upload_date = normalize_human_date(tds[1].get_text(" ", strip=True))
        if not doc_type or re.search(r"document type", doc_type, re.I):
            continue
        cleaned_doc = re.sub(r"keyboard_arrow_down", "", doc_type, flags=re.I).strip()
        if cleaned_doc:
            doc_labels.append(cleaned_doc)
        if re.search(r"admit\s*card", doc_type, re.I) and upload_date:
            nxt["admit_card_date"] = upload_date
        elif re.search(r"(?:written|final|recommended).*result|^\s*result", doc_type, re.I) and upload_date:
            nxt["result_date"] = upload_date

    base_for_resolve = nxt.get("source_url") or "https://upsc.gov.in/active-examinations/"
    pdf_list: List[str] = []
    seen_pdfs = set()
    for a in soup.select('a[href*=".pdf"], a[href*=".PDF"]'):
        resolved = resolve_url(base_for_resolve, a.get("href"))
        if resolved and is_public_http_url(resolved) and resolved not in seen_pdfs:
            seen_pdfs.add(resolved)
            pdf_list.append(resolved)

    embedded = re.findall(
        r"(?:https?://(?:www\.)?upsc\.gov\.in)?/(?:uploads|sites/default/files)/[^\"'\s\\<>]+\.pdf",
        html,
        re.I,
    )
    for raw_pdf in embedded:
        resolved = resolve_url(base_for_resolve, raw_pdf)
        if resolved and is_public_http_url(resolved) and resolved not in seen_pdfs:
            seen_pdfs.add(resolved)
            pdf_list.append(resolved)

    if pdf_list:
        nxt["pdf_url"] = (
            next((u for u in pdf_list if re.search(r"notif", u, re.I) and re.search(r"engl", u, re.I)), None)
            or next((u for u in pdf_list if re.search(r"notif", u, re.I) and not re.search(r"hindi", u, re.I)), None)
            or next((u for u in pdf_list if re.search(r"engl", u, re.I)), None)
            or next((u for u in pdf_list if not re.search(r"hindi", u, re.I)), None)
            or pdf_list[0]
        )

    fact_parts: List[str] = []
    if nxt.get("notification_number"):
        fact_parts.append(f"Notice No: {nxt['notification_number']}")
    fact_parts.extend(details)
    if doc_labels:
        fact_parts.append(f"Documents: {', '.join(doc_labels[:5])}")
    if fact_parts:
        nxt["description"] = " · ".join(fact_parts)
    return nxt


def parse_tnpsc_dashboard_detail_html(
    item: Dict[str, Optional[str]], html: str, detail_url: str
) -> Dict[str, Optional[str]]:
    soup = BeautifulSoup(html, "lxml")
    nxt = dict(item)
    notes: List[str] = []
    pdf_candidates: List[str] = []

    for tr in soup.select("table tr"):
        tds = tr.find_all("td")
        if len(tds) < 2:
            continue
        category = text_or_none(tds[0]) or ""
        title_cell = text_or_none(tds[1]) or ""
        first_a = tr.find("a")
        link_href = resolve_url(detail_url, first_a.get("href")) if first_a else None
        upload_date = normalize_human_date(tds[3].get_text(" ", strip=True)) if len(tds) >= 4 else None

        if re.match(r"^notification$", category, re.I):
            if upload_date and not nxt.get("published_date"):
                nxt["published_date"] = upload_date
            if link_href and re.search(r"\.pdf", link_href, re.I) and is_public_http_url(link_href):
                pdf_candidates.insert(0, link_href)
        elif re.search(r"date\s+of\s+examination", category, re.I) or re.search(r"date\s+of\s+examination", title_cell, re.I):
            exam_iso = normalize_human_date(title_cell)
            if exam_iso:
                nxt["exam_date"] = exam_iso
        elif re.search(r"apply\s+online", category, re.I):
            start_m = re.search(
                r"(?:commencement|opening)\s+of\s+(?:receiving\s+)?application\s*:\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})",
                title_cell,
                re.I,
            )
            end_m = re.search(r"last\s+date[^:]*:\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})", title_cell, re.I)
            if start_m:
                nxt["application_start_date"] = normalize_human_date(start_m.group(1))
            if end_m:
                nxt["application_deadline"] = normalize_human_date(end_m.group(1))
            if not nxt.get("published_date") and upload_date:
                nxt["published_date"] = upload_date
        elif re.search(r"hall\s*ticket|admit\s*card", category, re.I) and upload_date:
            nxt["admit_card_date"] = upload_date
        elif re.search(r"result|selection\s*list|counselling", category, re.I) and upload_date and not nxt.get("result_date"):
            nxt["result_date"] = upload_date
        elif re.search(r"addendum|amendment|corrigendum", category, re.I):
            if title_cell:
                notes.append(title_cell)
            if link_href and re.search(r"\.pdf", link_href, re.I) and is_public_http_url(link_href):
                pdf_candidates.append(link_href)

    if pdf_candidates and not nxt.get("pdf_url"):
        nxt["pdf_url"] = pdf_candidates[0]
    if notes:
        prefix = f"{nxt['description']} · " if nxt.get("description") else ""
        nxt["description"] = f"{prefix}{'; '.join(notes[:2])}"
    return nxt


def parse_tnpsc_annual_planner_html(html: str, planner_url: str) -> List[Dict[str, Optional[str]]]:
    soup = BeautifulSoup(html, "lxml")
    results: List[Dict[str, Optional[str]]] = []
    for tr in soup.select("table tr"):
        tds = tr.find_all("td")
        if len(tds) < 4:
            continue
        sno = text_or_none(tds[0])
        name = text_or_none(tds[1])
        if not sno or not re.match(r"^\d+$", sno) or not name or len(name) < 10:
            continue
        notif_date = normalize_human_date(tds[2].get_text(" ", strip=True))
        exam_date = normalize_human_date(tds[3].get_text(" ", strip=True))
        days = text_or_none(tds[4]) if len(tds) >= 5 else None
        results.append(
            {
                "title": name,
                "organization_name": "Tamil Nadu Public Service Commission (TNPSC)",
                "notification_number": f"TNPSC-PLAN-2026-{sno}",
                "vacancy_count": None,
                "job_category": "TNPSC Annual Planner",
                "qualification": None,
                "state": "Tamil Nadu",
                "application_start_date": notif_date,
                "application_deadline": None,
                "exam_date": exam_date,
                "admit_card_date": None,
                "result_date": None,
                "description": (
                    f"TNPSC Annual Planner 2026 · Notification date: {notif_date or 'TBA'} · Duration: {days} day(s)"
                    if days
                    else "TNPSC Annual Planner 2026"
                ),
                "pdf_url": None,
                "source_url": planner_url,
                "published_date": notif_date,
            }
        )
    return results


def parse_kerala_psc_gazette_subpage(html: str, subpage_url: str) -> List[Dict[str, Optional[str]]]:
    soup = BeautifulSoup(html, "lxml")
    results: List[Dict[str, Optional[str]]] = []
    seen = set()

    slug_m = re.search(r"gazette-date-(\d{2})(\d{2})(\d{4})", subpage_url, re.I)
    gazette_pub = f"{slug_m.group(3)}-{slug_m.group(2)}-{slug_m.group(1)}" if slug_m else None

    for el in soup.select('a[href*=".pdf"], a[href*=".PDF"]'):
        href = resolve_url(subpage_url, el.get("href"))
        title = text_or_none(el)
        if not href or not title or len(title) < 12 or not is_public_http_url(href):
            continue
        if re.search(r"authorised[- ]signatory|inline-files", href + title, re.I):
            continue

        cat_m = re.search(r"\b(\d{1,3}/\d{4})\b", title)
        cat_no = cat_m.group(1) if cat_m else None
        dedupe_key = cat_no or title.lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        cleaned_title = re.sub(r"\(\s*Cat\.?\s*No\.?\s*[^)]+\)", "", title, flags=re.I).strip() or title
        results.append(
            {
                "title": cleaned_title,
                "organization_name": "Kerala Public Service Commission (Kerala PSC)",
                "notification_number": f"Cat. No. {cat_no}" if cat_no else None,
                "vacancy_count": None,
                "job_category": "State Civil Services",
                "qualification": None,
                "state": "Kerala",
                "application_start_date": gazette_pub,
                "application_deadline": None,
                "exam_date": None,
                "admit_card_date": None,
                "result_date": None,
                "description": (
                    f"Kerala PSC Extraordinary Gazette Notification dated {gazette_pub}"
                    if gazette_pub
                    else "Kerala PSC Extraordinary Gazette Notification"
                ),
                "pdf_url": href,
                "source_url": subpage_url,
                "published_date": gazette_pub,
            }
        )
    return results


def parse_rbi_detail_html(item: Dict[str, Optional[str]], html: str, detail_url: str) -> Dict[str, Optional[str]]:
    soup = BeautifulSoup(html, "lxml")
    nxt = dict(item)
    container = soup.select_one("#pnlContent, .tablebg, main, body")
    txt = text_or_none(container) or ""

    pub_m = re.search(r"Date\s*:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{4})", txt, re.I)
    if pub_m:
        nxt["published_date"] = normalize_human_date(pub_m.group(1))

    last_m = re.search(
        r"(?:last\s+date[^.]{0,80}?|on\s+or\s+before|reach[^.]{0,40}?by|closing\s+date[^.]{0,40}?)\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4}|[A-Za-z]+\s+\d{1,2},\s*\d{4}|\d{1,2}\s+[A-Za-z]+\s*,?\s*\d{4})",
        txt,
        re.I,
    )
    if last_m:
        nxt["application_deadline"] = normalize_human_date(last_m.group(1))

    exam_m = re.search(
        r"(?:Date\s+of\s+(?:Online\s+)?Examination|Tentative\s+Date\s+of\s+(?:Test|Exam(?:ination)?)|Phase[- ]?I\s+Exam)[^.]{0,40}?(\d{1,2}[./-]\d{1,2}[./-]\d{4}|[A-Za-z]+\s+\d{1,2},\s*\d{4}|\d{1,2}\s+[A-Za-z]+\s*,?\s*\d{4})",
        txt,
        re.I,
    )
    if exam_m:
        nxt["exam_date"] = normalize_human_date(exam_m.group(1))

    vac_m = re.search(
        r"\b(?:fill|total|engage)\s+(?:[a-z]+\s+)?\((\d{1,4})\)\s*(?:posts?|vacanc(?:y|ies))",
        txt,
        re.I,
    ) or re.search(r"\b(\d{1,4})\s+(?:posts?|vacanc(?:y|ies))\b", txt, re.I)
    if vac_m:
        nxt["vacancy_count"] = vac_m.group(1)

    pdf_links: List[str] = []
    for a in soup.select('a[href*=".pdf"], a[href*=".PDF"]'):
        resolved = resolve_url(detail_url, a.get("href"))
        if resolved and is_public_http_url(resolved) and not re.search(r"Annual_Recruitment_Calendar|Utkarsh2029", resolved, re.I):
            pdf_links.append(resolved)
    if pdf_links:
        nxt["pdf_url"] = pdf_links[0]

    para = text_or_none(soup.select_one("#pnlContent p, .tablebg p"))
    if para and len(para) > 30:
        nxt["description"] = para[:260]
    return nxt


def extract_ibps_subpage_dates(
    items: List[Dict[str, Optional[str]]], html: str, page_url: str
) -> List[Dict[str, Optional[str]]]:
    soup = BeautifulSoup(html, "lxml")
    entries: List[Dict[str, Optional[str]]] = []

    for a in soup.select("a"):
        href = resolve_url(page_url, a.get("href"))
        text = text_or_none(a)
        if not href or not text or len(text) < 15:
            continue
        if not re.search(r"\.pdf$", href, re.I) and not re.search(
            r"notification|result|allotment|call\s*letter|score|corrigendum", text, re.I
        ):
            continue
        parent = a.find_parent(["li", "tr", "p", "div"])
        parent_text = text_or_none(parent) or text
        dm = re.search(r"(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{4})", parent_text)
        pub_date = normalize_human_date(dm.group(1)) if dm else None
        entries.append(
            {
                "date": pub_date,
                "title": text,
                "pdf_url": href if re.search(r"\.pdf$", href, re.I) and is_public_http_url(href) else None,
            }
        )

    if not entries:
        return []

    for item in items:
        t_low = (item.get("title") or "").lower()
        notif_no = (item.get("notification_number") or "").lower()
        match = (
            next((e for e in entries if (e["title"] or "").lower() == t_low), None)
            or next(
                (
                    e
                    for e in entries
                    if (notif_no and notif_no in (e["title"] or "").lower())
                    or (re.search(r"notification", e["title"] or "", re.I) and item.get("source_url") == page_url)
                ),
                None,
            )
            or next((e for e in entries if item.get("source_url") == page_url and e["pdf_url"]), None)
        )
        if match:
            if not item.get("published_date") and match["date"]:
                item["published_date"] = match["date"]
            if not item.get("pdf_url") and match["pdf_url"]:
                item["pdf_url"] = match["pdf_url"]
            if re.search(r"result|provisional\s+allotment|score", item.get("title") or "", re.I) and match["date"]:
                item["result_date"] = match["date"]
            if re.search(r"call\s*letter|admit\s*card", item.get("title") or "", re.I) and match["date"]:
                item["admit_card_date"] = match["date"]

    discovered: List[Dict[str, Optional[str]]] = []
    for e in entries:
        if not e["pdf_url"]:
            continue
        crp_m = re.search(r"CRP[-\sA-Z/]+(?:XVII|XVI|XV|XIV)", e["title"] or "", re.I)
        crp = crp_m.group(0) if crp_m else None
        title_str = e["title"] or ""
        discovered.append(
            {
                "title": title_str,
                "organization_name": "Institute of Banking Personnel Selection (IBPS)",
                "notification_number": crp,
                "vacancy_count": None,
                "job_category": "Public Sector Banking",
                "qualification": "Graduate",
                "state": "All India",
                "application_start_date": None,
                "application_deadline": None,
                "exam_date": None,
                "admit_card_date": e["date"] if re.search(r"call\s*letter|admit\s*card", title_str, re.I) else None,
                "result_date": e["date"] if re.search(r"result|allotment|score", title_str, re.I) else None,
                "description": f"Official IBPS notice dated {e['date']}" if e["date"] else None,
                "pdf_url": e["pdf_url"],
                "source_url": page_url,
                "published_date": e["date"],
            }
        )
    return discovered


def parse_nta_exam_calendar_pdf_text(text: str, calendar_pdf_url: str) -> List[Dict[str, Optional[str]]]:
    if not text or len(text) < 40:
        return []
    specs = [
        (r"Rashtriya\s+Indian\s+Military\s+College\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})", "NTA — Rashtriya Indian Military College (RIMC) Entrance Exam"),
        (r"SWAYAM\s+(\d{1,2})\s*[–-]\s*\d{1,2}\s+([A-Za-z]{3,9}\s+\d{4})", "NTA — SWAYAM December 2026 Examination"),
        (r"Rashtriya\s+Military\s+Schools\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})", "NTA — Rashtriya Military Schools (RMS CET) Examination"),
        (r"UGC\s+NET\s*\(December\s+Cycle\)\s+(\d{1,2})[^A-Za-z]{1,20}([A-Za-z]{3,9}\s+\d{4})", "NTA — UGC NET (December 2026 Cycle)"),
        (r"Joint\s+CSIR\s+UGC\s+NET\s*\(December\s+Cycle\)\s+(\d{1,2})[^A-Za-z]{1,20}([A-Za-z]{3,9}\s+\d{4})", "NTA — Joint CSIR-UGC NET (December 2026 Cycle)"),
        (r"Army\s+Cadets\s+College\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})", "NTA — Army Cadets College (ACC) Examination 2027"),
        (r"SHRESHTA\s*\(NETS\)[^0-9]{1,85}(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})", "NTA — SHRESHTA (NETS) Examination 2027"),
        (r"NIFT\s+Entrance\s+Examination\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})", "NTA — NIFT Entrance Examination (NIFTEE) 2027"),
        (r"JEE\s*\(Main\)\s*[—–-]\s*Session\s*1[^0-9]{1,25}(\d{1,2})[^A-Za-z]{1,20}([A-Za-z]{3,9}\s+\d{4})", "NTA — JEE (Main) 2027 Session 1"),
        (r"All\s+India\s+Sainik\s+Schools\s+Entrance\s+Examination\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})", "NTA — All India Sainik Schools Entrance Examination (AISSEE) 2027"),
        (r"Common\s+Management\s+Admission\s+Test\s*\(CMAT\)\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})", "NTA — Common Management Admission Test (CMAT) 2027"),
        (r"CUET\s*\(PG\)[^0-9]{1,75}(\d{1,2})[^A-Za-z]{1,40}([A-Za-z]{3,9}\s+\d{4})", "NTA — CUET (PG) 2027 Examination"),
        (r"JEE\s*\(Main\)\s*[—–-]\s*Session\s*2[^0-9]{1,25}(\d{1,2})\s*[–-]\s*\d{1,2}\s+([A-Za-z]{3,9}\s+\d{4})", "NTA — JEE (Main) 2027 Session 2"),
    ]
    out: List[Dict[str, Optional[str]]] = []
    for pattern, title in specs:
        m = re.search(pattern, text, re.I)
        if not m:
            continue
        raw_date = f"{m.group(1)} {m.group(2)}" if m.lastindex and m.lastindex >= 2 and m.group(2) else m.group(1)
        exam_iso = normalize_human_date(raw_date)
        if not exam_iso:
            continue
        slug = re.sub(r"[^A-Za-z0-9]+", "-", re.sub(r"^NTA\s*[—–-]\s*", "", title, flags=re.I)).strip("-")[:24].upper()
        out.append(
            {
                "title": title,
                "organization_name": "National Testing Agency (NTA)",
                "notification_number": f"NTA-CAL-{slug}",
                "vacancy_count": None,
                "job_category": "National Examination Schedule",
                "qualification": None,
                "state": "All India",
                "application_start_date": None,
                "application_deadline": None,
                "exam_date": exam_iso,
                "admit_card_date": None,
                "result_date": None,
                "description": f"Official NTA Examination Calendar Date: {exam_iso}",
                "pdf_url": calendar_pdf_url,
                "source_url": "https://nta.ac.in/",
                "published_date": None,
            }
        )
    return out


class UpscParser(BasePortalParser):
    parser_key = "upsc"
    organization_name = "Union Public Service Commission (UPSC)"

    def parse(self, html: str, source_url: str = "https://upsc.gov.in/active-examinations/") -> List[Dict[str, Optional[str]]]:
        soup = BeautifulSoup(html, "lxml")
        results: List[Dict[str, Optional[str]]] = []

        fixture_rows = soup.select("table.upsc-notice-table tbody tr.upsc-row, tr.upsc-row")
        if fixture_rows:
            for row in fixture_rows:
                title_el = row.select_one("td.col-title a") or row.select_one("a")
                title = text_or_none(title_el)
                if not title:
                    continue
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": text_or_none(row.select_one("td.col-advt")),
                        "vacancy_count": text_or_none(row.select_one("td.col-vacancy")),
                        "job_category": clean_text(row.get("data-category")) or "Central Civil Services",
                        "qualification": clean_text(row.get("data-qualification")),
                        "state": clean_text(row.get("data-state")) or "All India",
                        "application_start_date": text_or_none(row.select_one("td.col-start")),
                        "application_deadline": text_or_none(row.select_one("td.col-deadline")),
                        "exam_date": text_or_none(row.select_one("td.col-exam")),
                        "admit_card_date": text_or_none(row.select_one("td.col-admit")),
                        "result_date": text_or_none(row.select_one("td.col-result")),
                        "description": text_or_none(row.select_one("td.col-title p.summary")),
                        "pdf_url": resolve_url(source_url, (row.select_one("td.col-pdf a") or {}).get("href") if row.select_one("td.col-pdf a") else None),
                        "source_url": resolve_url(source_url, title_el.get("href")) if title_el else source_url,
                        "published_date": text_or_none(row.select_one("td.col-published")),
                    }
                )
            return results

        for tr in soup.select("table tr"):
            tds = tr.find_all("td")
            if len(tds) < 3:
                continue
            anchor = tds[0].find("a")
            title = text_or_none(anchor) or text_or_none(tds[0])
            if not title or re.search(r"examination name", title, re.I):
                continue
            notice_no = text_or_none(tds[1])
            exam_date = normalize_human_date(tds[2].get_text(" ", strip=True))
            deadline = normalize_human_date(tds[3].get_text(" ", strip=True)) if len(tds) >= 4 else None
            href = resolve_url(source_url, anchor.get("href")) if anchor else source_url
            href = href or source_url
            results.append(
                {
                    "title": title,
                    "organization_name": self.organization_name,
                    "notification_number": notice_no if notice_no and notice_no != "—" else None,
                    "vacancy_count": None,
                    "job_category": "UPSC Active Examination",
                    "qualification": None,
                    "state": "All India",
                    "application_start_date": None,
                    "application_deadline": deadline,
                    "exam_date": exam_date,
                    "admit_card_date": None,
                    "result_date": None,
                    "description": f"Examination Notice No: {notice_no}" if notice_no and notice_no != "—" else None,
                    "pdf_url": href if href.lower().endswith(".pdf") else None,
                    "source_url": href,
                    "published_date": None,
                }
            )
        return results[:35]


class SscParser(BasePortalParser):
    parser_key = "ssc"
    organization_name = "Staff Selection Commission (SSC)"

    def parse(self, html: str, source_url: str = "https://ssc.gov.in/") -> List[Dict[str, Optional[str]]]:
        soup = BeautifulSoup(html, "lxml")
        results: List[Dict[str, Optional[str]]] = []

        cards = soup.select("section.ssc-notice-board article.notice-board-card")
        if cards:
            for card in cards:
                title_el = card.select_one(".notice-title a") or card.select_one("a")
                title = text_or_none(title_el)
                if not title:
                    continue
                pdf_el = card.select_one("a.pdf-link")
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": text_or_none(card.select_one(".notice-num")),
                        "vacancy_count": text_or_none(card.select_one(".vacancies")),
                        "job_category": clean_text(card.get("data-category")) or "Central Group B & C",
                        "qualification": clean_text(card.get("data-qualification")),
                        "state": clean_text(card.get("data-state")) or "All India",
                        "application_start_date": text_or_none(card.select_one(".start-date")),
                        "application_deadline": text_or_none(card.select_one(".deadline")),
                        "exam_date": text_or_none(card.select_one(".exam-date")),
                        "admit_card_date": text_or_none(card.select_one(".admit-date")),
                        "result_date": text_or_none(card.select_one(".result-date")),
                        "description": text_or_none(card.select_one(".notice-desc")),
                        "pdf_url": resolve_url(source_url, pdf_el.get("href")) if pdf_el else None,
                        "source_url": resolve_url(source_url, title_el.get("href")) if title_el else source_url,
                        "published_date": text_or_none(card.select_one(".published-date")),
                    }
                )
            return results

        for el in soup.select('a[href*=".pdf"], .latest-news-list a, .notice-board a'):
            title = text_or_none(el)
            href = resolve_url(source_url, el.get("href"))
            if title and href and len(title) > 18:
                parent = el.find_parent(["li", "tr", "div"])
                parent_text = text_or_none(parent) or ""
                dm = re.search(r"(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})", parent_text)
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": None,
                        "vacancy_count": None,
                        "job_category": "SSC Notice",
                        "qualification": None,
                        "state": "All India",
                        "application_start_date": None,
                        "application_deadline": None,
                        "exam_date": None,
                        "admit_card_date": None,
                        "result_date": None,
                        "description": None,
                        "pdf_url": href if ".pdf" in href.lower() and is_public_http_url(href) else None,
                        "source_url": href,
                        "published_date": normalize_human_date(dm.group(1)) if dm else None,
                    }
                )
        return results[:35]


class TnpscParser(BasePortalParser):
    parser_key = "tnpsc"
    organization_name = "Tamil Nadu Public Service Commission (TNPSC)"

    def parse(self, html: str, source_url: str = "https://tnpsc.gov.in/web/examdashboard/index.aspx") -> List[Dict[str, Optional[str]]]:
        soup = BeautifulSoup(html, "lxml")
        results: List[Dict[str, Optional[str]]] = []

        fixture_rows = soup.select("table#notification-grid tbody tr.tnpsc-item")
        if fixture_rows:
            for row in fixture_rows:
                title_el = row.select_one("td.post-title a") or row.select_one("a")
                title = text_or_none(title_el)
                if not title:
                    continue
                pdf_el = row.select_one("td.pdf a")
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": text_or_none(row.select_one("td.advt-no")),
                        "vacancy_count": text_or_none(row.select_one("td.vacancies")),
                        "job_category": text_or_none(row.select_one("td.category")) or "State Civil Services",
                        "qualification": clean_text(row.get("data-qualification")),
                        "state": clean_text(row.get("data-state")) or "Tamil Nadu",
                        "application_start_date": text_or_none(row.select_one("td.start")),
                        "application_deadline": text_or_none(row.select_one("td.deadline")),
                        "exam_date": text_or_none(row.select_one("td.exam")),
                        "admit_card_date": text_or_none(row.select_one("td.admit")),
                        "result_date": text_or_none(row.select_one("td.result")),
                        "description": text_or_none(row.select_one("td.desc")),
                        "pdf_url": resolve_url(source_url, pdf_el.get("href")) if pdf_el else None,
                        "source_url": resolve_url(source_url, title_el.get("href")) if title_el else source_url,
                        "published_date": text_or_none(row.select_one("td.published")),
                    }
                )
            return results

        seen = set()
        for a in soup.select('a[href*="notid="]'):
            raw_text = text_or_none(a)
            href = resolve_url(source_url, a.get("href"))
            if not raw_text or not href or not is_public_http_url(href) or href in seen:
                continue
            seen.add(href)

            notif_m = re.search(r"\b(\d{1,3}/\d{4})\b", raw_text)
            notif_no = notif_m.group(1) if notif_m else None
            cleaned_title = re.sub(r"^\d+\.\s*", "", raw_text)
            cleaned_title = re.sub(r"\s*[-–]\s*\d{1,3}/\d{4}\s*$", "", cleaned_title).strip()

            results.append(
                {
                    "title": cleaned_title or raw_text,
                    "organization_name": self.organization_name,
                    "notification_number": notif_no,
                    "vacancy_count": None,
                    "job_category": "State Civil Services",
                    "qualification": None,
                    "state": "Tamil Nadu",
                    "application_start_date": None,
                    "application_deadline": None,
                    "exam_date": None,
                    "admit_card_date": None,
                    "result_date": None,
                    "description": f"TNPSC Exam Dashboard Notification {notif_no}" if notif_no else "TNPSC Exam Dashboard Notification",
                    "pdf_url": None,
                    "source_url": href,
                    "published_date": None,
                }
            )
        if results:
            return results[:30]

        for tr in soup.select("table tr"):
            tds = tr.find_all("td")
            if len(tds) < 5:
                continue
            notif_no = text_or_none(tds[1])
            if not notif_no or not re.search(r"\d{1,3}/\d{4}", notif_no):
                continue
            post_td = tds[2]
            pdf_anchors = [a for a in post_td.select('a[href*=".pdf"]') if not re.search(r"addendum", a.get_text(), re.I)]
            pdf_anchor = pdf_anchors[0] if pdf_anchors else None
            title = text_or_none(pdf_anchor) or text_or_none(post_td)
            if not title:
                continue
            pdf_url = resolve_url(source_url, pdf_anchor.get("href")) if pdf_anchor else None
            start_date = normalize_human_date(tds[3].get_text(" ", strip=True))
            deadline = normalize_human_date(tds[4].get_text(" ", strip=True))
            raw_exam = text_or_none(tds[5]) if len(tds) >= 6 else None
            exam_date = normalize_human_date(raw_exam)
            desc_parts = [f"TNPSC Notification {notif_no}"]
            if raw_exam:
                desc_parts.append(f"Exam Schedule: {raw_exam}")

            results.append(
                {
                    "title": title,
                    "organization_name": self.organization_name,
                    "notification_number": notif_no,
                    "vacancy_count": None,
                    "job_category": "State Civil Services",
                    "qualification": None,
                    "state": "Tamil Nadu",
                    "application_start_date": start_date,
                    "application_deadline": deadline,
                    "exam_date": exam_date,
                    "admit_card_date": None,
                    "result_date": None,
                    "description": " · ".join(desc_parts),
                    "pdf_url": pdf_url if is_public_http_url(pdf_url) else None,
                    "source_url": source_url,
                    "published_date": start_date,
                }
            )
        return results[:25]


class KeralaPscParser(BasePortalParser):
    parser_key = "keralapsc"
    organization_name = "Kerala Public Service Commission (Kerala PSC)"

    def parse(self, html: str, source_url: str = "https://www.keralapsc.gov.in/notifications") -> List[Dict[str, Optional[str]]]:
        soup = BeautifulSoup(html, "lxml")
        results: List[Dict[str, Optional[str]]] = []

        cards = soup.select(".kpsc-notifications .kpsc-card")
        if cards:
            for card in cards:
                title_el = card.select_one(".kpsc-title a") or card.select_one("a")
                title = text_or_none(title_el)
                if not title:
                    continue
                meta: Dict[str, Optional[str]] = {}
                for sp in card.select(".kpsc-meta span[data-k]"):
                    k = sp.get("data-k")
                    if k:
                        meta[k] = text_or_none(sp)
                pdf_el = card.select_one("a.kpsc-pdf")
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": text_or_none(card.select_one(".kpsc-cat-no")),
                        "vacancy_count": meta.get("vacancies"),
                        "job_category": clean_text(card.get("data-category")) or "State Civil Services",
                        "qualification": clean_text(card.get("data-qualification")),
                        "state": clean_text(card.get("data-state")) or "Kerala",
                        "application_start_date": meta.get("start"),
                        "application_deadline": meta.get("deadline"),
                        "exam_date": meta.get("exam"),
                        "admit_card_date": meta.get("admit"),
                        "result_date": meta.get("result"),
                        "description": text_or_none(card.select_one(".kpsc-desc")),
                        "pdf_url": resolve_url(source_url, pdf_el.get("href")) if pdf_el else None,
                        "source_url": resolve_url(source_url, title_el.get("href")) if title_el else source_url,
                        "published_date": meta.get("published"),
                    }
                )
            return results

        seen = set()
        for el in soup.select("a"):
            title = text_or_none(el)
            href = resolve_url(source_url, el.get("href"))
            if not title or not href or not is_public_http_url(href) or len(title) < 18:
                continue
            if not re.search(r"notification|category|ranked list|shortlist|gazette|extra-ordinary-gazette", title + href, re.I):
                continue
            dkey = href.lower()
            if dkey in seen:
                continue
            seen.add(dkey)

            cat_m = re.search(r"\b(\d{1,3}/\d{4})\b", title)
            slug_m = re.search(r"gazette-date-(\d{2})(\d{2})(\d{4})", href, re.I)
            gazette_pub = f"{slug_m.group(3)}-{slug_m.group(2)}-{slug_m.group(1)}" if slug_m else None
            results.append(
                {
                    "title": title,
                    "organization_name": self.organization_name,
                    "notification_number": f"Cat. No. {cat_m.group(1)}" if cat_m else None,
                    "vacancy_count": None,
                    "job_category": "State Civil Services",
                    "qualification": None,
                    "state": "Kerala",
                    "application_start_date": gazette_pub,
                    "application_deadline": None,
                    "exam_date": None,
                    "admit_card_date": None,
                    "result_date": None,
                    "description": f"Kerala PSC Extraordinary Gazette dated {gazette_pub}" if gazette_pub else None,
                    "pdf_url": href if ".pdf" in href.lower() and is_public_http_url(href) else None,
                    "source_url": href,
                    "published_date": gazette_pub,
                }
            )
        return results[:25]


class RpscParser(BasePortalParser):
    parser_key = "rpsc"
    organization_name = "Rajasthan Public Service Commission (RPSC)"

    def parse(self, html: str, source_url: str = "https://rpsc.rajasthan.gov.in/advertisements") -> List[Dict[str, Optional[str]]]:
        soup = BeautifulSoup(html, "lxml")
        results: List[Dict[str, Optional[str]]] = []

        rows = soup.select("table.rpsc-advt-table tbody tr.rpsc-row")
        if rows:
            for row in rows:
                title_el = row.select_one("td.rpsc-title a") or row.select_one("a")
                title = text_or_none(title_el)
                if not title:
                    continue
                pdf_el = row.select_one("a.rpsc-pdf")
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": text_or_none(row.select_one("td.rpsc-advt")),
                        "vacancy_count": text_or_none(row.select_one("td.rpsc-vac")),
                        "job_category": clean_text(row.get("data-category")) or "State Civil Services",
                        "qualification": clean_text(row.get("data-qualification")),
                        "state": clean_text(row.get("data-state")) or "Rajasthan",
                        "application_start_date": text_or_none(row.select_one("td.rpsc-start")),
                        "application_deadline": text_or_none(row.select_one("td.rpsc-deadline")),
                        "exam_date": text_or_none(row.select_one("td.rpsc-exam")),
                        "admit_card_date": text_or_none(row.select_one("td.rpsc-admit")),
                        "result_date": text_or_none(row.select_one("td.rpsc-result")),
                        "description": text_or_none(row.select_one("td.rpsc-desc")),
                        "pdf_url": resolve_url(source_url, pdf_el.get("href")) if pdf_el else None,
                        "source_url": resolve_url(source_url, title_el.get("href")) if title_el else source_url,
                        "published_date": text_or_none(row.select_one("td.rpsc-pub")),
                    }
                )
            return results

        for tr in soup.select("table tr"):
            tds = tr.find_all("td")
            if len(tds) < 2:
                continue
            anchor = tr.find("a")
            title = text_or_none(anchor) or text_or_none(tds[1] if len(tds) > 1 else tds[0])
            href = resolve_url(source_url, anchor.get("href")) if anchor else None
            if not title or len(title) < 12 or re.search(r"sr\.?\s*no|advertisement\s*title", title, re.I):
                continue
            row_txt = text_or_none(tr) or ""
            dm = re.search(r"(\d{1,2}[./-]\d{1,2}[./-]\d{4})", row_txt)
            results.append(
                {
                    "title": title,
                    "organization_name": self.organization_name,
                    "notification_number": None,
                    "vacancy_count": None,
                    "job_category": "State Civil Services",
                    "qualification": None,
                    "state": "Rajasthan",
                    "application_start_date": None,
                    "application_deadline": None,
                    "exam_date": None,
                    "admit_card_date": None,
                    "result_date": None,
                    "description": None,
                    "pdf_url": href if href and ".pdf" in href.lower() and is_public_http_url(href) else None,
                    "source_url": href or source_url,
                    "published_date": normalize_human_date(dm.group(1)) if dm else None,
                }
            )
        if results:
            return results[:25]

        for el in soup.select("a"):
            title = text_or_none(el)
            href = resolve_url(source_url, el.get("href"))
            if title and href and len(title) > 18 and re.search(r"advt|advertisement|ras|exam|corrigendum|press note", title, re.I):
                parent = el.find_parent(["li", "tr", "div"])
                dm = re.search(r"(\d{1,2}[./-]\d{1,2}[./-]\d{4})", text_or_none(parent) or "")
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": None,
                        "vacancy_count": None,
                        "job_category": "State Civil Services",
                        "qualification": None,
                        "state": "Rajasthan",
                        "application_start_date": None,
                        "application_deadline": None,
                        "exam_date": None,
                        "admit_card_date": None,
                        "result_date": None,
                        "description": None,
                        "pdf_url": href if ".pdf" in href.lower() and is_public_http_url(href) else None,
                        "source_url": href,
                        "published_date": normalize_human_date(dm.group(1)) if dm else None,
                    }
                )
        return results[:25]


class EmploymentNewsParser(BasePortalParser):
    parser_key = "employmentnews"
    organization_name = "Employment News (Ministry of I&B)"

    def parse(self, html: str, source_url: str = "https://employmentnews.gov.in/NewEmp/AllJobs.aspx?k=All") -> List[Dict[str, Optional[str]]]:
        soup = BeautifulSoup(html, "lxml")
        results: List[Dict[str, Optional[str]]] = []

        cards = soup.select(".employment-news-feed .en-notice-card")
        if cards:
            for card in cards:
                title_el = card.select_one(".en-title a") or card.select_one("a")
                title = text_or_none(title_el)
                if not title:
                    continue
                meta: Dict[str, Optional[str]] = {}
                for sp in card.select(".en-meta span[data-en]"):
                    k = sp.get("data-en")
                    if k:
                        meta[k] = text_or_none(sp)
                pdf_el = card.select_one("a.en-pdf")
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": text_or_none(card.select_one(".en-ref")),
                        "vacancy_count": meta.get("vacancies"),
                        "job_category": clean_text(card.get("data-category")) or "Central PSU & Ministries",
                        "qualification": clean_text(card.get("data-qualification")),
                        "state": clean_text(card.get("data-state")) or "All India",
                        "application_start_date": meta.get("start"),
                        "application_deadline": meta.get("deadline"),
                        "exam_date": meta.get("exam"),
                        "admit_card_date": meta.get("admit"),
                        "result_date": meta.get("result"),
                        "description": text_or_none(card.select_one(".en-desc")),
                        "pdf_url": resolve_url(source_url, pdf_el.get("href")) if pdf_el else None,
                        "source_url": resolve_url(source_url, title_el.get("href")) if title_el else source_url,
                        "published_date": meta.get("published"),
                    }
                )
            return results

        seen = set()
        for tr in soup.select("table tr"):
            tds = tr.find_all("td")
            if len(tds) < 5:
                continue
            issued_raw = text_or_none(tds[0])
            org_raw = text_or_none(tds[1])
            post_raw = text_or_none(tds[2])
            method_raw = text_or_none(tds[3])
            last_date_raw = text_or_none(tds[4])
            if not org_raw or not post_raw or re.search(r"issued\s*date|organisation", org_raw, re.I):
                continue

            title = f"{post_raw} — {org_raw}"
            dkey = f"{title.lower()}::{last_date_raw or ''}"
            if dkey in seen:
                continue
            seen.add(dkey)

            pub_iso = normalize_us_date(issued_raw)
            deadline_iso = normalize_human_date(last_date_raw)
            first_a = tr.find("a")
            anchor_href = (resolve_url(source_url, first_a.get("href")) if first_a else None) or source_url

            results.append(
                {
                    "title": title,
                    "organization_name": org_raw,
                    "notification_number": None,
                    "vacancy_count": None,
                    "job_category": method_raw or "Employment Gazette",
                    "qualification": None,
                    "state": "All India",
                    "application_start_date": pub_iso,
                    "application_deadline": deadline_iso,
                    "exam_date": None,
                    "admit_card_date": None,
                    "result_date": None,
                    "description": f"Employment News Gazette · Organisation: {org_raw} · Method: {method_raw or 'Recruitment'}"
                    + (f" · Closing Date: {deadline_iso}" if deadline_iso else ""),
                    "pdf_url": anchor_href if anchor_href.lower().endswith(".pdf") and is_public_http_url(anchor_href) else None,
                    "source_url": anchor_href,
                    "published_date": pub_iso,
                }
            )
        if results:
            return results[:30]

        for el in soup.select("a"):
            title = text_or_none(el)
            href = resolve_url(source_url, el.get("href"))
            if title and href and len(title) > 20 and re.search(r"recruitment|vacancy|scientist|officer|apprentice|assistant", title, re.I):
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": None,
                        "vacancy_count": None,
                        "job_category": "Central PSU & Ministries",
                        "qualification": None,
                        "state": "All India",
                        "application_start_date": None,
                        "application_deadline": None,
                        "exam_date": None,
                        "admit_card_date": None,
                        "result_date": None,
                        "description": None,
                        "pdf_url": href if ".pdf" in href.lower() and is_public_http_url(href) else None,
                        "source_url": href,
                        "published_date": None,
                    }
                )
        return results[:25]


class TnusrbParser(BasePortalParser):
    parser_key = "tnusrb"
    organization_name = "Tamil Nadu Uniformed Services Recruitment Board (TNUSRB)"

    def parse(self, html: str, source_url: str = "https://www.tnusrb.tn.gov.in/") -> List[Dict[str, Optional[str]]]:
        soup = BeautifulSoup(html, "lxml")
        results: List[Dict[str, Optional[str]]] = []

        cards = soup.select(".recruitment-panel .tnusrb-card, div.tnusrb-card")
        if cards:
            for card in cards:
                title_el = card.select_one("h4 a") or card.select_one("a.card-title") or card.select_one("a")
                title = text_or_none(title_el)
                if not title:
                    continue
                fields: Dict[str, Optional[str]] = {}
                for li in card.select("ul.dates-list li[data-field]"):
                    k = li.get("data-field")
                    if k:
                        fields[k] = text_or_none(li)
                pdf_el = card.select_one("a.btn-pdf, a.card-pdf")
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": text_or_none(card.select_one(".notif-code")),
                        "vacancy_count": fields.get("vacancies"),
                        "job_category": clean_text(card.get("data-category")) or "Police & Uniformed Services",
                        "qualification": clean_text(card.get("data-qualification")),
                        "state": clean_text(card.get("data-state")) or "Tamil Nadu",
                        "application_start_date": fields.get("start"),
                        "application_deadline": fields.get("deadline"),
                        "exam_date": fields.get("exam"),
                        "admit_card_date": fields.get("admit"),
                        "result_date": fields.get("result"),
                        "description": text_or_none(card.select_one("p.details")),
                        "pdf_url": resolve_url(source_url, pdf_el.get("href")) if pdf_el else None,
                        "source_url": resolve_url(source_url, title_el.get("href")) if title_el else source_url,
                        "published_date": fields.get("published"),
                    }
                )
            return results

        for el in soup.select('a[href*=".pdf"], a'):
            title = text_or_none(el)
            href = resolve_url(source_url, el.get("href"))
            if title and href and len(title) > 18 and re.search(r"sub-inspector|constable|recruitment|notification|brochure", title, re.I):
                parent = el.find_parent(["li", "tr", "div"])
                dm = re.search(r"(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})", text_or_none(parent) or "")
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": None,
                        "vacancy_count": None,
                        "job_category": "Police & Uniformed Services",
                        "qualification": None,
                        "state": "Tamil Nadu",
                        "application_start_date": None,
                        "application_deadline": None,
                        "exam_date": None,
                        "admit_card_date": None,
                        "result_date": None,
                        "description": None,
                        "pdf_url": href if ".pdf" in href.lower() and is_public_http_url(href) else None,
                        "source_url": href,
                        "published_date": normalize_human_date(dm.group(1)) if dm else None,
                    }
                )
        return results[:25]


class RrbCdgParser(BasePortalParser):
    parser_key = "rrbcdg"
    organization_name = "Railway Recruitment Boards (RRB)"

    def parse(self, html: str, source_url: str = "https://www.rrbcdg.gov.in/") -> List[Dict[str, Optional[str]]]:
        soup = BeautifulSoup(html, "lxml")
        results: List[Dict[str, Optional[str]]] = []

        rows = soup.select("table.cen-notice-table tbody tr")
        if rows:
            for row in rows:
                title_el = row.select_one("td.cen-title a") or row.select_one("a")
                title = text_or_none(title_el)
                if not title:
                    continue
                pdf_el = row.select_one("td.cen-doc a")
                results.append(
                    {
                        "title": title,
                        "organization_name": "Railway Recruitment Boards (RRB Chandigarh)",
                        "notification_number": text_or_none(row.select_one("td.cen-id")),
                        "vacancy_count": text_or_none(row.select_one("td.cen-posts")),
                        "job_category": clean_text(row.get("data-cat")) or "Indian Railways",
                        "qualification": clean_text(row.get("data-qualification")),
                        "state": clean_text(row.get("data-state")) or "All India",
                        "application_start_date": text_or_none(row.select_one("td.cen-open")),
                        "application_deadline": text_or_none(row.select_one("td.cen-close")),
                        "exam_date": text_or_none(row.select_one("td.cen-cbt")),
                        "admit_card_date": text_or_none(row.select_one("td.cen-ecall")),
                        "result_date": text_or_none(row.select_one("td.cen-res")),
                        "description": text_or_none(row.select_one("td.cen-summary")),
                        "pdf_url": resolve_url(source_url, pdf_el.get("href")) if pdf_el else None,
                        "source_url": resolve_url(source_url, title_el.get("href")) if title_el else source_url,
                        "published_date": text_or_none(row.select_one("td.cen-pub")),
                    }
                )
            return results

        seen = set()
        for el in soup.select('a[href*=".pdf"], table a, li a, .notice a, marquee a'):
            title = text_or_none(el)
            href = resolve_url(source_url, el.get("href"))
            if not title or not href or not is_public_http_url(href) or len(title) < 16:
                continue
            if not re.search(r"cen|alp|ntpc|technician|paramedical|ministerial|group|admit|e-call|result|corrigendum|schedule|notice|cbt", title + href, re.I):
                continue
            dkey = title.lower()
            if dkey in seen:
                continue
            seen.add(dkey)

            parent = el.find_parent(["li", "tr", "div"])
            parent_text = text_or_none(parent) or ""
            dm = re.search(r"(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})", parent_text)
            cen_m = re.search(r"\b(?:CEN|RRC)[-\s/]*(?:No\.?\s*)?(\d{2}/\d{4})\b", title, re.I)

            results.append(
                {
                    "title": title,
                    "organization_name": self.organization_name,
                    "notification_number": f"CEN-{cen_m.group(1)}" if cen_m else None,
                    "vacancy_count": None,
                    "job_category": "Railway Recruitment",
                    "qualification": None,
                    "state": "All India",
                    "application_start_date": None,
                    "application_deadline": None,
                    "exam_date": None,
                    "admit_card_date": None,
                    "result_date": None,
                    "description": f"Official RRB Notice ({source_url})",
                    "pdf_url": href if ".pdf" in href.lower() and is_public_http_url(href) else None,
                    "source_url": href,
                    "published_date": normalize_human_date(dm.group(1)) if dm else None,
                }
            )
        return results[:30]


class IbpsParser(BasePortalParser):
    parser_key = "ibps"
    organization_name = "Institute of Banking Personnel Selection (IBPS)"

    def parse(self, html: str, source_url: str = "https://www.ibps.in/") -> List[Dict[str, Optional[str]]]:
        soup = BeautifulSoup(html, "lxml")
        results: List[Dict[str, Optional[str]]] = []

        cards = soup.select(".crp-notification-list .crp-item")
        if cards:
            for card in cards:
                title_el = card.select_one("h3.crp-title a") or card.select_one("a")
                title = text_or_none(title_el)
                if not title:
                    continue
                attrs = {
                    span.get("data-field"): text_or_none(span)
                    for span in card.select(".crp-attrs span[data-field]")
                    if span.get("data-field")
                }
                pdf_el = card.select_one("a.crp-pdf")
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": text_or_none(card.select_one(".crp-code")),
                        "vacancy_count": attrs.get("vacancies"),
                        "job_category": clean_text(card.get("data-category")) or "Public Sector Banking",
                        "qualification": clean_text(card.get("data-qualification")),
                        "state": clean_text(card.get("data-state")) or "All India",
                        "application_start_date": attrs.get("start"),
                        "application_deadline": attrs.get("deadline"),
                        "exam_date": attrs.get("exam"),
                        "admit_card_date": attrs.get("admit"),
                        "result_date": attrs.get("result"),
                        "description": text_or_none(card.select_one("p.crp-summary")),
                        "pdf_url": resolve_url(source_url, pdf_el.get("href")) if pdf_el else None,
                        "source_url": resolve_url(source_url, title_el.get("href")) if title_el else source_url,
                        "published_date": attrs.get("published"),
                    }
                )
            return results

        seen = set()
        for el in soup.select("a"):
            title = text_or_none(el)
            href = resolve_url(source_url, el.get("href"))
            if not title or not href or not is_public_http_url(href) or len(title) < 18:
                continue
            if re.match(r"^CRP\s*[-\s]?(RRBs|CSA.*|PO/MTs|Clerks|Specialist Officer(?:s)?|Clerical cadre)$", title, re.I):
                continue
            if re.search(r"/index\.php/(?:specialist-officers|clerical-cadre|po-mt|regional-rural-bank|overview|career)/?$", href, re.I):
                continue
            is_ibps_reg = bool(re.search(r"ibpsreg\.ibps\.in", href, re.I))
            is_crp = bool(re.search(r"CRP|Notification for Common Recruitment|Provisional Allotment|Result|Call Letter|Recruitment of|Engagement of", title, re.I))
            if not is_crp and not is_ibps_reg:
                continue
            dkey = title.lower()
            if dkey in seen:
                continue
            seen.add(dkey)

            crp_m = re.search(r"CRP[-\sA-Z/]+(?:XVII|XVI|XV|XIV)", title, re.I)
            crp_code = crp_m.group(0) if crp_m else None
            reg_code = href.rstrip("/").split("/")[-1].upper() if is_ibps_reg else None
            is_pdf = ".pdf" in href.lower()
            file_date_m = re.search(r"(\d{2}\.\d{2}\.\d{4})\.pdf$", href, re.I) if is_pdf else None
            reg_from_m = re.search(r"Registration\s+From\s+(\d{1,2}[-/][A-Za-z]{3}[-/]\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{4})", title, re.I)
            parent = el.find_parent(["li", "p", "div"])
            parent_date_m = re.search(r"(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})", text_or_none(parent) or "")

            reg_start = normalize_human_date(reg_from_m.group(1)) if reg_from_m else None
            pub_date = (
                reg_start
                or (normalize_human_date(file_date_m.group(1)) if file_date_m else None)
                or (normalize_human_date(parent_date_m.group(1)) if parent_date_m else None)
            )
            clean_title = re.sub(r"\s*Registration\s+From\s+\d{1,2}[-/][A-Za-z]{3}[-/]\d{4}\s*$", "", title, flags=re.I).strip() or title

            results.append(
                {
                    "title": clean_title,
                    "organization_name": self.organization_name,
                    "notification_number": crp_code or (f"IBPS-{reg_code}" if reg_code else None),
                    "vacancy_count": None,
                    "job_category": "IBPS Active Recruitment Portal" if is_ibps_reg else "Public Sector Banking",
                    "qualification": None,
                    "state": "All India",
                    "application_start_date": reg_start,
                    "application_deadline": None,
                    "exam_date": None,
                    "admit_card_date": None,
                    "result_date": pub_date if re.search(r"provisional allotment|result", clean_title, re.I) and pub_date else None,
                    "description": f"IBPS Online Registration Portal · Opens {reg_start}" if reg_start else None,
                    "pdf_url": href if is_pdf and is_public_http_url(href) else None,
                    "source_url": source_url if is_pdf else href,
                    "published_date": pub_date,
                }
            )
        return results[:30]


class SbiParser(BasePortalParser):
    parser_key = "sbi"
    organization_name = "State Bank of India (SBI Careers)"

    def parse(self, html: str, source_url: str = "https://sbi.co.in/web/careers/current-openings") -> List[Dict[str, Optional[str]]]:
        soup = BeautifulSoup(html, "lxml")
        results: List[Dict[str, Optional[str]]] = []

        fixture_rows = soup.select("table.sbi-careers-table tbody tr.sbi-opening")
        if fixture_rows:
            for row in fixture_rows:
                title_el = row.select_one("td.title-col a") or row.select_one("a")
                title = text_or_none(title_el)
                if not title:
                    continue
                pdf_el = row.select_one("td.pdf-col a")
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": text_or_none(row.select_one("td.advt-col")),
                        "vacancy_count": text_or_none(row.select_one("td.vac-col")),
                        "job_category": clean_text(row.get("data-category")) or "SBI Banking Recruitment",
                        "qualification": clean_text(row.get("data-qualification")),
                        "state": clean_text(row.get("data-state")) or "All India",
                        "application_start_date": text_or_none(row.select_one("td.start-col")),
                        "application_deadline": text_or_none(row.select_one("td.end-col")),
                        "exam_date": text_or_none(row.select_one("td.exam-col")),
                        "admit_card_date": text_or_none(row.select_one("td.admit-col")),
                        "result_date": text_or_none(row.select_one("td.res-col")),
                        "description": text_or_none(row.select_one("td.title-col .opening-note")),
                        "pdf_url": resolve_url(source_url, pdf_el.get("href")) if pdf_el else None,
                        "source_url": resolve_url(source_url, title_el.get("href")) if title_el else source_url,
                        "published_date": text_or_none(row.select_one("td.pub-col")),
                    }
                )
            return results

        seen = set()
        for a in soup.select('li.icon-touch a[href*=".pdf"], .accordion-body a[href*=".pdf"], .panel-body a[href*=".pdf"]'):
            raw_href = a.get("href") or ""
            link_text = text_or_none(a) or ""
            if re.search(r"hindi|corrigendum", link_text, re.I) and not re.search(r"english", link_text, re.I):
                continue
            if not re.search(r"english|adv|detailed|notification|download", link_text + raw_href, re.I):
                continue
            resolved_pdf = resolve_url(source_url, raw_href)
            if not is_public_http_url(resolved_pdf):
                continue

            collapse_div = a.find_parent(class_=re.compile(r"panel-collapse|accordion-collapse|collapse|card-body"))
            prev_title = text_or_none(collapse_div.find_previous_sibling()) if collapse_div else None
            card = a.find_parent(class_=re.compile(r"\b(?:panel|card|accordion-item)\b"))
            card_meta = (
                text_or_none(card.select_one("h3, h4, h5, button, .panel-title, .accordion-button")) if card else None
            ) or ""
            raw_title = prev_title or card_meta
            if not raw_title or len(raw_title) < 15:
                continue

            full_card_text = (text_or_none(card) if card else None) or card_meta
            clean_title = clean_text(re.sub(r"\(Apply Online from[^)]+\)", "", raw_title, flags=re.I)) or raw_title
            if clean_title in seen:
                continue
            seen.add(clean_title)

            win_m = re.search(
                r"Apply Online from\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})\s*TO\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})",
                full_card_text,
                re.I,
            )
            start_date = normalize_human_date(win_m.group(1)) if win_m else None
            win_end = normalize_human_date(win_m.group(2)) if win_m else None
            last_m = re.search(r"LAST DATE TO APPLY\s*:\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})", full_card_text, re.I)
            deadline = (normalize_human_date(last_m.group(1)) if last_m else None) or win_end

            advt_m = re.search(r"ADVERTISEMENT NO:\s*([A-Z0-9/_-]+)", full_card_text, re.I)
            raw_advt_m = re.search(r"CRPD[-_][A-Z0-9_-]+|SCO-\d+", raw_href, re.I)
            advt = advt_m.group(1) if advt_m else (raw_advt_m.group(0) if raw_advt_m else None)

            results.append(
                {
                    "title": clean_title,
                    "organization_name": self.organization_name,
                    "notification_number": advt,
                    "vacancy_count": None,
                    "job_category": "SBI Banking Recruitment",
                    "qualification": None,
                    "state": "All India",
                    "application_start_date": start_date,
                    "application_deadline": deadline,
                    "exam_date": None,
                    "admit_card_date": None,
                    "result_date": None,
                    "description": (
                        f"SBI Current Opening ({advt})" + (f" · Online window {start_date} to {deadline}" if start_date and deadline else "")
                        if advt
                        else None
                    ),
                    "pdf_url": resolved_pdf,
                    "source_url": source_url,
                    "published_date": start_date,
                }
            )
        return results[:30]


class RbiParser(BasePortalParser):
    parser_key = "rbi"
    organization_name = "Reserve Bank of India (RBI Opportunities)"

    def parse(self, html: str, source_url: str = "https://opportunities.rbi.org.in/Scripts/Vacancies.aspx") -> List[Dict[str, Optional[str]]]:
        soup = BeautifulSoup(html, "lxml")
        results: List[Dict[str, Optional[str]]] = []

        notices = soup.select(".rbi-vacancies-list .rbi-notice")
        if notices:
            for notice in notices:
                title_el = notice.select_one("a.rbi-link") or notice.select_one("a")
                title = text_or_none(title_el)
                if not title:
                    continue
                pdf_el = notice.select_one("a.rbi-pdf")
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": text_or_none(notice.select_one(".rbi-advt")),
                        "vacancy_count": text_or_none(notice.select_one(".f-vac")),
                        "job_category": clean_text(notice.get("data-category")) or "Central Banking",
                        "qualification": clean_text(notice.get("data-qualification")),
                        "state": clean_text(notice.get("data-state")) or "All India",
                        "application_start_date": text_or_none(notice.select_one(".f-start")),
                        "application_deadline": text_or_none(notice.select_one(".f-deadline")),
                        "exam_date": text_or_none(notice.select_one(".f-exam")),
                        "admit_card_date": text_or_none(notice.select_one(".f-admit")),
                        "result_date": text_or_none(notice.select_one(".f-result")),
                        "description": text_or_none(notice.select_one("p.rbi-summary")),
                        "pdf_url": resolve_url(source_url, pdf_el.get("href")) if pdf_el else None,
                        "source_url": resolve_url(source_url, title_el.get("href")) if title_el else source_url,
                        "published_date": text_or_none(notice.select_one(".f-pub")),
                    }
                )
            return results

        seen = set()
        for el in soup.select('a[href*="bs_viewcontent"]'):
            title = text_or_none(el)
            href = resolve_url(source_url, el.get("href"))
            if not title or not href or len(title) < 18:
                continue
            if re.match(r"^(Recruitment|Promotion|Rosters at ROs)$", title, re.I):
                continue
            if href in seen:
                continue
            seen.add(href)
            id_m = re.search(r"[?&]Id=(\d+)", href, re.I)
            results.append(
                {
                    "title": title,
                    "organization_name": self.organization_name,
                    "notification_number": f"RBI-VAC-{id_m.group(1)}" if id_m else None,
                    "vacancy_count": None,
                    "job_category": "Central Banking",
                    "qualification": None,
                    "state": "All India",
                    "application_start_date": None,
                    "application_deadline": None,
                    "exam_date": None,
                    "admit_card_date": None,
                    "result_date": None,
                    "description": None,
                    "pdf_url": None,
                    "source_url": href,
                    "published_date": None,
                }
            )

        for el in soup.select('a[href*=".pdf"]'):
            title = text_or_none(el)
            href = resolve_url(source_url, el.get("href"))
            if not title or not href or len(title) < 18 or not is_public_http_url(href) or href in seen:
                continue
            if not re.search(r"recruitment|calendar|vacancy|officer|assistant", title + href, re.I):
                continue
            seen.add(href)
            results.append(
                {
                    "title": title,
                    "organization_name": self.organization_name,
                    "notification_number": "RBI-CALENDAR",
                    "vacancy_count": None,
                    "job_category": "Central Banking Schedule",
                    "qualification": None,
                    "state": "All India",
                    "application_start_date": None,
                    "application_deadline": None,
                    "exam_date": None,
                    "admit_card_date": None,
                    "result_date": None,
                    "description": "Official RBI Annual Recruitment Calendar & Exam Schedule PDF.",
                    "pdf_url": href,
                    "source_url": source_url,
                    "published_date": None,
                }
            )
        return results[:25]


class NtaParser(BasePortalParser):
    parser_key = "nta"
    organization_name = "National Testing Agency (NTA)"

    def parse(self, html: str, source_url: str = "https://nta.ac.in/") -> List[Dict[str, Optional[str]]]:
        soup = BeautifulSoup(html, "lxml")
        results: List[Dict[str, Optional[str]]] = []

        rows = soup.select("section.public-notices-grid .nta-notice-row")
        if rows:
            for row in rows:
                title_el = row.select_one(".nta-title a") or row.select_one("a")
                title = text_or_none(title_el)
                if not title:
                    continue
                meta = {
                    sp.get("data-m"): text_or_none(sp)
                    for sp in row.select(".nta-meta span[data-m]")
                    if sp.get("data-m")
                }
                pdf_el = row.select_one("a.nta-pdf")
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": text_or_none(row.select_one(".nta-ref")),
                        "vacancy_count": meta.get("vacancies"),
                        "job_category": clean_text(row.get("data-category")) or "National Examination",
                        "qualification": clean_text(row.get("data-qualification")),
                        "state": clean_text(row.get("data-state")) or "All India",
                        "application_start_date": meta.get("start"),
                        "application_deadline": meta.get("deadline"),
                        "exam_date": meta.get("exam"),
                        "admit_card_date": meta.get("admit"),
                        "result_date": meta.get("result"),
                        "description": text_or_none(row.select_one("p.nta-desc")),
                        "pdf_url": resolve_url(source_url, pdf_el.get("href")) if pdf_el else None,
                        "source_url": resolve_url(source_url, title_el.get("href")) if title_el else source_url,
                        "published_date": meta.get("published"),
                    }
                )
            return results

        seen = set()
        dated: List[Dict[str, Optional[str]]] = []
        general: List[Dict[str, Optional[str]]] = []
        for a in soup.select('a[href*="/Download/Notice/"], a[href*=".pdf"]'):
            href = resolve_url(source_url, a.get("href"))
            if not href or not is_public_http_url(href) or not re.search(r"\.pdf", href, re.I):
                continue
            parent_p = a.find_parent(["p", "li", "div", "tr"])
            content_title = text_or_none(parent_p.find("content")) if parent_p else None
            fallback_parent = None
            if parent_p:
                clone = BeautifulSoup(str(parent_p), "lxml")
                for bad_a in clone.select("a"):
                    bad_a.decompose()
                fallback_parent = text_or_none(clone)
            link_text = text_or_none(a)
            title = (
                content_title
                or (fallback_parent if fallback_parent and len(fallback_parent) > 15 else None)
                or (link_text if link_text and not re.match(r"^read\s*more$", link_text, re.I) else None)
            )
            if not title or len(title) < 12 or title in seen:
                continue
            if re.match(r"^procedure for duplicate score card$", title, re.I):
                continue
            seen.add(title)

            pub_date = normalize_human_date(href)
            inline_date = normalize_human_date(title)
            is_admit = bool(re.search(r"admit\s*card|city\s*intimation", title, re.I))
            is_result = bool(re.search(r"result|score\s*card|answer\s*key", title, re.I))
            category = "Admit Card / Intimation" if is_admit else ("Examination Result" if is_result else "National Examination Notice")

            entry: Dict[str, Optional[str]] = {
                "title": title,
                "organization_name": self.organization_name,
                "notification_number": None,
                "vacancy_count": None,
                "job_category": category,
                "qualification": None,
                "state": "All India",
                "application_start_date": None,
                "application_deadline": None,
                "exam_date": inline_date if re.search(r"schedule|exam", title, re.I) and inline_date else None,
                "admit_card_date": pub_date if is_admit else None,
                "result_date": pub_date if is_result else None,
                "description": f"Official NTA Public Notice released on {pub_date}." if pub_date else None,
                "pdf_url": href,
                "source_url": source_url,
                "published_date": pub_date,
            }
            if pub_date:
                dated.append(entry)
            else:
                general.append(entry)

        combined = dated + general
        if combined:
            return combined[:30]

        for el in soup.select("a"):
            title = text_or_none(el)
            href = resolve_url(source_url, el.get("href"))
            if not title or not href or len(title) < 15 or title in seen:
                continue
            if re.search(r"nta\.nic\.in|Notice|Examination|CUET|JEE|NEET|UGC|AISSEE|NCET|SWAYAM", title + href, re.I):
                seen.add(title)
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": None,
                        "vacancy_count": None,
                        "job_category": "National Examination",
                        "qualification": None,
                        "state": "All India",
                        "application_start_date": None,
                        "application_deadline": None,
                        "exam_date": None,
                        "admit_card_date": None,
                        "result_date": None,
                        "description": None,
                        "pdf_url": href if ".pdf" in href.lower() else None,
                        "source_url": href,
                        "published_date": None,
                    }
                )
        return results[:25]


class IndiaPostParser(BasePortalParser):
    parser_key = "indiapost"
    organization_name = "India Post — Department of Posts"

    def parse(self, html: str, source_url: str = "https://indiapostgdsonline.gov.in/") -> List[Dict[str, Optional[str]]]:
        soup = BeautifulSoup(html, "lxml")
        results: List[Dict[str, Optional[str]]] = []

        entries = soup.select(".gds-engagement-list .indiapost-entry")
        if entries:
            for entry in entries:
                title_el = entry.select_one("h4.ip-title a") or entry.select_one("a")
                title = text_or_none(title_el)
                if not title:
                    continue
                pdf_el = entry.select_one("a.ip-pdf")
                results.append(
                    {
                        "title": title,
                        "organization_name": self.organization_name,
                        "notification_number": text_or_none(entry.select_one(".ip-notif-no")),
                        "vacancy_count": text_or_none(entry.select_one(".ip-vac")),
                        "job_category": clean_text(entry.get("data-category")) or "Postal Services",
                        "qualification": clean_text(entry.get("data-qualification")),
                        "state": clean_text(entry.get("data-state")) or "All India",
                        "application_start_date": text_or_none(entry.select_one(".ip-start")),
                        "application_deadline": text_or_none(entry.select_one(".ip-deadline")),
                        "exam_date": text_or_none(entry.select_one(".ip-exam")),
                        "admit_card_date": text_or_none(entry.select_one(".ip-admit")),
                        "result_date": text_or_none(entry.select_one(".ip-result")),
                        "description": text_or_none(entry.select_one("p.ip-desc")),
                        "pdf_url": resolve_url(source_url, pdf_el.get("href")) if pdf_el else None,
                        "source_url": resolve_url(source_url, title_el.get("href")) if title_el else source_url,
                        "published_date": text_or_none(entry.select_one(".ip-pub")),
                    }
                )
            return results

        seen = set()
        for el in soup.select('a[href*=".pdf"], a[href*=".PDF"]'):
            href = resolve_url(source_url, el.get("href"))
            link_text = text_or_none(el)
            if not href or not is_public_http_url(href):
                continue

            file_name = re.sub(r"[_-]+", " ", re.sub(r"\.pdf$", "", href.split("/")[-1], flags=re.I))
            parent_box = el.find_parent(["li", "div", "p", "td"])
            parent_ctx = text_or_none(parent_box.parent if parent_box and parent_box.parent else parent_box) or ""
            is_dv_list = bool(re.search(r"DocVerList|_DV_List", href, re.I))
            circle_m = re.match(r"^([A-Za-z ]+?)\s+DV\s+List\s*(\d+)", file_name, re.I)

            if is_dv_list and circle_m:
                title = f"India Post GDS — {circle_m.group(1)} Circle Document Verification List {circle_m.group(2)}"
            elif re.search(r"Notifications1", href, re.I):
                title = f"India Post GDS Notification — {link_text or file_name} ({file_name})"
            elif link_text and len(link_text) > 15 and re.search(r"gds|gramin|recruit|vacancy|engagement|shortlist|post", link_text + file_name, re.I):
                title = link_text
            else:
                continue

            if title.lower() in seen:
                continue
            seen.add(title.lower())

            slug_name = re.sub(r"\s+", "-", file_name)[:24]
            results.append(
                {
                    "title": title,
                    "organization_name": self.organization_name,
                    "notification_number": f"GDS-{slug_name}" if re.search(r"Notifications1", href, re.I) else None,
                    "vacancy_count": None,
                    "job_category": "GDS Shortlist / Result" if is_dv_list else "Postal Services",
                    "qualification": "10th Pass",
                    "state": circle_m.group(1) if circle_m else "All India",
                    "application_start_date": None,
                    "application_deadline": None,
                    "exam_date": None,
                    "admit_card_date": None,
                    "result_date": normalize_human_date(parent_ctx) if is_dv_list else None,
                    "description": f"India Post GDS Official Circular ({file_name})",
                    "pdf_url": href,
                    "source_url": source_url,
                    "published_date": None,
                }
            )
        if results:
            return results[:25]

        unescaped = html.replace('\\"', '"')
        rsc_re = re.compile(
            r'"title"\s*:\s*"([^"]{15,300})"\s*,\s*"category"\s*:\s*"([^"]*)"\s*,\s*"date"\s*:\s*"([^"]*)"[^}]{0,220}?"version"\s*:\s*"([^"]*)"[^}]{0,120}?"url"\s*:\s*"(/api/documents/file/[^"]+)"'
        )
        english_first: List[Dict[str, Optional[str]]] = []
        other_langs: List[Dict[str, Optional[str]]] = []
        for m in rsc_re.finditer(unescaped):
            title = clean_text(m.group(1))
            raw_cat = clean_text(m.group(2)) or "Postal Services"
            pub_date = normalize_human_date(m.group(3))
            version = clean_text(m.group(4)) or ""
            pdf_url = resolve_url(source_url, m.group(5))
            if not title or not pdf_url or not is_public_http_url(pdf_url):
                continue
            if re.search(r"message from hon|minister|recruitment\s*rules", title, re.I):
                continue
            if not re.search(r"gds|gramin\s*dak|recruit|engagement|vacancy|shortlist|postal\s*assistant|postman|mts", f"{title} {raw_cat}", re.I):
                continue
            if re.match(r"^hindi version$", version, re.I) and any(r["title"] == title for r in english_first):
                continue
            if title.lower() in seen:
                continue
            seen.add(title.lower())
            vac_m = re.search(r"\b(\d{1,4})\s+(?:vacant\s+)?posts?\b", title, re.I)
            no_m = re.search(r"\bNo\.?\s*([A-Z0-9/-]+(?:-\d{4})?)\b", title, re.I)
            parsed = {
                "title": title,
                "organization_name": self.organization_name,
                "notification_number": no_m.group(1) if no_m else None,
                "vacancy_count": vac_m.group(1) if vac_m else None,
                "job_category": "Postal Recruitment" if re.search(r"recruit", raw_cat, re.I) else raw_cat,
                "qualification": None,
                "state": "All India",
                "application_start_date": None,
                "application_deadline": None,
                "exam_date": None,
                "admit_card_date": None,
                "result_date": None,
                "description": f"India Post {raw_cat} ({version})" if version else f"India Post {raw_cat}",
                "pdf_url": pdf_url,
                "source_url": source_url,
                "published_date": pub_date,
            }
            if re.search(r"english", version, re.I):
                english_first.append(parsed)
            else:
                other_langs.append(parsed)

        combined_rsc = english_first + other_langs
        return combined_rsc[:25] if combined_rsc else results[:20]
