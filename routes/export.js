'use strict';
// routes/export.js — Professional PDF & Excel exports
// npm install pdfkit exceljs

const express      = require('express');
const PDFDocument  = require('pdfkit');
const ExcelJS      = require('exceljs');
const mongoose     = require('mongoose');
const Attendance   = require('../models/Attendance');
const Task         = require('../models/Task');
const User         = require('../models/User');
const Organization = require('../models/Organization');
const authMiddleware   = require('../middleware/auth');
const { isManager }    = require('../middleware/roleCheck');
const { requireFeature } = require('../middleware/planGate');

const router = express.Router();
router.use(authMiddleware, isManager, requireFeature('exportReports'));

// ─── Helpers ─────────────────────────────────────────────────────────────────
const parseDate = (str, fallbackDaysAgo = 0) => {
  if (str) return new Date(str);
  const d = new Date();
  d.setDate(d.getDate() - fallbackDaysAgo);
  d.setHours(0, 0, 0, 0);
  return d;
};
const fmtDate  = d => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const fmtTime  = d => d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
const fmtMins  = m => { if (!m) return '0m'; const h = Math.floor(m / 60), mn = Math.round(m % 60); return h ? `${h}h ${mn}m` : `${mn}m`; };
const safeStr  = v => v == null ? '' : String(v);

// ─── Brand colours (ARGB for ExcelJS, hex for PDFKit) ────────────────────────
const BRAND = {
  primary:   '#137fec',
  dark:      '#0a1929',
  surface:   '#0f1822',
  text:      '#f0f6ff',
  textMuted: '#8ba3be',
  green:     '#10b981',
  amber:     '#f59e0b',
  red:       '#ef4444',
  white:     '#ffffff',
  // ExcelJS ARGB (alpha FF = opaque)
  xl: {
    primary:  'FF137fec',
    dark:     'FF0a1929',
    header:   'FF162030',
    row1:     'FF0f1822',
    row2:     'FF162030',
    green:    'FF10b981',
    amber:    'FFf59e0b',
    red:      'FFef4444',
    white:    'FFf0f6ff',
    muted:    'FF8ba3be',
    border:   'FF1c2a3a',
  }
};

