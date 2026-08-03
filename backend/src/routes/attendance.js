'use strict';

const { Router } = require('express');

const router = Router();
const prisma = require('../lib/prisma');
const {
  DATE_RE,
  istNow,
  todayIST,
  isDeadlinePassed,
  dateRange,
  computeDayStatuses,
} = require('../lib/attendanceLock');

const STATUSES = ['in_progress', 'completed', 'blocked', 'on_leave'];

// Accounts on a Mon–Fri week instead of the company default Mon–Sat —
// Saturday counts as a day off for them (never "absent"). Add employee ids
// here as needed.
const MON_FRI_EMPLOYEE_IDS = new Set([]);
const MON_FRI_WEEKDAYS = new Set([1, 2, 3, 4, 5]);

function workWeekdaysFor(employeeId) {
  return MON_FRI_EMPLOYEE_IDS.has(employeeId) ? MON_FRI_WEEKDAYS : undefined;
}

function isAdmin(req) {
  return req.admin?.role === 'admin';
}

// True when an employee may NOT write to `date`: its 19:30 IST deadline has
// passed and no admin has reopened it. Admins are never lock-restricted, so
// callers only invoke this for employee writes.
async function isLockedForEmployee(employeeId, date) {
  if (!isDeadlinePassed(date)) return false;
  const unlock = await prisma.attendanceUnlock.findUnique({
    where: { employeeId_date: { employeeId, date } },
  });
  return !unlock;
}

const LOCK_MSG = 'This day is locked (attendance closes at 7:30 PM). Ask an admin to reopen it.';

function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Validates the writable fields; returns { error } or { data }.
// `partial` allows omitted fields (PATCH).
function parseEntryFields(body, { partial = false } = {}) {
  const b = body || {};
  const data = {};

  if (b.date !== undefined || !partial) {
    if (!validDate(b.date)) return { error: 'date must be a valid YYYY-MM-DD date' };
    data.date = b.date;
  }
  if (b.taskDescription !== undefined || !partial) {
    const t = typeof b.taskDescription === 'string' ? b.taskDescription.trim() : '';
    if (!t) return { error: 'taskDescription is required' };
    if (t.length > 500) return { error: 'taskDescription must be 500 characters or fewer' };
    data.taskDescription = t;
  }
  if (b.timeSpentMinutes !== undefined || !partial) {
    const m = Number(b.timeSpentMinutes);
    if (!Number.isInteger(m) || m < 1 || m > 1440) {
      return { error: 'timeSpentMinutes must be an integer between 1 and 1440' };
    }
    data.timeSpentMinutes = m;
  }
  if (b.status !== undefined || !partial) {
    if (!STATUSES.includes(b.status)) {
      return { error: `status must be one of: ${STATUSES.join(', ')}` };
    }
    data.status = b.status;
  }
  if (b.comment !== undefined) {
    const c = b.comment === null ? null : String(b.comment).trim();
    if (c && c.length > 1000) return { error: 'comment must be 1000 characters or fewer' };
    data.comment = c || null;
  }

  return { data };
}

