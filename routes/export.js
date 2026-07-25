'use strict';
// routes/export.js
//
// PDF and Excel export endpoints for TaskRoom.
// Mounted at /api/export in server.js
//
// SETUP:
//   npm install pdfkit exceljs
//
// Endpoints:
//   GET /api/export/attendance/pdf?employeeId=&from=&to=&department=
//   GET /api/export/attendance/excel?employeeId=&from=&to=&department=
//   GET /api/export/tasks/pdf?employeeId=&from=&to=&status=&priority=&room=
//   GET /api/export/tasks/excel?employeeId=&from=&to=&status=&priority=&room=
//   GET /api/export/team-summary/pdf?from=&to=&department=       (org-level summary)
//   GET /api/export/team-summary/excel?from=&to=&department=
//   GET /api/export/task-compliance/pdf?from=&to=&employeeId=    (proof-of-work audit)
//   GET /api/export/task-compliance/excel?from=&to=&employeeId=
//   GET /api/export/rooms/pdf?from=&to=                          (room / category productivity)
//   GET /api/export/rooms/excel?from=&to=

const express      = require('express');
const PDFDocument  = require('pdfkit');
const ExcelJS      = require('exceljs');
const mongoose     = require('mongoose');
const Attendance   = require('../models/Attendance');
const Task         = require('../models/Task');
const User         = require('../models/User');
const Room         = require('../models/Room');
const Organization = require('../models/Organization');
const authMiddleware = require('../middleware/auth');
const { isManager }  = require('../middleware/roleCheck');
const { requireFeature } = require('../middleware/planGate');

const router = express.Router();
router.use(authMiddleware, isManager, requireFeature('exportReports'));

const STANDARD_WORKDAY_MINUTES = 8 * 60; // used to flag over/under-time days

// ─── Shared helpers ────────────────────────────────────────────────────────────
const parseDate = (str, fallbackDays = 0) => {
  if (str) return new Date(str);
  const d = new Date();
  d.setDate(d.getDate() - fallbackDays);
  d.setHours(0, 0, 0, 0);
  return d;
};

