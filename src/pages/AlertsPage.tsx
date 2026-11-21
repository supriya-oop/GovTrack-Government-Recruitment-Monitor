import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bell, CheckCheck, Trash2, Check, Search } from 'lucide-react';
import { apiRequest } from '../api/client.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useToast } from '../context/ToastContext.tsx';
import type { AlertItem } from '../types.ts';
import { SkeletonCard } from '../components/LoadingSkeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';

export function AlertsPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [unreadOnly, setUnreadOnly] = useState(searchParams.get('unread_only') === 'true');
  const [priority, setPriority] = useState(searchParams.get('priority') || '');
  const [alertType, setAlertType] = useState(searchParams.get('alert_type') || '');
  const [sourceCode, setSourceCode] = useState(searchParams.get('source_code') || '');
  const [q, setQ] = useState('');

  const [items, setItems] = useState<AlertItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadAlerts = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (unreadOnly) params.set('unread_only', 'true');
    if (priority) params.set('priority', priority);
    if (alertType) params.set('alert_type', alertType);
    if (sourceCode) params.set('source_code', sourceCode);
    if (q.trim()) params.set('q', q.trim());

    try {
      const res = await apiRequest<{ items: AlertItem[]; unread_count: number }>(`/alerts?${params.toString()}`);
      setItems(res.items);
      setUnreadCount(res.unread_count);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load alerts', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(loadAlerts, 120);
    return () => clearTimeout(t);
  }, [unreadOnly, priority, alertType, sourceCode, q]);

  const markRead = async (alert: AlertItem) => {
    if (!user) {
      showToast('Sign in to update alert read state.', 'info');
      return;
    }
    try {
      await apiRequest(`/alerts/${alert.id}/read`, {
        method: 'POST',
        body: JSON.stringify({ is_read: !alert.is_read }),
      });
      await loadAlerts();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Update failed', 'error');
    }
  };

  const markAllRead = async () => {
    if (!user) {
      showToast('Sign in to mark alerts as read.', 'info');
      return;
    }
    try {
      await apiRequest('/alerts/read-all', { method: 'POST' });
      showToast('All alerts marked as read.', 'success');
      await loadAlerts();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Action failed', 'error');
    }
  };

  const deleteAlert = async (alertId: number) => {
    if (!user) {
      showToast('Sign in to delete alerts.', 'info');
      return;
    }
    try {
      await apiRequest(`/alerts/${alertId}`, { method: 'DELETE' });
      showToast('Alert removed.', 'info');
      setItems((prev) => prev.filter((a) => a.id !== alertId));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2.5">
            <span>Alerts Center</span>
            {unreadCount > 0 && (
              <span className="px-2 py-0.5 text-xs font-bold tabular-nums rounded-md bg-rose-600 text-white">
                {unreadCount} unread
              </span>
            )}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Deduplicated notifications prioritized as Critical, High, Normal, or Low.
          </p>
        </div>

        <button
          type="button"
          onClick={markAllRead}
          disabled={unreadCount === 0}
          className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 flex items-center gap-1.5 self-start sm:self-auto whitespace-nowrap shrink-0"
        >
          <CheckCheck className="w-4 h-4" />
          <span>Mark All Read</span>
        </button>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="relative lg:col-span-2">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search alerts..."
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
          />
        </div>

        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
        >
          <option value="">All Priorities</option>
          <option value="Critical">Critical (Deadlines / Exams / Cancel)</option>
          <option value="High">High (Admit Card / Result)</option>
          <option value="Normal">Normal (New Notification)</option>
          <option value="Low">Low (Minor Source Updates)</option>
        </select>

        <select
          value={alertType}
          onChange={(e) => setAlertType(e.target.value)}
          className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
        >
          <option value="">All Alert Types</option>
          <option value="UPDATED">Updated</option>
          <option value="NEW">New Published</option>
          <option value="REMOVED">Removed</option>
          <option value="SOURCE_ERROR">Source Error</option>
        </select>

        <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-medium cursor-pointer">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => {
              setUnreadOnly(e.target.checked);
              const next = new URLSearchParams(searchParams);
              if (e.target.checked) next.set('unread_only', 'true');
              else next.delete('unread_only');
              setSearchParams(next);
            }}
          />
          <span>Unread only</span>
        </label>
      </div>

      {loading ? (
        <div className="space-y-3">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center">
          <Bell className="w-8 h-8 text-slate-300 dark:text-slate-700 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">No alerts match your filters</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Alerts are automatically created when important real changes or portal errors occur.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((alert) => (
            <div
              key={alert.id}
              className={`rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-colors ${
                !alert.is_read
                  ? 'border-blue-300 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-950/20'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900'
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  if (alert.notification_id) navigate(`/notifications/${alert.notification_id}`);
                  else navigate('/sources');
                }}
                className="text-left flex-1 min-w-0"
              >
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <StatusBadge label={alert.priority} />
                  <StatusBadge label={alert.alert_type} />
                  <span className="text-xs font-bold uppercase text-slate-500 dark:text-slate-400">
                    {alert.source_code || ''}
                  </span>
                  <span className="text-[11px] tabular-nums text-slate-400">
                    {new Date(alert.created_at).toLocaleString()}
                  </span>
                </div>
                <div className="text-sm font-bold text-slate-900 dark:text-white">{alert.title}</div>
                <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">{alert.message}</div>
              </button>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => markRead(alert)}
                  className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1 whitespace-nowrap"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{alert.is_read ? 'Mark Unread' : 'Mark Read'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => deleteAlert(alert.id)}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300"
                  title="Delete alert"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
