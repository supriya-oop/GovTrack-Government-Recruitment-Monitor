export interface User {
  id: number;
  full_name: string;
  email: string;
  role: 'user' | 'admin';
  target_exams: string | null;
  email_alerts_enabled: boolean;
  is_active: boolean;
  created_at: string;
}

export interface UserPreferences {
  target_organizations: string[];
  target_exams: string[];
  qualification: string;
  job_categories: string[];
  preferred_states: string[];
  alert_priorities: string[];
  saved_only_alerts: boolean;
  email_alerts_enabled: boolean;
  dark_mode: boolean;
  dashboard_page_size: number;
  updated_at: string;
}

export interface RecruitmentNotification {
  id: number;
  source_id: number;
  source_code: string;
  source_name: string;
  freshness_status?: string;
  entity_key: string;
  content_hash: string;
  title: string;
  organization_name: string;
  notification_number: string | null;
  vacancy_count: string | null;
  job_category: string | null;
  qualification: string | null;
  state: string | null;
  application_procedure: string | null;
  application_start_date: string | null;
  application_deadline: string | null;
  exam_date: string | null;
  admit_card_date: string | null;
  result_date: string | null;
  description: string | null;
  pdf_url: string | null;
  source_url: string;
  published_date: string | null;
  lifecycle_status: string;
  is_removed: boolean;
  is_demo_data: boolean;
  first_seen_at: string;
  last_seen_at: string;
  source_updated_at: string | null;
  status_label: string;
  days_to_deadline: number | null;
  days_to_exam: number | null;
  is_saved: boolean;
  match_score?: number;
  match_reasons?: string[];
  notes?: string;
  saved_at?: string;
}

export interface NotificationVersion {
  id: number;
  notification_id: number;
  version_number: number;
  title: string;
  organization_name: string;
  notification_number: string | null;
  vacancy_count: string | null;
  job_category: string | null;
  qualification: string | null;
  state: string | null;
  application_start_date: string | null;
  application_deadline: string | null;
  exam_date: string | null;
  admit_card_date: string | null;
  result_date: string | null;
  description: string | null;
  pdf_url: string | null;
  source_url: string;
  published_date: string | null;
  notification_status: string;
  content_hash: string;
  snapshot: Record<string, string | null>;
  run_id: string | null;
  captured_at: string;
}

export interface FieldDiff {
  field: string;
  old_value: string | null;
  new_value: string | null;
}

export interface ChangeRecord {
  id: number;
  run_id: string;
  source_id: number;
  source_code?: string;
  source_name?: string;
  organization_name?: string;
  notification_id: number | null;
  entity_key: string;
  notification_title: string;
  change_type: 'NEW' | 'UPDATED' | 'REMOVED';
  changed_field: string | null;
  change_label: string | null;
  previous_value: string | null;
  new_value: string | null;
  changed_fields: FieldDiff[];
  before_snapshot: Record<string, string | null> | null;
  after_snapshot: Record<string, string | null> | null;
  source_url: string;
  is_verified: boolean;
  verified_by: string | null;
  detected_at: string;
}

export interface AlertItem {
  id: number;
  change_id: number | null;
  source_id: number;
  source_code?: string;
  organization_name?: string;
  notification_id: number | null;
  title: string;
  message: string;
  alert_type: 'NEW' | 'UPDATED' | 'REMOVED' | 'SOURCE_ERROR';
  priority: 'Critical' | 'High' | 'Normal' | 'Low';
  severity: 'info' | 'warning' | 'critical';
  is_read: boolean;
  is_verified: boolean;
  created_at: string;
}

export interface MonitoringSource {
  id: number;
  code: string;
  name: string;
  organization_name: string;
  base_url: string;
  source_type: string;
  parser_key: string;
  fixture_filename: string;
  scrape_mode: string;
  crawl_interval_minutes: number;
  rate_limit_seconds: number;
  robots_policy: string;
  permission_note: string;
  is_active: boolean;
  is_demo_data: boolean;
  freshness_status: string;
  last_attempted_at: string | null;
  last_successful_at: string | null;
  last_http_status: number | null;
  last_error: string | null;
  last_parsed_count: number;
  last_duplicate_count: number;
  notifications_count: number;
  changes_count: number;
  next_scheduled_at: string;
}

export interface ScrapeRun {
  id: number;
  run_id: string;
  source_id: number;
  source_code?: string;
  source_name?: string;
  trigger_type: string;
  mode_used: string;
  status: string;
  http_status: number | null;
  parsed_count: number;
  new_count: number;
  updated_count: number;
  duplicate_count: number;
  removed_count: number;
  error_count: number;
  duration_ms: number;
  error_message: string | null;
  started_at: string;
  completed_at: string;
}

export interface MonitoringLogItem {
  id: number;
  run_id: string;
  source_id: number;
  source_code?: string;
  source_name?: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
  created_at: string;
}

export interface CalendarEvent {
  id: string;
  notification_id: number;
  title: string;
  organization_name: string;
  source_code: string;
  event_type: 'deadline' | 'exam' | 'admit_card' | 'result';
  event_label: string;
  date: string;
  days_remaining: number;
  is_upcoming: boolean;
  status_label: string;
}

export interface DashboardData {
  stats: {
    total_active_notifications: number;
    new_notifications_discovered: number;
    new_change_events: number;
    total_changes_detected: number;
    upcoming_deadlines_count: number;
    upcoming_exams_count: number;
    unread_alerts_count: number;
    healthy_sources_count: number;
    failed_sources_count: number;
    total_sources_count: number;
    demo_records_count: number;
    live_records_count: number;
  };
  charts: {
    by_organization: { code: string; name: string; organization_name: string; count: number }[];
    trends_over_time: { month: string; count: number }[];
    change_types_distribution: { label: string; change_type: string; count: number }[];
    upcoming_deadlines_timeline: { month: string; count: number; next_date: string }[];
  };
  upcoming_deadlines: RecruitmentNotification[];
  upcoming_examinations: RecruitmentNotification[];
  latest_notifications: RecruitmentNotification[];
  recent_changes: ChangeRecord[];
  sources: MonitoringSource[];
  recommendations: RecruitmentNotification[];
  recent_runs: ScrapeRun[];
}
