export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 animate-pulse">
      <div className="h-3.5 w-24 rounded bg-slate-200 dark:bg-slate-800 mb-3" />
      <div className="h-5 w-3/4 rounded bg-slate-200 dark:bg-slate-800 mb-3" />
      {Array.from({ length: lines }).map((_, idx) => (
        <div
          key={idx}
          className={`h-3 rounded bg-slate-100 dark:bg-slate-800/70 mb-2 ${idx === lines - 1 ? 'w-1/2' : 'w-full'}`}
        />
      ))}
    </div>
  );
}

export function SkeletonKpiGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 animate-pulse"
        >
          <div className="h-3 w-28 rounded bg-slate-200 dark:bg-slate-800 mb-3" />
          <div className="h-7 w-16 rounded bg-slate-200 dark:bg-slate-800 mb-2" />
          <div className="h-2.5 w-32 rounded bg-slate-100 dark:bg-slate-800/70" />
        </div>
      ))}
    </div>
  );
}
