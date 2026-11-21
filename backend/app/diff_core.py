import hashlib
import json
import re
from typing import Dict, List, Optional, Tuple

TRACKED_FIELDS = [
    "title",
    "organization_name",
    "notification_number",
    "vacancy_count",
    "job_category",
    "qualification",
    "state",
    "application_start_date",
    "application_deadline",
    "exam_date",
    "admit_card_date",
    "result_date",
    "description",
    "pdf_url",
    "source_url",
    "published_date",
    "notification_status",
]

PRESERVABLE_FIELDS = (
    "notification_number",
    "vacancy_count",
    "job_category",
    "qualification",
    "state",
    "application_start_date",
    "application_deadline",
    "exam_date",
    "admit_card_date",
    "result_date",
    "description",
    "pdf_url",
    "published_date",
)

IMPORTANT_ALERT_FIELDS = {
    "exam_date",
    "application_deadline",
    "application_start_date",
    "admit_card_date",
    "result_date",
    "vacancy_count",
    "qualification",
    "notification_status",
    "title",
    "notification_number",
    "published_date",
    "pdf_url",
    "source_url",
    "description",
}


def normalize_str(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    cleaned = re.sub(r"\s+", " ", str(value)).strip()
    return cleaned if cleaned else None


def resolve_notification_status(raw_status: Optional[str], title: Optional[str], description: Optional[str]) -> str:
    status_norm = (normalize_str(raw_status) or "").lower()
    if status_norm in ("cancelled", "canceled", "withdrawn"):
        return "cancelled"
    if status_norm == "removed":
        return "removed"
    combined = f"{title or ''} {description or ''}"
    if re.search(r"\b(?:cancelled|canceled|withdrawn|annulled)\b", combined, re.I):
        return "cancelled"
    return "active"


def build_entity_key_from_parts(
    source_code: str,
    notification_number: Optional[str],
    title: Optional[str],
) -> str:
    notif_no = normalize_str(notification_number)
    if notif_no:
        slug = re.sub(r"[^a-z0-9]+", "-", notif_no.lower()).strip("-")
        return f"{source_code}::{slug}"
    title_norm = re.sub(r"[^a-z0-9]+", "-", (normalize_str(title) or "untitled").lower()).strip("-")
    return f"{source_code}::{title_norm[:120]}"


def normalize_snapshot(raw: Dict[str, Optional[str]]) -> Dict[str, Optional[str]]:
    snap: Dict[str, Optional[str]] = {}
    for field in TRACKED_FIELDS:
        if field == "notification_status":
            snap[field] = resolve_notification_status(
                raw.get("notification_status") or raw.get("lifecycle_status"),
                raw.get("title"),
                raw.get("description"),
            )
        else:
            snap[field] = normalize_str(raw.get(field))
    return snap


def merge_preserving_missing_fields(
    old_snap: Dict[str, Optional[str]],
    new_snap: Dict[str, Optional[str]],
) -> Dict[str, Optional[str]]:
    merged = dict(new_snap)
    if merged.get("notification_status") == "cancelled":
        return merged
    for field in PRESERVABLE_FIELDS:
        if merged.get(field) is None and old_snap.get(field) is not None:
            merged[field] = old_snap[field]
    return merged


def compute_content_hash(snapshot: Dict[str, Optional[str]]) -> str:
    canonical = json.dumps(snapshot, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def compute_field_diffs(
    old_snap: Dict[str, Optional[str]],
    new_snap: Dict[str, Optional[str]],
) -> List[Dict[str, Optional[str]]]:
    diffs: List[Dict[str, Optional[str]]] = []
    for field in TRACKED_FIELDS:
        old_val = old_snap.get(field)
        new_val = new_snap.get(field)
        if old_val != new_val:
            diffs.append({"field": field, "old_value": old_val, "new_value": new_val})
    return diffs


def classify_field_change(field: str, old_val: Optional[str], new_val: Optional[str]) -> str:
    if field == "exam_date":
        return "EXAM DATE CHANGED"
    if field == "application_deadline":
        if old_val and new_val and re.match(r"^\d{4}-\d{2}-\d{2}$", old_val) and re.match(r"^\d{4}-\d{2}-\d{2}$", new_val):
            if new_val > old_val:
                return "APPLICATION DEADLINE EXTENDED"
        return "APPLICATION DEADLINE CHANGED"
    if field == "application_start_date":
        return "APPLICATION START CHANGED"
    if field == "admit_card_date":
        return "ADMIT CARD UPDATE"
    if field == "result_date":
        return "RESULT UPDATE"
    if field == "vacancy_count":
        return "VACANCY CHANGED"
    if field == "qualification":
        return "QUALIFICATION CHANGED"
    if field in ("notification_status", "lifecycle_status"):
        if new_val == "cancelled":
            return "NOTIFICATION CANCELLED"
        if new_val == "removed":
            return "VERIFIED REMOVAL"
        return "NOTIFICATION DETAILS UPDATED"
    if field == "pdf_url":
        return "OFFICIAL PDF UPDATED"
    return "NOTIFICATION DETAILS UPDATED"


def get_alert_priority_and_severity(
    change_type: str,
    field: str,
    new_val: Optional[str],
) -> Tuple[str, str]:
    if change_type == "REMOVED" or new_val == "cancelled" or field in ("exam_date", "application_deadline"):
        return ("Critical", "critical")
    if field in ("admit_card_date", "result_date"):
        return ("High", "warning")
    if change_type == "NEW" or field in ("vacancy_count", "application_start_date"):
        return ("Normal", "info")
    return ("Low", "info")
