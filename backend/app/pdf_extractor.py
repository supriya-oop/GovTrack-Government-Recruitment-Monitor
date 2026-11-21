import io
import logging
import re
import time
import urllib3
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote, unquote, urlparse
import requests
from bs4 import BeautifulSoup

try:
    import certifi
    CA_BUNDLE: Any = certifi.where()
except ImportError:
    CA_BUNDLE = True

try:
    from pypdf import PdfReader  # type: ignore
except ImportError:
    PdfReader = None  # type: ignore

from .config import SCRAPER_USER_AGENT
from .scrapers.base import clean_text, is_public_http_url, normalize_human_date, resolve_url

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
logger = logging.getLogger("govtrack.pdf")

DATE_TOKEN = (
    r"(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}"
    r"|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+\d{4}"
    r"|[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})"
)

BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"


def _safe_encode_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        encoded_path = quote(unquote(parsed.path), safe="/:@&+$,;=-_.!~*'()")
        return parsed._replace(path=encoded_path).geturl()
    except Exception:
        return url


def fetch_with_retry(
    url: str,
    *,
    timeout: float = 12.0,
    headers: Optional[Dict[str, str]] = None,
    retries: int = 2,
) -> requests.Response:
    target = _safe_encode_url(url)
    req_headers = {
        "User-Agent": SCRAPER_USER_AGENT,
        "Accept-Language": "en-IN,en-US;q=0.9,en;q=0.8",
        **(headers or {}),
    }
    last_exc: Optional[Exception] = None
    is_gov_in = ".gov.in" in target.lower() or ".nic.in" in target.lower()

    for attempt in range(retries + 1):
        try:
            resp = requests.get(
                target,
                headers=req_headers,
                timeout=timeout,
                allow_redirects=True,
                verify=CA_BUNDLE,
            )
            if resp.status_code >= 500 and attempt < retries:
                time.sleep(0.25 * (attempt + 1))
                continue
            return resp
        except requests.exceptions.SSLError as ssl_exc:
            last_exc = ssl_exc
            if is_gov_in:
                try:
                    logger.warning("TLS verification issue on official portal %s; retrying with verify=False", target)
                    resp = requests.get(
                        target,
                        headers=req_headers,
                        timeout=timeout,
                        allow_redirects=True,
                        verify=False,
                    )
                    return resp
                except Exception as inner_exc:
                    last_exc = inner_exc
        except Exception as exc:
            last_exc = exc
        if attempt < retries:
            time.sleep(0.25 * (attempt + 1))

    if last_exc:
        raise last_exc
    raise RuntimeError("Fetch failed")


def extract_text_from_pdf_buffer(data: bytes) -> str:
    if not data or len(data) < 100:
        return ""
    if b"%PDF" not in data[:32]:
        return ""

    if PdfReader is not None:
        try:
            reader = PdfReader(io.BytesIO(data), strict=False)
            chunks: List[str] = []
            for page in reader.pages[:20]:
                txt = page.extract_text() or ""
                if txt:
                    chunks.append(txt)
            joined = re.sub(r"\s+", " ", " ".join(chunks)).strip()
            if joined:
                return joined
        except Exception:
            pass

    import zlib
    text_parts: List[str] = []
    for match in re.finditer(rb"stream[\r\n]+(.*?)[\r\n]*endstream", data, re.S):
        raw = match.group(1)
        try:
            decoded = zlib.decompress(raw).decode("latin1", errors="ignore")
        except Exception:
            decoded = raw.decode("latin1", errors="ignore")
        for s_match in re.finditer(r"\(([^()]{2,200})\)\s*Tj", decoded):
            text_parts.append(s_match.group(1))
    return re.sub(r"\s+", " ", " ".join(text_parts)).strip()


