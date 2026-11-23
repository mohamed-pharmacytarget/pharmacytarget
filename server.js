// PharmacyTarget — self-hosted server
// Node.js + Express + SQLite (node:sqlite) + bcryptjs
// All passwords are hashed on the server. No password exists in frontend code.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const IS_VERCEL = !!process.env.VERCEL;
const DATA_DIR = process.env.DATA_DIR || (IS_VERCEL ? path.join('/tmp', 'pharmacytarget-data') : path.join(__dirname, 'data'));
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'pharmacytarget.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Vercel Blob persistence (serverless only): the Blob store is connected to
// the Vercel project, which sets BLOB_READ_WRITE_TOKEN automatically.
const BLOB_PATHNAME = 'pharmacytarget-db/pharmacytarget.db.enc';
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const blobEnabled = IS_VERCEL && !!BLOB_TOKEN;

let db = null;

// ---------- Schema ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL, -- owner | manager | employee | superadmin
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  monthly_sales REAL NOT NULL DEFAULT 0,
  monthly_invoices REAL NOT NULL DEFAULT 0,
  monthly_coding REAL NOT NULL DEFAULT 0,
  custom_items TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  sales REAL NOT NULL DEFAULT 0,
  invoices REAL NOT NULL DEFAULT 0,
  coding REAL NOT NULL DEFAULT 0,
  delivery REAL NOT NULL DEFAULT 0,
  preferred_value REAL NOT NULL DEFAULT 0,
  created_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(employee_id, date)
);
CREATE TABLE IF NOT EXISTS preferred_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sheet_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  filename TEXT NOT NULL,
  employee_id INTEGER,
  rows_json TEXT NOT NULL DEFAULT '[]',
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function reopenDb() {
  if (db) { try { db.close(); } catch (e) { /* ignore */ } db = null; }
  db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  migrateDb();
  seed();
}

db = new DatabaseSync(DB_PATH);
db.exec(SCHEMA);
migrateDb();

// Migrations for DBs created before a column existed.
function migrateDb() {
  try {
    const cols = db.prepare("PRAGMA table_info(preferred_items)").all().map(c => c.name);
    if (!cols.includes('category')) db.exec("ALTER TABLE preferred_items ADD COLUMN category TEXT NOT NULL DEFAULT ''");
  } catch (e) { console.error('migrate failed', e); }
}

// ---------- Seed (first run only) ----------
function seed() {
  // Idempotent: two instances starting at once must not crash each other.
  try {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count > 0) return;
  const insertUser = db.prepare(
    'INSERT OR IGNORE INTO users (username, password_hash, role, name) VALUES (?, ?, ?, ?)');
  const users = [
    ['owner', '123456', 'owner', 'المالك'],
    ['manager', '123456', 'manager', 'مدير الفرع'],
    ['employee', '1234', 'employee', 'موظف'],
    ['mohamed', 'mm@1234', 'superadmin', 'Mohamed Maher'],
  ];
  for (const [u, p, r, n] of users) {
    insertUser.run(u, bcrypt.hashSync(p, 10), r, n);
  }
  const set = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  set.run('branch_sales', '2000000');
  set.run('branch_invoices', '5000');
  set.run('branch_coding', '1000');
  set.run('branch_delivery', '500');
  // Sample employees so the dashboards are usable immediately
  const insEmp = db.prepare(
    'INSERT OR IGNORE INTO employees (name, username, monthly_sales, monthly_invoices, monthly_coding, custom_items) VALUES (?, ?, ?, ?, ?, ?)');
  insEmp.run('أحمد سامي', 'ahmed', 300000, 800, 150, JSON.stringify([{ name: 'مبيعات كوزمتكس', target: 20000 }]));
  insEmp.run('سارة علي', 'sara', 250000, 700, 120, JSON.stringify([]));
  console.log('Seeded accounts: owner, manager, employee, mohamed + branch targets.');
  } catch (e) { console.error('seed skipped:', e.message); }
}
seed();

function audit(username, action, details) {
  try { db.prepare('INSERT INTO audit_log (username, action, details) VALUES (?, ?, ?)').run(username || '', action, details || ''); } catch (e) { /* ignore */ }
}