// ═══════════════════════════════════════════════════════════════════════
//  PDF BUILDER — shared utility
// ═══════════════════════════════════════════════════════════════════════
function createPDF(res, filename) {
  const doc = new PDFDocument({ margin: 0, size: 'A4', layout: 'landscape', autoFirstPage: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  doc.pipe(res);
  return doc;
}

/**
 * Draw the branded page header. Returns the Y coordinate after the header.
 */
function drawHeader(doc, orgName, reportTitle, dateRange) {
  const W = doc.page.width;

  // Dark navy banner
  doc.rect(0, 0, W, 68).fill(BRAND.dark);

  // Orange left accent bar
  doc.rect(0, 0, 4, 68).fill(BRAND.primary);

  // Logo text
  doc.fill(BRAND.primary).fontSize(18).font('Helvetica-Bold').text('TaskRoom', 22, 16);
  doc.fill('#4a9ff5').fontSize(9).font('Helvetica').text('Field Workforce Management', 22, 38);

  // Org + report info (right-aligned)
  doc.fill(BRAND.text).fontSize(12).font('Helvetica-Bold').text(orgName, 0, 14, { width: W - 24, align: 'right' });
  doc.fill(BRAND.textMuted).fontSize(9).font('Helvetica').text(reportTitle, 0, 30, { width: W - 24, align: 'right' });
  doc.fill(BRAND.textMuted).fontSize(8).text(dateRange, 0, 44, { width: W - 24, align: 'right' });

  // Separator line
  doc.rect(0, 68, W, 2).fill(BRAND.primary);

  return 78; // Y after header
}

/**
 * Draw a row of summary stat cards. `stats` = [{label, value, color?}]
 */
function drawStatCards(doc, stats, startY) {
  const W      = doc.page.width;
  const margin = 20;
  const cols   = stats.length;
  const gutter = 8;
  const cardW  = (W - margin * 2 - gutter * (cols - 1)) / cols;
  const cardH  = 50;

  stats.forEach((s, i) => {
    const x = margin + i * (cardW + gutter);
    const color = s.color || BRAND.primary;

    // Card background
    doc.roundedRect(x, startY, cardW, cardH, 6).fill('#162030');
    // Left accent bar
    doc.rect(x, startY, 3, cardH).fill(color);

    // Label
    doc.fill(BRAND.textMuted).fontSize(8).font('Helvetica')
       .text(s.label.toUpperCase(), x + 10, startY + 9, { width: cardW - 14, lineBreak: false });

    // Value
    doc.fill(s.color || BRAND.text).fontSize(20).font('Helvetica-Bold')
       .text(safeStr(s.value), x + 10, startY + 20, { width: cardW - 14, lineBreak: false });
  });

  return startY + cardH + 14;
}

/**
 * Draw a professional data table.
 * headers = string[]
 * rows    = (string|{text,color})[][]
 * colW    = number[]  (pixel widths summing ≈ page width - 40)
 */
function drawTable(doc, headers, rows, colW, startY) {
  const margin  = 20;
  const rowH    = 20;
  const headH   = 24;
  const W       = doc.page.width;
  const fontSize = 8;

  let y = startY;

  const drawHeaderRow = () => {
    doc.rect(margin, y, W - margin * 2, headH).fill('#162030');
    let x = margin;
    headers.forEach((h, i) => {
      doc.fill(BRAND.primary).fontSize(fontSize).font('Helvetica-Bold')
         .text(safeStr(h).toUpperCase(), x + 5, y + 8, { width: colW[i] - 8, lineBreak: false });
      x += colW[i];
    });
    y += headH;
  };

  drawHeaderRow();

  rows.forEach((row, ri) => {
    // Page break
    if (y + rowH > doc.page.height - 30) {
      doc.addPage();
      doc.rect(0, 0, 4, doc.page.height).fill(BRAND.primary); // left bar
      y = 20;
      drawHeaderRow();
    }

    // Alternating row bg
    const bg = ri % 2 === 0 ? '#0f1822' : '#111d2b';
    doc.rect(margin, y, W - margin * 2, rowH).fill(bg);

    let x = margin;
    row.forEach((cell, ci) => {
      const isObj = cell && typeof cell === 'object';
      const text  = isObj ? safeStr(cell.text) : safeStr(cell);
      const color = isObj && cell.color ? cell.color : BRAND.textMuted;
      doc.fill(color).fontSize(fontSize).font('Helvetica')
         .text(text, x + 5, y + 6, { width: colW[ci] - 8, lineBreak: false });
      x += colW[ci];
    });

    // Row bottom border
    doc.moveTo(margin, y + rowH).lineTo(W - margin, y + rowH).strokeColor('#1c2a3a').lineWidth(0.5).stroke();
    y += rowH;
  });

  return y + 8;
}

/** Draw PDF footer with page number */
function drawFooter(doc) {
  const W = doc.page.width;
  const H = doc.page.height;
  doc.rect(0, H - 22, W, 22).fill('#0a1929');
  doc.fill(BRAND.textMuted).fontSize(7.5).font('Helvetica')
     .text(`Generated by TaskRoom · ${new Date().toLocaleString('en-IN')}`, 22, H - 14, { lineBreak: false });
  doc.text(`Page ${doc.bufferedPageRange().count}`, 0, H - 14, { width: W - 22, align: 'right', lineBreak: false });
}

// ═══════════════════════════════════════════════════════════════════════
//  EXCEL BUILDER — shared utility
// ═══════════════════════════════════════════════════════════════════════
function styleHeaderRow(ws, rowNum, cols) {
  const row = ws.getRow(rowNum);
  cols.forEach((_, ci) => {
    const cell = row.getCell(ci + 1);
    cell.font      = { bold: true, color: { argb: BRAND.xl.white }, size: 10, name: 'Calibri' };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.xl.header } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border    = { bottom: { style: 'thin', color: { argb: BRAND.xl.primary } } };
  });
  row.height = 22;
}

function styleTitleRows(ws, numCols, title, subtitle) {
  // Title
  ws.mergeCells(1, 1, 1, numCols);
  const t = ws.getCell('A1');
  t.value = title;
  t.font  = { bold: true, size: 14, color: { argb: BRAND.xl.white }, name: 'Calibri' };
  t.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.xl.dark } };
  t.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 28;

  // Subtitle
  ws.mergeCells(2, 1, 2, numCols);
  const s = ws.getCell('A2');
  s.value = subtitle;
  s.font  = { size: 9, color: { argb: BRAND.xl.muted }, name: 'Calibri' };
  s.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.xl.dark } };
  ws.getRow(2).height = 16;

  // Blank separator
  ws.getRow(3).height = 6;
  for (let c = 1; c <= numCols; c++) {
    ws.getCell(3, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.xl.dark } };
  }

  return 4; // first data row
}

