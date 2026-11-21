import React, { useEffect, useState } from 'react';
import {
  ShieldAlert,
  Play,
  Plus,
  Trash2,
  CheckCircle2,
  Power,
  RefreshCw,
} from 'lucide-react';
import { apiRequest } from '../api/client.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useToast } from '../context/ToastContext.tsx';
import type {
  ChangeRecord,
  MonitoringLogItem,
  MonitoringSource,
  RecruitmentNotification,
  ScrapeRun,
  User,
} from '../types.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';

type AdminTab = 'overview' | 'sources' | 'runs' | 'users' | 'records' | 'categories';

interface SystemHealth {
  total_sources: number;
  healthy_sources: number;
  failed_sources: number;
  disabled_sources: number;
  total_runs: number;
  failed_runs: number;
  total_notifications: number;
  total_changes: number;
  unverified_changes: number;
  total_users: number;
  scheduler: { intervalMinutes: number; enabled: boolean; lastRunAt: string | null };
  node_version: string;
  uptime_seconds: number;
}

interface CategoryItem {
  id: number;
  name: string;
  description: string | null;
}

export function AdminPage() {
  const { user } = useAuth();
  const { showToast } = useToast();

  const [tab, setTab] = useState<AdminTab>('overview');
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [sources, setSources] = useState<MonitoringSource[]>([]);
  const [runs, setRuns] = useState<ScrapeRun[]>([]);
  const [logs, setLogs] = useState<MonitoringLogItem[]>([]);
  const [failures, setFailures] = useState<ScrapeRun[]>([]);
  const [usersList, setUsersList] = useState<User[]>([]);
  const [changes, setChanges] = useState<ChangeRecord[]>([]);
  const [notifications, setNotifications] = useState<RecruitmentNotification[]>([]);
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);

  const [newSource, setNewSource] = useState({
    code: '',
    name: '',
    organization_name: '',
    base_url: '',
    source_type: 'HTML Scraper',
  });
  const [newCategory, setNewCategory] = useState({ name: '', description: '' });

  const loadAll = async () => {
    try {
      const [h, s, r, l, f, u, c, n, cats] = await Promise.all([
        apiRequest<SystemHealth>('/admin/system-health'),
        apiRequest<MonitoringSource[]>('/sources'),
        apiRequest<ScrapeRun[]>('/admin/runs'),
        apiRequest<MonitoringLogItem[]>('/admin/logs'),
        apiRequest<ScrapeRun[]>('/admin/failures'),
        apiRequest<User[]>('/admin/users'),
        apiRequest<{ items: ChangeRecord[] }>('/changes?page_size=25'),
        apiRequest<{ items: RecruitmentNotification[] }>('/notifications?page_size=25'),
        apiRequest<CategoryItem[]>('/admin/categories'),
      ]);
      setHealth(h);
      setSources(s);
      setRuns(r);
      setLogs(l);
      setFailures(f);
      setUsersList(u);
      setChanges(c.items);
      setNotifications(n.items);
      setCategories(cats);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load admin console', 'error');
    }
  };

  useEffect(() => {
    if (user?.role === 'admin') {
      loadAll();
    }
  }, [user?.role]);

  if (!user || user.role !== 'admin') {
    return (
      <div className="rounded-xl border border-rose-200 dark:border-rose-800 bg-white dark:bg-slate-900 p-10 text-center space-y-2 max-w-lg mx-auto mt-10">
        <ShieldAlert className="w-8 h-8 text-rose-600 mx-auto" />
        <h1 className="text-lg font-bold text-slate-900 dark:text-white">Admin Access Restricted</h1>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Only administrators can access system controls, source provisioning, and user management. All /api/admin endpoints enforce HTTP 403 server-side.
        </p>
      </div>
    );
  }

  const runBatch = async () => {
    setBatchRunning(true);
    try {
      await apiRequest('/admin/scrape-all', { method: 'POST', body: JSON.stringify({ mode: 'auto' }) });
      showToast('Batch monitoring run completed across all active sources.', 'success');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Batch failed', 'error');
    } finally {
      setBatchRunning(false);
    }
  };

  const toggleScheduler = async () => {
    if (!health) return;
    try {
      await apiRequest('/admin/scheduler', {
        method: 'PUT',
        body: JSON.stringify({ enabled: !health.scheduler.enabled }),
      });
      showToast(`Scheduler ${health.scheduler.enabled ? 'paused' : 'resumed'}.`, 'info');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Scheduler update failed', 'error');
    }
  };

  const createSource = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/sources', { method: 'POST', body: JSON.stringify(newSource) });
      setNewSource({ code: '', name: '', organization_name: '', base_url: '', source_type: 'HTML Scraper' });
      showToast('Monitoring source added.', 'success');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to add source', 'error');
    }
  };

  const toggleSource = async (src: MonitoringSource) => {
    try {
      await apiRequest(`/sources/${src.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !src.is_active }),
      });
      showToast(`${src.code.toUpperCase()} updated.`, 'success');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Update failed', 'error');
    }
  };

  const deleteSource = async (src: MonitoringSource) => {
    try {
      await apiRequest(`/sources/${src.id}`, { method: 'DELETE' });
      showToast(`${src.code.toUpperCase()} deleted.`, 'info');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  };

  const toggleUserRole = async (u: User) => {
    const nextRole = u.role === 'admin' ? 'user' : 'admin';
    try {
      await apiRequest(`/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ role: nextRole }) });
      showToast(`Updated ${u.email} role to ${nextRole}.`, 'success');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Role update failed', 'error');
    }
  };

  const toggleUserActive = async (u: User) => {
    try {
      await apiRequest(`/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: !u.is_active }) });
      showToast(`${u.email} ${u.is_active ? 'deactivated' : 'activated'}.`, 'info');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Status update failed', 'error');
    }
  };

  const verifyChange = async (changeId: number) => {
    try {
      await apiRequest(`/changes/${changeId}/verify`, { method: 'POST' });
      showToast('Change verified.', 'success');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Verification failed', 'error');
    }
  };

  const deleteNotification = async (id: number) => {
    try {
      await apiRequest(`/admin/notifications/${id}`, { method: 'DELETE' });
      showToast('Notification record deleted.', 'info');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  };

  const createCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/admin/categories', { method: 'POST', body: JSON.stringify(newCategory) });
      setNewCategory({ name: '', description: '' });
      showToast('Category added.', 'success');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create category', 'error');
    }
  };

  const deleteCategory = async (id: number) => {
    try {
      await apiRequest(`/admin/categories/${id}`, { method: 'DELETE' });
      showToast('Category deleted.', 'info');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  };

  const tabs: { key: AdminTab; label: string }[] = [
    { key: 'overview', label: 'System Health & Scheduler' },
    { key: 'sources', label: 'Manage Sources' },
    { key: 'runs', label: 'Logs & Failures' },
    { key: 'users', label: 'Users' },
    { key: 'records', label: 'Notifications & Changes' },
    { key: 'categories', label: 'Categories' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Admin Control Console
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Backend-enforced administrative controls for portals, users, schedules, and audit records.
          </p>
        </div>

        <button
          type="button"
          onClick={runBatch}
          disabled={batchRunning}
          className="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-xs font-semibold flex items-center gap-2 self-start sm:self-auto whitespace-nowrap shrink-0"
        >
          <Play className="w-3.5 h-3.5" />
          <span>{batchRunning ? 'Running Batch...' : 'Start Full Monitoring Run'}</span>
        </button>
      </div>

      <div className="border-b border-slate-200 dark:border-slate-800 flex overflow-x-auto gap-1">
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

      {tab === 'overview' && health && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500">Healthy / Total Sources</div>
              <div className="text-xl font-bold tabular-nums mt-1">
                {health.healthy_sources} / {health.total_sources}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500">Total Runs / Failures</div>
              <div className="text-xl font-bold tabular-nums mt-1">
                {health.total_runs} / {health.failed_runs}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500">Unverified Changes</div>
              <div className="text-xl font-bold tabular-nums mt-1">{health.unverified_changes}</div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="text-xs text-slate-500">Registered Users</div>
              <div className="text-xl font-bold tabular-nums mt-1">{health.total_users}</div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Periodic Monitoring Scheduler</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
                Status: {health.scheduler.enabled ? 'Active' : 'Paused'} · Interval: Every {health.scheduler.intervalMinutes} mins · Runtime: {health.node_version} ({health.uptime_seconds}s uptime)
              </p>
            </div>
            <button
              type="button"
              onClick={toggleScheduler}
              className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 self-start sm:self-auto"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{health.scheduler.enabled ? 'Pause Scheduler' : 'Enable Scheduler'}</span>
            </button>
          </div>
        </div>
      )}

      {tab === 'sources' && (
        <div className="space-y-6">
          <form
            onSubmit={createSource}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3"
          >
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Add Monitoring Source</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <input
                type="text"
                required
                placeholder="Code (e.g. kpsc)"
                value={newSource.code}
                onChange={(e) => setNewSource({ ...newSource, code: e.target.value })}
                className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
              />
              <input
                type="text"
                required
                placeholder="Portal Name"
                value={newSource.name}
                onChange={(e) => setNewSource({ ...newSource, name: e.target.value })}
                className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
              />
              <input
                type="text"
                required
                placeholder="Organization Name"
                value={newSource.organization_name}
                onChange={(e) => setNewSource({ ...newSource, organization_name: e.target.value })}
                className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
              />
              <input
                type="url"
                required
                placeholder="https://..."
                value={newSource.base_url}
                onChange={(e) => setNewSource({ ...newSource, base_url: e.target.value })}
                className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
              />
              <button
                type="submit"
                className="px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold flex items-center justify-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Source</span>
              </button>
            </div>
          </form>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="py-2.5 px-4">Code</th>
                  <th className="py-2.5 px-4">Organization</th>
                  <th className="py-2.5 px-4">Health</th>
                  <th className="py-2.5 px-4">Notices</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {sources.map((src) => (
                  <tr key={src.id}>
                    <td className="py-2.5 px-4 font-bold uppercase">{src.code}</td>
                    <td className="py-2.5 px-4">{src.organization_name}</td>
                    <td className="py-2.5 px-4">
                      <StatusBadge label={src.is_active ? src.freshness_status : 'Disabled'} />
                    </td>
                    <td className="py-2.5 px-4 tabular-nums">{src.notifications_count}</td>
                    <td className="py-2.5 px-4 text-right space-x-2">
                      <button
                        type="button"
                        onClick={() => toggleSource(src)}
                        className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
                      >
                        <Power className="w-3 h-3" />
                        <span>{src.is_active ? 'Disable' : 'Enable'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteSource(src)}
                        className="p-1 rounded border border-slate-200 dark:border-slate-700 text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'runs' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Scraping Failures ({failures.length})</h2>
            {failures.length === 0 ? (
              <p className="text-xs text-slate-500">Zero failed monitoring runs recorded.</p>
            ) : (
              <div className="space-y-2 text-xs">
                {failures.map((f) => (
                  <div key={f.run_id} className="p-3 rounded-lg bg-rose-50/60 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 flex justify-between gap-2">
                    <div>
                      <span className="font-bold uppercase">{f.source_code}</span> · <span className="font-mono">{f.run_id}</span>
                      <div className="text-rose-700 dark:text-rose-300 mt-0.5">{f.error_message}</div>
                    </div>
                    <span className="tabular-nums text-slate-500 shrink-0">{new Date(f.started_at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Recent Monitoring Runs &amp; Logs</h2>
            <div className="rounded-lg bg-slate-950 text-slate-200 p-3 font-mono text-[11px] space-y-1 max-h-72 overflow-y-auto">
              {logs.map((l) => (
                <div key={l.id} className="flex gap-2">
                  <span className="text-slate-500 shrink-0">{new Date(l.created_at).toLocaleTimeString()}</span>
                  <span className="text-blue-400 uppercase shrink-0">[{l.source_code}]</span>
                  <span className={l.level === 'ERROR' ? 'text-rose-400' : l.level === 'WARN' ? 'text-amber-400' : 'text-emerald-400'}>
                    [{l.level}]
                  </span>
                  <span>{l.message}</span>
                </div>
              ))}
            </div>
            <div className="text-xs text-slate-500 tabular-nums">Showing {runs.length} recent runs and {logs.length} log entries.</div>
          </div>
        </div>
      )}

      {tab === 'users' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="py-2.5 px-4">Name</th>
                <th className="py-2.5 px-4">Email</th>
                <th className="py-2.5 px-4">Role</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {usersList.map((u) => (
                <tr key={u.id}>
                  <td className="py-2.5 px-4 font-semibold">{u.full_name}</td>
                  <td className="py-2.5 px-4">{u.email}</td>
                  <td className="py-2.5 px-4 uppercase font-bold">{u.role}</td>
                  <td className="py-2.5 px-4">
                    <StatusBadge label={u.is_active ? 'Healthy' : 'Disabled'} />
                  </td>
                  <td className="py-2.5 px-4 text-right space-x-2">
                    <button
                      type="button"
                      onClick={() => toggleUserRole(u)}
                      className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      Make {u.role === 'admin' ? 'User' : 'Admin'}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleUserActive(u)}
                      className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      {u.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'records' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Verify Change Detection Records</h2>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-96 overflow-y-auto">
              {changes.length === 0 ? (
                <p className="text-xs text-slate-500 py-4">No change events to verify.</p>
              ) : (
                changes.map((c) => (
                  <div key={c.id} className="py-3 flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <StatusBadge label={c.change_label || c.change_type} />
                        {c.is_verified && <StatusBadge label="Verified" />}
                      </div>
                      <div className="font-semibold truncate mt-1">{c.notification_title}</div>
                    </div>
                    {!c.is_verified && (
                      <button
                        type="button"
                        onClick={() => verifyChange(c.id)}
                        className="px-2.5 py-1 rounded bg-emerald-700 text-white font-semibold shrink-0 flex items-center gap-1"
                      >
                        <CheckCircle2 className="w-3 h-3" />
                        <span>Verify</span>
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Manage Notification Records</h2>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-96 overflow-y-auto">
              {notifications.map((n) => (
                <div key={n.id} className="py-3 flex items-center justify-between gap-2 text-xs">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{n.title}</div>
                    <div className="text-slate-500 uppercase">{n.source_code}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteNotification(n.id)}
                    className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-rose-600 hover:bg-rose-50 shrink-0"
                    title="Delete notification"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'categories' && (
        <div className="space-y-4">
          <form
            onSubmit={createCategory}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col sm:flex-row gap-3"
          >
            <input
              type="text"
              required
              placeholder="Category name"
              value={newCategory.name}
              onChange={(e) => setNewCategory({ ...newCategory, name: e.target.value })}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs flex-1"
            />
            <input
              type="text"
              placeholder="Description"
              value={newCategory.description}
              onChange={(e) => setNewCategory({ ...newCategory, description: e.target.value })}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs flex-1"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-blue-700 text-white text-xs font-semibold shrink-0"
            >
              Add Category
            </button>
          </form>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {categories.map((cat) => (
              <div
                key={cat.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between gap-3"
              >
                <div>
                  <div className="text-sm font-bold text-slate-900 dark:text-white">{cat.name}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{cat.description || 'No description'}</div>
                </div>
                <button
                  type="button"
                  onClick={() => deleteCategory(cat.id)}
                  className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-rose-600 hover:bg-rose-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
