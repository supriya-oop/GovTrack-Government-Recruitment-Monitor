# GovTrack Data Dictionary

| Table | Purpose | Key Columns |
| --- | --- | --- |
| `users` | Registered aspirants & administrators | `id`, `full_name`, `email`, `password_hash`, `role`, `is_active` |
| `user_preferences` | Aspirant targeting & alert settings | `user_id`, `target_organizations`, `target_exams`, `qualification`, `job_categories`, `preferred_states`, `alert_priorities`, `dark_mode` |
| `categories` | Managed recruitment categories | `id`, `name`, `description` |
| `monitoring_sources` | Official portal definitions & health | `code`, `name`, `organization_name`, `base_url`, `source_type`, `scrape_mode`, `freshness_status`, `last_attempted_at`, `last_successful_at` |
| `recruitment_notifications` | Current canonical recruitment records | `source_id`, `entity_key`, `content_hash`, `title`, `notification_number`, `vacancy_count`, `qualification`, `state`, `application_start_date`, `application_deadline`, `exam_date`, `admit_card_date`, `result_date`, `pdf_url`, `lifecycle_status`, `is_removed`, `is_demo_data` |
| `notification_versions` | Immutable snapshot history per change | `notification_id`, `version_number`, `snapshot_json`, `content_hash`, `run_id`, `captured_at` |
| `change_history` | Field-level detected change audit log | `run_id`, `source_id`, `notification_id`, `change_type`, `changed_field`, `change_label`, `previous_value`, `new_value`, `is_verified`, `detected_at` |
| `alerts` | Prioritized deduplicated user alerts | `change_id`, `source_id`, `notification_id`, `title`, `message`, `alert_type`, `priority`, `severity`, `dedup_key`, `is_read` |
| `saved_notifications` | Per-user bookmarked recruitments & notes | `user_id`, `notification_id`, `notes`, `saved_at` |
| `scrape_runs` | Execution metrics for every monitoring check | `run_id`, `source_id`, `trigger_type`, `mode_used`, `status`, `http_status`, `parsed_count`, `new_count`, `updated_count`, `duplicate_count`, `removed_count`, `duration_ms` |
| `monitoring_logs` | Timestamped execution logs per source & run | `run_id`, `source_id`, `level`, `message`, `created_at` |
