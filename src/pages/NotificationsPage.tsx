import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Search,
  Bookmark,
  Share2,
  ExternalLink,
  FileDown,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { apiRequest, buildOfficialPdfUrl, buildPdfUrl } from '../api/client.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useToast } from '../context/ToastContext.tsx';
import type { RecruitmentNotification } from '../types.ts';
import { SkeletonCard } from '../components/LoadingSkeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';

interface NotificationsResponse {
  items: RecruitmentNotification[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  filters?: {
    organizations: { code: string; organization_name: string }[];
    categories: string[];
    qualifications: string[];
    states: string[];
  };
}

export function NotificationsPage() {
  const { user, preferences } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [q, setQ] = useState(searchParams.get('q') || '');
  const [sourceCode, setSourceCode] = useState(searchParams.get('source_code') || '');
  const [category, setCategory] = useState(searchParams.get('category') || '');
  const [qualification, setQualification] = useState(searchParams.get('qualification') || '');
  const [stateFilter, setStateFilter] = useState(searchParams.get('state') || '');
  const [appStatus, setAppStatus] = useState(searchParams.get('app_status') || '');
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status_filter') || '');
  const [sort, setSort] = useState(searchParams.get('sort') || 'newest');
  const [page, setPage] = useState(Number(searchParams.get('page') || 1));

  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQ(searchParams.get('q') || '');
    setSourceCode(searchParams.get('source_code') || '');
    setCategory(searchParams.get('category') || '');
    setQualification(searchParams.get('qualification') || '');
    setStateFilter(searchParams.get('state') || '');
    setAppStatus(searchParams.get('app_status') || '');
    setStatusFilter(searchParams.get('status_filter') || '');
    setSort(searchParams.get('sort') || 'newest');
    setPage(Number(searchParams.get('page') || 1));
  }, [searchParams]);

  const fetchNotifications = async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (sourceCode) params.set('source_code', sourceCode);
    if (category) params.set('category', category);
    if (qualification) params.set('qualification', qualification);
    if (stateFilter) params.set('state', stateFilter);
    if (appStatus) params.set('app_status', appStatus);
    if (statusFilter) params.set('status_filter', statusFilter);
    params.set('sort', sort);
    params.set('page', String(page));
    params.set('page_size', String(preferences?.dashboard_page_size || 12));

    try {
      const res = await apiRequest<NotificationsResponse>(`/notifications?${params.toString()}`);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notifications');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(fetchNotifications, 120);
    return () => clearTimeout(t);
  }, [q, sourceCode, category, qualification, stateFilter, appStatus, statusFilter, sort, page, user?.id]);

  const updateParam = (key: string, val: string) => {
    const next = new URLSearchParams(searchParams);
    if (val) next.set(key, val);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setSearchParams(next);
  };

  const clearAllFilters = () => {
    setSearchParams({});
  };

  const toggleSave = async (item: RecruitmentNotification) => {
    if (!user) {
      showToast('Sign in to bookmark notifications.', 'info');
      return;
    }
    try {
      if (item.is_saved) {
        await apiRequest(`/saved/${item.id}`, { method: 'DELETE' });
        showToast('Removed from Saved Notifications.', 'info');
      } else {
        await apiRequest(`/saved/${item.id}`, { method: 'POST', body: JSON.stringify({}) });
        showToast('Notification saved to your bookmarks.', 'success');
      }
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((n) => (n.id === item.id ? { ...n, is_saved: !item.is_saved } : n)),
            }
          : prev
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not update bookmark', 'error');
    }
  };

  const shareLink = async (item: RecruitmentNotification) => {
    const url = `${window.location.origin}/notifications/${item.id}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Notification link copied to clipboard.', 'success');
    } catch {
      showToast(`Share URL: ${url}`, 'info');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Recruitment Notifications
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            {data ? `${data.total} verified recruitment notices` : 'Loading recruitment directory...'}
          </p>
        </div>
        {(q || sourceCode || category || qualification || stateFilter || appStatus || statusFilter) && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 self-start sm:self-auto whitespace-nowrap shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Clear Filters</span>
          </button>
        )}
      </div>

      {/* Filters Toolbar */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-2 relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={q}
              onChange={(e) => updateParam('q', e.target.value)}
              placeholder="Live search title, organization, advt number, keyword..."
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <select
            value={sourceCode}
            onChange={(e) => updateParam('source_code', e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs text-slate-900 dark:text-slate-100"
          >
            <option value="">All Organizations</option>
            {data?.filters?.organizations.map((o) => (
              <option key={o.code} value={o.code}>
                {o.code.toUpperCase()} — {o.organization_name}
              </option>
            ))}
          </select>

          <select
            value={sort}
            onChange={(e) => updateParam('sort', e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs text-slate-900 dark:text-slate-100"
          >
            <option value="newest">Sort: Newest Published</option>
            <option value="deadline">Sort: Closest Deadline</option>
            <option value="exam_date">Sort: Earliest Exam Date</option>
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <select
            value={category}
            onChange={(e) => updateParam('category', e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs text-slate-900 dark:text-slate-100"
          >
            <option value="">All Job Categories</option>
            {data?.filters?.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            value={qualification}
            onChange={(e) => updateParam('qualification', e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs text-slate-900 dark:text-slate-100"
          >
            <option value="">All Qualifications</option>
            {data?.filters?.qualifications.map((qf) => (
              <option key={qf} value={qf}>
                {qf}
              </option>
            ))}
          </select>

          <select
            value={stateFilter}
            onChange={(e) => updateParam('state', e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs text-slate-900 dark:text-slate-100"
          >
            <option value="">All States / Regions</option>
            {data?.filters?.states.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>

          <select
            value={appStatus}
            onChange={(e) => updateParam('app_status', e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs text-slate-900 dark:text-slate-100"
          >
            <option value="">All Application Statuses</option>
            <option value="Applications Open">Applications Open</option>
            <option value="Closing Soon">Closing Soon</option>
            <option value="Opening Soon">Opening Soon</option>
            <option value="Upcoming Exam">Upcoming Exam</option>
            <option value="Admit Card Released">Admit Card Released</option>
            <option value="Result Released">Result Released</option>
            <option value="Closed">Closed</option>
            <option value="Cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-rose-200 dark:border-rose-800 bg-white dark:bg-slate-900 p-6 text-center text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      ) : !data || data.items.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center">
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">No notifications match your filters</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-4">
            Try clearing search terms or broadening status and organization filters.
          </p>
          <button
            type="button"
            onClick={clearAllFilters}
            className="px-4 py-2 rounded-lg bg-blue-700 text-white text-xs font-semibold"
          >
            Reset Filters
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {data.items.map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col justify-between gap-4 hover:border-blue-300 dark:hover:border-blue-700 transition-colors"
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-400">
                      {item.source_code} · {item.job_category || 'General'} · {item.state || 'All India'}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {item.is_demo_data && <StatusBadge label="DEMO DATA" />}
                      <StatusBadge label={item.status_label} />
                    </div>
                  </div>

                  <Link
                    to={`/notifications/${item.id}`}
                    className="text-base font-bold text-slate-900 dark:text-white hover:text-blue-700 dark:hover:text-blue-400 transition-colors line-clamp-2"
                  >
                    {item.title}
                  </Link>

                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {item.organization_name} · Ref: {item.notification_number || 'Not available'}
                  </p>

                  <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-xs">
                    <div>
                      <span className="text-slate-400 block text-[11px]">Vacancies</span>
                      <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-200">
                        {item.vacancy_count || 'Not available'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Qualification</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200 truncate block">
                        {item.qualification || 'Not available'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Published</span>
                      <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-200">
                        {item.published_date || 'Not available'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">App Start</span>
                      <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-200">
                        {item.application_start_date || 'Not available'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">App Deadline</span>
                      <span className="font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                        {item.application_deadline || 'Not available'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Exam Date</span>
                      <span className="font-semibold tabular-nums text-blue-700 dark:text-blue-400">
                        {item.exam_date || 'Not available'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Admit Card</span>
                      <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-200">
                        {item.admit_card_date || 'Not available'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Result Date</span>
                      <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-200">
                        {item.result_date || 'Not available'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Last Verified</span>
                      <span className="font-medium tabular-nums text-slate-600 dark:text-slate-300">
                        {new Date(item.last_seen_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/notifications/${item.id}`}
                      className="px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold whitespace-nowrap shrink-0"
                    >
                      View Details
                    </Link>
                    <a
                      href={item.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1 whitespace-nowrap shrink-0"
                    >
                      <span>Official URL</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    <a
                      href={buildOfficialPdfUrl(item.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2.5 py-1.5 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-950/40 text-xs font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 flex items-center gap-1 whitespace-nowrap shrink-0"
                      title={item.pdf_url ? 'Open official notification PDF' : 'Open verified notice PDF'}
                    >
                      <span>Official PDF</span>
                      <FileDown className="w-3 h-3" />
                    </a>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => toggleSave(item)}
                      className={`p-1.5 rounded-lg border transition-colors ${
                        item.is_saved
                          ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                          : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:text-blue-700'
                      }`}
                      title={item.is_saved ? 'Remove bookmark' : 'Save bookmark'}
                    >
                      <Bookmark className="w-4 h-4" fill={item.is_saved ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      type="button"
                      onClick={() => shareLink(item)}
                      className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                      title="Copy share link"
                    >
                      <Share2 className="w-4 h-4" />
                    </button>
                    <a
                      href={buildPdfUrl(item.id)}
                      className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                      title="Download GovTrack summary PDF"
                    >
                      <FileDown className="w-4 h-4" />
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {data.total_pages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                Page {data.page} of {data.total_pages} ({data.total} results)
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={data.page <= 1}
                  onClick={() => updateParam('page', String(data.page - 1))}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold disabled:opacity-40 flex items-center gap-1"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>Previous</span>
                </button>
                <button
                  type="button"
                  disabled={data.page >= data.total_pages}
                  onClick={() => updateParam('page', String(data.page + 1))}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold disabled:opacity-40 flex items-center gap-1"
                >
                  <span>Next</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
