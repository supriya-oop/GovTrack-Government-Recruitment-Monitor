import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bookmark, Trash2, Save, ExternalLink, FileDown } from 'lucide-react';
import { apiRequest, buildOfficialPdfUrl } from '../api/client.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useToast } from '../context/ToastContext.tsx';
import type { AlertItem, RecruitmentNotification } from '../types.ts';
import { SkeletonCard } from '../components/LoadingSkeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';

export function SavedPage() {
  const { user } = useAuth();
  const { showToast } = useToast();

  const [items, setItems] = useState<RecruitmentNotification[]>([]);
  const [savedAlerts, setSavedAlerts] = useState<AlertItem[]>([]);
  const [notesDraft, setNotesDraft] = useState<Record<number, string>>({});
  const [filterText, setFilterText] = useState('');
  const [loading, setLoading] = useState(true);

  const loadSaved = async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await apiRequest<{ items: RecruitmentNotification[]; saved_alerts: AlertItem[] }>('/saved');
      setItems(res.items);
      setSavedAlerts(res.saved_alerts);
      const drafts: Record<number, string> = {};
      for (const it of res.items) drafts[it.id] = it.notes || '';
      setNotesDraft(drafts);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load saved notifications', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSaved();
  }, [user?.id]);

  const saveNotes = async (notifId: number) => {
    try {
      await apiRequest(`/saved/${notifId}`, {
        method: 'POST',
        body: JSON.stringify({ notes: notesDraft[notifId] ?? '' }),
      });
      showToast('Personal notes saved.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save notes', 'error');
    }
  };

  const removeBookmark = async (notifId: number) => {
    try {
      await apiRequest(`/saved/${notifId}`, { method: 'DELETE' });
      showToast('Bookmark removed.', 'info');
      setItems((prev) => prev.filter((i) => i.id !== notifId));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to remove bookmark', 'error');
    }
  };

  if (!user) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center space-y-3">
        <Bookmark className="w-8 h-8 text-blue-600 mx-auto" />
        <h1 className="text-lg font-bold text-slate-900 dark:text-white">Sign in to manage Saved Notifications</h1>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Your bookmarked recruitments, personal preparation notes, and deadline alerts are stored per account.
        </p>
        <Link
          to="/login"
          className="inline-block px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold"
        >
          Sign In
        </Link>
      </div>
    );
  }

  const filtered = items.filter((it) => {
    if (!filterText.trim()) return true;
    const ql = filterText.trim().toLowerCase();
    return (
      it.title.toLowerCase().includes(ql) ||
      it.organization_name.toLowerCase().includes(ql) ||
      (it.notes || '').toLowerCase().includes(ql)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Saved Notifications ({items.length})
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Track bookmarked examinations, upcoming closing dates, and personal study notes.
          </p>
        </div>
        <input
          type="search"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter saved items or notes..."
          className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs w-full sm:w-64"
        />
      </div>

      {loading ? (
        <SkeletonCard lines={4} />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center space-y-3">
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">No saved notifications yet</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Bookmark any notification from the Recruitment Notifications directory to track it here.
          </p>
          <Link
            to="/notifications"
            className="inline-block px-4 py-2 rounded-lg bg-blue-700 text-white text-xs font-semibold"
          >
            Browse Notifications
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.map((item) => (
            <div
              key={item.id}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-[11px] font-bold uppercase text-blue-700 dark:text-blue-400">
                    {item.source_code} · Saved {item.saved_at ? new Date(item.saved_at).toLocaleDateString() : ''}
                  </span>
                  <Link
                    to={`/notifications/${item.id}`}
                    className="block text-base font-bold text-slate-900 dark:text-white hover:text-blue-700 dark:hover:text-blue-400 mt-0.5"
                  >
                    {item.title}
                  </Link>
                </div>
                <StatusBadge label={item.status_label} />
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs tabular-nums text-slate-600 dark:text-slate-300">
                <div>Deadline: <span className="font-semibold">{item.application_deadline || 'Not available'}</span></div>
                <div>Exam Date: <span className="font-semibold">{item.exam_date || 'Not available'}</span></div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-500 mb-1">Personal Notes</label>
                <textarea
                  rows={2}
                  value={notesDraft[item.id] ?? ''}
                  onChange={(e) => setNotesDraft((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  placeholder="Add fee payment status, center preference, syllabus reminders..."
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
                />
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => saveNotes(item.id)}
                    className="px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold flex items-center gap-1"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Save Note</span>
                  </button>
                  <a
                    href={item.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold flex items-center gap-1"
                  >
                    <span>Official</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  <a
                    href={buildOfficialPdfUrl(item.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2.5 py-1.5 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 text-xs font-semibold flex items-center gap-1"
                  >
                    <span>PDF</span>
                    <FileDown className="w-3 h-3" />
                  </a>
                </div>
                <button
                  type="button"
                  onClick={() => removeBookmark(item.id)}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600"
                  title="Remove bookmark"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {savedAlerts.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">Alerts for Your Bookmarked Notifications</h2>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {savedAlerts.map((a) => (
              <Link
                key={a.id}
                to={a.notification_id ? `/notifications/${a.notification_id}` : '/alerts'}
                className="py-2.5 flex items-center justify-between gap-3 text-xs hover:bg-slate-50 dark:hover:bg-slate-800/50 px-2 rounded"
              >
                <div>
                  <span className="font-semibold text-slate-900 dark:text-white">{a.title}</span>
                  <div className="text-slate-500 dark:text-slate-400">{a.message}</div>
                </div>
                <StatusBadge label={a.priority} />
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
