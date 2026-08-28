import { Fragment, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Expand, Search, Star, X } from 'lucide-react';
import CustomMonthPicker from '../CustomMonthPicker';

const ROLE_ORDER = { ADMIN: 0, SENIOR_TL: 1, TL: 2, CAPTAIN: 3, INTERN: 4 };
const MEMBER_COLUMN_WIDTH = 'w-72 min-w-72 max-w-72';
const ROLE_COLUMN_WIDTH = 'w-40 min-w-40 max-w-40';
const STATUS_COLUMN_WIDTH = 'w-40 min-w-40 max-w-40';
const RATING_COLUMN_WIDTH = 'w-36 min-w-36 max-w-36';
const REASON_COLUMN_WIDTH = 'w-72 min-w-72 max-w-72';

const STATUS_STYLES = {
  ACTIVE:
    'border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900 dark:text-emerald-100',
  COMPLETED:
    'border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-700 dark:bg-blue-900 dark:text-blue-100',
  TERMINATED:
    'border-red-200 bg-red-100 text-red-800 dark:border-red-700 dark:bg-red-900 dark:text-red-100',
  DISCONTINUED:
    'border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-700 dark:bg-orange-900 dark:text-orange-100',
  'IN-ACTIVE':
    'border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-100',
};

function dateOnly(value) {
  if (!value) return null;
  const normalized = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function formatPeriodDate(value) {
  const normalized = dateOnly(value);
  if (!normalized) return 'Date unavailable';
  const [year, month, day] = normalized.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  });
}

function periodKey(rating) {
  const start = dateOnly(rating?.period_start);
  const end = dateOnly(rating?.period_end);
  return start && end ? `${start}|${end}` : null;
}

function ScoreBadge({ value }) {
  if (value == null) {
    return (
      <span className="font-bold text-slate-400 dark:text-slate-500">—</span>
    );
  }
  const score = Number(value);
  const tone =
    score >= 8
      ? 'border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-600 dark:bg-emerald-900 dark:text-emerald-100'
      : score >= 5
        ? 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-500 dark:bg-amber-900 dark:text-amber-100'
        : 'border-red-300 bg-red-100 text-red-800 dark:border-red-600 dark:bg-red-900 dark:text-red-100';
  return (
    <span
      className={`inline-flex min-w-14 items-center justify-center rounded-xl border px-2.5 py-2 text-sm font-black shadow-sm ${tone}`}
    >
      {score.toFixed(1).replace(/\.0$/, '')}/10
    </span>
  );
}

