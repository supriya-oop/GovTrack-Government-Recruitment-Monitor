interface StatusBadgeProps {
  label: string;
  size?: 'xs' | 'sm';
}

export function StatusBadge({ label, size = 'xs' }: StatusBadgeProps) {
  const norm = label.toLowerCase();

  let colorClass =
    'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700';

  if (
    norm.includes('applications open') ||
    norm === 'healthy' ||
    norm === 'success' ||
    norm === 'verified' ||
    norm === 'normal'
  ) {
    colorClass =
      'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800';
  } else if (
    norm.includes('closing soon') ||
    norm.includes('admit card') ||
    norm.includes('high') ||
    norm.includes('delayed') ||
    norm.includes('deadline') ||
    norm.includes('exam date')
  ) {
    colorClass =
      'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800';
  } else if (
    norm.includes('cancelled') ||
    norm.includes('removed') ||
    norm.includes('failed') ||
    norm.includes('rate limited') ||
    norm === 'critical' ||
    norm === 'error'
  ) {
    colorClass =
      'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800';
  } else if (
    norm.includes('upcoming exam') ||
    norm.includes('opening soon') ||
    norm.includes('result') ||
    norm.includes('new') ||
    norm.includes('vacancy') ||
    norm.includes('qualification')
  ) {
    colorClass =
      'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800';
  } else if (norm.includes('demo')) {
    colorClass =
      'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-800';
  }

  const sizeClass = size === 'sm' ? 'px-2.5 py-0.5 text-xs' : 'px-2 py-0.5 text-[11px]';

  return (
    <span
      className={`inline-flex items-center font-medium rounded-md border whitespace-nowrap shrink-0 ${sizeClass} ${colorClass}`}
    >
      {label}
    </span>
  );
}
