import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  FileText,
  Sparkles,
  GitCompareArrows,
  Clock,
  GraduationCap,
  Bell,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { apiRequest } from '../api/client.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useToast } from '../context/ToastContext.tsx';
import type { DashboardData } from '../types.ts';
import {
  ChangeTypesDistributionChart,
  NotificationsByOrgChart,
  RecruitmentTrendsChart,
  UpcomingDeadlinesTimelineChart,
} from '../components/Charts.tsx';
import { SkeletonCard, SkeletonKpiGrid } from '../components/LoadingSkeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';

export function DashboardPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<DashboardData>('/dashboard');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDashboard();
  }, [user?.id]);

  if (loading) {
    return (
      <div className="space-y-6">
        <SkeletonKpiGrid count={8} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-rose-200 dark:border-rose-800 bg-white dark:bg-slate-900 p-8 text-center">
        <p className="text-sm font-semibold text-rose-700 dark:text-rose-300 mb-3">{error || 'Unable to load dashboard'}</p>
        <button
          type="button"
          onClick={loadDashboard}
          className="px-4 py-2 rounded-lg bg-blue-700 text-white text-xs font-semibold"
        >
          Retry
        </button>
      </div>
    );
  }

  const s = data.stats;

  const kpiCards = [
    {
      label: 'Active Notifications',
      value: s.total_active_notifications,
      sub: `${s.live_records_count} live official records`,
      icon: FileText,
      to: '/notifications?status_filter=active',
      accent: 'text-blue-700 dark:text-blue-400',
    },
    {
      label: 'New Discovered',
      value: s.new_notifications_discovered,
      sub: 'Recent live discoveries',
      icon: Sparkles,
      to: '/notifications?sort=newest',
      accent: 'text-indigo-700 dark:text-indigo-400',
    },
    {
      label: 'Changes Detected',
      value: s.total_changes_detected,
      sub: 'Verified snapshot diffs',
      icon: GitCompareArrows,
      to: '/changes',
      accent: 'text-amber-700 dark:text-amber-400',
    },
    {
      label: 'Upcoming Deadlines',
      value: s.upcoming_deadlines_count,
      sub: 'Open application windows',
      icon: Clock,
      to: '/notifications?sort=deadline&status_filter=open',
      accent: 'text-emerald-700 dark:text-emerald-400',
    },
    {
      label: 'Upcoming Exams',
      value: s.upcoming_exams_count,
      sub: 'Scheduled test dates',
      icon: GraduationCap,
      to: '/notifications?sort=exam_date&status_filter=upcoming_exam',
      accent: 'text-blue-700 dark:text-blue-400',
    },
    {
      label: 'Unread Alerts',
      value: s.unread_alerts_count,
      sub: 'Prioritized change notices',
      icon: Bell,
      to: '/alerts?unread_only=true',
      accent: 'text-rose-700 dark:text-rose-400',
    },
    {
      label: 'Healthy Sources',
      value: s.healthy_sources_count,
      sub: `of ${s.total_sources_count} monitored portals`,
      icon: CheckCircle2,
      to: '/sources',
      accent: 'text-emerald-700 dark:text-emerald-400',
    },
    {
      label: 'Failed Sources',
      value: s.failed_sources_count,
      sub: 'Protected against stale data',
      icon: AlertTriangle,
      to: '/sources',
      accent: s.failed_sources_count > 0 ? 'text-rose-700 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Recruitment Monitoring Dashboard
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Real-time database overview across {s.total_sources_count} official recruitment portals.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={loadDashboard}
            className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* 8 KPI Cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {kpiCards.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.label}
              type="button"
              onClick={() => navigate(card.to)}
              className="text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-xs transition-all group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">{card.label}</span>
                <Icon className={`w-4 h-4 ${card.accent}`} />
              </div>
              <div className="text-2xl font-bold tabular-nums text-slate-900 dark:text-white">
                {card.value}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 flex items-center justify-between">
                <span>{card.sub}</span>
                <ArrowRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity text-blue-600" />
              </div>
            </button>
          );
        })}
      </section>

      {/* 4 Interactive Charts */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Notifications by Organization</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">Click any bar to filter notifications</p>
            </div>
            <Link to="/notifications" className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline">
              Explore
            </Link>
          </div>
          <NotificationsByOrgChart data={data.charts.by_organization} />
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Recruitment Trends Over Time</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">Published volume across monitored months</p>
            </div>
            <Link to="/notifications?sort=newest" className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline">
              Latest
            </Link>
          </div>
          <RecruitmentTrendsChart data={data.charts.trends_over_time} />
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Change Types Distribution</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">Click any category to filter Change History</p>
            </div>
            <Link to="/changes" className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline">
              Audit Log
            </Link>
          </div>
          <ChangeTypesDistributionChart data={data.charts.change_types_distribution} />
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Upcoming Deadlines Timeline</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">Open application windows grouped by month</p>
            </div>
            <Link to="/calendar" className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline">
              Calendar
            </Link>
          </div>
          <UpcomingDeadlinesTimelineChart data={data.charts.upcoming_deadlines_timeline} />
        </div>
      </section>

      {/* Upcoming Deadlines & Upcoming Examinations */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Upcoming Application Deadlines</h2>
            <Link to="/notifications?sort=deadline&status_filter=open" className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline">
              View all
            </Link>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.upcoming_deadlines.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">No upcoming application deadlines.</p>
            ) : (
              data.upcoming_deadlines.slice(0, 5).map((item) => (
                <Link
                  key={item.id}
                  to={`/notifications/${item.id}`}
                  className="py-3 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 -mx-2 px-2 rounded-lg transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">{item.title}</div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                      {item.source_code.toUpperCase()} · {item.notification_number || 'Ref Not available'}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                      {item.application_deadline || 'Not available'}
                    </div>
                    <div className="text-[11px] tabular-nums text-amber-700 dark:text-amber-400">
                      {item.days_to_deadline !== null ? `${item.days_to_deadline}d left` : 'Not available'}
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Upcoming Examinations</h2>
            <Link to="/notifications?sort=exam_date&status_filter=upcoming_exam" className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline">
              View all
            </Link>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.upcoming_examinations.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">No upcoming examination dates.</p>
            ) : (
              data.upcoming_examinations.slice(0, 5).map((item) => (
                <Link
                  key={item.id}
                  to={`/notifications/${item.id}`}
                  className="py-3 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 -mx-2 px-2 rounded-lg transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">{item.title}</div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                      {item.source_code.toUpperCase()} · {item.job_category || 'General'}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs font-semibold tabular-nums text-blue-700 dark:text-blue-400">
                      {item.exam_date || 'Not available'}
                    </div>
                    <div className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                      {item.days_to_exam !== null ? `in ${item.days_to_exam}d` : 'Not available'}
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Personalized Recommendations & Recently Detected Changes */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Personalized Recommendations</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">Matched from your target organizations &amp; exams</p>
            </div>
            <Link to="/opportunities" className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline">
              My Opportunities
            </Link>
          </div>
          <div className="space-y-3">
            {data.recommendations.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">Update your target preferences in Profile to see matches.</p>
            ) : (
              data.recommendations.slice(0, 4).map((item) => (
                <Link
                  key={item.id}
                  to={`/notifications/${item.id}`}
                  className="block rounded-lg border border-slate-200/80 dark:border-slate-800 p-3 hover:border-blue-300 dark:hover:border-blue-700 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[11px] font-semibold uppercase text-blue-700 dark:text-blue-400">
                      {item.source_code} · {item.match_score}% match
                    </span>
                    <StatusBadge label={item.status_label} />
                  </div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 line-clamp-1">{item.title}</div>
                  {item.match_reasons && item.match_reasons.length > 0 && (
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 truncate">
                      Why: {item.match_reasons.join(' · ')}
                    </div>
                  )}
                </Link>
              ))
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Recently Detected Changes</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">Real snapshot comparison events</p>
            </div>
            <Link to="/changes" className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline">
              Full History
            </Link>
          </div>
          <div className="space-y-3">
            {data.recent_changes.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  No official date or notification changes detected yet.
                </p>
              </div>
            ) : (
              data.recent_changes.slice(0, 5).map((chg) => (
                <Link
                  key={chg.id}
                  to={chg.notification_id ? `/notifications/${chg.notification_id}` : '/changes'}
                  className="block rounded-lg border border-slate-200/80 dark:border-slate-800 p-3 hover:border-blue-300 dark:hover:border-blue-700 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <StatusBadge label={chg.change_label || chg.change_type} />
                    <span className="text-[11px] tabular-nums text-slate-400">
                      {new Date(chg.detected_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 line-clamp-1">
                    {chg.notification_title}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 truncate">
                    {chg.previous_value ? `${chg.previous_value} → ` : ''}
                    <span className="font-semibold text-slate-700 dark:text-slate-200">{chg.new_value || 'Not available'}</span>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Latest Notifications & Source Health Overview */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Latest Notifications</h2>
            <Link to="/notifications" className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline">
              Browse all
            </Link>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.latest_notifications.slice(0, 6).map((n) => (
              <Link
                key={n.id}
                to={`/notifications/${n.id}`}
                className="py-3 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 -mx-2 px-2 rounded-lg transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">{n.title}</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                    {n.organization_name} · Vacancies: {n.vacancy_count || 'Not available'} · Published:{' '}
                    {n.published_date || 'Not available'}
                  </div>
                </div>
                <StatusBadge label={n.status_label} />
              </Link>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Source Health Overview</h2>
            <Link to="/sources" className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline">
              Manage
            </Link>
          </div>
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {data.sources.map((src) => (
              <Link
                key={src.id}
                to={`/notifications?source_code=${encodeURIComponent(src.code)}`}
                className="flex items-center justify-between gap-2 py-2 px-2.5 rounded-lg border border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase text-slate-800 dark:text-slate-200">{src.code}</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                    {src.notifications_count} notices · LIVE
                  </div>
                </div>
                <StatusBadge label={src.freshness_status} />
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