def extract_structured_fields_from_pdf_text(text: str) -> Dict[str, Optional[str]]:
    result: Dict[str, Optional[str]] = {
        "application_start_date": None,
        "application_deadline": None,
        "exam_date": None,
        "admit_card_date": None,
        "result_date": None,
        "vacancy_count": None,
        "qualification": None,
        "notification_status": None,
    }
    if not text or len(text) < 25:
        return result

    if re.search(r"\b(?:notification|examination|recruitment)\s+(?:stands\s+)?(?:cancelled|canceled|withdrawn|annulled)\b", text, re.I):
        result["notification_status"] = "cancelled"

    reg_window_re = re.compile(
        rf"(?:On-?line\s+Registration(?:\s+(?:of\s+Application|including|and|of)\s+[^.\n]{{0,80}})?|Online\s+submission\s+of\s+Application\s+Form|Registration\s+(?:Window|Dates?)|Application\s+(?:opens?|from)|Opening\s*&\s*Closing\s+Date|Submission\s+of\s+Online\s+Application).{{0,90}}?(?:FROM\s+)?({DATE_TOKEN})\s*(?:to|TO|–|-|&|till|upto)\s*({DATE_TOKEN})(?:\s+(?:FROM\s+)?({DATE_TOKEN})\s*(?:to|TO|–|-|&|till|upto)\s*({DATE_TOKEN}))?",
        re.I,
    )
    reg_m = reg_window_re.search(text)
    if reg_m:
        start_raw = reg_m.group(3) or reg_m.group(1)
        end_raw = reg_m.group(4) or reg_m.group(2)
        result["application_start_date"] = normalize_human_date(start_raw)
        result["application_deadline"] = normalize_human_date(end_raw)

    if not result["application_start_date"]:
        start_re = re.compile(
            rf"(?:Date\s+of\s+(?:Commencement|Opening)\s+of\s+(?:Receiving\s+)?(?:Online\s+)?Application|Application\s+Start\s+Date|Opening\s+Date)[^0-9A-Za-z]{{0,35}}({DATE_TOKEN})",
            re.I,
        )
        m = start_re.search(text)
        if m:
            result["application_start_date"] = normalize_human_date(m.group(1))

    if not result["application_deadline"]:
        deadline_re = re.compile(
            rf"(?:Last\s+Date\s+(?:&\s+Time\s+)?(?:for|of)\s+(?:Receipt\s+of\s+|Submission\s+of\s+|Online\s+)?(?:Applications?|Registration)|Closing\s+Date\s+(?:for|of)\s+(?:Application|Registration)|Last\s+date\s+for\s+receipt\s+of\s+applications|Last\s+date\s+to\s+apply)[^0-9A-Za-z]{{0,40}}({DATE_TOKEN})",
            re.I,
        )
        m = deadline_re.search(text)
        if m:
            result["application_deadline"] = normalize_human_date(m.group(1))

    exam_patterns = [
        re.compile(
            rf"(?:Date\s+of\s+(?:Online\s+)?(?:Preliminary|Mains?|Written|CBT|Competitive|Recruitment)?\s*Examination|Commencement\s+of\s+(?:the\s+)?Examination|Tentative\s+Date\s+of\s+(?:Online\s+)?(?:Examination|Test)|Online\s+Examination\s*[–:-]?\s*(?:Preliminary|Phase\s*-?\s*I|Tier\s*-?\s*I)?|Exam\s+Date)[^0-9A-Za-z]{{0,45}}({DATE_TOKEN})",
            re.I,
        ),
        re.compile(
            rf"(?:Preliminary\s+Examination|Phase\s*-?\s*I\s+(?:Online\s+)?Exam(?:ination)?|Tier\s*-?\s*I\s+Exam(?:ination)?|Written\s+Test)[^0-9A-Za-z]{{0,45}}({DATE_TOKEN})",
            re.I,
        ),
    ]
    for pat in exam_patterns:
        em = pat.search(text)
        if em:
            iso = normalize_human_date(em.group(1))
            if iso:
                result["exam_date"] = iso
                break

    if not result["exam_date"]:
        my_re = re.compile(
            r"(?:Date\s+of\s+(?:Online\s+)?Examination|Online\s+Examination\s*[–:-]\s*(?:Preliminary|Main)|Commencement\s+of\s+Examination)[^0-9A-Za-z]{0,25}((?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s*/\s*(?:January|February|March|April|May|June|July|August|September|October|November|December))?,?\s+\d{4})",
            re.I,
        )
        my_m = my_re.search(text)
        if my_m:
            cleaned_m = clean_text(my_m.group(1))
            if cleaned_m:
                result["exam_date"] = re.sub(r",\s*", " ", cleaned_m)

    admit_re = re.compile(
        rf"(?:Download\s+of\s+)?(?:Call\s+Letters?|Admit\s+Card|Hall\s+Ticket|e-Admit\s+Card)[^0-9A-Za-z]{{0,40}}({DATE_TOKEN})",
        re.I,
    )
    admit_m = admit_re.search(text)
    if admit_m:
        result["admit_card_date"] = normalize_human_date(admit_m.group(1))

    result_re = re.compile(
        rf"(?:Declaration|Publication)\s+of\s+(?:Preliminary|Main|Final|Written\s+)?Result[^0-9A-Za-z]{{0,40}}({DATE_TOKEN})",
        re.I,
    )
    result_m = result_re.search(text)
    if result_m:
        result["result_date"] = normalize_human_date(result_m.group(1))

    vac_m = (
        re.search(r"\bTotal\s+(?:Tentative\s+|Number\s+of\s+)?Vacancies\s*[:\-–]?\s*(\d{1,6})\b", text, re.I)
        or re.search(r"\bNumber\s+of\s+(?:Vacancies|Posts?)\s*[:\-–]?\s*0*(\d{1,6})\b", text, re.I)
        or re.search(r"\bVacancies\s*[:\-–]\s*0*(\d{1,6})\b", text, re.I)
    )
    if vac_m:
        num = int(vac_m.group(1))
        if 1 <= num <= 500000:
            result["vacancy_count"] = str(num)

    head_slice = text[:14000]
    qual_patterns: List[Tuple[str, str]] = [
        (r"\b(?:M\.?B\.?B\.?S\.?|Bachelor of Medicine)\b", "MBBS"),
        (r"\b(?:B\.E\.?|B\.Tech\.?|B\.?\s*Tech)\b|\b(?:Bachelor of Engineering|Bachelor of Technology)\b", "B.E. / B.Tech"),
        (r"\b(?:Post\s+Graduate|Master['’]?s?\s+Degree|M\.?\s*Sc|M\.?\s*A\.?|M\.?\s*Tech|MCA|MBA)\b", "Post Graduate"),
        (r"\b(?:Graduation|Graduate|Bachelor['’]?s?\s+Degree|Degree\s+(?:of|from)\s+a\s+recognized\s+University)\b", "Graduate"),
        (r"\b(?:Diploma\s+in\s+[A-Za-z ]+|ITI\s+Certificate)\b", "Diploma / ITI"),
        (r"\b(?:12th\s+Standard|Higher\s+Secondary|10\+2|Intermediate)\b", "12th Pass"),
        (r"\b(?:10th\s+Standard|Matriculation|SSLC|Secondary\s+School)\b", "10th Pass"),
    ]
    for pat, label in qual_patterns:
        if re.search(pat, head_slice, re.I):
            result["qualification"] = label
            break

    return result


