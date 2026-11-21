import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ExternalLink, History, CheckCircle2, X, Search } from 'lucide-react';
import { apiRequest } from '../api/client.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useToast } from '../context/ToastContext.tsx';
import type { ChangeRecord, MonitoringSource } from '../types.ts';
import { DiffViewer } from '../components/DiffViewer.tsx';
import { SkeletonCard } from '../components/LoadingSkeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';

interface ChangesResponse {
  items: ChangeRecord[];
  total: number;
  page: number;
  total_pages: number;
}

export function ChangeHistoryPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [changeType, setChangeType] = useState(searchParams.get('change_type') || '');
  const [sourceCode, setSourceCode] = useState(searchParams.get('source_code') || '');
  const [q, setQ] = useState(searchParams.get('q') || '');
  const [data, setData] = useState<ChangesResponse | null>(null);
  const [sources, setSources] = useState<MonitoringSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeDiff, setActiveDiff] = useState<ChangeRecord | null>(null);

  useEffect(() => {
    apiRequest<MonitoringSource[]>('/sources')
      .then((res) => setSources(res))
      .catch(() => {});
  }, []);

  const loadChanges = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (changeType) params.set('change_type', changeType);
    if (sourceCode) params.set('source_code', sourceCode);
    if (q.trim()) params.set('q', q.trim());
    try {
      const res = await apiRequest<ChangesResponse>(`/changes?${params.toString()}`);
      setData(res);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load change history', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setChangeType(searchParams.get('change_type') || '');
    setSourceCode(searchParams.get('source_code') || '');
    setQ(searchParams.get('q') || '');
  }, [searchParams]);

  useEffect(() => {
    const t = setTimeout(loadChanges, 120);
    return () => clearTimeout(t);
  }, [changeType, sourceCode, q]);

  const updateFilter = (key: string, val: string) => {
    const next = new URLSearchParams(searchParams);
    if (val) next.set(key, val);
    else next.delete(key);
    setSearchParams(next);
  };

  const handleVerify = async (changeId: number) => {
    try {
      await apiRequest(`/changes/${changeId}/verify`, { method: 'POST' });
      showToast('Change event marked as verified.', 'success');
      loadChanges();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Verification failed', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Official Change History
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Verified portal snapshot comparison. Only official changes with known previous and updated values appear here.
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={q}
            onChange={(e) => updateFilter('q', e.target.value)}
            placeholder="Search notification title or change label..."
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
          />
        </div>

        <select
          value={changeType}
          onChange={(e) => updateFilter('change_type', e.target.value)}
          className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
        >
          <option value="">All Change Types</option>
          <option value="EXAM DATE CHANGED">Exam Date Changed</option>
          <option value="APPLICATION DEADLINE EXTENDED">Application Deadline Extended</option>
          <option value="APPLICATION DEADLINE CHANGED">Application Deadline Changed</option>
          <option value="APPLICATION START CHANGED">Application Start Changed</option>
          <option value="ADMIT CARD UPDATE">Admit Card Update</option>
          <option value="RESULT UPDATE">Result Update</option>
          <option value="VACANCY CHANGED">Vacancy Changed</option>
          <option value="QUALIFICATION CHANGED">Qualification Changed</option>
          <option value="NOTIFICATION CANCELLED">Notification Cancelled</option>
          <option value="VERIFIED REMOVAL">Verified Removal</option>
        </select>

        <select
          value={sourceCode}
          onChange={(e) => updateFilter('source_code', e.target.value)}
          className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
        >
          <option value="">All Organizations</option>
          {(sources.length > 0
            ? sources.map((s) => ({ code: s.code, label: `${s.code === 'rrbcdg' ? 'RRB' : s.code.toUpperCase()} — ${s.organization_name}` }))
            : ['upsc', 'ssc', 'ibps', 'sbi', 'rrbcdg', 'employmentnews', 'nta', 'tnpsc', 'keralapsc', 'rpsc', 'tnusrb', 'rbi', 'indiapost'].map((code) => ({
                code,
                label: code === 'rrbcdg' ? 'RRB' : code.toUpperCase(),
              }))
          ).map((item) => (
            <option key={item.code} value={item.code}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      {/* Change Events */}
      {loading ? (
        <div className="space-y-4">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={3} />
        </div>
      ) : !data || data.items.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center space-y-2">
          <p className="text-sm font-bold text-slate-900 dark:text-white">No official date or notification changes detected yet</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-lg mx-auto">
            All monitored notifications currently match their captured live portal baselines. Whenever any monitored portal modifies or extends an official date or vacancy count, both the previous and updated values will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.items.map((chg) => (
            <div
              key={chg.id}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4"
            >
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge label={chg.change_label || chg.change_type} size="sm" />
                    <span className="text-xs font-bold uppercase text-blue-700 dark:text-blue-400">
                      {chg.source_code || 'PORTAL'}
                    </span>
                    <span className="text-xs font-mono text-slate-400">{chg.run_id}</span>
                    {chg.is_verified && <StatusBadge label="Verified" />}
                  </div>
                  <Link
                    to={chg.notification_id ? `/notifications/${chg.notification_id}` : '/notifications'}
                    className="text-base font-bold text-slate-900 dark:text-white hover:text-blue-700 dark:hover:text-blue-400 block"
                  >
                    {chg.notification_title}
                  </Link>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {chg.organization_name || chg.source_name} · Detected:{' '}
                    <span className="tabular-nums font-medium">{new Date(chg.detected_at).toLocaleString()}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <a
                    href={chg.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1 whitespace-nowrap"
                  >
                    <span>View Official Source</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <button
                    type="button"
                    onClick={() => setActiveDiff(chg)}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1 whitespace-nowrap"
                  >
                    <History className="w-3.5 h-3.5" />
                    <span>View Previous Version</span>
                  </button>
                  {user?.role === 'admin' && !chg.is_verified && (
                    <button
                      type="button"
                      onClick={() => handleVerify(chg.id)}
                      className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold flex items-center gap-1 whitespace-nowrap"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Verify</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 p-3.5 text-xs">
                <div>
                  <span className="text-slate-400 block text-[11px]">Changed Field</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                    {chg.changed_field || 'title'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[11px]">Previous Value</span>
                  <span className="font-mono text-rose-700 dark:text-rose-300 break-all">
                    {chg.previous_value || 'Not available'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[11px]">New Value</span>
                  <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-300 break-all">
                    {chg.new_value || 'Not available'}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Version Snapshot Modal */}
      {activeDiff && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs">
          <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4 shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <StatusBadge label={activeDiff.change_label || activeDiff.change_type} />
                  <span className="text-xs font-mono text-slate-400">{activeDiff.run_id}</span>
                </div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white">{activeDiff.notification_title}</h2>
              </div>
              <button
                type="button"
                onClick={() => setActiveDiff(null)}
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close version modal"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <DiffViewer
              diffs={activeDiff.changed_fields}
              beforeSnapshot={activeDiff.before_snapshot}
              afterSnapshot={activeDiff.after_snapshot}
            />
          </div>
        </div>
      )}
    </div>
  );
}
