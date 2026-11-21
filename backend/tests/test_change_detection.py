import re
import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT_DIR))

from backend.app.diff_core import (  # noqa: E402
    build_entity_key_from_parts,
    classify_field_change,
    compute_content_hash,
    compute_field_diffs,
    get_alert_priority_and_severity,
    merge_preserving_missing_fields,
    normalize_snapshot,
)

FIXTURES_DIR = ROOT_DIR / "backend" / "fixtures"


def extract_upsc_rows_stdlib(html: str) -> list[dict]:
    """Minimal stdlib fallback extractor for environments without bs4/sqlalchemy installed."""
    rows = []
    for tr_match in re.finditer(
        r'<tr class="upsc-row"[^>]*data-category="([^"]*)"(?:\s+data-qualification="([^"]*)")?(?:\s+data-state="([^"]*)")?[^>]*>(.*?)</tr>',
        html,
        re.S,
    ):
        cat, qual, state, body = tr_match.group(1), tr_match.group(2), tr_match.group(3), tr_match.group(4)

        def cell(cls: str):
            m = re.search(rf'<td class="{cls}"[^>]*>(.*?)</td>', body, re.S)
            if not m:
                return None
            text = re.sub(r"<[^>]+>", " ", m.group(1))
            text = re.sub(r"\s+", " ", text).strip()
            return text or None

        title_m = re.search(r'<td class="col-title">.*?<a href="([^"]+)">(.*?)</a>', body, re.S)
        sum_m = re.search(r'<p class="summary">(.*?)</p>', body, re.S)
        pdf_m = re.search(r'<td class="col-pdf"><a href="([^"]+)">', body, re.S)
        rows.append(
            normalize_snapshot(
                {
                    "title": title_m.group(2) if title_m else None,
                    "organization_name": "Union Public Service Commission (UPSC)",
                    "notification_number": cell("col-advt"),
                    "vacancy_count": cell("col-vacancy"),
                    "job_category": cat,
                    "qualification": qual,
                    "state": state or "All India",
                    "application_start_date": cell("col-start"),
                    "application_deadline": cell("col-deadline"),
                    "exam_date": cell("col-exam"),
                    "admit_card_date": cell("col-admit"),
                    "result_date": cell("col-result"),
                    "description": sum_m.group(1) if sum_m else None,
                    "pdf_url": pdf_m.group(1) if pdf_m else None,
                    "source_url": title_m.group(1) if title_m else "https://upsc.gov.in/",
                    "published_date": cell("col-published"),
                }
            )
        )
    return rows