const fmtDate    = d => d ? new Date(d).toLocaleDateString('en-IN') : '—';
const fmtDateTime= d => d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtTime    = d => d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
const fmtMins    = m => { if (!m) return '—'; const h = Math.floor(m / 60); const mn = Math.round(m % 60); return h ? `${h}h ${mn}m` : `${mn}m`; };
const fmtPercent = (n, d) => d ? `${Math.round((n / d) * 100)}%` : '0%';
const safeStr     = v => (v == null ? '' : String(v));
const titleCase    = s => safeStr(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function scoreGrade(score) {
  return score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
}

function calcScore(tasksCompleted, tasksAssigned, totalMinutes, daysPresent) {
  const taskRate  = tasksAssigned > 0 ? Math.min(tasksCompleted / tasksAssigned, 1) : 0;
  const avgHrs    = daysPresent > 0 ? (totalMinutes / 60) / daysPresent : 0;
  const hoursRate = Math.min(avgHrs / 9, 1);
  return Math.round((taskRate * 50) + (hoursRate * 50));
}

// Resolve org + validated date range once per request
async function resolveOrgAndRange(req) {
  const org  = req.org || await Organization.findById(req.user.organization);
  const from = parseDate(req.query.from, 30);
  const to   = parseDate(req.query.to);
  to.setHours(23, 59, 59, 999);
  return { org, from, to };
}

// ─── PDF brand header ──────────────────────────────────────────────────────────
function pdfHeader(doc, orgName, title, subtitle, filters) {
  const W = doc.page.width;

  doc.rect(0, 0, W, 80).fill('#137fec');
  doc.fill('#ffffff').fontSize(20).font('Helvetica-Bold').text('TaskRoom', 40, 24);
  doc.fill('#dbeafe').fontSize(9).font('Helvetica').text('Field Workforce Management', 40, 48);
  doc.fill('#ffffff').fontSize(11).font('Helvetica-Bold')
     .text(orgName, 0, 28, { align: 'right', width: W - 40, lineBreak: false });
  doc.fill('#dbeafe').fontSize(9).font('Helvetica')
     .text(title, 0, 46, { align: 'right', width: W - 40, lineBreak: false });

  doc.rect(0, 80, W, 50).fill('#f8fafc');
  doc.fill('#0f172a').fontSize(15).font('Helvetica-Bold').text(subtitle, 40, 90);

  const metaLine = ['Generated: ' + new Date().toLocaleString('en-IN'), ...(filters || [])].join('   •   ');
  doc.fill('#64748b').fontSize(8).font('Helvetica').text(metaLine, 40, 111, { width: W - 80, lineBreak: false });

  doc.moveTo(40, 132).lineTo(W - 40, 132).strokeColor('#e2e8f0').lineWidth(1).stroke();
  doc.y = 142;
  doc.x = 40;
}

// ─── PDF section title ─────────────────────────────────────────────────────────
function pdfSectionTitle(doc, text) {
  if (doc.y + 24 > doc.page.height - 60) { doc.addPage(); doc.y = 40; }
  const y = doc.y; // capture before .text() mutates doc.y
  doc.fill('#0f172a').fontSize(11).font('Helvetica-Bold').text(text, 40, y, { lineBreak: false });
  doc.y = y + 18; // set explicitly — never trust doc.y after a .text() call
}

// ─── PDF table (with optional per-row background callback + totals row) ───────
function pdfTable(doc, headers, rows, colWidths, opts = {}) {
  const startX    = 40;
  const rowH      = 24;
  const headerRowH = 30; // taller than data rows — headers can be two words (e.g. "TOTAL HOURS")
  const pageW     = doc.page.width - 80;

  if (!colWidths) {
    const w = Math.floor(pageW / headers.length);
    colWidths = headers.map(() => w);
  }

  const drawHeaderRow = () => {
    let x = startX;
    const y = doc.y;
    doc.rect(startX, y, pageW, headerRowH).fill('#1e293b');
    headers.forEach((h, i) => {
      doc.fill('#ffffff').fontSize(7).font('Helvetica-Bold')
         .text(String(h).toUpperCase(), x + 5, y + 6,
               { width: colWidths[i] - 10, align: 'left' });
      x += colWidths[i];
    });
    doc.y = y + headerRowH + 1;
  };

  drawHeaderRow();

  rows.forEach((row, ri) => {
    if (doc.y + rowH > doc.page.height - 60) {
      doc.addPage(); doc.y = 40;
      drawHeaderRow();
    }
    const y  = doc.y;
    const bg = opts.rowBg ? opts.rowBg(row, ri) : (ri % 2 === 0 ? '#f1f5f9' : '#ffffff');
    doc.rect(startX, y, pageW, rowH).fill(bg);

    const accent = opts.accentColor ? opts.accentColor(row, ri) : '#137fec';
    doc.rect(startX, y, 3, rowH).fill(accent);

    let x = startX;
    row.forEach((cell, i) => {
      doc.fill('#1e293b').fontSize(7.8).font('Helvetica')
         .text(safeStr(cell), x + 6, y + 7,
               { width: colWidths[i] - 12, lineBreak: false });
      x += colWidths[i];
    });
    doc.y = y + rowH + 1;
  });

  // Optional totals row
  if (opts.totalsRow) {
    const y = doc.y;
    doc.rect(startX, y, pageW, rowH).fill('#dbeafe');
    let x = startX;
    opts.totalsRow.forEach((cell, i) => {
      doc.fill('#137fec').fontSize(8).font('Helvetica-Bold')
         .text(safeStr(cell), x + 6, y + 7, { width: colWidths[i] - 12, lineBreak: false });
      x += colWidths[i];
    });
    doc.y = y + rowH + 1;
  }

  doc.y += 14;
}

// ─── PDF summary cards (auto width, wraps to new row if too many) ─────────────
function pdfSummaryCards(doc, items) {
  const W       = doc.page.width - 80;
  const maxCols = items.length > 5 ? Math.ceil(items.length / 2) : items.length;
  const colW    = Math.floor(W / maxCols);
  const cardH   = 52;
  const rows    = Math.ceil(items.length / maxCols);
  const blockH  = rows * (cardH + 6);

  // Keep the whole card grid together — never let it split across a page break
  if (doc.y + blockH > doc.page.height - 60) { doc.addPage(); doc.y = 40; }

  const startY = doc.y; // capture ONCE — do not read doc.y again inside the loop,
                         // since .text() mutates it even when x/y are passed explicitly

  items.forEach((item, i) => {
    const col = i % maxCols;
    const row = Math.floor(i / maxCols);
    const x   = 40 + col * colW;
    const y   = startY + row * (cardH + 6);

    doc.rect(x, y, colW - 6, cardH).fill('#eff6ff');
    doc.rect(x, y, colW - 6, 3).fill('#137fec');
    doc.fill('#137fec').fontSize(16).font('Helvetica-Bold')
       .text(safeStr(item.value), x + 10, y + 10, { width: colW - 26, lineBreak: false });
    doc.fill('#64748b').fontSize(7.5).font('Helvetica')
       .text(safeStr(item.label), x + 10, y + 32, { width: colW - 26, lineBreak: false });
  });

  doc.y = startY + blockH + 10; // set explicitly from startY, not from the (now drifted) doc.y
}

// ─── PDF page footer ───────────────────────────────────────────────────────────
function pdfFooter(doc) {
  const W     = doc.page.width;
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.rect(0, doc.page.height - 28, W, 28).fill('#f8fafc');
    doc.fill('#94a3b8').fontSize(8).font('Helvetica')
       .text('TaskRoom — Confidential', 40, doc.page.height - 18, { lineBreak: false });
    doc.fill('#94a3b8').fontSize(8).font('Helvetica')
       .text(`Page ${i + 1} of ${range.count}`, 0, doc.page.height - 18,
             { align: 'right', width: W - 40, lineBreak: false });
  }
}

// ─── Excel style helpers ───────────────────────────────────────────────────────
function excelTitleBlock(ws, lastCol, orgName, title, subtitle) {
  ws.mergeCells(`A1:${lastCol}1`);
  ws.getCell('A1').value = `${orgName} — ${title}`;
  ws.getCell('A1').font  = { bold: true, size: 14 };
  ws.mergeCells(`A2:${lastCol}2`);
  ws.getCell('A2').value = subtitle;
  ws.getCell('A2').font  = { size: 9, color: { argb: 'FF64748B' } };
  ws.addRow([]);
}

function excelHeader(ws, cols) {
  const row = ws.addRow(cols);
  row.eachCell(cell => {
    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.font   = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF64748B' } } };
    cell.alignment = { vertical: 'middle' };
  });
  ws.getRow(row.number).height = 22;
  return row;
}

function excelStripe(ws, headerRowNumber) {
  ws.eachRow((row, n) => {
    if (n <= headerRowNumber) return;
    const fill = n % 2 === 0 ? 'FFF8FAFC' : 'FFFFFFFF';
    row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }; });
  });
}