def fetch_official_pdf_buffer(
    pdf_url: str,
    referer_url: Optional[str] = None,
    max_bytes: int = 25_000_000,
    timeout: float = 12.0,
    retries: int = 1,
) -> Optional[Tuple[bytes, str]]:
    if not pdf_url or not is_public_http_url(pdf_url):
        return None

    candidates = (
        [re.sub(r"^http://", "https://", pdf_url, flags=re.I), pdf_url]
        if pdf_url.lower().startswith("http://")
        else [pdf_url]
    )

    for candidate in candidates:
        try:
            p = urlparse(candidate)
            pdf_origin = f"{p.scheme}://{p.netloc}"
            ref_origin = None
            if referer_url and is_public_http_url(referer_url):
                rp = urlparse(referer_url)
                ref_origin = f"{rp.scheme}://{rp.netloc}"
            origin_referer = referer_url if (ref_origin == pdf_origin and referer_url) else f"{pdf_origin}/"

            resp = fetch_with_retry(
                candidate,
                timeout=timeout,
                retries=retries,
                headers={
                    "Accept": "application/pdf,application/octet-stream,*/*;q=0.8",
                    "Referer": origin_referer,
                },
            )
            if resp.status_code in (401, 403):
                resp = fetch_with_retry(
                    candidate,
                    timeout=min(timeout, 10.0),
                    retries=0,
                    headers={"User-Agent": BROWSER_UA, "Accept": "*/*"},
                )
            if resp.status_code != 200:
                continue

            content_len = int(resp.headers.get("content-length") or 0)
            if content_len > max_bytes:
                continue

            data = resp.content
            if len(data) < 100 or len(data) > max_bytes:
                continue

            ct = (resp.headers.get("content-type") or "").lower()
            is_pdf_magic = b"%PDF" in data[:16]
            if not is_pdf_magic and "application/pdf" not in ct:
                continue
            return data, (resp.url or candidate)
        except Exception:
            continue
    return None


