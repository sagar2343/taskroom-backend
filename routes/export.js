'use strict';
// routes/export.js
//
// PDF and Excel export endpoints.
// Mounted at /api/export in server.js
//
// SETUP:
//   npm install pdfkit exceljs
//
// Endpoints:
//   GET /api/export/attendance/pdf?employeeId=&from=&to=
//   GET /api/export/attendance/excel?employeeId=&from=&to=
//   GET /api/export/tasks/pdf?employeeId=&from=&to=&status=
//   GET /api/export/tasks/excel?employeeId=&from=&to=&status=
//   GET /api/export/team-summary/pdf?from=&to=         (org-level summary)

const express      = require('express');
const PDFDocument  = require('pdfkit');
const ExcelJS      = require('exceljs');
const mongoose     = require('mongoose');
const Attendance   = require('../models/Attendance');
const Task         = require('../models/Task');
const User         = require('../models/User');
const Organization = require('../models/Organization');
const authMiddleware = require('../middleware/auth');
const { isManager }  = require('../middleware/roleCheck');
const { requireFeature } = require('../middleware/planGate');

const router = express.Router();
router.use(authMiddleware, isManager, requireFeature('exportReports'));

// ─── Shared helpers ────────────────────────────────────────────────────────────
const parseDate = (str, fallbackDays = 0) => {
  if (str) return new Date(str);
  const d = new Date();
  d.setDate(d.getDate() - fallbackDays);
  d.setHours(0, 0, 0, 0);
  return d;
};

const fmtDate   = d => d ? new Date(d).toLocaleDateString('en-IN') : '—';
const fmtTime   = d => d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
const fmtMins   = m => { if (!m) return '—'; const h = Math.floor(m / 60); const mn = Math.round(m % 60); return h ? `${h}h ${mn}m` : `${mn}m`; };
const fmtINR    = n => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const safeStr   = v => (v == null ? '' : String(v));

// ─── PDF brand header ──────────────────────────────────────────────────────────
function pdfHeader(doc, orgName, title, subtitle) {
  doc.rect(0, 0, doc.page.width, 72).fill('#1a1a2e');
  doc.fill('#ffffff').fontSize(20).font('Helvetica-Bold').text('TaskRoom', 40, 22);
  doc.fill('#94a3b8').fontSize(9).font('Helvetica').text('Field Workforce Management', 40, 46);

  doc.fill('#ffffff').fontSize(14).font('Helvetica-Bold').text(orgName, 0, 22, { align: 'right', width: doc.page.width - 40 });
  doc.fill('#94a3b8').fontSize(9).font('Helvetica').text(title, 0, 42, { align: 'right', width: doc.page.width - 40 });
  doc.moveDown(0);
  doc.y = 90;

  doc.fill('#1e293b').fontSize(16).font('Helvetica-Bold').text(subtitle, 40, 90);
  doc.fill('#64748b').fontSize(9).font('Helvetica').text(`Generated: ${new Date().toLocaleString('en-IN')}`, 40, 110);
  doc.moveTo(40, 124).lineTo(doc.page.width - 40, 124).strokeColor('#e2e8f0').lineWidth(1).stroke();
  doc.y = 134;
}

// ─── PDF table ─────────────────────────────────────────────────────────────────
function pdfTable(doc, headers, rows, colWidths) {
  const startX   = 40;
  const rowH     = 22;
  const headerH  = 24;
  const pageW    = doc.page.width - 80;

  // Auto-distribute if no widths given
  if (!colWidths) {
    const w = Math.floor(pageW / headers.length);
    colWidths = headers.map(() => w);
  }

  // Header row
  let x = startX;
  doc.rect(startX, doc.y, pageW, headerH).fill('#1e293b');
  headers.forEach((h, i) => {
    doc.fill('#ffffff').fontSize(8).font('Helvetica-Bold')
      .text(h, x + 4, doc.y - headerH + 7, { width: colWidths[i] - 8, lineBreak: false });
    x += colWidths[i];
  });
  doc.y += 4;

  // Data rows
  rows.forEach((row, ri) => {
    if (doc.y + rowH > doc.page.height - 60) { doc.addPage(); doc.y = 40; }
    const bg = ri % 2 === 0 ? '#f8fafc' : '#ffffff';
    doc.rect(startX, doc.y, pageW, rowH).fill(bg);

    x = startX;
    row.forEach((cell, i) => {
      doc.fill('#334155').fontSize(8).font('Helvetica')
        .text(safeStr(cell), x + 4, doc.y - rowH + 7, { width: colWidths[i] - 8, lineBreak: false });
      x += colWidths[i];
    });
    doc.y += 4;
  });

  doc.y += 12;
}