function excelAutoFilter(ws, headerRowNumber, lastCol) {
  ws.autoFilter = { from: `A${headerRowNumber}`, to: `${lastCol}${headerRowNumber}` };
  ws.views = [{ state: 'frozen', ySplit: headerRowNumber }];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ATTENDANCE REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

async function getAttendanceData(orgId, employeeId, from, to, department) {
  const query = {
    organization: orgId,
    workDate:     { $gte: from, $lte: to },
  };
  if (employeeId && mongoose.Types.ObjectId.isValid(employeeId)) {
    query.employee = new mongoose.Types.ObjectId(employeeId);
  }

  let records = await Attendance.find(query)
    .populate('employee', 'fullName username employeeId department designation')
    .sort({ workDate: -1, 'employee.fullName': 1 });

  if (department) {
    records = records.filter(r => (r.employee?.department || '').toLowerCase() === department.toLowerCase());
  }
  return records;
}

function attendanceEmployeeSummary(records) {
  const map = new Map();
  records.forEach(r => {
    const key = r.employee?._id?.toString() || 'unknown';
    if (!map.has(key)) {
      map.set(key, {
        name:       r.employee?.fullName || r.employee?.username || '—',
        empId:      r.employee?.employeeId || '—',
        department: r.employee?.department || '—',
        daysPresent: 0,
        totalMinutes: 0,
        overtimeDays: 0,
        undertimeDays: 0,
        tasksCompleted: 0,
        sessions: 0,
      });
    }
    const e = map.get(key);
    if (r.totalMinutes > 0) e.daysPresent += 1;
    e.totalMinutes    += r.totalMinutes || 0;
    e.tasksCompleted  += r.tasksCompleted || 0;
    e.sessions        += r.sessions.length;
    if (r.totalMinutes > STANDARD_WORKDAY_MINUTES) e.overtimeDays += 1;
    else if (r.totalMinutes > 0 && r.totalMinutes < STANDARD_WORKDAY_MINUTES) e.undertimeDays += 1;
  });

  return [...map.values()]
    .map(e => ({
      ...e,
      totalHours: parseFloat((e.totalMinutes / 60).toFixed(1)),
      avgHoursPerDay: e.daysPresent ? parseFloat((e.totalMinutes / 60 / e.daysPresent).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes);
}

// GET /api/export/attendance/pdf
router.get('/attendance/pdf', async (req, res) => {
  try {
    const { org, from, to } = await resolveOrgAndRange(req);
    const { employeeId, department } = req.query;
    const records = await getAttendanceData(org._id, employeeId, from, to, department);
    const empSummary = attendanceEmployeeSummary(records);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${Date.now()}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape', bufferPages: true });
    doc.pipe(res);

    const filters = [];
    if (department) filters.push(`Dept: ${department}`);
    if (employeeId) filters.push('Employee filter applied');

    pdfHeader(doc, org.name, 'Attendance Report', `Attendance — ${fmtDate(from)} to ${fmtDate(to)}`, filters);

    const totalDays    = records.length;
    const totalHoursN  = records.reduce((s, r) => s + (r.totalMinutes || 0) / 60, 0);
    const presentDays  = records.filter(r => r.totalMinutes > 0 || r.isOnline).length;
    const avgHours     = presentDays ? (totalHoursN / presentDays).toFixed(1) : '0.0';
    const overtimeDays = records.filter(r => r.totalMinutes > STANDARD_WORKDAY_MINUTES).length;
    const uniqueEmps   = new Set(records.map(r => r.employee?._id?.toString())).size;

    pdfSummaryCards(doc, [
      { label: 'Employees Covered', value: uniqueEmps },
      { label: 'Total Records',     value: totalDays },
      { label: 'Total Hours',       value: totalHoursN.toFixed(1) + 'h' },
      { label: 'Avg Hours/Day',     value: avgHours + 'h' },
      { label: 'Present Days',      value: presentDays },
      { label: 'Overtime Days (>8h)', value: overtimeDays },
    ]);

    // Employee-wise summary section
    pdfSectionTitle(doc, 'Employee-wise Summary');
    pdfTable(
      doc,
      ['Employee', 'Emp ID', 'Department', 'Days Present', 'Total Hours', 'Avg Hrs/Day', 'Overtime Days', 'Tasks Done'],
      empSummary.map(e => [e.name, e.empId, e.department, e.daysPresent, `${e.totalHours}h`, `${e.avgHoursPerDay}h`, e.overtimeDays, e.tasksCompleted]),
      [110, 60, 90, 74, 68, 68, 74, 70],
      {
        totalsRow: ['TOTAL', '', '', presentDays, `${totalHoursN.toFixed(1)}h`, `${avgHours}h`, overtimeDays,
          empSummary.reduce((s, e) => s + e.tasksCompleted, 0)],
      }
    );

    // Daily detail section
    pdfSectionTitle(doc, 'Daily Attendance Detail');
    const headers   = ['Date', 'Employee', 'Emp ID', 'Department', 'First In', 'Last Out', 'Total Hours', 'Sessions', 'Tasks Done', 'Flag'];
    const colWidths = [58, 100, 58, 82, 68, 68, 62, 50, 62, 66];
    const rows      = records.map(r => {
      const flag = r.totalMinutes > STANDARD_WORKDAY_MINUTES ? 'Overtime'
        : r.totalMinutes === 0 ? 'Absent'
        : r.totalMinutes < STANDARD_WORKDAY_MINUTES ? 'Short Day' : 'Normal';
      return [
        fmtDate(r.workDate),
        r.employee?.fullName || r.employee?.username || '—',
        r.employee?.employeeId || '—',
        r.employee?.department || '—',
        r.punchInTime ? fmtTime(r.punchInTime) : (r.sessions[0]?.startTime ? fmtTime(r.sessions[0].startTime) : '—'),
        r.punchOutTime ? fmtTime(r.punchOutTime) : (() => { const last = [...r.sessions].reverse().find(s => s.endTime); return last ? fmtTime(last.endTime) : '—'; })(),
        fmtMins(r.totalMinutes),
        r.sessions.length,
        r.tasksCompleted,
        flag,
      ];
    });

    pdfTable(doc, headers, rows, colWidths, {
      accentColor: row => row[9] === 'Absent' ? '#ef4444' : row[9] === 'Overtime' ? '#f59e0b' : '#137fec',
    });

    pdfFooter(doc);
    doc.end();
  } catch (err) {
    console.error('export/attendance/pdf error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/export/attendance/excel
router.get('/attendance/excel', async (req, res) => {
  try {
    const { org, from, to } = await resolveOrgAndRange(req);
    const { employeeId, department } = req.query;
    const records = await getAttendanceData(org._id, employeeId, from, to, department);
    const empSummary = attendanceEmployeeSummary(records);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TaskRoom';
    wb.created = new Date();

    // ── Sheet 1: Employee Summary ──
    const wsSummary = wb.addWorksheet('Employee Summary', { pageSetup: { fitToPage: true, orientation: 'landscape' } });
    excelTitleBlock(wsSummary, 'H', org.name, 'Attendance — Employee Summary',
      `Period: ${fmtDate(from)} to ${fmtDate(to)}  |  Generated: ${new Date().toLocaleString('en-IN')}`);
    wsSummary.columns = [
      { key: 'name', width: 24 }, { key: 'empId', width: 14 }, { key: 'dept', width: 18 },
      { key: 'days', width: 14 }, { key: 'hours', width: 14 }, { key: 'avg', width: 14 },
      { key: 'overtime', width: 14 }, { key: 'tasks', width: 12 },
    ];
    const sumHeaderRow = excelHeader(wsSummary, ['Employee', 'Emp ID', 'Department', 'Days Present', 'Total Hours', 'Avg Hrs/Day', 'Overtime Days', 'Tasks Done']).number;
    empSummary.forEach(e => wsSummary.addRow([e.name, e.empId, e.department, e.daysPresent, e.totalHours, e.avgHoursPerDay, e.overtimeDays, e.tasksCompleted]));
    excelStripe(wsSummary, sumHeaderRow);
    excelAutoFilter(wsSummary, sumHeaderRow, 'H');

    // ── Sheet 2: Daily Detail ──
    const ws = wb.addWorksheet('Daily Detail', { pageSetup: { fitToPage: true, orientation: 'landscape' } });
    excelTitleBlock(ws, 'J', org.name, 'Attendance — Daily Detail',
      `Period: ${fmtDate(from)} to ${fmtDate(to)}  |  Generated: ${new Date().toLocaleString('en-IN')}`);

    ws.columns = [
      { key: 'date', width: 14 }, { key: 'name', width: 22 }, { key: 'empId', width: 14 },
      { key: 'dept', width: 18 }, { key: 'punchIn', width: 16 }, { key: 'punchOut', width: 16 },
      { key: 'hours', width: 14 }, { key: 'sessions', width: 10 }, { key: 'tasks', width: 10 }, { key: 'flag', width: 12 },
    ];

    const headerRow = excelHeader(ws, ['Date', 'Employee', 'Emp ID', 'Department', 'First Punch-In', 'Last Punch-Out', 'Total Hours', 'Sessions', 'Tasks Done', 'Flag']).number;

    records.forEach(r => {
      const flag = r.totalMinutes > STANDARD_WORKDAY_MINUTES ? 'Overtime'
        : r.totalMinutes === 0 ? 'Absent'
        : r.totalMinutes < STANDARD_WORKDAY_MINUTES ? 'Short Day' : 'Normal';
      const row = ws.addRow({
        date:     fmtDate(r.workDate),
        name:     r.employee?.fullName || r.employee?.username || '—',
        empId:    r.employee?.employeeId || '—',
        dept:     r.employee?.department || '—',
        punchIn:  r.punchInTime ? fmtTime(r.punchInTime) : '—',
        punchOut: r.punchOutTime ? fmtTime(r.punchOutTime) : '—',
        hours:    parseFloat(((r.totalMinutes || 0) / 60).toFixed(2)),
        sessions: r.sessions.length,
        tasks:    r.tasksCompleted,
        flag,
      });
      if (flag === 'Absent') row.getCell('flag').font = { color: { argb: 'FFEF4444' }, bold: true };
      if (flag === 'Overtime') row.getCell('flag').font = { color: { argb: 'FFF59E0B' }, bold: true };
    });

    excelStripe(ws, headerRow);
    excelAutoFilter(ws, headerRow, 'J');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${Date.now()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('export/attendance/excel error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

async function getTaskData(orgId, { employeeId, from, to, status, priority, room }) {
  const query = {
    organization: orgId,
    createdAt: { $gte: from, $lte: to },
  };
  if (employeeId && mongoose.Types.ObjectId.isValid(employeeId)) query.assignedTo = new mongoose.Types.ObjectId(employeeId);
  if (status)   query.status   = status;
  if (priority) query.priority = priority;
  if (room && mongoose.Types.ObjectId.isValid(room)) query.room = new mongoose.Types.ObjectId(room);

  return Task.find(query)
    .populate('assignedTo', 'fullName username employeeId department')
    .populate('createdBy',  'fullName username')
    .populate('room', 'name category')
    .sort({ createdAt: -1 });
}

function taskComplianceStats(tasks) {
  let requiredPhoto = 0, submittedPhoto = 0;
  let requiredSig   = 0, submittedSig   = 0;
  let overdueSteps  = 0, totalSteps = 0;

  tasks.forEach(t => {
    (t.steps || []).forEach(s => {
      totalSteps += 1;
      if (s.validations?.requirePhoto) {
        requiredPhoto += 1;
        if (s.submittedPhotoUrl) submittedPhoto += 1;
      }
      if (s.validations?.requireSignature) {
        requiredSig += 1;
        if (s.signatureData) submittedSig += 1;
      }
      if (s.isOverdue) overdueSteps += 1;
    });
  });

  return { requiredPhoto, submittedPhoto, requiredSig, submittedSig, overdueSteps, totalSteps };
}

// GET /api/export/tasks/pdf
router.get('/tasks/pdf', async (req, res) => {
  try {
    const { org, from, to } = await resolveOrgAndRange(req);
    const { employeeId, status, priority, room } = req.query;
    const tasks = await getTaskData(org._id, { employeeId, from, to, status, priority, room });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="tasks-${Date.now()}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape', bufferPages: true });
    doc.pipe(res);

    const filters = [];
    if (status)   filters.push(`Status: ${titleCase(status)}`);
    if (priority) filters.push(`Priority: ${titleCase(priority)}`);
    if (room)     filters.push('Room filter applied');
    if (employeeId) filters.push('Employee filter applied');

    pdfHeader(doc, org.name, 'Task Report', `Tasks — ${fmtDate(from)} to ${fmtDate(to)}`, filters);

    const byStatus = tasks.reduce((m, t) => { m[t.status] = (m[t.status] || 0) + 1; return m; }, {});
    const compliance = taskComplianceStats(tasks);
    const now = new Date();
    const overdueTasks = tasks.filter(t => ['pending', 'in_progress'].includes(t.status) && t.endDatetime < now).length;

    pdfSummaryCards(doc, [
      { label: 'Total Tasks',   value: tasks.length },
      { label: 'Completed',     value: byStatus.completed || 0 },
      { label: 'In Progress',   value: byStatus.in_progress || 0 },
      { label: 'Pending',       value: byStatus.pending || 0 },
      { label: 'Overdue Now',   value: overdueTasks },
      { label: 'Cancelled',     value: byStatus.cancelled || 0 },
      { label: 'Photo Compliance',     value: fmtPercent(compliance.submittedPhoto, compliance.requiredPhoto) },
      { label: 'Signature Compliance', value: fmtPercent(compliance.submittedSig, compliance.requiredSig) },
    ]);

    pdfSectionTitle(doc, 'Task Detail');
    const headers   = ['Title', 'Room', 'Assigned To', 'Status', 'Priority', 'Start', 'End', 'Steps', 'Field Work', 'Notes'];
    const colWidths = [120, 70, 88, 62, 55, 66, 66, 40, 58, 90];
    const rows      = tasks.map(t => {
      const emp = Array.isArray(t.assignedTo) ? t.assignedTo[0] : t.assignedTo;
      const note = t.status === 'cancelled' ? `Cancelled: ${t.cancellationReason || '—'}` : '';
      return [
        t.title,
        t.room?.name || '—',
        emp?.fullName || emp?.username || '—',
        titleCase(t.status),
        titleCase(t.priority || 'medium'),
        fmtDate(t.startDatetime),
        fmtDate(t.endDatetime),
        `${t.completedSteps || 0}/${t.totalSteps || t.steps?.length || 0}`,
        t.isFieldWork ? 'Yes' : 'No',
        note,
      ];
    });

    pdfTable(doc, headers, rows, colWidths, {
      accentColor: row => row[3] === 'Cancelled' ? '#ef4444' : row[3] === 'Overdue' ? '#f59e0b' : row[3] === 'Completed' ? '#22c55e' : '#137fec',
    });

    pdfFooter(doc);
    doc.end();
  } catch (err) {
    console.error('export/tasks/pdf error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/export/tasks/excel
router.get('/tasks/excel', async (req, res) => {
  try {
    const { org, from, to } = await resolveOrgAndRange(req);
    const { employeeId, status, priority, room } = req.query;
    const tasks = await getTaskData(org._id, { employeeId, from, to, status, priority, room });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TaskRoom';
    const ws   = wb.addWorksheet('Tasks', { pageSetup: { fitToPage: true, orientation: 'landscape' } });

    excelTitleBlock(ws, 'L', org.name, 'Task Report',
      `Period: ${fmtDate(from)} to ${fmtDate(to)}  |  Generated: ${new Date().toLocaleString('en-IN')}`);

    ws.columns = [
      { key: 'title',    width: 30 }, { key: 'room', width: 18 }, { key: 'assigned', width: 22 },
      { key: 'empId',    width: 14 }, { key: 'status', width: 14 }, { key: 'priority', width: 12 },
      { key: 'start',    width: 16 }, { key: 'end',    width: 16 }, { key: 'steps',    width: 10 },
      { key: 'field',    width: 10 }, { key: 'manager',width: 20 }, { key: 'cancelReason', width: 26 },
    ];

    const headerRow = excelHeader(ws, ['Title', 'Room', 'Assigned To', 'Emp ID', 'Status', 'Priority', 'Start', 'End', 'Steps', 'Field Work', 'Created By', 'Cancellation Reason']).number;

    tasks.forEach(t => {
      const emp = Array.isArray(t.assignedTo) ? t.assignedTo[0] : t.assignedTo;
      const row = ws.addRow({
        title:    t.title,
        room:     t.room?.name || '—',
        assigned: emp?.fullName || emp?.username || '—',
        empId:    emp?.employeeId || '—',
        status:   titleCase(t.status),
        priority: titleCase(t.priority || 'medium'),
        start:    fmtDate(t.startDatetime),
        end:      fmtDate(t.endDatetime),
        steps:    `${t.completedSteps || 0}/${t.totalSteps || t.steps?.length || 0}`,
        field:    t.isFieldWork ? 'Yes' : 'No',
        manager:  t.createdBy?.fullName || t.createdBy?.username || '—',
        cancelReason: t.status === 'cancelled' ? (t.cancellationReason || '—') : '',
      });
      if (t.status === 'cancelled') row.getCell('status').font = { color: { argb: 'FFEF4444' }, bold: true };
      if (t.status === 'completed') row.getCell('status').font = { color: { argb: 'FF22C55E' }, bold: true };
    });

    excelStripe(ws, headerRow);
    excelAutoFilter(ws, headerRow, 'L');

    // ── Second sheet: Status × Priority breakdown pivot ──
    const wsPivot = wb.addWorksheet('Status Breakdown');
    excelTitleBlock(wsPivot, 'D', org.name, 'Task Status Breakdown',
      `Period: ${fmtDate(from)} to ${fmtDate(to)}`);
    wsPivot.columns = [{ key: 'status', width: 18 }, { key: 'low', width: 12 }, { key: 'medium', width: 12 }, { key: 'high', width: 12 }];
    const pivotHeaderRow = excelHeader(wsPivot, ['Status', 'Low Priority', 'Medium Priority', 'High Priority']).number;

    const statuses = ['pending', 'in_progress', 'completed', 'overdue', 'cancelled'];
    statuses.forEach(st => {
      const low    = tasks.filter(t => t.status === st && t.priority === 'low').length;
      const medium = tasks.filter(t => t.status === st && t.priority === 'medium').length;
      const high   = tasks.filter(t => t.status === st && t.priority === 'high').length;
      wsPivot.addRow([titleCase(st), low, medium, high]);
    });
    excelStripe(wsPivot, pivotHeaderRow);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="tasks-${Date.now()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('export/tasks/excel error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TEAM SUMMARY (org-wide productivity)
// ═══════════════════════════════════════════════════════════════════════════════

async function getTeamSummaryRows(org, from, to, department) {
  const attendance = await Attendance.aggregate([
    { $match: { organization: org._id, workDate: { $gte: from, $lte: to } } },
    { $group: {
        _id:            '$employee',
        totalMinutes:   { $sum: '$totalMinutes' },
        daysPresent:    { $sum: { $cond: [{ $gt: ['$totalMinutes', 0] }, 1, 0] } },
        tasksCompleted: { $sum: '$tasksCompleted' },
        tasksAssigned:  { $sum: '$tasksAssigned' },
    }},
  ]);

  const empIds = attendance.map(a => a._id);
  const userQuery = { _id: { $in: empIds } };
  const users  = await User.find(userQuery).select('fullName username employeeId department');
  const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u]));

  let rows = attendance.map(a => {
    const u        = userMap[a._id.toString()];
    const rate     = a.tasksAssigned ? Math.round((a.tasksCompleted / a.tasksAssigned) * 100) : 0;
    const avgHours = a.daysPresent ? (a.totalMinutes / 60 / a.daysPresent).toFixed(1) : 0;
    const score    = calcScore(a.tasksCompleted, a.tasksAssigned, a.totalMinutes, a.daysPresent);
    return {
      name:      u?.fullName || u?.username || '—',
      empId:     u?.employeeId || '—',
      dept:      u?.department || '—',
      days:      a.daysPresent,
      totalHrs:  (a.totalMinutes / 60).toFixed(1),
      avgHrs:    avgHours,
      completed: a.tasksCompleted,
      assigned:  a.tasksAssigned,
      rate,
      score,
      grade: scoreGrade(score),
    };
  }).sort((a, b) => b.score - a.score);

  if (department) rows = rows.filter(r => (r.dept || '').toLowerCase() === department.toLowerCase());
  return rows;
}

// GET /api/export/team-summary/pdf
router.get('/team-summary/pdf', async (req, res) => {
  try {
    const { org, from, to } = await resolveOrgAndRange(req);
    const rows = await getTeamSummaryRows(org, from, to, req.query.department);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="team-summary-${Date.now()}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape', bufferPages: true });
    doc.pipe(res);

    const filters = [`Plan: ${titleCase(org.effectivePlan || org.plan)}`];
    if (req.query.department) filters.push(`Dept: ${req.query.department}`);

    pdfHeader(doc, org.name, 'Team Productivity Summary', `Team Summary — ${fmtDate(from)} to ${fmtDate(to)}`, filters);

    const avgScore = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0;
    const gradeDist = rows.reduce((m, r) => { m[r.grade] = (m[r.grade] || 0) + 1; return m; }, {});

    pdfSummaryCards(doc, [
      { label: 'Employees',    value: rows.length },
      { label: 'Avg Score',    value: avgScore + '/100' },
      { label: 'Grade A',      value: gradeDist.A || 0 },
      { label: 'Grade B',      value: gradeDist.B || 0 },
      { label: 'Grade C',      value: gradeDist.C || 0 },
      { label: 'Grade D',      value: gradeDist.D || 0 },
    ]);

    const headers   = ['Rank', 'Employee', 'Emp ID', 'Department', 'Days Present', 'Total Hours', 'Avg Hrs/Day', 'Tasks Done', 'Tasks Assigned', 'Completion %', 'Score', 'Grade'];
    const colWidths = [36, 96, 58, 78, 62, 60, 60, 56, 70, 62, 48, 40];
    const tableRows = rows.map((r, i) => [
      i + 1, r.name, r.empId, r.dept, r.days, `${r.totalHrs}h`, `${r.avgHrs}h`,
      r.completed, r.assigned, `${r.rate}%`, `${r.score}/100`, r.grade,
    ]);

    pdfTable(doc, headers, tableRows, colWidths, {
      accentColor: row => row[11] === 'A' ? '#22c55e' : row[11] === 'D' ? '#ef4444' : '#137fec',
    });

    pdfFooter(doc);
    doc.end();
  } catch (err) {
    console.error('export/team-summary/pdf error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/export/team-summary/excel
router.get('/team-summary/excel', async (req, res) => {
  try {
    const { org, from, to } = await resolveOrgAndRange(req);
    const rows = await getTeamSummaryRows(org, from, to, req.query.department);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TaskRoom';
    const ws = wb.addWorksheet('Team Summary', { pageSetup: { fitToPage: true, orientation: 'landscape' } });

    excelTitleBlock(ws, 'K', org.name, 'Team Productivity Summary',
      `Period: ${fmtDate(from)} to ${fmtDate(to)}  |  Generated: ${new Date().toLocaleString('en-IN')}`);

    ws.columns = [
      { key: 'rank', width: 8 }, { key: 'name', width: 24 }, { key: 'empId', width: 14 },
      { key: 'dept', width: 18 }, { key: 'days', width: 12 }, { key: 'totalHrs', width: 14 },
      { key: 'avgHrs', width: 14 }, { key: 'completed', width: 12 }, { key: 'assigned', width: 14 },
      { key: 'rate', width: 14 }, { key: 'score', width: 10 }, { key: 'grade', width: 8 },
    ];

    const headerRow = excelHeader(ws, [
      'Rank', 'Employee', 'Emp ID', 'Department', 'Days Present', 'Total Hours', 'Avg Hrs/Day',
      'Tasks Done', 'Tasks Assigned', 'Completion %', 'Score', 'Grade',
    ]).number;

    rows.forEach((r, i) => {
      const row = ws.addRow([i + 1, r.name, r.empId, r.dept, r.days, Number(r.totalHrs), Number(r.avgHrs), r.completed, r.assigned, `${r.rate}%`, r.score, r.grade]);
      if (r.grade === 'A') row.getCell(12).font = { color: { argb: 'FF22C55E' }, bold: true };
      if (r.grade === 'D') row.getCell(12).font = { color: { argb: 'FFEF4444' }, bold: true };
    });

    excelStripe(ws, headerRow);
    excelAutoFilter(ws, headerRow, 'L');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="team-summary-${Date.now()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('export/team-summary/excel error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK COMPLIANCE / PROOF-OF-WORK AUDIT  (new)
//  Step-level: was proof required, was it submitted, was step overdue, location.
// ═══════════════════════════════════════════════════════════════════════════════

async function getComplianceRows(orgId, { employeeId, from, to }) {
  const query = { organization: orgId, createdAt: { $gte: from, $lte: to } };
  if (employeeId && mongoose.Types.ObjectId.isValid(employeeId)) query.assignedTo = new mongoose.Types.ObjectId(employeeId);

  const tasks = await Task.find(query)
    .populate('assignedTo', 'fullName username employeeId')
    .sort({ createdAt: -1 });

  const rows = [];
  tasks.forEach(t => {
    const emp = Array.isArray(t.assignedTo) ? t.assignedTo[0] : t.assignedTo;
    (t.steps || []).forEach(s => {
      const needsProof = s.validations?.requirePhoto || s.validations?.requireSignature || s.validations?.requireLocationCheck;
      if (!needsProof) return; // only include steps that actually require proof — audit is meaningful only here
      rows.push({
        taskTitle:  t.title,
        stepTitle:  s.title,
        employee:   emp?.fullName || emp?.username || '—',
        empId:      emp?.employeeId || '—',
        status:     titleCase(s.status),
        photoReq:   s.validations?.requirePhoto ? 'Yes' : 'No',
        photoOk:    s.validations?.requirePhoto ? (s.submittedPhotoUrl ? 'Submitted' : 'Missing') : '—',
        sigReq:     s.validations?.requireSignature ? 'Yes' : 'No',
        sigOk:      s.validations?.requireSignature ? (s.signatureData ? 'Submitted' : 'Missing') : '—',
        locReq:     s.validations?.requireLocationCheck ? 'Yes' : 'No',
        locOk:      s.validations?.requireLocationCheck ? (s.submittedLocation?.coordinates ? 'Verified' : 'Missing') : '—',
        overdue:    s.isOverdue ? 'Yes' : 'No',
        completedAt: s.employeeCompleteTime,
      });
    });
  });
  return rows;
}

router.get('/task-compliance/pdf', async (req, res) => {
  try {
    const { org, from, to } = await resolveOrgAndRange(req);
    const rows = await getComplianceRows(org._id, { employeeId: req.query.employeeId, from, to });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="compliance-${Date.now()}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape', bufferPages: true });
    doc.pipe(res);

    pdfHeader(doc, org.name, 'Compliance Audit', `Proof-of-Work Compliance — ${fmtDate(from)} to ${fmtDate(to)}`);

    const missingPhoto = rows.filter(r => r.photoOk === 'Missing').length;
    const missingSig   = rows.filter(r => r.sigOk === 'Missing').length;
    const missingLoc   = rows.filter(r => r.locOk === 'Missing').length;
    const overdueCount = rows.filter(r => r.overdue === 'Yes').length;

    pdfSummaryCards(doc, [
      { label: 'Steps Requiring Proof', value: rows.length },
      { label: 'Missing Photos',        value: missingPhoto },
      { label: 'Missing Signatures',    value: missingSig },
      { label: 'Missing Location Check',value: missingLoc },
      { label: 'Overdue Steps',         value: overdueCount },
    ]);

    const headers   = ['Task', 'Step', 'Employee', 'Status', 'Photo', 'Signature', 'Location', 'Overdue'];
    const colWidths = [110, 100, 90, 62, 68, 76, 68, 56];
    const tableRows = rows.map(r => [
      r.taskTitle, r.stepTitle, r.employee, r.status,
      r.photoReq === 'Yes' ? r.photoOk : '—',
      r.sigReq   === 'Yes' ? r.sigOk   : '—',
      r.locReq   === 'Yes' ? r.locOk   : '—',
      r.overdue,
    ]);

    pdfTable(doc, headers, tableRows, colWidths, {
      accentColor: row => (row[4] === 'Missing' || row[5] === 'Missing' || row[6] === 'Missing') ? '#ef4444' : '#22c55e',
    });

    pdfFooter(doc);
    doc.end();
  } catch (err) {
    console.error('export/task-compliance/pdf error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/task-compliance/excel', async (req, res) => {
  try {
    const { org, from, to } = await resolveOrgAndRange(req);
    const rows = await getComplianceRows(org._id, { employeeId: req.query.employeeId, from, to });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TaskRoom';
    const ws = wb.addWorksheet('Compliance Audit', { pageSetup: { fitToPage: true, orientation: 'landscape' } });

    excelTitleBlock(ws, 'H', org.name, 'Proof-of-Work Compliance Audit',
      `Period: ${fmtDate(from)} to ${fmtDate(to)}  |  Generated: ${new Date().toLocaleString('en-IN')}`);

    ws.columns = [
      { key: 'task', width: 28 }, { key: 'step', width: 24 }, { key: 'employee', width: 22 },
      { key: 'status', width: 14 }, { key: 'photo', width: 14 }, { key: 'sig', width: 14 },
      { key: 'loc', width: 14 }, { key: 'overdue', width: 10 },
    ];

    const headerRow = excelHeader(ws, ['Task', 'Step', 'Employee', 'Status', 'Photo', 'Signature', 'Location', 'Overdue']).number;

    rows.forEach(r => {
      const row = ws.addRow([
        r.taskTitle, r.stepTitle, r.employee, r.status,
        r.photoReq === 'Yes' ? r.photoOk : '—',
        r.sigReq   === 'Yes' ? r.sigOk   : '—',
        r.locReq   === 'Yes' ? r.locOk   : '—',
        r.overdue,
      ]);
      [5, 6, 7].forEach(col => {
        if (row.getCell(col).value === 'Missing') row.getCell(col).font = { color: { argb: 'FFEF4444' }, bold: true };
        if (row.getCell(col).value === 'Submitted' || row.getCell(col).value === 'Verified') row.getCell(col).font = { color: { argb: 'FF22C55E' } };
      });
    });

    excelStripe(ws, headerRow);
    excelAutoFilter(ws, headerRow, 'H');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="compliance-${Date.now()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('export/task-compliance/excel error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ROOM / CATEGORY PRODUCTIVITY  (new)
// ═══════════════════════════════════════════════════════════════════════════════

async function getRoomRows(orgId, from, to) {
  const rooms = await Room.find({ organization: orgId, isArchived: false }).select('name category stats members');

  const taskAgg = await Task.aggregate([
    { $match: { organization: orgId, createdAt: { $gte: from, $lte: to } } },
    { $group: {
        _id:        '$room',
        total:      { $sum: 1 },
        completed:  { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        cancelled:  { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
        overdue:    { $sum: { $cond: [{ $eq: ['$status', 'overdue'] }, 1, 0] } },
    }},
  ]);
  const taskMap = Object.fromEntries(taskAgg.map(t => [t._id?.toString(), t]));

  return rooms.map(r => {
    const t = taskMap[r._id.toString()] || { total: 0, completed: 0, cancelled: 0, overdue: 0 };
    return {
      name: r.name,
      category: titleCase(r.category),
      activeMembers: r.members.filter(m => m.status === 'active').length,
      totalTasks: t.total,
      completed: t.completed,
      cancelled: t.cancelled,
      overdue: t.overdue,
      completionRate: t.total ? Math.round((t.completed / t.total) * 100) : 0,
    };
  }).sort((a, b) => b.totalTasks - a.totalTasks);
}

router.get('/rooms/pdf', async (req, res) => {
  try {
    const { org, from, to } = await resolveOrgAndRange(req);
    const rows = await getRoomRows(org._id, from, to);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rooms-${Date.now()}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape', bufferPages: true });
    doc.pipe(res);

    pdfHeader(doc, org.name, 'Room Productivity', `Room / Category Productivity — ${fmtDate(from)} to ${fmtDate(to)}`);

    pdfSummaryCards(doc, [
      { label: 'Active Rooms',  value: rows.length },
      { label: 'Total Tasks',   value: rows.reduce((s, r) => s + r.totalTasks, 0) },
      { label: 'Avg Completion', value: rows.length ? Math.round(rows.reduce((s, r) => s + r.completionRate, 0) / rows.length) + '%' : '0%' },
    ]);

    const headers   = ['Room', 'Category', 'Active Members', 'Total Tasks', 'Completed', 'Cancelled', 'Overdue', 'Completion %'];
    const colWidths = [130, 90, 90, 76, 76, 76, 68, 80];
    const tableRows = rows.map(r => [r.name, r.category, r.activeMembers, r.totalTasks, r.completed, r.cancelled, r.overdue, `${r.completionRate}%`]);

    pdfTable(doc, headers, tableRows, colWidths);
    pdfFooter(doc);
    doc.end();
  } catch (err) {
    console.error('export/rooms/pdf error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/rooms/excel', async (req, res) => {
  try {
    const { org, from, to } = await resolveOrgAndRange(req);
    const rows = await getRoomRows(org._id, from, to);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TaskRoom';
    const ws = wb.addWorksheet('Room Productivity', { pageSetup: { fitToPage: true, orientation: 'landscape' } });

    excelTitleBlock(ws, 'H', org.name, 'Room / Category Productivity',
      `Period: ${fmtDate(from)} to ${fmtDate(to)}  |  Generated: ${new Date().toLocaleString('en-IN')}`);

    ws.columns = [
      { key: 'name', width: 26 }, { key: 'category', width: 16 }, { key: 'members', width: 16 },
      { key: 'total', width: 14 }, { key: 'completed', width: 14 }, { key: 'cancelled', width: 14 },
      { key: 'overdue', width: 12 }, { key: 'rate', width: 14 },
    ];

    const headerRow = excelHeader(ws, ['Room', 'Category', 'Active Members', 'Total Tasks', 'Completed', 'Cancelled', 'Overdue', 'Completion %']).number;
    rows.forEach(r => ws.addRow([r.name, r.category, r.activeMembers, r.totalTasks, r.completed, r.cancelled, r.overdue, `${r.completionRate}%`]));
    excelStripe(ws, headerRow);
    excelAutoFilter(ws, headerRow, 'H');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rooms-${Date.now()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('export/rooms/excel error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;