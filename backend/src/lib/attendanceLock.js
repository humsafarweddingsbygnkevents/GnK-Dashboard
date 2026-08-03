'use strict';

// Attendance locking rules — the single source of truth for time math.
//
// Each day's attendance locks at 19:30 IST. After that, an employee can no
// longer add/edit/delete entries for that day unless an admin has "reopened"
// it (an AttendanceUnlock row). A working day (Mon–Sat) that passed its
// deadline with no entry logged is counted "Absent"; Sundays are off and are
// never absent. India observes no DST, so IST is a fixed UTC+5:30 all year.

const IST_OFFSET_MIN = 5 * 60 + 30; // 330 — Asia/Kolkata, no DST
const DEADLINE_MIN = 19 * 60 + 30; // 1170 — 7:30 PM
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Current IST wall-clock as { date: "YYYY-MM-DD", minutes: minsSinceMidnight }.
// We shift the UTC instant by +5:30 and then read it as if it were UTC, so the
// server's own timezone never matters.
function istNow(now = new Date()) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function todayIST(now = new Date()) {
  return istNow(now).date;
}

// Mon–Sat count by default; Sunday (getUTCDay() === 0) is always off. Some
// accounts work a Mon–Fri week instead — pass their `workWeekdays` (a Set of
// getUTCDay() values, e.g. {1,2,3,4,5}) to exclude Saturday too. Parsed as
// UTC midnight so the weekday doesn't drift with the server's timezone.
function isWorkingDay(dateStr, workWeekdays) {
  const wd = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return workWeekdays ? workWeekdays.has(wd) : wd !== 0;
}

// Has this date's 19:30 IST deadline passed? Past dates: always. Today: only
// after 19:30. Future dates: never.
function isDeadlinePassed(dateStr, now = new Date()) {
  const { date: today, minutes } = istNow(now);
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  return minutes >= DEADLINE_MIN;
}

// "YYYY-MM-DD" one day after the given date (UTC-safe).
function nextDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Inclusive list of "YYYY-MM-DD" strings from `from` to `to`. Caps at `maxDays`
// so a bogus range can't spin forever.
function dateRange(from, to, maxDays = 400) {
  const out = [];
  let cur = from;
  while (cur <= to && out.length < maxDays) {
    out.push(cur);
    cur = nextDate(cur);
  }
  return out;
}

// Short weekday label for a date, in IST-neutral UTC parsing.
function weekdayLabel(dateStr) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
    new Date(`${dateStr}T00:00:00Z`).getUTCDay()
  ];
}

// Per-day status for the attendance sheet. `entriesByDate` maps date -> count,
// `unlockedDates` is a Set of reopened dates, `joinDate` is the employee's
// first expected day (their account creation date, IST). `workWeekdays`
// overrides the default Mon–Sat week for accounts on a Mon–Fri schedule (see
// MON_FRI_EMPLOYEE_IDS in routes/attendance.js). Returns one row per day with
// a display status plus a `locked` flag (writes blocked).
//
//   present  — at least one entry logged
//   pending  — working day, deadline not yet passed, nothing logged
//   unlocked — deadline passed but an admin reopened it; awaiting a fresh entry
//   absent   — working day, deadline passed, nothing logged, not reopened
//   off      — non-working day for this account, or before they joined
function computeDayStatuses({ dates, entriesByDate, unlockedDates, joinDate, workWeekdays, now = new Date() }) {
  return dates.map((date) => {
    const count = entriesByDate.get(date) || 0;
    const unlocked = unlockedDates.has(date);
    const passed = isDeadlinePassed(date, now);
    const working = isWorkingDay(date, workWeekdays);
    const beforeJoin = joinDate && date < joinDate;

    let status;
    if (count > 0) status = 'present';
    else if (!working || beforeJoin) status = 'off';
    else if (!passed) status = 'pending';
    else if (unlocked) status = 'unlocked';
    else status = 'absent';

    return {
      date,
      weekday: weekdayLabel(date),
      working,
      status,
      unlocked,
      // A day is locked to the employee once its deadline passed, unless an
      // admin reopened it. Present/off days locked past deadline become
      // read-only; unlocked days are writable again.
      locked: passed && !unlocked,
      entryCount: count,
    };
  });
}

module.exports = {
  IST_OFFSET_MIN,
  DEADLINE_MIN,
  DATE_RE,
  istNow,
  todayIST,
  isWorkingDay,
  isDeadlinePassed,
  nextDate,
  dateRange,
  weekdayLabel,
  computeDayStatuses,
};