// ─── Excel style helpers ───────────────────────────────────────────────────────
function excelHeader(ws, cols) {
  const row = ws.addRow(cols);
  row.eachCell(cell => {
    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.font   = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF64748B' } } };
    cell.alignment = { vertical: 'middle' };
  });
  ws.getRow(row.number).height = 22;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ATTENDANCE REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

async function getAttendanceData(orgId, employeeId, from, to) {
  const query = {
    organization: orgId,
    workDate:     { $gte: from, $lte: to },
  };
  if (employeeId && mongoose.Types.ObjectId.isValid(employeeId)) {
    query.employee = new mongoose.Types.ObjectId(employeeId);
  }

  return Attendance.find(query)
    .populate('employee', 'fullName username employeeId department')
    .sort({ workDate: -1, 'employee.fullName': 1 });
}

// GET /api/export/attendance/pdf
router.get('/attendance/pdf', async (req, res) => {
  try {
    const org  = req.org || await Organization.findById(req.user.organization);
    const from = parseDate(req.query.from, 30);
    const to   = parseDate(req.query.to);
    to.setHours(23, 59, 59, 999);

    const records = await getAttendanceData(org._id, req.query.employeeId, from, to);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${Date.now()}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    doc.pipe(res);

    pdfHeader(doc, org.name, 'Attendance Report', `Attendance — ${fmtDate(from)} to ${fmtDate(to)}`);

    // Summary cards
    const totalDays    = records.length;
    const totalHours   = records.reduce((s, r) => s + (r.totalMinutes || 0) / 60, 0).toFixed(1);
    const avgHours     = totalDays ? (totalHours / totalDays).toFixed(1) : 0;
    const presentDays  = records.filter(r => r.totalMinutes > 0).length;

    const cards = [
      ['Total Records', totalDays],
      ['Total Hours',   `${totalHours}h`],
      ['Avg Hours/Day', `${avgHours}h`],
      ['Days Present',  presentDays],
    ];
    const cardW = 155, cardH = 52, cardSpacing = 12;
    let cx = 40;
    cards.forEach(([label, val]) => {
      doc.rect(cx, doc.y, cardW, cardH).fill('#f1f5f9');
      doc.fill('#64748b').fontSize(8).font('Helvetica').text(label, cx + 10, doc.y - cardH + 10, { width: cardW - 20 });
      doc.fill('#1e293b').fontSize(20).font('Helvetica-Bold').text(String(val), cx + 10, doc.y - 28, { width: cardW - 20 });
      cx += cardW + cardSpacing;
    });
    doc.y += 20;

    // Table
    const headers   = ['Date', 'Employee', 'Emp ID', 'Department', 'First Punch-In', 'Last Punch-Out', 'Total Hours', 'Sessions', 'Tasks Done'];
    const colWidths = [65, 110, 70, 90, 80, 85, 72, 58, 72];
    const rows      = records.map(r => [
      fmtDate(r.workDate),
      r.employee?.fullName || r.employee?.username || '—',
      r.employee?.employeeId || '—',
      r.employee?.department || '—',
      r.punchInTime ? fmtTime(r.punchInTime) : (r.sessions[0]?.startTime ? fmtTime(r.sessions[0].startTime) : '—'),
      r.punchOutTime ? fmtTime(r.punchOutTime) : (() => { const last = [...r.sessions].reverse().find(s => s.endTime); return last ? fmtTime(last.endTime) : '—'; })(),
      fmtMins(r.totalMinutes),
      r.sessions.length,
      r.tasksCompleted,
    ]);

    pdfTable(doc, headers, rows, colWidths);

    doc.end();
  } catch (err) {
    console.error('export/attendance/pdf error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/export/attendance/excel
router.get('/attendance/excel', async (req, res) => {
  try {
    const org  = req.org || await Organization.findById(req.user.organization);
    const from = parseDate(req.query.from, 30);
    const to   = parseDate(req.query.to);
    to.setHours(23, 59, 59, 999);

    const records = await getAttendanceData(org._id, req.query.employeeId, from, to);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TaskRoom';
    wb.created = new Date();

    const ws = wb.addWorksheet('Attendance', { pageSetup: { fitToPage: true, orientation: 'landscape' } });

    // Title rows
    ws.mergeCells('A1:I1');
    ws.getCell('A1').value = `${org.name} — Attendance Report`;
    ws.getCell('A1').font  = { bold: true, size: 14 };
    ws.mergeCells('A2:I2');
    ws.getCell('A2').value = `Period: ${fmtDate(from)} to ${fmtDate(to)}  |  Generated: ${new Date().toLocaleString('en-IN')}`;
    ws.getCell('A2').font  = { size: 9, color: { argb: 'FF64748B' } };
    ws.addRow([]);

    ws.columns = [
      { key: 'date',    width: 14 },
      { key: 'name',    width: 22 },
      { key: 'empId',   width: 14 },
      { key: 'dept',    width: 18 },
      { key: 'punchIn', width: 16 },
      { key: 'punchOut',width: 16 },
      { key: 'hours',   width: 14 },
      { key: 'sessions',width: 10 },
      { key: 'tasks',   width: 10 },
    ];

    excelHeader(ws, ['Date', 'Employee', 'Emp ID', 'Department', 'First Punch-In', 'Last Punch-Out', 'Total Hours', 'Sessions', 'Tasks Done']);

    records.forEach(r => {
      ws.addRow({
        date:     fmtDate(r.workDate),
        name:     r.employee?.fullName || r.employee?.username || '—',
        empId:    r.employee?.employeeId || '—',
        dept:     r.employee?.department || '—',
        punchIn:  r.punchInTime ? fmtTime(r.punchInTime) : '—',
        punchOut: r.punchOutTime ? fmtTime(r.punchOutTime) : '—',
        hours:    fmtMins(r.totalMinutes),
        sessions: r.sessions.length,
        tasks:    r.tasksCompleted,
      });
    });

    // Alternating rows
    ws.eachRow((row, n) => {
      if (n <= 4) return;
      const fill = n % 2 === 0 ? 'FFF8FAFC' : 'FFFFFFFF';
      row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }; });
    });

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

async function getTaskData(orgId, employeeId, from, to, status) {
  const query = {
    organization: orgId,
    createdAt: { $gte: from, $lte: to },
  };
  if (employeeId && mongoose.Types.ObjectId.isValid(employeeId)) {
    query.assignedTo = new mongoose.Types.ObjectId(employeeId);
  }
  if (status) query.status = status;

  return Task.find(query)
    .populate('assignedTo', 'fullName username employeeId')
    .populate('createdBy',  'fullName username')
    .sort({ createdAt: -1 });
}

// GET /api/export/tasks/pdf
router.get('/tasks/pdf', async (req, res) => {
  try {
    const org  = req.org || await Organization.findById(req.user.organization);
    const from = parseDate(req.query.from, 30);
    const to   = parseDate(req.query.to);
    to.setHours(23, 59, 59, 999);

    const tasks = await getTaskData(org._id, req.query.employeeId, from, to, req.query.status);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="tasks-${Date.now()}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    doc.pipe(res);

    pdfHeader(doc, org.name, 'Task Report', `Tasks — ${fmtDate(from)} to ${fmtDate(to)}`);

    const byStatus = tasks.reduce((m, t) => { m[t.status] = (m[t.status] || 0) + 1; return m; }, {});
    const cards = [
      ['Total Tasks',  tasks.length],
      ['Completed',    byStatus.completed || 0],
      ['In Progress',  byStatus.in_progress || 0],
      ['Pending',      byStatus.pending || 0],
      ['Cancelled',    byStatus.cancelled || 0],
    ];
    const cardW = 128, cardH = 52, cardSpacing = 8;
    let cx = 40;
    cards.forEach(([label, val]) => {
      doc.rect(cx, doc.y, cardW, cardH).fill('#f1f5f9');
      doc.fill('#64748b').fontSize(8).font('Helvetica').text(label, cx + 10, doc.y - cardH + 10, { width: cardW - 20 });
      doc.fill('#1e293b').fontSize(20).font('Helvetica-Bold').text(String(val), cx + 10, doc.y - 28, { width: cardW - 20 });
      cx += cardW + cardSpacing;
    });
    doc.y += 20;

    const headers   = ['Title', 'Assigned To', 'Emp ID', 'Status', 'Priority', 'Start', 'End', 'Steps', 'Field Work'];
    const colWidths = [130, 95, 65, 65, 58, 70, 70, 42, 62];
    const rows      = tasks.map(t => {
      const emp = Array.isArray(t.assignedTo) ? t.assignedTo[0] : t.assignedTo;
      return [
        t.title,
        emp?.fullName || emp?.username || '—',
        emp?.employeeId || '—',
        t.status,
        t.priority || 'normal',
        fmtDate(t.startDatetime),
        fmtDate(t.endDatetime),
        t.steps?.length || 0,
        t.isFieldWork ? 'Yes' : 'No',
      ];
    });

    pdfTable(doc, headers, rows, colWidths);
    doc.end();
  } catch (err) {
    console.error('export/tasks/pdf error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/export/tasks/excel
router.get('/tasks/excel', async (req, res) => {
  try {
    const org  = req.org || await Organization.findById(req.user.organization);
    const from = parseDate(req.query.from, 30);
    const to   = parseDate(req.query.to);
    to.setHours(23, 59, 59, 999);

    const tasks = await getTaskData(org._id, req.query.employeeId, from, to, req.query.status);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TaskRoom';
    const ws   = wb.addWorksheet('Tasks', { pageSetup: { fitToPage: true, orientation: 'landscape' } });

    ws.mergeCells('A1:J1');
    ws.getCell('A1').value = `${org.name} — Task Report`;
    ws.getCell('A1').font  = { bold: true, size: 14 };
    ws.mergeCells('A2:J2');
    ws.getCell('A2').value = `Period: ${fmtDate(from)} to ${fmtDate(to)}  |  Generated: ${new Date().toLocaleString('en-IN')}`;
    ws.addRow([]);

    ws.columns = [
      { key: 'title',    width: 30 },
      { key: 'assigned', width: 22 },
      { key: 'empId',    width: 14 },
      { key: 'status',   width: 14 },
      { key: 'priority', width: 12 },
      { key: 'start',    width: 16 },
      { key: 'end',      width: 16 },
      { key: 'steps',    width: 8  },
      { key: 'field',    width: 10 },
      { key: 'manager',  width: 20 },
    ];

    excelHeader(ws, ['Title', 'Assigned To', 'Emp ID', 'Status', 'Priority', 'Start', 'End', 'Steps', 'Field Work', 'Created By']);

    tasks.forEach(t => {
      const emp = Array.isArray(t.assignedTo) ? t.assignedTo[0] : t.assignedTo;
      ws.addRow({
        title:    t.title,
        assigned: emp?.fullName || emp?.username || '—',
        empId:    emp?.employeeId || '—',
        status:   t.status,
        priority: t.priority || 'normal',
        start:    fmtDate(t.startDatetime),
        end:      fmtDate(t.endDatetime),
        steps:    t.steps?.length || 0,
        field:    t.isFieldWork ? 'Yes' : 'No',
        manager:  t.createdBy?.fullName || t.createdBy?.username || '—',
      });
    });

    ws.eachRow((row, n) => {
      if (n <= 4) return;
      const fill = n % 2 === 0 ? 'FFF8FAFC' : 'FFFFFFFF';
      row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }; });
    });

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
//  TEAM SUMMARY (org-wide productivity PDF)
// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/export/team-summary/pdf?from=&to=
router.get('/team-summary/pdf', async (req, res) => {
  try {
    const org  = req.org || await Organization.findById(req.user.organization);
    const from = parseDate(req.query.from, 30);
    const to   = parseDate(req.query.to);
    to.setHours(23, 59, 59, 999);

    // Aggregate per employee
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
    const users  = await User.find({ _id: { $in: empIds } }).select('fullName username employeeId department');
    const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u]));

    const rows = attendance
      .map(a => {
        const u        = userMap[a._id.toString()];
        const rate     = a.tasksAssigned ? Math.round((a.tasksCompleted / a.tasksAssigned) * 100) : 0;
        const avgHours = a.daysPresent ? (a.totalMinutes / 60 / a.daysPresent).toFixed(1) : 0;
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
          score:     Math.round((rate * 0.5) + (Math.min(Number(avgHours), 9) / 9 * 100 * 0.5)),
        };
      })
      .sort((a, b) => b.score - a.score);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="team-summary-${Date.now()}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    doc.pipe(res);

    pdfHeader(doc, org.name, 'Team Productivity Summary', `Team Summary — ${fmtDate(from)} to ${fmtDate(to)}`);

    const headers   = ['Employee', 'Emp ID', 'Department', 'Days Present', 'Total Hours', 'Avg Hrs/Day', 'Tasks Done', 'Tasks Assigned', 'Completion %', 'Score'];
    const colWidths = [110, 65, 90, 74, 68, 68, 68, 80, 72, 57];
    const tableRows = rows.map(r => [
      r.name, r.empId, r.dept, r.days, `${r.totalHrs}h`, `${r.avgHrs}h`,
      r.completed, r.assigned, `${r.rate}%`, `${r.score}/100`,
    ]);

    pdfTable(doc, headers, tableRows, colWidths);
    doc.end();
  } catch (err) {
    console.error('export/team-summary/pdf error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
