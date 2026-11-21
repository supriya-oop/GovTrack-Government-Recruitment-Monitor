import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Bookmark,
  Share2,
  ExternalLink,
  FileDown,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import { apiRequest, buildOfficialPdfUrl, buildPdfUrl } from '../api/client.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useToast } from '../context/ToastContext.tsx';
import type { ChangeRecord, NotificationVersion, RecruitmentNotification } from '../types.ts';
import { DiffViewer } from '../components/DiffViewer.tsx';
import { SkeletonCard } from '../components/LoadingSkeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';

type DetailTab = 'overview' | 'dates' | 'eligibility' | 'documents' | 'history';

interface NotificationDetailResponse {
  notification: RecruitmentNotification & { source_base_url?: string; source_type?: string };
  versions: NotificationVersion[];
  changes: ChangeRecord[];
  related: RecruitmentNotification[];
}

export function NotificationDetailsPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const { showToast } = useToast();

  const [tab, setTab] = useState<DetailTab>('overview');
  const [data, setData] = useState<NotificationDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiRequest<NotificationDetailResponse>(`/notifications/${id}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Notification not found'))
      .finally(() => setLoading(false));
  }, [id, user?.id]);

  const toggleSave = async () => {
    if (!data) return;
    if (!user) {
      showToast('Sign in to save notifications.', 'info');
      return;
    }
    const n = data.notification;
    try {
      if (n.is_saved) {
        await apiRequest(`/saved/${n.id}`, { method: 'DELETE' });
        showToast('Removed from Saved Notifications.', 'info');
      } else {
        await apiRequest(`/saved/${n.id}`, { method: 'POST', body: JSON.stringify({}) });
        showToast('Notification saved to bookmarks.', 'success');
      }
      setData((prev) => (prev ? { ...prev, notification: { ...prev.notification, is_saved: !n.is_saved } } : prev));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update bookmark', 'error');
    }
  };

  const shareLink = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied to clipboard.', 'success');
    } catch {
      showToast(url, 'info');
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <SkeletonCard lines={5} />
        <SkeletonCard lines={4} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-rose-200 dark:border-rose-800 bg-white dark:bg-slate-900 p-8 text-center">
        <p className="text-sm font-semibold text-rose-700 dark:text-rose-300 mb-3">{error || 'Not found'}</p>
        <Link to="/notifications" className="text-xs font-semibold text-blue-700 hover:underline">
          Back to Notifications
        </Link>
      </div>
    );
  }

  const n = data.notification;

  const timelineSteps = [
    { label: 'Notification Published', date: n.published_date },
    { label: 'Application Opens', date: n.application_start_date },
    { label: 'Application Closes', date: n.application_deadline },
    { label: 'Admit Card', date: n.admit_card_date },
    { label: 'Exam Date', date: n.exam_date },
    { label: 'Result', date: n.result_date },
  ];

  const tabs: { key: DetailTab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'dates', label: 'Important Dates' },
    { key: 'eligibility', label: 'Eligibility' },
    { key: 'documents', label: 'Documents' },
    { key: 'history', label: `Change History (${data.changes.length})` },
  ];

  return (
    <div className="space-y-6">
      <Link
        to="/notifications"
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-blue-700 dark:hover:text-blue-400"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Back to Notifications</span>
      </Link>

      {/* Header Card */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-blue-700 dark:text-blue-400">
                {n.source_code} · {n.job_category || 'General'}
              </span>
              {n.is_demo_data && <StatusBadge label="DEMO DATA" />}
              <StatusBadge label={n.status_label} size="sm" />
              <StatusBadge label={n.freshness_status || 'Healthy'} />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">{n.title}</h1>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {n.organization_name} · Advertisement No: <span className="font-semibold">{n.notification_number || 'Not available'}</span>
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              Last Monitoring Check: {new Date(n.last_seen_at).toLocaleString()} · Versions Stored: {data.versions.length}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={toggleSave}
              className={`px-3 py-2 rounded-lg border text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                n.is_saved
                  ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Bookmark className="w-3.5 h-3.5" fill={n.is_saved ? 'currentColor' : 'none'} />
              <span>{n.is_saved ? 'Saved' : 'Save Bookmark'}</span>
            </button>
            <button
              type="button"
              onClick={shareLink}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Share2 className="w-3.5 h-3.5" />
              <span>Share</span>
            </button>
            <a
              href={buildOfficialPdfUrl(n.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3.5 py-2 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <FileDown className="w-3.5 h-3.5" />
              <span>Official PDF</span>
            </a>
            <a
              href={n.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3.5 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <span>Official Source</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="mt-6 border-b border-slate-200 dark:border-slate-800 flex overflow-x-auto gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors ${
                tab === t.key
                  ? 'border-blue-700 text-blue-700 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white mb-2">Recruitment Summary</h2>
              <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                {n.description || 'Not available'}
              </p>
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white mb-2">Application Procedure</h2>
              <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                {n.application_procedure ||
                  `Review the official notification on ${n.organization_name} (${n.source_url}), complete online registration before ${n.application_deadline || 'the notified closing date'}, and download your confirmation receipt.`}
              </p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-4 border-t border-slate-100 dark:border-slate-800 text-xs">
              <div>
                <span className="text-slate-400 block">Total Vacancies</span>
                <span className="font-bold text-sm tabular-nums">{n.vacancy_count || 'Not available'}</span>
              </div>
              <div>
                <span className="text-slate-400 block">Qualification</span>
                <span className="font-bold text-sm">{n.qualification || 'Not available'}</span>
              </div>
              <div>
                <span className="text-slate-400 block">State / Region</span>
                <span className="font-bold text-sm">{n.state || 'Not available'}</span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white mb-4">Milestone Timeline</h2>
            <ol className="space-y-4">
              {timelineSteps.map((step, idx) => (
                <li key={idx} className="flex items-start gap-3">
                  {step.date ? (
                    <CheckCircle2 className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                  ) : (
                    <Clock className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-700 dark:text-slate-300">{step.label}</span>
                    <span className="font-semibold tabular-nums text-slate-900 dark:text-white">
                      {step.date || 'Not available'}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

      {tab === 'dates' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white mb-4">Important Dates Timeline</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {timelineSteps.map((step) => (
              <div
                key={step.label}
                className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 p-4"
              >
                <div className="text-xs text-slate-500 dark:text-slate-400">{step.label}</div>
                <div className="text-base font-bold tabular-nums text-slate-900 dark:text-white mt-1">
                  {step.date || 'Not available'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'eligibility' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">Eligibility, Vacancies &amp; Procedure</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-800/50">
              <dt className="text-xs text-slate-500 dark:text-slate-400">Required Qualification</dt>
              <dd className="font-semibold mt-1">{n.qualification || 'Not available'}</dd>
            </div>
            <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-800/50">
              <dt className="text-xs text-slate-500 dark:text-slate-400">Vacancy Count</dt>
              <dd className="font-semibold tabular-nums mt-1">{n.vacancy_count || 'Not available'}</dd>
            </div>
            <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-800/50">
              <dt className="text-xs text-slate-500 dark:text-slate-400">Job Category</dt>
              <dd className="font-semibold mt-1">{n.job_category || 'Not available'}</dd>
            </div>
            <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-800/50">
              <dt className="text-xs text-slate-500 dark:text-slate-400">State / Jurisdiction</dt>
              <dd className="font-semibold mt-1">{n.state || 'Not available'}</dd>
            </div>
          </dl>
        </div>
      )}

      {tab === 'documents' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">Official Documents &amp; Exports</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <a
              href={n.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-blue-400 flex items-center justify-between"
            >
              <div>
                <div className="text-xs font-bold">Official Portal Page</div>
                <div className="text-[11px] text-slate-500 truncate max-w-[180px]">{n.source_url}</div>
              </div>
              <ExternalLink className="w-4 h-4 text-blue-600 shrink-0" />
            </a>
            <a
              href={buildOfficialPdfUrl(n.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="p-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/30 hover:border-blue-400 flex items-center justify-between"
            >
              <div>
                <div className="text-xs font-bold text-blue-800 dark:text-blue-200">Official Notification PDF</div>
                <div className="text-[11px] text-slate-500">
                  {n.pdf_url ? 'Opens official source PDF inline' : 'Verified notice PDF viewer'}
                </div>
              </div>
              <FileDown className="w-4 h-4 text-blue-600 shrink-0" />
            </a>
            <a
              href={buildPdfUrl(n.id)}
              className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-blue-400 flex items-center justify-between"
            >
              <div>
                <div className="text-xs font-bold">GovTrack Summary PDF</div>
                <div className="text-[11px] text-slate-500">Download verified snapshot</div>
              </div>
              <FileDown className="w-4 h-4 text-blue-600 shrink-0" />
            </a>
          </div>
          {n.pdf_url && (
            <p className="text-[11px] text-slate-500 dark:text-slate-400 break-all">
              Direct source PDF URL:{' '}
              <a
                href={n.pdf_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-700 dark:text-blue-400 hover:underline"
              >
                {n.pdf_url}
              </a>
            </p>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Detected Field Changes</h2>
            {data.changes.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                No modifications detected since initial baseline capture.
              </p>
            ) : (
              <div className="space-y-4">
                {data.changes.map((chg) => (
                  <div key={chg.id} className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <StatusBadge label={chg.change_label || chg.change_type} />
                        <span className="text-xs font-mono text-slate-500">{chg.run_id}</span>
                      </div>
                      <span className="text-xs tabular-nums text-slate-500">
                        {new Date(chg.detected_at).toLocaleString()}
                      </span>
                    </div>
                    <DiffViewer
                      diffs={chg.changed_fields}
                      beforeSnapshot={chg.before_snapshot}
                      afterSnapshot={chg.after_snapshot}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-3">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Captured Versions ({data.versions.length})</h2>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {data.versions.map((v) => (
                <div key={v.id} className="py-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-bold">Version {v.version_number}</span>
                    <span className="text-slate-500 ml-2 font-mono">{v.content_hash.slice(0, 14)}...</span>
                  </div>
                  <div className="text-slate-500 tabular-nums">
                    Deadline: {v.application_deadline || 'Not available'} · Exam: {v.exam_date || 'Not available'} ·{' '}
                    {new Date(v.captured_at).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Related Notifications */}
      {data.related.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">Related Recruitments</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.related.map((rel) => (
              <Link
                key={rel.id}
                to={`/notifications/${rel.id}`}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 hover:border-blue-300 dark:hover:border-blue-700 transition-colors"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-bold uppercase text-blue-700 dark:text-blue-400">
                    {rel.source_code}
                  </span>
                  <StatusBadge label={rel.status_label} />
                </div>
                <div className="text-xs font-bold text-slate-900 dark:text-white line-clamp-1">{rel.title}</div>
                <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
                  Deadline: {rel.application_deadline || 'Not available'} · Exam: {rel.exam_date || 'Not available'}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
