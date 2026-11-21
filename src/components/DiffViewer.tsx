import type { FieldDiff } from '../types.ts';

interface DiffViewerProps {
  diffs: FieldDiff[];
  beforeSnapshot?: Record<string, string | null> | null;
  afterSnapshot?: Record<string, string | null> | null;
}

const FIELD_LABELS: Record<string, string> = {
  title: 'Notification Title',
  organization_name: 'Organization',
  notification_number: 'Advertisement / Ref No.',
  vacancy_count: 'Vacancies',
  job_category: 'Category',
  qualification: 'Qualification',
  state: 'State / Region',
  application_start_date: 'Application Start Date',
  application_deadline: 'Application Deadline',
  exam_date: 'Examination Date',
  admit_card_date: 'Admit Card Date',
  result_date: 'Result Date',
  description: 'Summary / Description',
  pdf_url: 'Official PDF Link',
  source_url: 'Official Source URL',
  published_date: 'Published Date',
  notification_status: 'Lifecycle Status',
};

export function DiffViewer({ diffs, beforeSnapshot, afterSnapshot }: DiffViewerProps) {
  const rows = diffs.length > 0 ? diffs : [];

  return (
    <div className="space-y-4">
      {rows.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/70 text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="py-2 px-3 font-semibold">Changed Field</th>
                <th className="py-2 px-3 font-semibold">Previous Value</th>
                <th className="py-2 px-3 font-semibold">New Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {rows.map((d, idx) => (
                <tr key={idx} className="bg-white dark:bg-slate-900">
                  <td className="py-2.5 px-3 font-medium text-slate-800 dark:text-slate-200">
                    {FIELD_LABELS[d.field] || d.field}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-rose-700 dark:text-rose-300 bg-rose-50/40 dark:bg-rose-950/20 break-all">
                    {d.old_value || 'Not available'}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-emerald-700 dark:text-emerald-300 bg-emerald-50/40 dark:bg-emerald-950/20 break-all">
                    {d.new_value || 'Not available'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(beforeSnapshot || afterSnapshot) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/50 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
              Previous Version Snapshot
            </div>
            {beforeSnapshot ? (
              <dl className="space-y-1.5 text-xs">
                {Object.entries(beforeSnapshot).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 border-b border-slate-200/60 dark:border-slate-800/60 pb-1">
                    <dt className="text-slate-500 dark:text-slate-400 shrink-0">{FIELD_LABELS[k] || k}</dt>
                    <dd className="text-slate-800 dark:text-slate-200 text-right truncate max-w-[60%]" title={v || 'Not available'}>
                      {v || 'Not available'}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">No prior version (newly discovered).</p>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/50 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
              Updated Version Snapshot
            </div>
            {afterSnapshot ? (
              <dl className="space-y-1.5 text-xs">
                {Object.entries(afterSnapshot).map(([k, v]) => {
                  const changed = beforeSnapshot && beforeSnapshot[k] !== v;
                  return (
                    <div
                      key={k}
                      className={`flex justify-between gap-2 border-b border-slate-200/60 dark:border-slate-800/60 pb-1 ${
                        changed ? 'bg-blue-50/70 dark:bg-blue-950/30 px-1 rounded' : ''
                      }`}
                    >
                      <dt className="text-slate-500 dark:text-slate-400 shrink-0">{FIELD_LABELS[k] || k}</dt>
                      <dd
                        className={`text-right truncate max-w-[60%] ${
                          changed ? 'font-semibold text-blue-700 dark:text-blue-300' : 'text-slate-800 dark:text-slate-200'
                        }`}
                        title={v || 'Not available'}
                      >
                        {v || 'Not available'}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">Removed from official listing.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