// ---------- Vercel Blob persistence (serverless only) ----------
// Vercel's filesystem is ephemeral (/tmp only, per-instance), so the SQLite
// file is synced to a private Vercel Blob store: reloaded when a newer
// snapshot exists, uploaded (AES-256-GCM-encrypted, key derived from
// SESSION_SECRET) after every mutation. Without a Blob token (local/Render)
// the app simply uses the local SQLite file as before.
let blobLib = null;
async function getBlob() { if (!blobLib) blobLib = await import('@vercel/blob'); return blobLib; }
function blobKey() {
  return crypto.createHash('sha256')
    .update(String(process.env.BLOB_ENCRYPTION_KEY || process.env.SESSION_SECRET || 'change-me-in-production'))
    .digest();
}
function encryptBuf(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', blobKey(), iv);
  return Buffer.concat([iv, Buffer.concat([c.update(buf), c.final()]), c.getAuthTag()]);
}
function decryptBuf(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', blobKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
}
let blobChain = Promise.resolve();
let lastBlobCheck = 0;
let lastBlobUploadedAt = 0; // uploadedAt of the snapshot our local file matches
function queueBlob(fn) { const p = blobChain.then(fn, fn); blobChain = p.catch(() => {}); return p; }
async function syncFromBlob({ force = false } = {}) {
  if (!blobEnabled) return false;
  return queueBlob(async () => {
    const now = Date.now();
    if (!force && now - lastBlobCheck < 5000) return false;
    lastBlobCheck = now;
    const { list } = await getBlob();
    const { blobs } = await list({ prefix: BLOB_PATHNAME, token: BLOB_TOKEN });
    const blob = blobs && blobs[0];
    if (!blob) return false;
    const uploadedAt = new Date(blob.uploadedAt).getTime();
    if (uploadedAt <= lastBlobUploadedAt) return false;
    let res = await fetch(blob.url, { headers: { Authorization: `Bearer ${BLOB_TOKEN}` } });
    if (!res.ok) res = await fetch(blob.url); // public-store fallback
    if (!res.ok) throw new Error(`blob download failed: ${res.status}`);
    const plain = decryptBuf(Buffer.from(await res.arrayBuffer()));
    const tmp = DB_PATH + '.download';
    fs.writeFileSync(tmp, plain);
    if (db) { try { db.close(); } catch (e) { /* ignore */ } db = null; }
    fs.renameSync(tmp, DB_PATH);
    db = new DatabaseSync(DB_PATH);
    db.exec(SCHEMA);
    migrateDb();
    seed();
    lastBlobUploadedAt = uploadedAt;
    return true;
  });
}
async function persistToBlob() {
  if (!blobEnabled) return false;
  return queueBlob(async () => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
    const { put } = await getBlob();
    const blob = await put(BLOB_PATHNAME, encryptBuf(fs.readFileSync(DB_PATH)),
      { access: 'private', addRandomSuffix: false, allowOverwrite: true, token: BLOB_TOKEN });
    lastBlobUploadedAt = new Date(blob.uploadedAt).getTime();
    lastBlobCheck = Date.now();
    return true;
  });
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Stateless signed-cookie sessions: express-session's MemoryStore does not
// survive across Vercel serverless instances, so the session is an
// HMAC-signed cookie (payload: id/username/role/name, 7-day expiry).
const SESSION_COOKIE = 'pt_session';
function sessionKey() {
  return crypto.createHash('sha256')
    .update(String(process.env.SESSION_SECRET || 'change-me-in-production')).digest();
}
function signSession(user) {
  const payload = Buffer.from(JSON.stringify({
    ...user, exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifySession(value) {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', sessionKey()).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp < Date.now()) return null;
    return { id: data.id, username: data.username, role: data.role, name: data.name };
  } catch (e) { return null; }
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
app.use((req, res, next) => {
  const user = verifySession(parseCookies(req)[SESSION_COOKIE]);
  req.session = user ? { user } : {};
  req._setSessionUser = (u) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${signSession(u)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    req.session = { user: u };
  };
  req._clearSession = () => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    req.session = {};
  };
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Blob sync: reload a newer snapshot before any API call; persist after mutations.
app.use('/api', async (req, res, next) => {
  if (!blobEnabled) return next();
  try {
    const mutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
    await syncFromBlob({ force: mutating });
    if (mutating) {
      const origJson = res.json.bind(res);
      const origSend = res.send.bind(res);
      let done = false;
      const persistOnce = async () => {
        if (done) return;
        done = true;
        try { await persistToBlob(); } catch (e) { console.error('blob persist failed', e); }
      };
      res.json = async function (body) { if (res.statusCode < 400) await persistOnce(); return origJson(body); };
      res.send = async function (body) { if (res.statusCode < 400) await persistOnce(); return origSend(body); };
    }
  } catch (e) { console.error('blob sync failed', e); }
  next();
});

const requireAuth = (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'غير مسجل الدخول' });
  next();
};
const requireRole = (...roles) => (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'غير مسجل الدخول' });
  if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: 'لا تملك الصلاحية' });
  next();
};
const me = (req) => req.session.user;

