import re
from typing import Dict, List, Optional
from urllib.parse import urljoin

MONTHS: Dict[str, str] = {
    "jan": "01",
    "january": "01",
    "feb": "02",
    "february": "02",
    "mar": "03",
    "march": "03",
    "apr": "04",
    "april": "04",
    "may": "05",
    "jun": "06",
    "june": "06",
    "jul": "07",
    "july": "07",
    "aug": "08",
    "august": "08",
    "sep": "09",
    "sept": "09",
    "september": "09",
    "oct": "10",
    "october": "10",
    "nov": "11",
    "november": "11",
    "dec": "12",
    "december": "12",
}


def clean_text(val: Optional[str]) -> Optional[str]:
    if not val:
        return None
    cleaned = re.sub(r"\s+", " ", str(val)).strip()
    return cleaned if cleaned else None


def resolve_url(base_url: str, href: Optional[str]) -> Optional[str]:
    if not href:
        return None
    trimmed = href.strip()
    if not trimmed or trimmed.startswith("#") or trimmed.lower().startswith("javascript:"):
        return None
    try:
        return urljoin(base_url, trimmed)
    except Exception:
        return None


def text_or_none(node) -> Optional[str]:
    return clean_text(node.get_text(" ", strip=True)) if node is not None else None


def is_public_http_url(url: Optional[str]) -> bool:
    if not url:
        return False
    return bool(re.match(r"^https?://(?!10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)", url, re.I))


def normalize_human_date(raw: Optional[str]) -> Optional[str]:
    cleaned = clean_text(raw)
    if not cleaned or re.match(r"^(?:-+|—+|n/?a|nil|tba|not\s+applicable)$", cleaned, re.I):
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}$", cleaned):
        return cleaned

    compact = re.search(r"(?:^|_)(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:\d{6})?(?:\.pdf|$)", cleaned, re.I)
    if compact:
        return f"{compact.group(1)}-{compact.group(2)}-{compact.group(3)}"

    dmy = re.search(r"(\d{1,2})[./-](\d{1,2})[./-](\d{4})", cleaned)
    if dmy:
        day = int(dmy.group(1))
        mon = int(dmy.group(2))
        if 1 <= day <= 31 and 1 <= mon <= 12:
            return f"{dmy.group(3)}-{mon:02d}-{day:02d}"

    d_mon_y = re.search(r"(\d{1,2})(?:st|nd|rd|th)?[-/\s]+([A-Za-z]{3,9}),?[-/\s]+(\d{4})", cleaned)
    if d_mon_y:
        mon_key = d_mon_y.group(2).lower()
        mon = MONTHS.get(mon_key) or MONTHS.get(mon_key[:3])
        if mon:
            return f"{d_mon_y.group(3)}-{mon}-{int(d_mon_y.group(1)):02d}"

    mon_d_y = re.search(r"\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\b", cleaned)
    if mon_d_y:
        mon_key = mon_d_y.group(1).lower()
        mon = MONTHS.get(mon_key) or MONTHS.get(mon_key[:3])
        if mon:
            return f"{mon_d_y.group(3)}-{mon}-{int(mon_d_y.group(2)):02d}"

    return None


def normalize_us_date(raw: Optional[str]) -> Optional[str]:
    cleaned = clean_text(raw)
    if not cleaned:
        return None
    mdy = re.search(r"(\d{1,2})[./-](\d{1,2})[./-](\d{4})", cleaned)
    if mdy:
        mon = int(mdy.group(1))
        day = int(mdy.group(2))
        if 1 <= mon <= 12 and 1 <= day <= 31:
            return f"{mdy.group(3)}-{mon:02d}-{day:02d}"
    return normalize_human_date(raw)


class BasePortalParser:
    parser_key = "base"
    organization_name = "Government Organization"

    def parse(self, html: str, source_url: str) -> List[Dict[str, Optional[str]]]:
        raise NotImplementedError