class InMemoryMonitorPipeline:
    """Deterministic change-detection pipeline mirror for reproducible offline unit testing."""

    def __init__(self):
        self.records: dict[str, dict] = {}
        self.versions: dict[str, list[dict]] = {}
        self.changes: list[dict] = []
        self.alerts: list[dict] = []
        self.alert_dedup_keys: set[str] = set()
        self.missing_counts: dict[str, int] = {}

    def _add_alert(self, alert: dict, dedup_key: str) -> None:
        if dedup_key in self.alert_dedup_keys:
            return
        self.alert_dedup_keys.add(dedup_key)
        self.alerts.append(alert)

    def ingest(self, source_code: str, items: list[dict], http_status: int = 200) -> dict:
        counts = {"new": 0, "updated": 0, "duplicate": 0, "removed": 0, "error": 0}
        if http_status >= 400 or len(items) == 0:
            counts["error"] = 1
            return counts

        seen = set()
        for raw in items:
            raw_snap = normalize_snapshot(raw)
            key = build_entity_key_from_parts(source_code, raw_snap["notification_number"], raw_snap["title"])
            if key in seen:
                counts["duplicate"] += 1
                continue
            seen.add(key)
            self.missing_counts[key] = 0

            if key not in self.records:
                new_hash = compute_content_hash(raw_snap)
                self.records[key] = {"hash": new_hash, "snap": raw_snap, "removed": False}
                self.versions[key] = [dict(raw_snap)]
                self.changes.append(
                    {
                        "key": key,
                        "type": "NEW",
                        "changed_field": "title",
                        "change_label": "NEW NOTIFICATION",
                        "previous_value": None,
                        "new_value": raw_snap["title"],
                        "diffs": [{"field": "title", "old_value": None, "new_value": raw_snap["title"]}],
                    }
                )
                self._add_alert({"key": key, "type": "NEW", "priority": "Normal"}, f"NEW::{key}::{new_hash}")
                counts["new"] += 1
            else:
                prev = self.records[key]
                if prev["removed"]:
                    prev["removed"] = False
                snap = merge_preserving_missing_fields(prev["snap"], raw_snap)
                new_hash = compute_content_hash(snap)
                if prev["hash"] == new_hash:
                    counts["duplicate"] += 1
                    continue
                diffs = compute_field_diffs(prev["snap"], snap)
                if not diffs:
                    counts["duplicate"] += 1
                    continue
                self.records[key] = {"hash": new_hash, "snap": snap, "removed": False}
                self.versions[key].append(dict(snap))
                for diff in diffs:
                    label = classify_field_change(diff["field"], diff["old_value"], diff["new_value"])
                    priority, _sev = get_alert_priority_and_severity("UPDATED", diff["field"], diff["new_value"])
                    self.changes.append(
                        {
                            "key": key,
                            "type": "UPDATED",
                            "changed_field": diff["field"],
                            "change_label": label,
                            "previous_value": diff["old_value"],
                            "new_value": diff["new_value"],
                            "diffs": [diff],
                        }
                    )
                    self._add_alert(
                        {
                            "key": key,
                            "type": "UPDATED",
                            "label": label,
                            "priority": priority,
                            "previous_value": diff["old_value"],
                            "new_value": diff["new_value"],
                        },
                        f"UPD::{key}::{diff['field']}::{diff['old_value'] or ''}::{diff['new_value'] or ''}",
                    )
                counts["updated"] += 1

        for key, rec in self.records.items():
            if key not in seen and not rec["removed"]:
                self.missing_counts[key] = self.missing_counts.get(key, 0) + 1
                if self.missing_counts[key] >= 2:
                    rec["removed"] = True
                    self.changes.append(
                        {
                            "key": key,
                            "type": "REMOVED",
                            "changed_field": "notification_status",
                            "change_label": "VERIFIED REMOVAL",
                            "previous_value": "active",
                            "new_value": "removed",
                            "diffs": [{"field": "notification_status", "old_value": "active", "new_value": "removed"}],
                        }
                    )
                    self._add_alert({"key": key, "type": "REMOVED", "priority": "Critical"}, f"REM::{key}")
                    counts["removed"] += 1
        return counts


