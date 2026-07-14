require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');
const fs = require('fs');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || '*';

async function initSchema() {
  const schema = fs.readFileSync('schema.sql', 'utf8');
  await db.executeMultiple(schema);
}

const app = express();
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// --- Auth ---
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await db.execute({ sql: 'SELECT * FROM employees WHERE email = ?', args: [email] });
  const emp = result.rows[0];
  if (!emp || !bcrypt.compareSync(password, emp.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: emp.id, name: emp.name, role: emp.role }, SECRET, { expiresIn: '7d' });
  res.json({ token, name: emp.name, role: emp.role });
});

// --- Manager: upload excel workbook, sheet name = employee name ---
app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  if (req.user.role !== 'manager') return res.status(403).json({ error: 'Managers only' });
  const wb = XLSX.read(req.file.buffer, { type: 'buffer' });

  const batchResult = await db.execute({
    sql: 'INSERT INTO upload_batches (uploaded_by, filename) VALUES (?, ?)',
    args: [req.user.id, req.file.originalname],
  });
  const batchId = Number(batchResult.lastInsertRowid);

  let summary = [];
  for (const sheetName of wb.SheetNames) {
    const empResult = await db.execute({ sql: 'SELECT * FROM employees WHERE name = ?', args: [sheetName.trim()] });
    const emp = empResult.rows[0];
    if (!emp) { summary.push({ sheet: sheetName, status: 'no matching employee' }); continue; }

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
    let count = 0;
    for (const row of rows) {
      const name = row.Name || row.name || row.Customer || row.id || '';
      const phone = row['Phone Number'] || row.Phone || row.phone || row.Number || row.Mobile || '';
      if (!name && !phone) continue;
      await db.execute({
        sql: `INSERT INTO leads (batch_id, employee_id, customer_name, phone_number, extra_data) VALUES (?, ?, ?, ?, ?)`,
        args: [batchId, emp.id, name, String(phone || 'TO_BE_FETCHED'), JSON.stringify(row)],
      });
      count++;
    }
    summary.push({ sheet: sheetName, employee: emp.name, leadsAdded: count });
  }
  res.json({ batchId, summary });
});

// --- Employee: get own leads ---
app.get('/api/leads', authMiddleware, async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT * FROM leads WHERE employee_id = ? ORDER BY created_at DESC',
    args: [req.user.id],
  });
  res.json(result.rows);
});

// --- Manager: get all leads / progress ---
app.get('/api/leads/all', authMiddleware, async (req, res) => {
  if (req.user.role !== 'manager') return res.status(403).json({ error: 'Managers only' });
  const result = await db.execute(`SELECT leads.*, employees.name as employee_name FROM leads
    JOIN employees ON leads.employee_id = employees.id ORDER BY leads.created_at DESC`);
  res.json(result.rows);
});

// --- Update call status/reason ---
app.post('/api/leads/:id/call', authMiddleware, async (req, res) => {
  const { status, reason } = req.body;
  const leadResult = await db.execute({ sql: 'SELECT * FROM leads WHERE id = ?', args: [req.params.id] });
  const lead = leadResult.rows[0];
  if (!lead || lead.employee_id !== req.user.id) return res.status(403).json({ error: 'Not your lead' });

  await db.execute({
    sql: 'UPDATE leads SET status = ?, call_reason = ?, called_at = CURRENT_TIMESTAMP WHERE id = ?',
    args: [status, reason, req.params.id],
  });
  await db.execute({
    sql: 'INSERT INTO call_logs (lead_id, employee_id, status, reason) VALUES (?, ?, ?, ?)',
    args: [req.params.id, req.user.id, status, reason],
  });
  res.json({ success: true });
});

// --- Create employee (manager only) ---
app.post('/api/employees', authMiddleware, async (req, res) => {
  if (req.user.role !== 'manager') return res.status(403).json({ error: 'Managers only' });
  const { name, email, password, role } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = await db.execute({
      sql: 'INSERT INTO employees (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      args: [name, email, hash, role || 'employee'],
    });
    res.json({ id: Number(result.lastInsertRowid) });
  } catch (e) {
    res.status(400).json({ error: 'Email or name already exists' });
  }
});

// --- Manager: list uploaded workbooks/batches ---
app.get('/api/uploads', authMiddleware, async (req, res) => {
  if (req.user.role !== 'manager') return res.status(403).json({ error: 'Managers only' });
  const result = await db.execute(`
    SELECT upload_batches.id, upload_batches.filename, upload_batches.uploaded_at,
           COUNT(leads.id) as lead_count
    FROM upload_batches
    LEFT JOIN leads ON leads.batch_id = upload_batches.id
    GROUP BY upload_batches.id
    ORDER BY upload_batches.uploaded_at DESC
  `);
  res.json(result.rows);
});

// --- One-time setup: create the first manager account remotely ---
// Protected by a SETUP_KEY env var so randoms can't call it. Delete this route
// (or unset SETUP_KEY) after you've created your manager account.
app.post('/api/setup', async (req, res) => {
  if (!process.env.SETUP_KEY || req.headers['x-setup-key'] !== process.env.SETUP_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { name, email, password } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = await db.execute({
      sql: 'INSERT INTO employees (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      args: [name, email, hash, 'manager'],
    });
    res.json({ id: Number(result.lastInsertRowid), message: 'Manager created' });
  } catch (e) {
    res.status(400).json({ error: 'Email or name already exists' });
  }
});

const PORT = process.env.PORT || 4000;
initSchema().then(() => {
  app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
});