// GET /api/attendance — employees always see only their own rows (query params
// can't widen the scope); admins see everything, filterable by employee + range.
router.get('/', async (req, res) => {
  try {
    const where = {};
    if (isAdmin(req)) {
      if (req.query.employeeId !== undefined) {
        const id = Number(req.query.employeeId);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid employeeId' });
        where.employeeId = id;
      }
    } else {
      where.employeeId = req.admin.sub;
    }

    const { from, to } = req.query;
    if (from !== undefined || to !== undefined) {
      if ((from !== undefined && !validDate(from)) || (to !== undefined && !validDate(to))) {
        return res.status(400).json({ error: 'from/to must be YYYY-MM-DD dates' });
      }
      where.date = {};
      if (from) where.date.gte = from;
      if (to) where.date.lte = to;
    }

    const entries = await prisma.attendanceEntry.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      include: { employee: { select: { id: true, name: true, email: true } } },
    });
    res.json({ data: entries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/attendance — employeeId is forced from the session for employees
// (same server-side provenance rule as Hotel.source / Client.source); admins
// must name a valid employee.
router.post('/', async (req, res) => {
  try {
    const parsed = parseEntryFields(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let employeeId;
    if (isAdmin(req)) {
      employeeId = Number(req.body?.employeeId);
      if (!Number.isInteger(employeeId)) return res.status(400).json({ error: 'employeeId required' });
      const employee = await prisma.admin.findUnique({ where: { id: employeeId } });
      if (!employee || employee.role !== 'employee') {
        return res.status(400).json({ error: 'Employee not found' });
      }
    } else {
      employeeId = req.admin.sub;
      // Employees can't backfill a locked day; admins bypass the deadline.
      if (await isLockedForEmployee(employeeId, parsed.data.date)) {
        return res.status(403).json({ error: LOCK_MSG });
      }
    }

    const entry = await prisma.attendanceEntry.create({
      data: { ...parsed.data, employeeId },
      include: { employee: { select: { id: true, name: true, email: true } } },
    });
    res.status(201).json(entry);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/attendance/status — day-by-day attendance for a month (or a custom
// from/to range), with each day resolved to present/pending/absent/off/
// unlocked and a `locked` flag. Employees only ever see their own; admins must
// name an employeeId. Absence is computed live here, never stored.
router.get('/status', async (req, res) => {
  try {
    let employeeId;
    if (isAdmin(req)) {
      employeeId = Number(req.query.employeeId);
      if (!Number.isInteger(employeeId)) return res.status(400).json({ error: 'employeeId required' });
    } else {
      employeeId = req.admin.sub;
    }

    const employee = await prisma.admin.findUnique({ where: { id: employeeId } });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    // Default window: the 1st of the current IST month through today.
    const today = todayIST();
    let { from, to } = req.query;
    from = from || `${today.slice(0, 7)}-01`;
    to = to || today;
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
      return res.status(400).json({ error: 'from/to must be YYYY-MM-DD with from <= to' });
    }

    const [entries, unlocks] = await Promise.all([
      prisma.attendanceEntry.findMany({ where: { employeeId, date: { gte: from, lte: to } } }),
      prisma.attendanceUnlock.findMany({ where: { employeeId, date: { gte: from, lte: to } } }),
    ]);

    const entriesByDate = new Map();
    for (const e of entries) entriesByDate.set(e.date, (entriesByDate.get(e.date) || 0) + 1);
    const unlockedDates = new Set(unlocks.map((u) => u.date));

    // The employee isn't "absent" before they existed — clamp expectations to
    // their account creation date (in IST).
    const joinDate = istNow(new Date(employee.createdAt)).date;

    const days = computeDayStatuses({
      dates: dateRange(from, to),
      entriesByDate,
      unlockedDates,
      joinDate,
      workWeekdays: workWeekdaysFor(employeeId),
    });

    // Newest first, matching the entries table.
    days.reverse();

    const summary = days.reduce((acc, d) => {
      acc[d.status] = (acc[d.status] || 0) + 1;
      return acc;
    }, {});

    res.json({ data: { from, to, deadline: '19:30', days, summary } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/attendance/absences — a compact "who was absent" view for the
// dashboard home + attendance pages. Employees see only their own absent dates;
// admins see every active employee's. Default window is the current IST month.
// Absence is derived live (working day, deadline passed, no entry, not reopened).
router.get('/absences', async (req, res) => {
  try {
    const today = todayIST();
    let { from, to } = req.query;
    from = from || `${today.slice(0, 7)}-01`;
    to = to || today;
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
      return res.status(400).json({ error: 'from/to must be YYYY-MM-DD with from <= to' });
    }
    const dates = dateRange(from, to);

    const admin = isAdmin(req);
    const employees = admin
      ? await prisma.admin.findMany({ where: { role: 'employee', active: true }, orderBy: { name: 'asc' } })
      : await prisma.admin.findMany({ where: { id: req.admin.sub } });

    const ids = employees.map((e) => e.id);
    const [entries, unlocks] = await Promise.all([
      prisma.attendanceEntry.findMany({
        where: { employeeId: { in: ids }, date: { gte: from, lte: to } },
        select: { employeeId: true, date: true },
      }),
      prisma.attendanceUnlock.findMany({
        where: { employeeId: { in: ids }, date: { gte: from, lte: to } },
        select: { employeeId: true, date: true },
      }),
    ]);

    const entriesByEmp = new Map();
    for (const e of entries) {
      if (!entriesByEmp.has(e.employeeId)) entriesByEmp.set(e.employeeId, new Map());
      const m = entriesByEmp.get(e.employeeId);
      m.set(e.date, (m.get(e.date) || 0) + 1);
    }
    const unlocksByEmp = new Map();
    for (const u of unlocks) {
      if (!unlocksByEmp.has(u.employeeId)) unlocksByEmp.set(u.employeeId, new Set());
      unlocksByEmp.get(u.employeeId).add(u.date);
    }

    const perEmployee = employees.map((emp) => {
      const days = computeDayStatuses({
        dates,
        entriesByDate: entriesByEmp.get(emp.id) || new Map(),
        unlockedDates: unlocksByEmp.get(emp.id) || new Set(),
        joinDate: istNow(new Date(emp.createdAt)).date,
        workWeekdays: workWeekdaysFor(emp.id),
      });
      // Newest-first list of the dates this employee was marked absent.
      const absentDates = days
        .filter((d) => d.status === 'absent')
        .map((d) => d.date)
        .sort()
        .reverse();
      return {
        id: emp.id,
        name: emp.name || emp.email,
        email: emp.email,
        absentDates,
        absentCount: absentDates.length,
        absentToday: absentDates.includes(today),
      };
    });

    if (admin) {
      return res.json({
        data: {
          scope: 'admin',
          from,
          to,
          today,
          employees: perEmployee,
          totalAbsences: perEmployee.reduce((s, e) => s + e.absentCount, 0),
          absentTodayCount: perEmployee.filter((e) => e.absentToday).length,
        },
      });
    }
    const self = perEmployee[0] || { absentDates: [], absentCount: 0, absentToday: false };
    return res.json({
      data: {
        scope: 'self',
        from,
        to,
        today,
        absentDates: self.absentDates,
        absentCount: self.absentCount,
        absentToday: self.absentToday,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/attendance/unlock — admin reopens a locked day for an employee.
// POST /api/attendance/relock — admin removes that reopening (re-locks it).
// Both are admin-only (this router is shared, so the guard lives here).
function parseUnlockBody(body) {
  const employeeId = Number(body?.employeeId);
  const date = body?.date;
  if (!Number.isInteger(employeeId)) return { error: 'employeeId required' };
  if (typeof date !== 'string' || !DATE_RE.test(date)) return { error: 'date must be YYYY-MM-DD' };
  return { employeeId, date };
}

router.post('/unlock', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
    const { error, employeeId, date } = parseUnlockBody(req.body);
    if (error) return res.status(400).json({ error });

    const employee = await prisma.admin.findUnique({ where: { id: employeeId } });
    if (!employee || employee.role !== 'employee') {
      return res.status(400).json({ error: 'Employee not found' });
    }

    const unlock = await prisma.attendanceUnlock.upsert({
      where: { employeeId_date: { employeeId, date } },
      update: { unlockedBy: req.admin.sub },
      create: { employeeId, date, unlockedBy: req.admin.sub },
    });
    res.json({ ok: true, unlock });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/relock', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
    const { error, employeeId, date } = parseUnlockBody(req.body);
    if (error) return res.status(400).json({ error });

    await prisma.attendanceUnlock.deleteMany({ where: { employeeId, date } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Employees get 404 (not 403) for rows that aren't theirs — a foreign id
// shouldn't even be confirmed to exist.
async function findOwnedEntry(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  const entry = await prisma.attendanceEntry.findUnique({ where: { id } });
  if (!entry || (!isAdmin(req) && entry.employeeId !== req.admin.sub)) {
    res.status(404).json({ error: 'Entry not found' });
    return null;
  }
  return entry;
}

// PATCH /api/attendance/:id — employeeId is immutable; other fields partial.
router.patch('/:id', async (req, res) => {
  try {
    const entry = await findOwnedEntry(req, res);
    if (!entry) return;

    const parsed = parseEntryFields(req.body, { partial: true });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (!Object.keys(parsed.data).length) return res.status(400).json({ error: 'Nothing to update' });

    // Employees can't edit a locked day, nor move an entry into one; both the
    // current date and any new date must be writable. Admins bypass this.
    if (!isAdmin(req)) {
      if (await isLockedForEmployee(entry.employeeId, entry.date)) {
        return res.status(403).json({ error: LOCK_MSG });
      }
      if (parsed.data.date && parsed.data.date !== entry.date &&
          await isLockedForEmployee(entry.employeeId, parsed.data.date)) {
        return res.status(403).json({ error: LOCK_MSG });
      }
    }

    const updated = await prisma.attendanceEntry.update({
      where: { id: entry.id },
      data: parsed.data,
      include: { employee: { select: { id: true, name: true, email: true } } },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/attendance/:id
router.delete('/:id', async (req, res) => {
  try {
    const entry = await findOwnedEntry(req, res);
    if (!entry) return;
    if (!isAdmin(req) && await isLockedForEmployee(entry.employeeId, entry.date)) {
      return res.status(403).json({ error: LOCK_MSG });
    }
    await prisma.attendanceEntry.delete({ where: { id: entry.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