class TestChangeDetectionSuite(unittest.TestCase):
    """22 labelled change-detection, priority classification, provenance, and failure-safety tests."""

    def test_01_new_notification_detection(self):
        pipeline = InMemoryMonitorPipeline()
        rows = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc.html").read_text(encoding="utf-8"))
        res = pipeline.ingest("upsc", rows)
        self.assertEqual(res["new"], 3)
        self.assertEqual(res["updated"], 0)
        self.assertEqual(len(pipeline.alerts), 3)

    def test_02_exact_rerun_duplicate_suppression(self):
        pipeline = InMemoryMonitorPipeline()
        rows = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc.html").read_text(encoding="utf-8"))
        pipeline.ingest("upsc", rows)
        res2 = pipeline.ingest("upsc", rows)
        self.assertEqual(res2["new"], 0)
        self.assertEqual(res2["updated"], 0)
        self.assertEqual(res2["duplicate"], 3)
        self.assertEqual(len(pipeline.alerts), 3)

    def test_03_formatting_only_html_edit_causes_zero_false_alerts(self):
        pipeline = InMemoryMonitorPipeline()
        v1 = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc.html").read_text(encoding="utf-8"))
        fmt = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc_format_only.html").read_text(encoding="utf-8"))
        pipeline.ingest("upsc", v1)
        res = pipeline.ingest("upsc", fmt)
        self.assertEqual(res["updated"], 0)
        self.assertEqual(res["duplicate"], 3)
        self.assertEqual(len(pipeline.alerts), 3)

    def test_04_deadline_extension_exam_shift_and_vacancy_diff(self):
        pipeline = InMemoryMonitorPipeline()
        v1 = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc.html").read_text(encoding="utf-8"))
        v2 = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc_v2_updated.html").read_text(encoding="utf-8"))
        pipeline.ingest("upsc", v1)
        res = pipeline.ingest("upsc", v2)
        self.assertEqual(res["new"], 1)  # 07/2026-CMS added
        self.assertEqual(res["updated"], 1)  # 05/2026-CSP updated
        updated_events = [c for c in pipeline.changes if c["type"] == "UPDATED"]
        by_field = {c["changed_field"]: c for c in updated_events}
        self.assertEqual(by_field["application_deadline"]["change_label"], "APPLICATION DEADLINE EXTENDED")
        self.assertEqual(by_field["application_deadline"]["previous_value"], "2026-11-26")
        self.assertEqual(by_field["application_deadline"]["new_value"], "2026-12-05")
        self.assertEqual(by_field["exam_date"]["change_label"], "EXAM DATE CHANGED")
        self.assertEqual(by_field["exam_date"]["previous_value"], "2027-01-24")
        self.assertEqual(by_field["exam_date"]["new_value"], "2027-02-07")
        self.assertEqual(by_field["vacancy_count"]["change_label"], "VACANCY CHANGED")
        self.assertEqual(by_field["vacancy_count"]["previous_value"], "1056")
        self.assertEqual(by_field["vacancy_count"]["new_value"], "1105")

    def test_05_http_404_never_deletes_existing_notifications(self):
        pipeline = InMemoryMonitorPipeline()
        v1 = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc.html").read_text(encoding="utf-8"))
        pipeline.ingest("upsc", v1)
        res_404 = pipeline.ingest("upsc", [], http_status=404)
        self.assertEqual(res_404["error"], 1)
        self.assertEqual(res_404["removed"], 0)
        self.assertTrue(all(not rec["removed"] for rec in pipeline.records.values()))

    def test_06_http_404_followed_by_restored_page_no_false_change(self):
        pipeline = InMemoryMonitorPipeline()
        v1 = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc.html").read_text(encoding="utf-8"))
        pipeline.ingest("upsc", v1)
        pipeline.ingest("upsc", [], http_status=404)
        res_restored = pipeline.ingest("upsc", v1, http_status=200)
        self.assertEqual((res_restored["new"], res_restored["updated"], res_restored["removed"], res_restored["duplicate"]), (0, 0, 0, 3))

    def test_07_http_429_rate_limit_preserves_state(self):
        pipeline = InMemoryMonitorPipeline()
        v1 = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc.html").read_text(encoding="utf-8"))
        pipeline.ingest("upsc", v1)
        res_429 = pipeline.ingest("upsc", [], http_status=429)
        self.assertEqual(res_429["error"], 1)
        self.assertEqual(len(pipeline.records), 3)

    def test_08_zero_result_parse_failure_guard(self):
        pipeline = InMemoryMonitorPipeline()
        v1 = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc.html").read_text(encoding="utf-8"))
        pipeline.ingest("upsc", v1)
        broken_html = (FIXTURES_DIR / "upsc_404_error.html").read_text(encoding="utf-8")
        parsed_broken = extract_upsc_rows_stdlib(broken_html)
        self.assertEqual(len(parsed_broken), 0)
        res = pipeline.ingest("upsc", parsed_broken, http_status=200)
        self.assertEqual(res["error"], 1)
        self.assertEqual(res["removed"], 0)

    def test_09_in_batch_duplicate_rows_suppressed(self):
        pipeline = InMemoryMonitorPipeline()
        rows = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc.html").read_text(encoding="utf-8"))
        res = pipeline.ingest("upsc", rows + [rows[0]])
        self.assertEqual(res["new"], 3)
        self.assertEqual(res["duplicate"], 1)

    def test_10_missing_fields_stay_none_never_invented(self):
        rows = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc.html").read_text(encoding="utf-8"))
        csp = rows[0]
        self.assertIsNone(csp["admit_card_date"])
        self.assertIsNone(csp["result_date"])

    def test_11_safe_removal_requires_consecutive_healthy_parses(self):
        pipeline = InMemoryMonitorPipeline()
        rows = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc.html").read_text(encoding="utf-8"))
        pipeline.ingest("upsc", rows)
        subset = rows[:2]
        res1 = pipeline.ingest("upsc", subset)
        self.assertEqual(res1["removed"], 0)
        res2 = pipeline.ingest("upsc", subset)
        self.assertEqual(res2["removed"], 1)

    def test_12_pdf_link_update_detected_with_before_after(self):
        pipeline = InMemoryMonitorPipeline()
        v1 = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc.html").read_text(encoding="utf-8"))
        v2 = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc_v2_updated.html").read_text(encoding="utf-8"))
        pipeline.ingest("upsc", v1)
        pipeline.ingest("upsc", v2)
        pdf_events = [c for c in pipeline.changes if c["type"] == "UPDATED" and c["changed_field"] == "pdf_url"]
        self.assertEqual(len(pdf_events), 1)
        self.assertIsNone(pdf_events[0]["previous_value"])
        self.assertIn("upsc.gov.in/active-examinations", pdf_events[0]["new_value"])

    def test_13_entity_key_falls_back_to_title_when_number_missing(self):
        key = build_entity_key_from_parts("nta", None, "UGC NET December 2026 Examination")
        self.assertEqual(key, "nta::ugc-net-december-2026-examination")

    def test_14_all_13_portal_offline_fixtures_exist_and_non_empty(self):
        expected = [
            "upsc.html", "ssc.html", "ibps.html", "sbi.html", "rrbcdg.html",
            "employmentnews.html", "nta.html", "tnpsc.html", "keralapsc.html",
            "rpsc.html", "tnusrb.html", "rbi.html", "indiapost.html",
        ]
        for fname in expected:
            fpath = FIXTURES_DIR / fname
            self.assertTrue(fpath.exists(), f"Missing fixture: {fname}")
            self.assertGreater(len(fpath.read_text(encoding="utf-8")), 200)

    def test_15_three_cycle_timestamped_refresh_consistency(self):
        pipeline = InMemoryMonitorPipeline()
        v1 = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc.html").read_text(encoding="utf-8"))
        v2 = extract_upsc_rows_stdlib((FIXTURES_DIR / "upsc_v2_updated.html").read_text(encoding="utf-8"))
        r1 = pipeline.ingest("upsc", v1)
        r2 = pipeline.ingest("upsc", v2)
        r3 = pipeline.ingest("upsc", v2)
        self.assertEqual((r1["new"], r1["updated"], r1["duplicate"]), (3, 0, 0))
        self.assertEqual((r2["new"], r2["updated"], r2["duplicate"]), (1, 1, 2))
        self.assertEqual((r3["new"], r3["updated"], r3["duplicate"]), (0, 0, 4))

    def test_16_exam_date_change_creates_critical_priority_alert(self):
        pipeline = InMemoryMonitorPipeline()
        base = {
            "title": "IBPS – CRP Recruitment",
            "organization_name": "IBPS",
            "notification_number": "CRP-PO-XVI",
            "exam_date": "2026-12-10",
            "source_url": "https://www.ibps.in/",
        }
        updated = dict(base, exam_date="2026-12-25")
        pipeline.ingest("ibps", [base])
        res = pipeline.ingest("ibps", [updated])
        self.assertEqual(res["updated"], 1)
        exam_alerts = [a for a in pipeline.alerts if a.get("label") == "EXAM DATE CHANGED"]
        self.assertEqual(len(exam_alerts), 1)
        self.assertEqual(exam_alerts[0]["priority"], "Critical")

    def test_17_multi_field_update_creates_separate_change_records_per_field(self):
        pipeline = InMemoryMonitorPipeline()
        v1 = {
            "title": "IBPS – CRP Recruitment",
            "organization_name": "IBPS",
            "notification_number": "CRP-CLERK-XVI",
            "application_deadline": "2026-11-28",
            "exam_date": "2026-12-10",
            "vacancy_count": "6128",
            "qualification": "Graduate",
            "source_url": "https://www.ibps.in/",
        }
        v2 = dict(
            v1,
            exam_date="2026-12-25",
            application_deadline="2026-12-12",
            vacancy_count="6500",
            qualification="Graduate + Computer Literacy",
        )
        pipeline.ingest("ibps", [v1])
        pipeline.ingest("ibps", [v2])
        updated = [c for c in pipeline.changes if c["type"] == "UPDATED"]
        self.assertEqual(len(updated), 4)
        labels = {c["changed_field"]: c["change_label"] for c in updated}
        self.assertEqual(labels["exam_date"], "EXAM DATE CHANGED")
        self.assertEqual(labels["application_deadline"], "APPLICATION DEADLINE EXTENDED")
        self.assertEqual(labels["vacancy_count"], "VACANCY CHANGED")
        self.assertEqual(labels["qualification"], "QUALIFICATION CHANGED")

    def test_18_missing_exam_date_on_partial_scrape_never_deletes_existing_exam_date(self):
        pipeline = InMemoryMonitorPipeline()
        v1 = {
            "title": "IBPS – CRP Recruitment",
            "organization_name": "IBPS",
            "notification_number": "CRP-RRB-XV",
            "exam_date": "2026-12-10",
            "source_url": "https://www.ibps.in/",
        }
        partial = dict(v1, exam_date=None)
        pipeline.ingest("ibps", [v1])
        res = pipeline.ingest("ibps", [partial])
        self.assertEqual(res["updated"], 0)
        self.assertEqual(res["duplicate"], 1)
        self.assertEqual(pipeline.records["ibps::crp-rrb-xv"]["snap"]["exam_date"], "2026-12-10")

    def test_19_version_history_preserves_previous_snapshots(self):
        pipeline = InMemoryMonitorPipeline()
        v1 = {
            "title": "IBPS – CRP Recruitment",
            "organization_name": "IBPS",
            "notification_number": "CRP-SO-XVI",
            "exam_date": "2026-12-10",
            "source_url": "https://www.ibps.in/",
        }
        v2 = dict(v1, exam_date="2026-12-25")
        pipeline.ingest("ibps", [v1])
        pipeline.ingest("ibps", [v2])
        versions = pipeline.versions["ibps::crp-so-xvi"]
        self.assertEqual(len(versions), 2)
        self.assertEqual(versions[0]["exam_date"], "2026-12-10")
        self.assertEqual(versions[1]["exam_date"], "2026-12-25")

    def test_20_notification_cancellation_detected(self):
        pipeline = InMemoryMonitorPipeline()
        v1 = {
            "title": "SSC Special Recruitment Notification",
            "organization_name": "SSC",
            "notification_number": "SSC-SP-2026",
            "exam_date": "2026-12-12",
            "source_url": "https://ssc.gov.in/",
        }
        v2 = dict(v1, notification_status="cancelled")
        pipeline.ingest("ssc", [v1])
        pipeline.ingest("ssc", [v2])
        cancel_events = [c for c in pipeline.changes if c["change_label"] == "NOTIFICATION CANCELLED"]
        self.assertEqual(len(cancel_events), 1)
        self.assertEqual(cancel_events[0]["previous_value"], "active")
        self.assertEqual(cancel_events[0]["new_value"], "cancelled")

    def test_21_alert_priority_classification(self):
        self.assertEqual(get_alert_priority_and_severity("UPDATED", "exam_date", "2027-01-10")[0], "Critical")
        self.assertEqual(get_alert_priority_and_severity("UPDATED", "application_deadline", "2027-01-10")[0], "Critical")
        self.assertEqual(get_alert_priority_and_severity("UPDATED", "admit_card_date", "2026-12-01")[0], "High")
        self.assertEqual(get_alert_priority_and_severity("UPDATED", "result_date", "2026-12-20")[0], "High")
        self.assertEqual(get_alert_priority_and_severity("NEW", "title", "New Job")[0], "Normal")
        self.assertEqual(get_alert_priority_and_severity("UPDATED", "description", "Minor wording")[0], "Low")

    def test_22_duplicate_alert_prevention(self):
        pipeline = InMemoryMonitorPipeline()
        item = {
            "title": "RBI Grade B Officer",
            "organization_name": "RBI",
            "notification_number": "RBI-GB-2026",
            "exam_date": "2026-12-15",
            "source_url": "https://opportunities.rbi.org.in/",
        }
        pipeline.ingest("rbi", [item])
        pipeline.ingest("rbi", [dict(item, exam_date="2026-12-30")])
        pipeline.ingest("rbi", [dict(item, exam_date="2026-12-15")])
        pipeline.ingest("rbi", [dict(item, exam_date="2026-12-30")])
        # Duplicate transition 2026-12-15 -> 2026-12-30 must not create duplicate alert
        matching = [a for a in pipeline.alerts if a.get("previous_value") == "2026-12-15" and a.get("new_value") == "2026-12-30"]
        self.assertEqual(len(matching), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