// ---------- Helpers ----------
function monthRange(month) { // month = YYYY-MM
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const last = new Date(y, m, 0).getDate();
  const end = `${month}-${String(last).padStart(2, '0')}`;
  return { start, end, daysInMonth: last };
}
function workingDays(month) { // exclude Fridays (Egypt weekend)
  const { start, end, daysInMonth } = monthRange(month);
  const [y, m] = month.split('-').map(Number);
  let n = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(y, m - 1, d).getDay() !== 5) n++;
  }
  return n;
}
function remainingWorkingDays(month, fromDate) {
  const { daysInMonth } = monthRange(month);
  const [y, m] = month.split('-').map(Number);
  let n = 0;
  for (let d = fromDate; d <= daysInMonth; d++) {
    if (new Date(y, m - 1, d).getDay() !== 5) n++;
  }
  return Math.max(n, 1);
}
function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = Number(r.value);
  return {
    branch_sales: s.branch_sales ?? 2000000,
    branch_invoices: s.branch_invoices ?? 5000,
    branch_coding: s.branch_coding ?? 1000,
    branch_delivery: s.branch_delivery ?? 500,
  };
}
function employeeTotals(empId, month) {
  const { start, end } = monthRange(month);
  const row = db.prepare(`
    SELECT COALESCE(SUM(sales),0) sales, COALESCE(SUM(invoices),0) invoices,
           COALESCE(SUM(coding),0) coding, COALESCE(SUM(delivery),0) delivery,
           COALESCE(SUM(preferred_value),0) preferred
    FROM daily_results WHERE employee_id=? AND date>=? AND date<=?`).get(empId, start, end);
  return row;
}
function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }

// ---------- Auth ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'أدخل اليوزر والباسورد' });
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(username).trim());
  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }
  req._setSessionUser({ id: user.id, username: user.username, role: user.role, name: user.name });
  audit(user.username, 'login', 'تسجيل دخول');
  res.json({ ok: true, user: req.session.user });
});
app.post('/api/logout', (req, res) => {
  req._clearSession();
  res.json({ ok: true });
});
app.get('/api/me', requireAuth, (req, res) => res.json({ user: me(req) }));
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- Settings ----------
app.get('/api/settings', requireAuth, (req, res) => res.json(getSettings()));
app.put('/api/settings', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const k of ['branch_sales', 'branch_invoices', 'branch_coding', 'branch_delivery']) {
    if (req.body[k] !== undefined) set.run(k, String(Number(req.body[k]) || 0));
  }
  audit(me(req).username, 'update_settings', 'تعديل تارجت الفرع');
  res.json(getSettings());
});

// ---------- Employees ----------
app.get('/api/employees', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM employees WHERE active=1 ORDER BY name').all();
  res.json(rows.map(r => ({ ...r, custom_items: JSON.parse(r.custom_items || '[]') })));
});
app.post('/api/employees', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  const { name, username, password, monthly_sales, monthly_invoices, monthly_coding, custom_items } = req.body || {};
  if (!name || !username) return res.status(400).json({ error: 'الاسم واليوزر مطلوبان' });
  try {
    const hash = bcrypt.hashSync(String(password || '1234'), 10);
    const u = db.prepare('INSERT INTO users (username, password_hash, role, name) VALUES (?, ?, ?, ?)')
      .run(String(username).trim(), hash, 'employee', name);
    const e = db.prepare('INSERT INTO employees (user_id, name, username, monthly_sales, monthly_invoices, monthly_coding, custom_items) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(u.lastInsertRowid, name, String(username).trim(),
        Number(monthly_sales) || 0, Number(monthly_invoices) || 0, Number(monthly_coding) || 0,
        JSON.stringify(Array.isArray(custom_items) ? custom_items : []));
    audit(me(req).username, 'add_employee', `إضافة موظف ${name}`);
    res.json({ ok: true, id: e.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: 'اليوزر موجود بالفعل' });
  }
});
app.put('/api/employees/:id', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  const { name, monthly_sales, monthly_invoices, monthly_coding, custom_items } = req.body || {};
  db.prepare('UPDATE employees SET name=?, monthly_sales=?, monthly_invoices=?, monthly_coding=?, custom_items=? WHERE id=?')
    .run(name, Number(monthly_sales) || 0, Number(monthly_invoices) || 0, Number(monthly_coding) || 0,
      JSON.stringify(Array.isArray(custom_items) ? custom_items : []), req.params.id);
  audit(me(req).username, 'update_employee', `تعديل موظف ${req.params.id}`);
  res.json({ ok: true });
});
app.delete('/api/employees/:id', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  db.prepare('UPDATE employees SET active=0 WHERE id=?').run(req.params.id);
  audit(me(req).username, 'delete_employee', `حذف موظف ${req.params.id}`);
  res.json({ ok: true });
});

