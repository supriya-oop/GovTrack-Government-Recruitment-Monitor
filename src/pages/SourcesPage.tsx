import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ExternalLink, ScrollText, Power, X } from 'lucide-react';
import { apiRequest } from '../api/client.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useToast } from '../context/ToastContext.tsx';
import type { MonitoringLogItem, MonitoringSource, ScrapeRun } from '../types.ts';
import { SkeletonCard } from '../components/LoadingSkeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';

interface LogsResponse {
  source: MonitoringSource;
  runs: ScrapeRun[];
  logs: MonitoringLogItem[];
}

export function SourcesPage() {
  const { user } = useAuth();
  const { showToast } = useToast();

  const [sources, setSources] = useState<MonitoringSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [scrapingAll, setScrapingAll] = useState(false);
  const [logsModal, setLogsModal] = useState<LogsResponse | null>(null);

  const loadSources = async () => {
    setLoading(true);
    try {
      const res = await apiRequest<MonitoringSource[]>('/sources');
      setSources(res);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load sources', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSources();
  }, []);

  const handleCheckNow = async (src: MonitoringSource, extraBody: Record<string, unknown> = { mode: 'live' }) => {
    if (!user) {
      showToast('Sign in to trigger a portal monitoring check.', 'info');
      return;
    }
    setBusyId(src.id);
    try {
      const run = await apiRequest<ScrapeRun>(`/sources/${src.id}/scrape`, {
        method: 'POST',
        body: JSON.stringify(extraBody),
      });
      if (run.status === 'success') {
        showToast(
          `${src.code.toUpperCase()} checked (${run.mode_used}): parsed ${run.parsed_count}, new ${run.new_count}, updated ${run.updated_count}.`,
          'success'
        );
      } else {
        showToast(`${src.code.toUpperCase()} returned ${run.status}: existing records preserved safely.`, 'error');
      }
      await loadSources();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Source check failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleActive = async (src: MonitoringSource) => {
    if (!user || user.role !== 'admin') {
      showToast('Admin role required to enable or disable monitoring sources.', 'info');
      return;
    }
    setBusyId(src.id);
    try {
      await apiRequest(`/sources/${src.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !src.is_active }),
      });
      showToast(`${src.code.toUpperCase()} ${src.is_active ? 'disabled' : 'enabled'}.`, 'success');
      await loadSources();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update source status', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleScrapeAllLive = async () => {
    if (!user) {
      showToast('Sign in to run a full batch check.', 'info');
      return;
    }
    setScrapingAll(true);
    try {
      const res = await apiRequest<{ total_sources: number; runs?: ScrapeRun[] }>('/sources/scrape-all-live', {
        method: 'POST',
      });
      const runs = res.runs || [];
      const okCount = runs.filter((r) => r.status === 'success').length;
      const failCount = runs.length - okCount;
      showToast(
        runs.length > 0
          ? `Checked ${res.total_sources} portals: ${okCount} succeeded${failCount > 0 ? `, ${failCount} failed` : ''}.`
          : `Completed monitoring checks across ${res.total_sources} active portals.`,
        failCount > 0 && okCount === 0 ? 'error' : 'success'
      );
      await loadSources();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Batch scrape failed', 'error');
    } finally {
      setScrapingAll(false);
    }
  };

  const openLogs = async (src: MonitoringSource) => {
    try {
      const res = await apiRequest<LogsResponse>(`/sources/${src.id}/logs`);
      setLogsModal(res);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load logs', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Monitoring Sources ({sources.length})
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Official government portals monitored with robots.txt compliance, rate limiting, and stale-data protection.
          </p>
        </div>

        <button
          type="button"
          onClick={handleScrapeAllLive}
          disabled={scrapingAll}
          className="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-xs font-semibold flex items-center gap-2 self-start sm:self-auto whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${scrapingAll ? 'animate-spin' : ''}`} />
          <span>{scrapingAll ? 'Checking All Portals...' : 'Check All Portals Now'}</span>
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {sources.map((src) => {
            const isBusy = busyId === src.id;
            return (
              <div
                key={src.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col justify-between gap-4"
              >
                <div>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-blue-700 dark:text-blue-400">
                          {src.code}
                        </span>
                        <span className="text-xs text-slate-400">· {src.source_type}</span>
                      </div>
                      <h2 className="text-base font-bold text-slate-900 dark:text-white mt-0.5">{src.name}</h2>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{src.organization_name}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <StatusBadge label={isBusy ? 'Checking' : src.is_active ? src.freshness_status : 'Disabled'} />
                      {src.last_http_status !== null && (
                        <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                          HTTP {src.last_http_status}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                    <div>
                      <span className="text-slate-400 block text-[11px]">Status</span>
                      <span className="font-semibold">{src.is_active ? 'Enabled' : 'Disabled'}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Notifications</span>
                      <span className="font-semibold tabular-nums">
                        {src.notifications_count}
                        <span className="text-slate-400 font-normal"> · Parsed {src.last_parsed_count}</span>
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Changes / Dups</span>
                      <span className="font-semibold tabular-nums">
                        {src.changes_count}
                        <span className="text-slate-400 font-normal"> · {src.last_duplicate_count} dups</span>
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Last Checked</span>
                      <span className="font-medium tabular-nums">
                        {src.last_attempted_at ? new Date(src.last_attempted_at).toLocaleString() : 'Pending'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Last Successful</span>
                      <span className="font-medium tabular-nums">
                        {src.last_successful_at ? new Date(src.last_successful_at).toLocaleString() : 'Not yet'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[11px]">Next Scheduled</span>
                      <span className="font-medium tabular-nums">
                        {new Date(src.next_scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>

                  {src.last_error && (
                    <div className="mt-3 rounded-lg border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                      {src.last_error}
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleCheckNow(src, { mode: 'live' })}
                    className="px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isBusy ? 'animate-spin' : ''}`} />
                    <span>Check Now</span>
                  </button>

                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleToggleActive(src)}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1 whitespace-nowrap shrink-0"
                  >
                    <Power className="w-3.5 h-3.5" />
                    <span>{src.is_active ? 'Disable' : 'Enable'}</span>
                  </button>

                  <Link
                    to={`/notifications?source_code=${encodeURIComponent(src.code)}`}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                  >
                    View Notifications
                  </Link>

                  <a
                    href={src.base_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1 whitespace-nowrap shrink-0"
                  >
                    <span>View Source</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>

                  <button
                    type="button"
                    onClick={() => openLogs(src)}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1 whitespace-nowrap shrink-0"
                  >
                    <ScrollText className="w-3.5 h-3.5" />
                    <span>View Logs</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Monitoring Logs Modal */}
      {logsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs">
          <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white">
                  Monitoring Logs — {logsModal.source.organization_name}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">{logsModal.source.robots_policy}</p>
              </div>
              <button
                type="button"
                onClick={() => setLogsModal(null)}
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Recent Scrape Runs</h3>
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                    <tr>
                      <th className="py-2 px-3">Run ID</th>
                      <th className="py-2 px-3">Status</th>
                      <th className="py-2 px-3">HTTP</th>
                      <th className="py-2 px-3">Mode</th>
                      <th className="py-2 px-3">Parsed</th>
                      <th className="py-2 px-3">New / Upd</th>
                      <th className="py-2 px-3">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 tabular-nums">
                    {logsModal.runs.map((r) => (
                      <tr key={r.run_id}>
                        <td className="py-2 px-3 font-mono">{r.run_id}</td>
                        <td className="py-2 px-3">
                          <StatusBadge label={r.status} />
                          {r.error_message && (
                            <div className="text-[10px] text-rose-600 dark:text-rose-400 mt-0.5 max-w-[200px] truncate" title={r.error_message}>
                              {r.error_message}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 font-mono">{r.http_status ?? '—'}</td>
                        <td className="py-2 px-3">{r.mode_used}</td>
                        <td className="py-2 px-3">{r.parsed_count}</td>
                        <td className="py-2 px-3">{r.new_count} / {r.updated_count}</td>
                        <td className="py-2 px-3">{r.duration_ms}ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Execution Log Events</h3>
              <div className="rounded-lg bg-slate-950 text-slate-200 p-3 font-mono text-[11px] space-y-1.5 max-h-60 overflow-y-auto">
                {logsModal.logs.length === 0 ? (
                  <div className="text-slate-400">No log lines recorded yet.</div>
                ) : (
                  logsModal.logs.map((l) => (
                    <div key={l.id} className="flex gap-2">
                      <span className="text-slate-500 shrink-0">{new Date(l.created_at).toLocaleTimeString()}</span>
                      <span
                        className={
                          l.level === 'ERROR'
                            ? 'text-rose-400 shrink-0'
                            : l.level === 'WARN'
                              ? 'text-amber-400 shrink-0'
                              : 'text-emerald-400 shrink-0'
                        }
                      >
                        [{l.level}]
                      </span>
                      <span className="text-slate-300">{l.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