def discover_pdf_url_from_html_page(page_url: str, timeout: float = 8.0) -> Optional[str]:
    if not page_url or not is_public_http_url(page_url):
        return None
    if re.search(r"\.pdf(?:$|\?)", page_url, re.I):
        return page_url
    try:
        p = urlparse(page_url)
        resp = fetch_with_retry(
            page_url,
            timeout=timeout,
            retries=1,
            headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Referer": f"{p.scheme}://{p.netloc}/",
            },
        )
        if resp.status_code != 200:
            return None
        ct = (resp.headers.get("content-type") or "").lower()
        if "application/pdf" in ct:
            return resp.url or page_url

        html = resp.text
        soup = BeautifulSoup(html, "lxml")
        candidates: List[str] = []
        for el in soup.select('a[href*=".pdf"], a[href*=".PDF"]'):
            resolved = resolve_url(page_url, el.get("href"))
            if resolved and is_public_http_url(resolved) and not re.search(r"Annual_Recruitment_Calendar|Utkarsh2029|authorised-signatory", resolved, re.I):
                candidates.append(resolved)

        regex_matches = re.findall(
            r"(?:https?://[^\"'\s\\<>]+|/(?:uploads|Document|document|Notifications1|sites/default/files)/[^\"'\s\\<>]+)\.pdf",
            html,
            re.I,
        )
        for m in regex_matches:
            resolved = resolve_url(page_url, m)
            if resolved and is_public_http_url(resolved) and resolved not in candidates:
                candidates.append(resolved)

        if not candidates:
            return None
        return (
            next((u for u in candidates if re.search(r"notif", u, re.I) and re.search(r"engl", u, re.I)), None)
            or next((u for u in candidates if re.search(r"notif|advt|detailed", u, re.I)), None)
            or next((u for u in candidates if re.search(r"engl", u, re.I)), None)
            or candidates[0]
        )
    except Exception:
        return None


def enrich_notification_from_pdf(item: Dict[str, Optional[str]]) -> Dict[str, Optional[str]]:
    pdf_url = item.get("pdf_url")
    if not pdf_url or not is_public_http_url(pdf_url):
        return item
    missing_important = (
        not item.get("exam_date")
        or not item.get("application_deadline")
        or not item.get("application_start_date")
        or not item.get("vacancy_count")
        or not item.get("qualification")
    )
    if not missing_important:
        return item

    try:
        fetched = fetch_official_pdf_buffer(pdf_url, item.get("source_url"), max_bytes=6_000_000, timeout=10.0, retries=1)
        if not fetched:
            return item
        pdf_bytes, _ = fetched
        pdf_text = extract_text_from_pdf_buffer(pdf_bytes)
        if not pdf_text:
            return item

        extracted = extract_structured_fields_from_pdf_text(pdf_text)
        nxt = dict(item)
        for field in (
            "application_start_date",
            "application_deadline",
            "exam_date",
            "admit_card_date",
            "result_date",
            "vacancy_count",
            "qualification",
        ):
            if not nxt.get(field) and extracted.get(field):
                nxt[field] = extracted[field]
        if extracted.get("notification_status") == "cancelled":
            nxt["notification_status"] = "cancelled"
        if not nxt.get("description") and extracted.get("exam_date"):
            nxt["description"] = clean_text(f"Exam Date: {extracted['exam_date']}")
        return nxt
    except Exception:
        return item
