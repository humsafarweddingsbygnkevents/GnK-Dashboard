'use strict';

// Attendance locking rules — the single source of truth for time math.
//
// Each day's attendance locks at 20:00 IST. After that, an employee can no
// longer add/edit/delete entries for that day unless an admin has "reopened"
// it (an AttendanceUnlock row). A working day (Mon–Sat) that passed its
// deadline with no entry logged is counted "Absent"; Sundays are off and are
// never absent. India observes no DST, so IST is a fixed UTC+5:30 all year.
//
// A reopening is only good for UNLOCK_WINDOW_MIN (60 minutes) from the moment
// the admin opens it — past that it expires on its own and the day locks
// again, exactly as if the admin had clicked "lock again". This is computed
// live off the AttendanceUnlock row's `createdAt`, no cleanup job required,
// the same way absence itself is computed live rather than stored.

const IST_OFFSET_MIN = 5 * 60 + 30; // 330 — Asia/Kolkata, no DST
const DEADLINE_MIN = 20 * 60; // 1200 — 8:00 PM
const UNLOCK_WINDOW_MIN = 60; // a reopened day auto-locks 1 hour after it was opened
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

// Has this date's 20:00 IST deadline passed? Past dates: always. Today: only
// after 20:00. Future dates: never.
function isDeadlinePassed(dateStr, now = new Date()) {
  const { date: today, minutes } = istNow(now);
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  return minutes >= DEADLINE_MIN;
}

// The instant a date's 20:00 IST deadline falls, in ms since epoch. 20:00 IST
// is 14:30 UTC (1200 − 330 minutes), so this needs no timezone library and
// doesn't move with the server's own clock. Used to tell an entry written
// while the day was still open from one written after it closed.
function deadlineAt(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getTime() + (DEADLINE_MIN - IST_OFFSET_MIN) * 60_000;
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
// MON_FRI_EMPLOYEE_IDS in routes/attendance.js). Days before `joinDate` are
// dropped from the result entirely, for every employee alike — there is
// nothing to say about a day before their account existed, not even "off"
// (which would wrongly suggest a real day was excused). Returns one row per
// remaining day with a display status plus a `locked` flag (writes blocked).
//
//   present  — at least one entry logged, on a day that is closed normally
//   reopened — an admin reopened the day and it now holds entries. Deliberately
//              not "present": a day filled after its deadline, while still open
//              for further edits, is not the same thing as one logged on time,
//              and an admin looking at the sheet has to be able to see which is
//              which — otherwise reopening an absent day quietly turned it green
//              and there was nothing left saying it had ever been reopened.
//   pending  — working day, deadline not yet passed, nothing logged
//   unlocked — deadline passed but an admin reopened it; awaiting a fresh entry
//   absent   — working day, deadline passed, nothing logged, not reopened
//   off      — non-working day for this account (e.g. a Sunday), on or after they joined
//
// `reopenedAt` (date -> when the unlock was created) drives two things: it is
// how a day's `unlocked` flag itself is derived — a raw AttendanceUnlock row
// only counts while it's within UNLOCK_WINDOW_MIN of its `createdAt`; past
// that the day reads exactly as if it had never been reopened. Callers that
// skip `reopenedAt` get unlocks that never expire, so pass it whenever the
// caller's unlocks came from the database (every current caller does).
// Together with `entryUpdatedAt` (date -> newest entry updatedAt) it also
// gives `changedSinceReopen`, i.e. the employee has written to it since the
// admin opened it — the cue for the admin to lock it again, moot once the
// window has already closed it for them. `updatedAt` is deliberately used
// here (not `createdAt`) — ANY touch since the reopening is the signal, remarks
// included, since "has this reopened day been touched at all" is the question.
//
// `entryCreatedAt` (date -> newest entry createdAt) separately gives
// `refilled`: the day holds an entry that was first CREATED after its own
// deadline, so it was filled late rather than on the day. Locking a reopened
// day deletes the unlock row, which would otherwise leave a day that had been
// absent looking identical to one logged on time — this is derived from the
// entries themselves, so it survives the lock and needs no new column. An
// admin writing an entry for a past day (they bypass the deadline, see
// routes/attendance.js) counts too, which is right: the day was still filled
// after it closed.
//
// This deliberately uses createdAt, not updatedAt: remarks can be added (or an
// admin can fix a typo) on an already-on-time day without any of that being a
// "late fill" — Prisma's `@updatedAt` bumps on every field touch regardless of
// which field changed, so `updatedAt` can't tell "refilled" apart from "someone
// added a note afterward." createdAt is set once and never moves, so it can.
function computeDayStatuses({
  dates, entriesByDate, unlockedDates, joinDate, workWeekdays,
  reopenedAt, entryUpdatedAt, entryCreatedAt, now = new Date(),
}) {
  return dates
    .filter((date) => !(joinDate && date < joinDate))
    .map((date) => {
      const count = entriesByDate.get(date) || 0;
      const rawUnlocked = unlockedDates.has(date);
      const openedAt = reopenedAt ? reopenedAt.get(date) : null;
      // A raw unlock row only counts while it's still within its 1-hour
      // window; past that it auto-expires and the day is locked again with
      // no separate job needed to close it — see the note above.
      const expired = Boolean(openedAt) &&
        now.getTime() - openedAt.getTime() >= UNLOCK_WINDOW_MIN * 60_000;
      const unlocked = rawUnlocked && !expired;
      const passed = isDeadlinePassed(date, now);
      const working = isWorkingDay(date, workWeekdays);
      // A reopening only means anything once the day had actually closed. Before
      // the deadline the day is open to the employee anyway, so an unlock row
      // sitting there must not colour a normal day's status.
      const reopened = unlocked && passed;

      let status;
      if (count > 0) status = reopened ? 'reopened' : 'present';
      else if (!working) status = 'off';
      else if (!passed) status = 'pending';
      else if (unlocked) status = 'unlocked';
      else status = 'absent';

      const touchedAt = entryUpdatedAt ? entryUpdatedAt.get(date) : null;
      const createdLateAt = entryCreatedAt ? entryCreatedAt.get(date) : null;

      return {
        date,
        weekday: weekdayLabel(date),
        working,
        status,
        unlocked,
        // A day is locked to the employee once its deadline passed, unless an
        // admin reopened it (and that reopening hasn't expired). Present/off
        // days locked past deadline become read-only; unlocked days are
        // writable again.
        locked: passed && !unlocked,
        // Written to since the reopening — false on a day reopened but not yet
        // touched, so "nothing has changed" and "they've filled it" read apart.
        changedSinceReopen: Boolean(reopened && openedAt && touchedAt && touchedAt > openedAt),
        // Holds an entry first CREATED after its own deadline (not merely edited
        // late — see the note above computeDayStatuses). Outlives the unlock row
        // (and its expiry), so a day stays marked as filled late once it's
        // locked again, whether an admin relocked it or the hour just ran out.
        refilled: Boolean(count > 0 && createdLateAt && createdLateAt.getTime() > deadlineAt(date)),
        entryCount: count,
      };
    });
}

module.exports = {
  IST_OFFSET_MIN,
  DEADLINE_MIN,
  UNLOCK_WINDOW_MIN,
  DATE_RE,
  istNow,
  todayIST,
  isWorkingDay,
  isDeadlinePassed,
  deadlineAt,
  nextDate,
  dateRange,
  weekdayLabel,
  computeDayStatuses,
};
