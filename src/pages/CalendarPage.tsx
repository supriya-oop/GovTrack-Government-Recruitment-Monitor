import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Calendar as CalendarIcon, List, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiRequest } from '../api/client.ts';
import type { CalendarEvent, MonitoringSource } from '../types.ts';
import { SkeletonCard } from '../components/LoadingSkeleton.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';

interface CalendarResponse {
  events: CalendarEvent[];
  upcoming_events: CalendarEvent[];
  today: string;
}

const EVENT_COLORS: Record<CalendarEvent['event_type'], string> = {
  deadline: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800',
  exam: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800',
  admit_card: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800',
  result: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800',
};

export function CalendarPage() {
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [sources, setSources] = useState<MonitoringSource[]>([]);
  const [sourceFilter, setSourceFilter] = useState('');
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [viewMode, setViewMode] = useState<'calendar' | 'list'>('calendar');
  const [loading, setLoading] = useState(true);

  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth()); // 0-indexed

  useEffect(() => {
    apiRequest<MonitoringSource[]>('/sources').then(setSources).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (sourceFilter) params.set('source_code', sourceFilter);
    if (eventTypeFilter) params.set('event_type', eventTypeFilter);
    apiRequest<CalendarResponse>(`/calendar?${params.toString()}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [sourceFilter, eventTypeFilter]);

  const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`;
  const firstDayOfWeek = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  const eventsByDay = useMemo(() => {
    const map = new Map<number, CalendarEvent[]>();
    if (!data) return map;
    for (const ev of data.events) {
      if (ev.date.startsWith(monthStr)) {
        const d = Number(ev.date.slice(8, 10));
        if (!map.has(d)) map.set(d, []);
        map.get(d)!.push(ev);
      }
    }
    return map;
  }, [data, monthStr]);

  const prevMonth = () => {
    if (month === 0) {
      setYear((y) => y - 1);
      setMonth(11);
    } else {
      setMonth((m) => m - 1);
    }
  };

  const nextMonth = () => {
    if (month === 11) {
      setYear((y) => y + 1);
      setMonth(0);
    } else {
      setMonth((m) => m + 1);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Smart Deadline Tracker
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Track application closing dates, examinations, admit cards, and result schedules.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setViewMode('calendar')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 border ${
              viewMode === 'calendar'
                ? 'bg-blue-700 text-white border-blue-700'
                : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700'
            }`}
          >
            <CalendarIcon className="w-3.5 h-3.5" />
            <span>Monthly View</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('list')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 border ${
              viewMode === 'list'
                ? 'bg-blue-700 text-white border-blue-700'
                : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700'
            }`}
          >
            <List className="w-3.5 h-3.5" />
            <span>Upcoming List</span>
          </button>
        </div>
      </div>

      {/* Filters & Legend */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
          >
            <option value="">All Organizations</option>
            {sources.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code.toUpperCase()} — {s.organization_name}
              </option>
            ))}
          </select>

          <select
            value={eventTypeFilter}
            onChange={(e) => setEventTypeFilter(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs"
          >
            <option value="">All Event Types</option>
            <option value="deadline">Application Deadlines</option>
            <option value="exam">Examination Dates</option>
            <option value="admit_card">Admit Card Releases</option>
            <option value="result">Result Dates</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className={`px-2 py-0.5 rounded border font-medium ${EVENT_COLORS.deadline}`}>Deadline</span>
          <span className={`px-2 py-0.5 rounded border font-medium ${EVENT_COLORS.exam}`}>Exam</span>
          <span className={`px-2 py-0.5 rounded border font-medium ${EVENT_COLORS.admit_card}`}>Admit Card</span>
          <span className={`px-2 py-0.5 rounded border font-medium ${EVENT_COLORS.result}`}>Result</span>
        </div>
      </div>

      {loading ? (
        <SkeletonCard lines={6} />
      ) : viewMode === 'calendar' ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">{monthLabel}</h2>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={prevMonth}
                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Previous month"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={nextMonth}
                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Next month"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 text-center text-[11px] font-semibold text-slate-500 dark:text-slate-400 py-2">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>

          <div className="grid grid-cols-7 divide-x divide-y divide-slate-200 dark:divide-slate-800">
            {Array.from({ length: firstDayOfWeek }).map((_, idx) => (
              <div key={`empty-${idx}`} className="min-h-[100px] bg-slate-50/40 dark:bg-slate-950/30 p-1.5" />
            ))}
            {Array.from({ length: daysInMonth }).map((_, idx) => {
              const day = idx + 1;
              const iso = `${monthStr}-${String(day).padStart(2, '0')}`;
              const isToday = data?.today === iso;
              const dayEvents = eventsByDay.get(day) || [];
              return (
                <div
                  key={day}
                  className={`min-h-[104px] p-1.5 flex flex-col gap-1 ${
                    isToday ? 'bg-blue-50/40 dark:bg-blue-950/20' : ''
                  }`}
                >
                  <div
                    className={`text-xs font-semibold tabular-nums ${
                      isToday
                        ? 'text-blue-700 dark:text-blue-400 underline'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {day}
                  </div>
                  {dayEvents.slice(0, 3).map((ev) => (
                    <Link
                      key={ev.id}
                      to={`/notifications/${ev.notification_id}`}
                      className={`block px-1.5 py-0.5 rounded border text-[10px] font-medium truncate ${EVENT_COLORS[ev.event_type]}`}
                      title={`${ev.event_label}: ${ev.title}`}
                    >
                      {ev.source_code.toUpperCase()} · {ev.title}
                    </Link>
                  ))}
                  {dayEvents.length > 3 && (
                    <span className="text-[10px] text-slate-400 px-1">+{dayEvents.length - 3} more</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 divide-y divide-slate-100 dark:divide-slate-800">
          {!data || data.upcoming_events.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">No upcoming events match your selection.</div>
          ) : (
            data.upcoming_events.map((ev) => (
              <Link
                key={ev.id}
                to={`/notifications/${ev.notification_id}`}
                className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${EVENT_COLORS[ev.event_type]}`}>
                      {ev.event_label}
                    </span>
                    <span className="text-xs font-bold uppercase text-slate-600 dark:text-slate-400">
                      {ev.source_code}
                    </span>
                    <StatusBadge label={ev.status_label} />
                  </div>
                  <div className="text-sm font-bold text-slate-900 dark:text-white truncate">{ev.title}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{ev.organization_name}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-bold tabular-nums text-slate-900 dark:text-white">{ev.date}</div>
                  <div className="text-xs font-semibold tabular-nums text-blue-700 dark:text-blue-400">
                    {ev.days_remaining === 0 ? 'Today' : `In ${ev.days_remaining} days`}
                  </div>
                </div>
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}