function RatingsGrid({ members, search, fullScreen }) {
  const filteredMembers = useMemo(() => {
    const term = search.trim().toLowerCase();
    return [...members]
      .filter(
        (member) =>
          !term ||
          `${member.full_name || ''} ${member.email || ''} ${member.intern_code || ''} ${member.role || ''}`
            .toLowerCase()
            .includes(term)
      )
      .sort((a, b) => {
        const roleDifference =
          (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99);
        if (roleDifference) return roleDifference;
        return String(a.full_name || a.email || '').localeCompare(
          String(b.full_name || b.email || ''),
          undefined,
          { sensitivity: 'base' }
        );
      });
  }, [members, search]);

  const periods = useMemo(() => {
    const byKey = new Map();
    for (const member of filteredMembers) {
      for (const rating of member.weekly_ratings || []) {
        const key = periodKey(rating);
        if (!key) continue;
        const [start, end] = key.split('|');
        byKey.set(key, { key, start, end });
      }
    }
    return [...byKey.values()].sort((a, b) => a.start.localeCompare(b.start));
  }, [filteredMembers]);

  if (filteredMembers.length === 0) {
    return (
      <div className="p-10 text-center text-sm font-semibold text-slate-500 dark:text-slate-400">
        No department members match this search.
      </div>
    );
  }

  return (
    <div
      className={
        fullScreen
          ? 'min-h-0 flex-1 overflow-auto bg-white dark:bg-slate-900'
          : 'max-h-[62vh] overflow-auto'
      }
    >
      <table className="min-w-max w-full border-separate border-spacing-0 text-sm">
        <thead className="sticky top-0 z-30 bg-slate-50 dark:bg-slate-950">
          <tr>
            <th
              rowSpan={2}
              className={`sticky left-0 z-40 ${MEMBER_COLUMN_WIDTH} border-b border-r border-slate-300 bg-slate-50 px-5 py-4 text-left font-extrabold text-slate-800 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100`}
            >
              Member
            </th>
            <th
              rowSpan={2}
              className={`${ROLE_COLUMN_WIDTH} border-b border-r border-slate-300 bg-slate-50 px-4 py-4 text-center font-extrabold text-slate-800 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100`}
            >
              Role
            </th>
            <th
              rowSpan={2}
              className={`${STATUS_COLUMN_WIDTH} border-b border-r border-slate-300 bg-slate-50 px-4 py-4 text-center font-extrabold text-slate-800 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100`}
            >
              Status
            </th>
            {periods.map((period, index) => (
              <th
                key={period.key}
                colSpan={2}
                className="border-b border-r border-slate-300 bg-slate-50 px-4 py-3 text-center font-extrabold text-slate-800 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
              >
                <div>Week {index + 1}</div>
                <div className="mt-1 text-[11px] font-bold text-slate-500 dark:text-slate-400">
                  {formatPeriodDate(period.start)} to{' '}
                  {formatPeriodDate(period.end)}
                </div>
              </th>
            ))}
          </tr>
          <tr>
            {periods.map((period) => (
              <Fragment key={`${period.key}-columns`}>
                <th
                  className={`${RATING_COLUMN_WIDTH} border-b border-r border-slate-300 bg-slate-50 px-4 py-3 text-center font-extrabold text-slate-700 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-200`}
                >
                  Rating
                </th>
                <th
                  className={`${REASON_COLUMN_WIDTH} border-b border-r border-slate-300 bg-slate-50 px-4 py-3 text-left font-extrabold text-slate-700 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-200`}
                >
                  Reason
                </th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {filteredMembers.map((member, index) => {
            const rowBackground =
              index % 2 === 0
                ? 'bg-white dark:bg-slate-900'
                : 'bg-slate-50 dark:bg-slate-800';
            const status = member.suspended
              ? 'IN-ACTIVE'
              : String(member.internship_status || 'ACTIVE').replaceAll(
                  '_',
                  ' '
                );
            const ratingsByPeriod = new Map(
              (member.weekly_ratings || [])
                .map((rating) => [periodKey(rating), rating])
                .filter(([key]) => key)
            );

            return (
              <tr key={member.id} className={rowBackground}>
                <td
                  className={`sticky left-0 z-20 ${MEMBER_COLUMN_WIDTH} ${rowBackground} border-b border-r border-slate-200 px-5 py-4 dark:border-slate-600`}
                >
                  <div className="font-extrabold text-slate-900 dark:text-white">
                    {member.full_name || 'Unnamed member'}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {member.email}
                  </div>
                  <div className="mt-1 text-xs font-bold text-indigo-600 dark:text-indigo-300">
                    Intern Code: {member.intern_code || '—'}
                  </div>
                </td>
                <td
                  className={`${ROLE_COLUMN_WIDTH} border-b border-r border-slate-200 px-4 py-4 text-center dark:border-slate-600`}
                >
                  <span className="inline-flex rounded-full border border-indigo-200 bg-indigo-100 px-2.5 py-1 text-xs font-extrabold text-indigo-800 dark:border-indigo-700 dark:bg-indigo-900 dark:text-indigo-100">
                    {String(member.role || '').replaceAll('_', ' ')}
                  </span>
                </td>
                <td
                  className={`${STATUS_COLUMN_WIDTH} border-b border-r border-slate-200 px-4 py-4 text-center dark:border-slate-600`}
                >
                  <span
                    className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-extrabold ${
                      STATUS_STYLES[status] || STATUS_STYLES.ACTIVE
                    }`}
                  >
                    {status}
                  </span>
                </td>
                {periods.map((period) => {
                  const rating = ratingsByPeriod.get(period.key);
                  return (
                    <Fragment key={`${member.id}-${period.key}-cells`}>
                      <td
                        className={`${RATING_COLUMN_WIDTH} border-b border-r border-slate-200 px-4 py-3 text-center dark:border-slate-600`}
                      >
                        <ScoreBadge value={rating?.score} />
                      </td>
                      <td
                        className={`${REASON_COLUMN_WIDTH} border-b border-r border-slate-200 px-4 py-3 text-left text-slate-600 dark:border-slate-600 dark:text-slate-300`}
                      >
                        <span
                          className="line-clamp-3"
                          title={rating?.remarks || ''}
                        >
                          {rating?.remarks || '—'}
                        </span>
                      </td>
                    </Fragment>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function DepartmentRatingsSheet({
  departmentName,
  data,
  selectedMonth,
  onMonthChange,
  isLoading,
  error,
  onRetry,
}) {
  const [search, setSearch] = useState('');
  const [fullScreen, setFullScreen] = useState(false);
  const displayedInternCount = useMemo(() => {
    const query = search.trim().toLowerCase();
    return new Set(
      (data?.members || [])
        .filter(
          (member) =>
            !query ||
            `${member.full_name || ''} ${member.email || ''} ${member.intern_code || ''} ${member.role || ''}`
              .toLowerCase()
              .includes(query)
        )
        .map((member) => member.id)
    ).size;
  }, [data?.members, search]);
  const availableMonths = data?.available_months || [];

  useEffect(() => {
    if (
      availableMonths.length > 0 &&
      !availableMonths.includes(selectedMonth)
    ) {
      onMonthChange(availableMonths[0]);
    }
  }, [availableMonths, onMonthChange, selectedMonth]);

  useEffect(() => {
    if (!fullScreen) return undefined;
    document.body.classList.add('modal-open');
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setFullScreen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [fullScreen]);

  const renderContent = (isFullScreen = false) => (
    <div
      className={`overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_14px_35px_rgba(15,23,42,0.06)] dark:border-slate-700 dark:bg-slate-900 dark:shadow-none ${
        isFullScreen ? 'flex h-[calc(100vh-3rem)] min-h-[34rem] flex-col' : ''
      }`}
    >
      <div className="flex flex-col gap-4 border-b border-slate-200 p-5 dark:border-slate-700 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-xs font-extrabold uppercase tracking-[0.2em] text-amber-600 dark:text-amber-300">
            Department ratings sheet
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h3 className="text-xl font-extrabold text-slate-900 dark:text-white">
              {departmentName || 'Department'}
            </h3>
            <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-extrabold text-amber-700 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
              Total Interns: {displayedInternCount}
            </span>
          </div>
          <p className="mt-1 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <Star className="h-4 w-4 fill-amber-400 text-amber-500" />
            Ratings are scored out of 10
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="w-56 text-xs font-bold text-slate-500 dark:text-slate-400">
            Month
            <CustomMonthPicker
              value={selectedMonth}
              onChange={onMonthChange}
              allowedMonths={availableMonths}
              disabled={availableMonths.length === 0}
              className="mt-1"
            />
          </label>
          <div className="relative min-w-56 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search members..."
              className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-800 outline-none focus:border-amber-400 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            />
          </div>
          {!isFullScreen ? (
            <button
              type="button"
              onClick={() => setFullScreen(true)}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-extrabold text-white hover:bg-slate-800 dark:bg-amber-500 dark:text-slate-950 dark:hover:bg-amber-400"
            >
              <Expand className="h-4 w-4" />
              View Full
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setFullScreen(false)}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-extrabold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-white dark:hover:bg-slate-700"
            >
              <X className="h-4 w-4" />
              Close
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-12">
          <div className="h-9 w-9 animate-spin rounded-full border-b-2 border-amber-500" />
        </div>
      ) : error ? (
        <div className="p-10 text-center">
          <p className="font-bold text-red-600 dark:text-red-300">
            {error.response?.data?.error || 'Failed to load department ratings'}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white"
          >
            Retry
          </button>
        </div>
      ) : availableMonths.length === 0 ? (
        <div className="p-12 text-center text-sm font-semibold text-slate-500 dark:text-slate-400">
          No rating months are available for this department.
        </div>
      ) : data?.members?.length ? (
        <RatingsGrid
          members={data.members}
          search={search}
          fullScreen={isFullScreen}
        />
      ) : (
        <div className="p-12 text-center text-sm font-semibold text-slate-500 dark:text-slate-400">
          No members are available in this department view.
        </div>
      )}
    </div>
  );

  return (
    <>
      {renderContent(false)}
      {fullScreen &&
        createPortal(
          <div className="fixed inset-0 z-[9999] overflow-hidden bg-slate-950/80 p-3 backdrop-blur-sm md:p-6">
            <div className="mx-auto h-full max-w-[1800px]">
              {renderContent(true)}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
