import { useNavigate } from 'react-router-dom';

interface OrgChartItem {
  code: string;
  name: string;
  organization_name: string;
  count: number;
}

interface TrendItem {
  month: string;
  count: number;
}

interface ChangeDistItem {
  label: string;
  change_type: string;
  count: number;
}

interface DeadlineBucket {
  month: string;
  count: number;
  next_date: string;
}

export function NotificationsByOrgChart({ data }: { data: OrgChartItem[] }) {
  const navigate = useNavigate();
  const top = data.slice(0, 10);
  const maxVal = Math.max(1, ...top.map((d) => d.count));

  if (top.length === 0) {
    return <p className="text-xs text-slate-500 dark:text-slate-400 py-8 text-center">No organization records yet.</p>;
  }

  return (
    <div className="space-y-2.5">
      {top.map((item) => {
        const pct = Math.max(6, Math.round((item.count / maxVal) * 100));
        return (
          <button
            key={item.code}
            type="button"
            onClick={() => navigate(`/notifications?source_code=${encodeURIComponent(item.code)}`)}
            className="w-full text-left group flex items-center gap-3 py-1 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800/50 px-1.5 transition-colors"
            title={`Filter notifications for ${item.organization_name}`}
          >
            <span className="w-24 text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-300 truncate shrink-0">
              {item.code}
            </span>
            <div className="flex-1 h-2.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-600 dark:bg-blue-500 group-hover:bg-blue-700 dark:group-hover:bg-blue-400 transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-8 text-right text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200">
              {item.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function RecruitmentTrendsChart({ data }: { data: TrendItem[] }) {
  const navigate = useNavigate();
  if (data.length === 0) {
    return <p className="text-xs text-slate-500 dark:text-slate-400 py-8 text-center">No timeline trend data yet.</p>;
  }

  const maxVal = Math.max(1, ...data.map((d) => d.count));
  const width = 420;
  const height = 160;
  const padX = 28;
  const padY = 20;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const points = data.map((d, i) => {
    const x = data.length === 1 ? width / 2 : padX + (i / (data.length - 1)) * innerW;
    const y = padY + innerH - (d.count / maxVal) * innerH;
    return { ...d, x, y };
  });

  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');
  const area = `${padX},${padY + innerH} ${polyline} ${points[points.length - 1].x},${padY + innerH}`;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-44 overflow-visible">
        <defs>
          <linearGradient id="govtrackTrendGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#2563eb" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((frac, idx) => {
          const y = padY + innerH * (1 - frac);
          return (
            <line
              key={idx}
              x1={padX}
              x2={width - padX}
              y1={y}
              y2={y}
              stroke="currentColor"
              className="text-slate-200 dark:text-slate-800"
              strokeDasharray="3 3"
            />
          );
        })}
        <polygon points={area} fill="url(#govtrackTrendGrad)" />
        <polyline
          fill="none"
          stroke="#2563eb"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={polyline}
        />
        {points.map((p) => (
          <g
            key={p.month}
            className="cursor-pointer"
            onClick={() => navigate('/notifications?sort=newest')}
          >
            <circle cx={p.x} cy={p.y} r="4.5" className="fill-white dark:fill-slate-900 stroke-blue-600 dark:stroke-blue-400" strokeWidth="2.2" />
            <text
              x={p.x}
              y={p.y - 9}
              textAnchor="middle"
              className="fill-slate-700 dark:fill-slate-200 text-[10px] font-semibold"
            >
              {p.count}
            </text>
            <text
              x={p.x}
              y={height - 2}
              textAnchor="middle"
              className="fill-slate-500 dark:fill-slate-400 text-[10px]"
            >
              {p.month}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function ChangeTypesDistributionChart({ data }: { data: ChangeDistItem[] }) {
  const navigate = useNavigate();
  if (data.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          No official date or notification changes detected yet. All monitored portals match their live baselines.
        </p>
      </div>
    );
  }

  const total = data.reduce((acc, d) => acc + d.count, 0);
  const colors = [
    'bg-blue-600 dark:bg-blue-500',
    'bg-amber-500 dark:bg-amber-400',
    'bg-emerald-600 dark:bg-emerald-500',
    'bg-indigo-600 dark:bg-indigo-500',
    'bg-rose-600 dark:bg-rose-500',
  ];

  return (
    <div className="space-y-3">
      <div className="h-3 w-full rounded-full overflow-hidden flex bg-slate-100 dark:bg-slate-800">
        {data.map((d, idx) => (
          <div
            key={d.label}
            className={`${colors[idx % colors.length]} h-full transition-all cursor-pointer`}
            style={{ width: `${Math.max(4, Math.round((d.count / Math.max(1, total)) * 100))}%` }}
            title={`${d.label}: ${d.count}`}
            onClick={() => navigate(`/changes?change_type=${encodeURIComponent(d.label)}`)}
          />
        ))}
      </div>
      <div className="space-y-1.5">
        {data.slice(0, 6).map((d, idx) => (
          <button
            key={d.label}
            type="button"
            onClick={() => navigate(`/changes?change_type=${encodeURIComponent(d.label)}`)}
            className="w-full flex items-center justify-between text-xs py-1 px-1.5 rounded hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
          >
            <span className="flex items-center gap-2 text-slate-700 dark:text-slate-300 truncate">
              <span className={`w-2.5 h-2.5 rounded-sm shrink-0 ${colors[idx % colors.length]}`} />
              <span className="truncate">{d.label}</span>
            </span>
            <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{d.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function UpcomingDeadlinesTimelineChart({ data }: { data: DeadlineBucket[] }) {
  const navigate = useNavigate();
  if (data.length === 0) {
    return <p className="text-xs text-slate-500 dark:text-slate-400 py-8 text-center">No upcoming deadlines scheduled.</p>;
  }
  const maxVal = Math.max(1, ...data.map((d) => d.count));

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
      {data.slice(0, 8).map((bucket) => {
        const barH = Math.max(20, Math.round((bucket.count / maxVal) * 88));
        return (
          <button
            key={bucket.month}
            type="button"
            onClick={() => navigate('/calendar')}
            className="group flex flex-col items-center justify-end p-2.5 rounded-lg border border-slate-200/80 dark:border-slate-800 hover:border-blue-300 dark:hover:border-blue-700 bg-slate-50/50 dark:bg-slate-900/50 transition-colors"
          >
            <span className="text-xs font-bold tabular-nums text-slate-800 dark:text-slate-100 mb-1.5">{bucket.count}</span>
            <div className="w-full h-24 flex items-end justify-center">
              <div
                className="w-9 rounded-t-md bg-blue-600/85 dark:bg-blue-500/85 group-hover:bg-blue-700 dark:group-hover:bg-blue-400 transition-all"
                style={{ height: `${barH}px` }}
              />
            </div>
            <span className="mt-2 text-[11px] font-medium tabular-nums text-slate-600 dark:text-slate-400">{bucket.month}</span>
          </button>
        );
      })}
    </div>
  );
}