function styleDataRows(ws, startRow, numCols) {
  ws.eachRow((row, rowNum) => {
    if (rowNum < startRow) return;
    const bg = rowNum % 2 === 0 ? BRAND.xl.row2 : BRAND.xl.row1;
    row.eachCell({ includeEmpty: true }, cell => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.font      = { size: 10, color: { argb: BRAND.xl.white }, name: 'Calibri' };
      cell.alignment = { vertical: 'middle' };
      cell.border    = { bottom: { style: 'hair', color: { argb: BRAND.xl.border } } };
    });
  });
}

async function sendExcel(wb, res, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  await wb.xlsx.write(res);
  res.end();
}

// ═══════════════════════════════════════════════════════════════════════
//  DATA FETCHERS
// ═══════════════════════════════════════════════════════════════════════
async function fetchAttendance(orgId, employeeId, from, to) {
  const q = { organization: orgId, workDate: { $gte: from, $lte: to } };
  if (employeeId && mongoose.Types.ObjectId.isValid(employeeId))
    q.employee = new mongoose.Types.ObjectId(employeeId);
  return Attendance.find(q)
    .populate('employee', 'fullName username employeeId department designation')
    .sort({ workDate: -1, 'employee.fullName': 1 });
}

async function fetchTasks(orgId, employeeId, from, to, status) {
  const q = { organization: orgId, createdAt: { $gte: from, $lte: to } };
  if (employeeId && mongoose.Types.ObjectId.isValid(employeeId))
    q.assignedTo = new mongoose.Types.ObjectId(employeeId);
  if (status) q.status = status;
  return Task.find(q)
    .populate('assignedTo', 'fullName username employeeId')
    .populate('createdBy',  'fullName username')
    .sort({ createdAt: -1 });
}