// ---------- Daily results ----------
app.get('/api/daily', requireAuth, (req, res) => {
  const { employee_id, month } = req.query;
  if (!employee_id || !month) return res.status(400).json({ error: 'employee_id و month مطلوبان' });
  const { start, end } = monthRange(month);
  const rows = db.prepare('SELECT * FROM daily_results WHERE employee_id=? AND date>=? AND date<=? ORDER BY date')
    .all(employee_id, start, end);
  res.json(rows);
});
app.post('/api/daily', requireAuth, (req, res) => {
  const { employee_id, date, sales, invoices, coding, delivery, preferred_value } = req.body || {};
  if (!employee_id || !date) return res.status(400).json({ error: 'الموظف والتاريخ مطلوبان' });
  db.prepare(`INSERT INTO daily_results (employee_id, date, sales, invoices, coding, delivery, preferred_value, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(employee_id, date) DO UPDATE SET sales=excluded.sales, invoices=excluded.invoices,
    coding=excluded.coding, delivery=excluded.delivery, preferred_value=excluded.preferred_value,
    updated_at=datetime('now')`)
    .run(employee_id, date, Number(sales) || 0, Number(invoices) || 0, Number(coding) || 0,
      Number(delivery) || 0, Number(preferred_value) || 0, me(req).username);
  audit(me(req).username, 'daily_result', `تسجيل نتائج يوم ${date} للموظف ${employee_id}`);
  res.json({ ok: true });
});

// ---------- Reports ----------
app.get('/api/reports/summary', requireAuth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const settings = getSettings();
  const emps = db.prepare('SELECT * FROM employees WHERE active=1').all();
  const wd = workingDays(month);
  const today = new Date().toISOString().slice(0, 10);
  const dayNum = month === today.slice(0, 7) ? Number(today.slice(8, 10)) : monthRange(month).daysInMonth;
  const perEmployee = emps.map(e => {
    const t = employeeTotals(e.id, month);
    const dailySales = e.monthly_sales / wd;
    const remainingDays = remainingWorkingDays(month, Math.min(dayNum + 1, monthRange(month).daysInMonth));
    const tomorrowSales = Math.max(0, Math.round((e.monthly_sales - t.sales) / remainingDays));
    const idx = Math.round((pct(t.sales, e.monthly_sales) + pct(t.invoices, e.monthly_invoices) + pct(t.coding, e.monthly_coding)) / 3);
    return {
      id: e.id, name: e.name, username: e.username,
      target: { sales: e.monthly_sales, invoices: e.monthly_invoices, coding: e.monthly_coding },
      achieved: t, index: idx,
      classification: idx >= 90 ? 'ممتاز' : idx >= 70 ? 'على المسار الصحيح' : idx >= 50 ? 'يحتاج دعمًا' : 'متأخر',
      dailyRequired: { sales: Math.round(dailySales), invoices: Math.round(e.monthly_invoices / wd), coding: Math.round(e.monthly_coding / wd) },
      tomorrow: { sales: tomorrowSales },
      custom_items: JSON.parse(e.custom_items || '[]'),
    };
  });
  const totals = perEmployee.reduce((a, e) => ({
    sales: a.sales + e.achieved.sales, invoices: a.invoices + e.achieved.invoices,
    coding: a.coding + e.achieved.coding, delivery: a.delivery + e.achieved.delivery,
    preferred: a.preferred + e.achieved.preferred,
  }), { sales: 0, invoices: 0, coding: 0, delivery: 0, preferred: 0 });
  const avgInvoice = totals.invoices > 0 ? Math.round(totals.sales / totals.invoices) : 0;
  // Problems auto-detected from real numbers
  const problems = [];
  for (const e of perEmployee) {
    if (e.target.sales > 0 && pct(e.achieved.sales, e.target.sales) < 50 && dayNum >= 15) {
      problems.push({ employee: e.name, problem: `مبيعات ${e.name} أقل من 50% من التارجت في منتصف الشهر`, cause: 'مبيعات يومية أقل من المطلوب اليومي', solution: 'راجع المطلوب اليومي مع الموظف، ركز على أصناف الـ Preferred، وتابع نتائجه يوميًا', indicator: 'نسبة تحقيق المبيعات' });
    }
    if (e.target.coding > 0 && pct(e.achieved.coding, e.target.coding) < 40) {
      problems.push({ employee: e.name, problem: `تكويد ${e.name} متأخر عن التارجت`, cause: 'عدم تسجيل عملاء جدد (تكويد) بشكل يومي', solution: 'اطلب من كل موظف تكويد كل عميل جديد في نفس اليوم، وراجع عدد التكويد في تقرير نهاية اليوم', indicator: 'عدد التكويد اليومي' });
    }
    if (e.target.invoices > 0 && pct(e.achieved.invoices, e.target.invoices) < 50 && dayNum >= 15) {
      problems.push({ employee: e.name, problem: `عدد فواتير ${e.name} أقل من 50% من التارجت`, cause: 'عدد عملاء أقل أو فواتير مدمجة', solution: 'شجع الموظف على فصل الفواتير وتقديم خدمة سريعة لكل عميل', indicator: 'عدد الفواتير اليومي' });
    }
  }
  if (totals.sales < settings.branch_sales * 0.5 && dayNum >= 15) {
    problems.push({ employee: 'الفرع', problem: 'مبيعات الفرع أقل من 50% من التارجت الشهري', cause: 'إجمالي المبيعات اليومية أقل من المطلوب', solution: 'اجتماع سريع مع الفريق، مراجعة الـ Preferred List، وزيادة المتابعة اليومية', indicator: 'نسبة تحقيق مبيعات الفرع' });
  }
  res.json({ month, settings, workingDays: wd, totals, avgInvoice, perEmployee, problems });
});

