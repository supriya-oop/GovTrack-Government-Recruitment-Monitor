import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Briefcase, Clock, GraduationCap, GitCompareArrows, SlidersHorizontal, Info } from 'lucide-react';
import { apiRequest } from '../api/client.ts';
import { useAuth } from '../context/AuthContext.tsx';
import type { ChangeRecord, RecruitmentNotification, UserPreferences } from '../types.ts';
import { SkeletonCard } from '../components/LoadingSkeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';

interface OpportunitiesResponse {
  preferences: UserPreferences;
  matched_notifications: RecruitmentNotification[];
  approaching_deadlines: RecruitmentNotification[];
  upcoming_exams: RecruitmentNotification[];
  saved_changes: ChangeRecord[];
  summary: {
    total_matched: number;
    approaching_deadlines_count: number;
    upcoming_exams_count: number;
    saved_changes_count: number;
  };
}

export function OpportunitiesPage() {
  const { user } = useAuth();
  const [data, setData] = useState<OpportunitiesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiRequest<OpportunitiesResponse>('/opportunities')
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load opportunities'))
      .finally(() => setLoading(false));
  }, [user?.id]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SkeletonCard lines={4} />
        <SkeletonCard lines={4} />
        <SkeletonCard lines={4} />
        <SkeletonCard lines={4} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-rose-200 dark:border-rose-800 bg-white dark:bg-slate-900 p-6 text-sm text-rose-700 dark:text-rose-300">
        {error || 'Unable to load opportunities.'}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            My Opportunities
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Personalized feed matched to your target organizations, qualifications, job categories, and preferred states.
          </p>
        </div>
        <Link
          to="/profile"
          className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0 self-start sm:self-auto"
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span>Customize Preferences</span>
        </Link>
      </div>

      {/* Explicit Disclaimer */}
      <div className="rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50/70 dark:bg-blue-950/30 p-3.5 flex items-start gap-2.5 text-xs text-blue-900 dark:text-blue-200">
        <Info className="w-4 h-4 shrink-0 mt-0.5 text-blue-700 dark:text-blue-400" />
        <div>
          <span className="font-semibold">Informational Match Notice:</span> Recommendations are matched strictly against your saved profile criteria (Qualification: <span className="font-semibold">{data.preferences.qualification}</span>, Orgs: <span className="font-semibold uppercase">{data.preferences.target_organizations.join(', ') || 'Any'}</span>). Always verify complete eligibility rules on the official notification PDF before applying.
        </div>
      </div>

      {/* Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>Matched Recruitments</span>
            <Briefcase className="w-4 h-4 text-blue-600" />
          </div>
          <div className="text-2xl font-bold tabular-nums mt-1">{data.summary.total_matched}</div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>Approaching Deadlines (21d)</span>
            <Clock className="w-4 h-4 text-amber-600" />
          </div>
          <div className="text-2xl font-bold tabular-nums mt-1">{data.summary.approaching_deadlines_count}</div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>Upcoming Exams</span>
            <GraduationCap className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="text-2xl font-bold tabular-nums mt-1">{data.summary.upcoming_exams_count}</div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>Changes on Saved Jobs</span>
            <GitCompareArrows className="w-4 h-4 text-rose-600" />
          </div>
          <div className="text-2xl font-bold tabular-nums mt-1">{data.summary.saved_changes_count}</div>
        </div>
      </div>

      {/* Matched Notifications Feed */}
      <div className="space-y-3">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">Matched Recruitment Opportunities</h2>
        {data.matched_notifications.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500">
            No notifications match your current criteria. Broaden your target organizations or job categories in Profile.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.matched_notifications.map((item) => (
              <Link
                key={item.id}
                to={`/notifications/${item.id}`}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 hover:border-blue-400 dark:hover:border-blue-600 transition-colors flex flex-col justify-between gap-3"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-xs font-bold uppercase tracking-wide text-blue-700 dark:text-blue-400">
                      {item.source_code} · {item.match_score}% Match
                    </span>
                    <div className="flex items-center gap-1.5">
                      {item.is_demo_data && <StatusBadge label="DEMO DATA" />}
                      <StatusBadge label={item.status_label} />
                    </div>
                  </div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white line-clamp-2">{item.title}</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {item.organization_name} · {item.qualification || 'Qualification Not available'} · {item.state || 'All India'}
                  </p>
                  {item.match_reasons && item.match_reasons.length > 0 && (
                    <div className="mt-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-2 text-[11px] text-slate-700 dark:text-slate-300">
                      <span className="font-semibold">Matched because:</span> {item.match_reasons.join(' · ')}
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs tabular-nums text-slate-600 dark:text-slate-300">
                  <span>Deadline: {item.application_deadline || 'Not available'}</span>
                  <span>Exam: {item.exam_date || 'Not available'}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Changes on Saved Notifications */}
      {data.saved_changes.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <h2 className="text-base font-bold text-slate-900 dark:text-white">Detected Updates on Your Saved Jobs</h2>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.saved_changes.map((chg) => (
              <Link
                key={chg.id}
                to={chg.notification_id ? `/notifications/${chg.notification_id}` : '/changes'}
                className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-slate-50 dark:hover:bg-slate-800/40 px-2 rounded-lg"
              >
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <StatusBadge label={chg.change_label || chg.change_type} />
                    <span className="text-xs font-semibold text-slate-900 dark:text-white">{chg.notification_title}</span>
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Previous: {chg.previous_value || 'Not available'} → New: {chg.new_value || 'Not available'}
                  </div>
                </div>
                <span className="text-[11px] tabular-nums text-slate-400">{new Date(chg.detected_at).toLocaleString()}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