// ═══════════════════════════════════════════════════════════════════════
//  ATTENDANCE — PDF
// ═══════════════════════════════════════════════════════════════════════
router.get('/attendance/pdf', async (req, res) => {
  try {
    const org  = await Organization.findById(req.user.organization);
    const from = parseDate(req.query.from, 30);
    const to   = parseDate(req.query.to); to.setHours(23, 59, 59, 999);

    const records = await fetchAttendance(org._id, req.query.employeeId, from, to);
    const doc = createPDF(res, `taskroom-attendance-${Date.now()}.pdf`);

    let y = drawHeader(doc, org.name, 'Attendance Report', `${fmtDate(from)} — ${fmtDate(to)}`);

    const totalMins    = records.reduce((s, r) => s + (r.totalMinutes || 0), 0);
    const presentDays  = records.filter(r => r.totalMinutes > 0).length;
    const avgHrs       = presentDays ? ((totalMins / 60) / presentDays).toFixed(1) : 0;

    y = drawStatCards(doc, [
      { label: 'Total Records',  value: records.length,           color: BRAND.primary },
      { label: 'Present Days',   value: presentDays,              color: BRAND.green   },
      { label: 'Total Hours',    value: `${(totalMins/60).toFixed(1)}h`, color: BRAND.amber  },
      { label: 'Avg Hrs / Day',  value: `${avgHrs}h`,             color: '#8b5cf6'     },
    ], y);

    const headers = ['Date', 'Employee', 'Emp ID', 'Department', 'Punch In', 'Punch Out', 'Total Hours', 'Sessions', 'Tasks Done'];
    const colW    = [65, 100, 64, 90, 70, 72, 68, 54, 64];

    const rows = records.map(r => [
      { text: fmtDate(r.workDate),                                        color: BRAND.text    },
      { text: r.employee?.fullName || r.employee?.username || '—',        color: BRAND.text    },
      { text: r.employee?.employeeId || '—',                              color: BRAND.primary },
      { text: r.employee?.department || '—',                              color: BRAND.textMuted },
      { text: r.punchInTime  ? fmtTime(r.punchInTime)  : (r.sessions?.[0]?.startTime ? fmtTime(r.sessions[0].startTime) : '—') },
      { text: r.punchOutTime ? fmtTime(r.punchOutTime) : '—'                                 },
      { text: fmtMins(r.totalMinutes), color: (r.totalMinutes||0) >= 480 ? BRAND.green : BRAND.textMuted },
      { text: String(r.sessions?.length || 0)                             },
      { text: String(r.tasksCompleted || 0)                               },
    ]);

    drawTable(doc, headers, rows, colW, y);
    drawFooter(doc);
    doc.end();
  } catch (err) {
    console.error('export/attendance/pdf:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ATTENDANCE — Excel ──────────────────────────────────────────────────────
router.get('/attendance/excel', async (req, res) => {
  try {
    const org  = await Organization.findById(req.user.organization);
    const from = parseDate(req.query.from, 30);
    const to   = parseDate(req.query.to); to.setHours(23, 59, 59, 999);
    const records = await fetchAttendance(org._id, req.query.employeeId, from, to);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TaskRoom';
    const ws = wb.addWorksheet('Attendance', { pageSetup: { fitToPage: true, orientation: 'landscape' } });

    ws.columns = [
      { key: 'date',    width: 16 }, { key: 'name',     width: 24 },
      { key: 'empId',   width: 14 }, { key: 'dept',     width: 18 },
      { key: 'punchIn', width: 14 }, { key: 'punchOut', width: 14 },
      { key: 'hours',   width: 14 }, { key: 'sessions', width: 10 },
      { key: 'tasks',   width: 10 },
    ];

    const firstDataRow = styleTitleRows(ws, 9,
      `${org.name} — Attendance Report`,
      `Period: ${fmtDate(from)} to ${fmtDate(to)}  |  Generated: ${new Date().toLocaleString('en-IN')}  |  Records: ${records.length}`
    );

    ws.getRow(firstDataRow).values = ['Date','Employee','Emp ID','Department','Punch In','Punch Out','Total Hours','Sessions','Tasks Done'];
    styleHeaderRow(ws, firstDataRow, ws.columns);

    records.forEach(r => {
      const row = ws.addRow({
        date:    fmtDate(r.workDate),
        name:    r.employee?.fullName || r.employee?.username || '—',
        empId:   r.employee?.employeeId || '—',
        dept:    r.employee?.department || '—',
        punchIn: r.punchInTime ? fmtTime(r.punchInTime) : '—',
        punchOut:r.punchOutTime ? fmtTime(r.punchOutTime) : '—',
        hours:   fmtMins(r.totalMinutes),
        sessions:r.sessions?.length || 0,
        tasks:   r.tasksCompleted || 0,
      });
      // Colour total hours cell
      const hoursCell = row.getCell('hours');
      if ((r.totalMinutes || 0) >= 480) hoursCell.font = { color: { argb: BRAND.xl.green }, bold: true, size: 10, name: 'Calibri' };
    });

    styleDataRows(ws, firstDataRow + 1, 9);
    await sendExcel(wb, res, `taskroom-attendance-${Date.now()}.xlsx`);
  } catch (err) {
    console.error('export/attendance/excel:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  TASKS — PDF
// ═══════════════════════════════════════════════════════════════════════
router.get('/tasks/pdf', async (req, res) => {
  try {
    const org   = await Organization.findById(req.user.organization);
    const from  = parseDate(req.query.from, 30);
    const to    = parseDate(req.query.to); to.setHours(23, 59, 59, 999);
    const tasks = await fetchTasks(org._id, req.query.employeeId, from, to, req.query.status);

    const doc = createPDF(res, `taskroom-tasks-${Date.now()}.pdf`);
    let y = drawHeader(doc, org.name, 'Task Report', `${fmtDate(from)} — ${fmtDate(to)}`);

    const byStatus = tasks.reduce((m, t) => { m[t.status] = (m[t.status] || 0) + 1; return m; }, {});
    y = drawStatCards(doc, [
      { label: 'Total Tasks',  value: tasks.length,              color: BRAND.primary },
      { label: 'Completed',    value: byStatus.completed || 0,   color: BRAND.green   },
      { label: 'In Progress',  value: byStatus.in_progress || 0, color: BRAND.amber   },
      { label: 'Pending',      value: byStatus.pending || 0,     color: '#8b5cf6'     },
      { label: 'Cancelled',    value: byStatus.cancelled || 0,   color: BRAND.red     },
    ], y);

    const headers = ['Title', 'Assigned To', 'Emp ID', 'Status', 'Priority', 'Start', 'Deadline', 'Steps', 'GPS'];
    const colW    = [115, 90, 62, 64, 54, 68, 68, 38, 34];

    const statusColor = { completed: BRAND.green, in_progress: BRAND.primary, pending: BRAND.textMuted, cancelled: BRAND.red, overdue: BRAND.red };

    const rows = tasks.map(t => {
      const emp = Array.isArray(t.assignedTo) ? t.assignedTo[0] : t.assignedTo;
      return [
        { text: t.title,                         color: BRAND.text    },
        { text: emp?.fullName || emp?.username || '—', color: BRAND.text },
        { text: emp?.employeeId || '—',          color: BRAND.primary },
        { text: (t.status || '').replace('_', ' '), color: statusColor[t.status] || BRAND.textMuted },
        { text: t.priority || 'medium',          color: t.priority === 'high' ? BRAND.red : t.priority === 'low' ? BRAND.green : BRAND.amber },
        { text: fmtDate(t.startDatetime)         },
        { text: fmtDate(t.endDatetime)           },
        { text: String(t.steps?.length || 0)     },
        { text: t.isFieldWork ? '✓' : '—',       color: t.isFieldWork ? BRAND.green : BRAND.textMuted },
      ];
    });

    drawTable(doc, headers, rows, colW, y);
    drawFooter(doc);
    doc.end();
  } catch (err) {
    console.error('export/tasks/pdf:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// ─── TASKS — Excel ───────────────────────────────────────────────────────────
router.get('/tasks/excel', async (req, res) => {
  try {
    const org   = await Organization.findById(req.user.organization);
    const from  = parseDate(req.query.from, 30);
    const to    = parseDate(req.query.to); to.setHours(23, 59, 59, 999);
    const tasks = await fetchTasks(org._id, req.query.employeeId, from, to, req.query.status);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TaskRoom';
    const ws = wb.addWorksheet('Tasks', { pageSetup: { fitToPage: true, orientation: 'landscape' } });

    ws.columns = [
      { key: 'title',    width: 32 }, { key: 'assigned', width: 22 },
      { key: 'empId',    width: 14 }, { key: 'status',   width: 14 },
      { key: 'priority', width: 12 }, { key: 'start',    width: 16 },
      { key: 'end',      width: 16 }, { key: 'steps',    width: 8  },
      { key: 'gps',      width: 8  }, { key: 'manager',  width: 20 },
    ];

    const firstDataRow = styleTitleRows(ws, 10,
      `${org.name} — Task Report`,
      `Period: ${fmtDate(from)} to ${fmtDate(to)}  |  Total: ${tasks.length} tasks  |  Generated: ${new Date().toLocaleString('en-IN')}`
    );

    ws.getRow(firstDataRow).values = ['Title','Assigned To','Emp ID','Status','Priority','Start','Deadline','Steps','GPS','Created By'];
    styleHeaderRow(ws, firstDataRow, ws.columns);

    tasks.forEach(t => {
      const emp = Array.isArray(t.assignedTo) ? t.assignedTo[0] : t.assignedTo;
      ws.addRow({
        title:    t.title,
        assigned: emp?.fullName || emp?.username || '—',
        empId:    emp?.employeeId || '—',
        status:   (t.status || '').replace('_', ' '),
        priority: t.priority || 'medium',
        start:    fmtDate(t.startDatetime),
        end:      fmtDate(t.endDatetime),
        steps:    t.steps?.length || 0,
        gps:      t.isFieldWork ? 'Yes' : 'No',
        manager:  t.createdBy?.fullName || t.createdBy?.username || '—',
      });
    });

    styleDataRows(ws, firstDataRow + 1, 10);
    await sendExcel(wb, res, `taskroom-tasks-${Date.now()}.xlsx`);
  } catch (err) {
    console.error('export/tasks/excel:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  TEAM SUMMARY — PDF (org-wide productivity)
// ═══════════════════════════════════════════════════════════════════════
router.get('/team-summary/pdf', async (req, res) => {
  try {
    const org  = await Organization.findById(req.user.organization);
    const from = parseDate(req.query.from, 30);
    const to   = parseDate(req.query.to); to.setHours(23, 59, 59, 999);

    const attStats = await Attendance.aggregate([
      { $match: { organization: org._id, workDate: { $gte: from, $lte: to } } },
      { $group: {
          _id:            '$employee',
          totalMinutes:   { $sum: '$totalMinutes' },
          daysPresent:    { $sum: { $cond: [{ $gt: ['$totalMinutes', 0] }, 1, 0] } },
          tasksCompleted: { $sum: '$tasksCompleted' },
          tasksAssigned:  { $sum: '$tasksAssigned' },
      }},
    ]);

    const users   = await User.find({ _id: { $in: attStats.map(a => a._id) } }).select('fullName username employeeId department');
    const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u]));

    const rows = attStats.map(a => {
      const u    = userMap[a._id.toString()];
      const rate = a.tasksAssigned ? Math.round((a.tasksCompleted / a.tasksAssigned) * 100) : 0;
      const avgH = a.daysPresent ? parseFloat((a.totalMinutes / 60 / a.daysPresent).toFixed(1)) : 0;
      const score= Math.round((rate * 0.5) + (Math.min(avgH, 9) / 9 * 100 * 0.5));
      const grade= score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
      return { u, a, rate, avgH, score, grade };
    }).sort((a, b) => b.score - a.score);

    const doc = createPDF(res, `taskroom-team-summary-${Date.now()}.pdf`);
    let y = drawHeader(doc, org.name, 'Team Productivity Summary', `${fmtDate(from)} — ${fmtDate(to)}`);

    const avgScore = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0;
    const grades   = rows.reduce((m, r) => { m[r.grade] = (m[r.grade] || 0) + 1; return m; }, {});

    y = drawStatCards(doc, [
      { label: 'Employees',   value: rows.length,   color: BRAND.primary },
      { label: 'Avg Score',   value: avgScore+'/100',color: avgScore>=70?BRAND.green:avgScore>=50?BRAND.amber:BRAND.red },
      { label: 'Grade A',     value: grades.A || 0, color: BRAND.green   },
      { label: 'Grade B',     value: grades.B || 0, color: BRAND.primary },
      { label: 'Grade C',     value: grades.C || 0, color: BRAND.amber   },
      { label: 'Grade D',     value: grades.D || 0, color: BRAND.red     },
    ], y);

    const headers = ['#', 'Employee', 'Emp ID', 'Dept', 'Days', 'Total Hrs', 'Avg Hrs/Day', 'Tasks Done', 'Assigned', 'Rate', 'Score', 'Grade'];
    const colW    = [24, 100, 60, 80, 34, 52, 62, 58, 58, 42, 46, 42];

    const gradeColor = { A: BRAND.green, B: '#4a9ff5', C: BRAND.amber, D: BRAND.red };

    const tableRows = rows.map((r, i) => [
      { text: String(i + 1),                              color: BRAND.textMuted },
      { text: r.u?.fullName || r.u?.username || '—',      color: BRAND.text      },
      { text: r.u?.employeeId || '—',                    color: BRAND.primary   },
      { text: r.u?.department || '—',                    color: BRAND.textMuted },
      { text: String(r.a.daysPresent)                                            },
      { text: `${(r.a.totalMinutes/60).toFixed(1)}h`                            },
      { text: `${r.avgH}h`                                                       },
      { text: String(r.a.tasksCompleted)                                         },
      { text: String(r.a.tasksAssigned)                                          },
      { text: `${r.rate}%`,   color: r.rate>=80?BRAND.green:r.rate>=50?BRAND.amber:BRAND.red },
      { text: `${r.score}`,   color: gradeColor[r.grade] || BRAND.textMuted     },
      { text: r.grade,        color: gradeColor[r.grade] || BRAND.textMuted     },
    ]);

    drawTable(doc, headers, tableRows, colW, y);
    drawFooter(doc);
    doc.end();
  } catch (err) {
    console.error('export/team-summary/pdf:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