// Smart Performance Coach
app.get('/api/coach/:employee_id', requireAuth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.employee_id);
  if (!e) return res.status(404).json({ error: 'موظف غير موجود' });
  const t = employeeTotals(e.id, month);
  const tips = [];
  const salesPct = pct(t.sales, e.monthly_sales);
  if (salesPct < 70) tips.push({ cause: 'المبيعات أقل من المطلوب', indicator: 'المبيعات', amount: Math.round(e.monthly_sales - t.sales), suggestion: 'ركز على أصناف الـ Preferred وعلى العملاء المترددين، وراجع المطلوب اليومي كل صباح', expected: 'رفع نسبة تحقيق المبيعات' });
  if (pct(t.coding, e.monthly_coding) < 70) tips.push({ cause: 'التكويد أقل من المطلوب', indicator: 'التكويد', amount: Math.round(e.monthly_coding - t.coding), suggestion: 'كوّد كل عميل جديد فورًا قبل نهاية الشيفت', expected: 'زيادة قاعدة العملاء' });
  if (pct(t.invoices, e.monthly_invoices) < 70) tips.push({ cause: 'عدد الفواتير أقل من المطلوب', indicator: 'الفواتير', amount: Math.round(e.monthly_invoices - t.invoices), suggestion: 'سرّع خدمة العملاء ولا تدمج فواتير عملاء مختلفين', expected: 'زيادة عدد الفواتير' });
  if (!tips.length) tips.push({ cause: 'لا توجد مشكلة واضحة', indicator: 'الأداء العام', amount: 0, suggestion: 'حافظ على نفس المعدل اليومي حتى نهاية الشهر', expected: 'تحقيق التارجت كاملًا' });
  res.json({ employee: e.name, tips });
});

// CSV export
app.get('/api/export.csv', requireAuth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const emps = db.prepare('SELECT * FROM employees WHERE active=1').all();
  let csv = 'الموظف,مبيعات محققة,تارجت مبيعات,فواتير محققة,تارجت فواتير,تكويد محقق,تارجت تكويد,قيمة Preferred\n';
  for (const e of emps) {
    const t = employeeTotals(e.id, month);
    csv += `${e.name},${t.sales},${e.monthly_sales},${t.invoices},${e.monthly_invoices},${t.coding},${e.monthly_coding},${t.preferred}\n`;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="report-${month}.csv"`);
  res.send('\ufeff' + csv);
});

// ---------- Sheet uploads (Excel / CSV) ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Read an uploaded Excel/CSV file. CSV must be decoded as UTF-8 explicitly:
// XLSX.read on a raw buffer mis-decodes Arabic headers as latin1.
function readSheetBuffer(buffer, filename) {
  if (/\.csv$/i.test(filename || '')) {
    return XLSX.read(buffer.toString('utf8').replace(/^\uFEFF/, ''), { type: 'string' });
  }
  return XLSX.read(buffer, { type: 'buffer' });
}

// e-Plus items export (the pharmacy app's "تقرير مبيعات أصناف"): headers and
// data rows are misaligned (RTL export), so it is parsed by position:
// [total selling price, qty, unit, balance, origin, company, name, code, employee].
// Footer rows ("عدد الأصناف" summary, "Page -1 of 1") are skipped.
function normalizeItemsSheet(ws) {
  const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!arr.length) return null;
  const headers = arr[0].map(h => String(h).trim());
  if (!headers.includes('إجمالى س.بيع') || !headers.includes('الإسم')) return null;
  const rows = [];
  for (const r of arr.slice(1)) {
    const value = Number(r[0]);
    const qty = Number(r[1]);
    const name = String(r[6] ?? '').trim();
    if (!name || isNaN(value) || isNaN(qty)) continue;
    rows.push({
      item: name,
      code: String(r[7] ?? '').trim(),
      company: String(r[5] ?? '').trim(),
      origin: String(r[4] ?? '').trim(),
      unit: String(r[2] ?? '').trim(),
      qty, value,
      employee: String(r[8] ?? '').trim(),
    });
  }
  return rows;
}

// ---------- Preferred List ----------
app.get('/api/preferred', requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM preferred_items WHERE active=1 ORDER BY CASE WHEN category='' THEN 1 ELSE 0 END, category, name").all());
});
app.post('/api/preferred', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  const { name, price, category } = req.body || {};
  if (!name) return res.status(400).json({ error: 'اسم الصنف مطلوب' });
  const r = db.prepare('INSERT INTO preferred_items (name, price, category) VALUES (?, ?, ?)').run(name, Number(price) || 0, String(category || '').trim());
  audit(me(req).username, 'preferred_add', `إضافة صنف مفضل ${name}`);
  res.json({ ok: true, id: r.lastInsertRowid });
});
// Upload a Preferred Excel/CSV sheet: columns اسم الصنف / السعر / الفئة.
// The app analyses the sheet and categorises items by الفئة.
app.post('/api/preferred/upload', requireRole('owner', 'manager', 'superadmin'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'اختر ملف أكسيل أو CSV' });
  let rows = [];
  try {
    const wb = readSheetBuffer(req.file.buffer, req.file.originalname);
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'تعذر قراءة الملف' });
  }
  const norm = v => String(v ?? '').trim();
  const num = v => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
  const find = db.prepare('SELECT id FROM preferred_items WHERE name=? AND active=1');
  const ins = db.prepare('INSERT INTO preferred_items (name, price, category) VALUES (?, ?, ?)');
  const upd = db.prepare('UPDATE preferred_items SET price=?, category=? WHERE id=?');
  const cats = {};
  let added = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const keys = Object.keys(row);
    const name = norm(row['الصنف'] || row['اسم الصنف'] || row['item'] || row['name'] || (keys.length ? row[keys[0]] : ''));
    if (!name) { skipped++; continue; }
    const price = num(row['السعر'] || row['price'] || row['سعر'] || 0);
    const category = norm(row['الفئة'] || row['التصنيف'] || row['category'] || row['الفئة/التصنيف']) || 'بدون فئة';
    const ex = find.get(name);
    if (ex) { upd.run(price, category, ex.id); updated++; } else { ins.run(name, price, category); added++; }
    const c = cats[category] || (cats[category] = { category, count: 0, total: 0 });
    c.count++; c.total += price;
  }
  const categories = Object.values(cats).sort((a, b) => b.count - a.count);
  db.prepare('INSERT INTO sheet_uploads (type, filename, employee_id, rows_json, uploaded_by) VALUES (?, ?, ?, ?, ?)')
    .run('preferred', req.file.originalname, null, JSON.stringify(rows), me(req).username);
  audit(me(req).username, 'preferred_upload', `رفع شيت Preferred ${req.file.originalname} (${added + updated} صنف في ${categories.length} فئة)`);
  res.json({ ok: true, added, updated, skipped, total: added + updated, categories });
});
app.delete('/api/preferred/:id', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  db.prepare('UPDATE preferred_items SET active=0 WHERE id=?').run(req.params.id);
  audit(me(req).username, 'preferred_delete', `حذف صنف مفضل ${req.params.id}`);
  res.json({ ok: true });
});
// Preferred achievement per employee (from daily entries + items sheets)
app.get('/api/preferred/achievement', requireAuth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const { start, end } = monthRange(month);
  const emps = db.prepare('SELECT * FROM employees WHERE active=1').all();
  const prefNames = db.prepare('SELECT name FROM preferred_items WHERE active=1').all().map(r => r.name.trim());
  const out = emps.map(e => {
    const t = employeeTotals(e.id, month);
    // From uploaded items sheets
    let sheetValue = 0; let sheetItems = [];
    const uploads = db.prepare("SELECT rows_json FROM sheet_uploads WHERE type='items' AND created_at>=? AND created_at<=?")
      .all(start + ' 00:00:00', end + ' 23:59:59');
    for (const u of uploads) {
      for (const row of JSON.parse(u.rows_json || '[]')) {
        const empName = String(row.employee || row['الموظف'] || '').trim();
        const item = String(row.item || row['الصنف'] || '').trim();
        if (empName === e.name && prefNames.includes(item)) {
          const v = Number(row.value || row['القيمة'] || row.total || 0);
          sheetValue += v;
          sheetItems.push({ item, qty: Number(row.qty || row['الكمية'] || 0), value: v });
        }
      }
    }
    return { employee_id: e.id, name: e.name, dailyPreferred: t.preferred, sheetPreferred: sheetValue, totalPreferred: t.preferred + sheetValue, sheetItems };
  });
  res.json(out);
});

// ---------- Sheet uploads (Excel / CSV) ----------
app.post('/api/uploads', requireRole('owner', 'manager', 'superadmin'), upload.single('file'), (req, res) => {
  const type = req.body.type || 'sales'; // sales | items
  const employee_id = req.body.employee_id ? Number(req.body.employee_id) : null;
  if (!req.file) return res.status(400).json({ error: 'اختر ملف أكسيل أو CSV' });
  let rows = [];
  try {
    const wb = readSheetBuffer(req.file.buffer, req.file.originalname);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (type === 'items') {
      rows = normalizeItemsSheet(ws) || XLSX.utils.sheet_to_json(ws, { defval: '' });
    } else {
      rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'تعذر قراءة الملف' });
  }
  const r = db.prepare('INSERT INTO sheet_uploads (type, filename, employee_id, rows_json, uploaded_by) VALUES (?, ?, ?, ?, ?)')
    .run(type, req.file.originalname, employee_id, JSON.stringify(rows), me(req).username);
  audit(me(req).username, 'upload', `رفع شيت ${req.file.originalname} (${type})`);
  res.json({ ok: true, id: r.lastInsertRowid, rows: rows.length, analysis: analyzeRows(type, rows) });
});
function analyzeRows(type, rows) {
  const s = getSettings();
  if (type === 'items') {
    // Normalized items rows: { item, value, qty, employee }
    let totalSales = 0, totalQty = 0;
    const byItem = {};
    const byEmployee = {};
    const prefNames = db.prepare('SELECT name FROM preferred_items WHERE active=1').all().map(r => r.name.trim());
    let preferredValue = 0;
    for (const row of rows) {
      const value = Number(row.value ?? row['إجمالى س.بيع'] ?? 0) || 0;
      const qty = Number(row.qty ?? row['الكمية'] ?? 0) || 0;
      const item = String(row.item ?? row['الصنف'] ?? row['الإسم'] ?? '').trim();
      totalSales += value; totalQty += qty;
      if (item) {
        byItem[item] = (byItem[item] || 0) + value;
        if (prefNames.includes(item)) preferredValue += value;
      }
      const emp = String(row.employee ?? row['الموظف'] ?? '').trim();
      if (emp) {
        byEmployee[emp] = byEmployee[emp] || { sales: 0, invoices: 0, coding: 0 };
        byEmployee[emp].sales += value;
      }
    }
    const topItems = Object.entries(byItem).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([item, value]) => ({ item, value }));
    const branchSalesPct = pct(totalSales, s.branch_sales);
    return {
      totalSales, totalQty, itemsCount: Object.keys(byItem).length,
      branchSalesPct,
      achieved: totalSales >= s.branch_sales,
      verdict: totalSales >= s.branch_sales
        ? `حققنا تارجت المبيعات في الشيت المرفوع — ${branchSalesPct}% من تارجت الفرع`
        : `لم نحقق تارجت المبيعات بعد — حققنا ${branchSalesPct}% من تارجت الفرع (${s.branch_sales} جنيه)`,
      topItems, preferredValue,
      byEmployee,
    };
  }
  let totalSales = 0, totalInvoices = 0, totalCoding = 0;
  const byEmployee = {};
  for (const row of rows) {
    const sales = Number(row.sales || row['المبيعات'] || row['مبيعات'] || 0);
    const inv = Number(row.invoices || row['الفواتير'] || row['فواتير'] || 0);
    const cod = Number(row.coding || row['التكويد'] || row['تكويد'] || 0);
    totalSales += sales; totalInvoices += inv; totalCoding += cod;
    const emp = String(row.employee || row['الموظف'] || 'غير محدد');
    byEmployee[emp] = byEmployee[emp] || { sales: 0, invoices: 0, coding: 0 };
    byEmployee[emp].sales += sales; byEmployee[emp].invoices += inv; byEmployee[emp].coding += cod;
  }
  return {
    totalSales, totalInvoices, totalCoding,
    branchSalesPct: pct(totalSales, s.branch_sales),
    achieved: totalSales >= s.branch_sales,
    verdict: totalSales >= s.branch_sales
      ? 'حققنا تارجت المبيعات في الشيت المرفوع'
      : `لم نحقق تارجت المبيعات بعد — حققنا ${pct(totalSales, s.branch_sales)}% من تارجت الفرع (${s.branch_sales} جنيه)`,
    byEmployee,
  };
}
app.get('/api/uploads', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, type, filename, employee_id, uploaded_by, created_at, length(rows_json) rows_size FROM sheet_uploads ORDER BY id DESC LIMIT 50').all();
  res.json(rows);
});
app.get('/api/uploads/:id/analysis', requireAuth, (req, res) => {
  const u = db.prepare('SELECT * FROM sheet_uploads WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'غير موجود' });
  res.json({ ...u, rows: JSON.parse(u.rows_json || '[]'), analysis: analyzeRows(u.type, JSON.parse(u.rows_json || '[]')) });
});

// ---------- Change requests (Mohamed only) ----------
app.get('/api/change-requests', requireRole('superadmin'), (req, res) => {
  res.json(db.prepare('SELECT * FROM change_requests ORDER BY id DESC').all());
});
app.post('/api/change-requests', requireAuth, (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'اكتب الطلب' });
  const r = db.prepare('INSERT INTO change_requests (username, text) VALUES (?, ?)').run(me(req).username, text);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// ---------- Users (superadmin only — hidden from owner/manager) ----------
app.get('/api/users', requireRole('superadmin'), (req, res) => {
  res.json(db.prepare('SELECT id, username, role, name, active, created_at FROM users ORDER BY role, username').all());
});
app.post('/api/users/change-password', requireAuth, (req, res) => {
  const { username, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'الباسورد قصير' });
  // A user can change their own password; superadmin can change anyone's
  if (me(req).role !== 'superadmin' && me(req).username !== username) return res.status(403).json({ error: 'لا تملك الصلاحية' });
  db.prepare('UPDATE users SET password_hash=? WHERE username=?').run(bcrypt.hashSync(String(newPassword), 10), username);
  audit(me(req).username, 'change_password', `تغيير باسورد ${username}`);
  res.json({ ok: true });
});

// ---------- Audit / backup / restore ----------
app.get('/api/audit', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
});
app.get('/api/backup', requireRole('owner', 'superadmin'), (req, res) => {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="pharmacytarget-backup.db"');
  res.send(fs.readFileSync(DB_PATH));
});
app.post('/api/restore', requireRole('superadmin'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'اختر ملف قاعدة البيانات' });
  if (db) { try { db.close(); } catch (e) { /* ignore */ } db = null; }
  fs.writeFileSync(DB_PATH, req.file.buffer);
  db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  audit(me(req).username, 'restore', 'استعادة نسخة احتياطية');
  res.json({ ok: true, note: 'تمت الاستعادة — سجل الدخول مرة أخرى' });
});

// ---------- SPA fallback ----------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PharmacyTarget running on http://localhost:${PORT}`);
    console.log(`Database: ${DB_PATH}`);
    if (blobEnabled) console.log('Blob persistence: enabled (private store, encrypted snapshot)');
  });
}

module.exports = app;
