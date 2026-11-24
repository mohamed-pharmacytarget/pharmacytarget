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
CREATE TABLE IF NOT EXISTS employee_days_off (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  created_by TEXT,
  UNIQUE(employee_id, date)
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
  sheet_month TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS customer_profiles (
  code TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cashback_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_code TEXT NOT NULL,
  employee_id INTEGER,
  employee_name TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  month TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_code TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS loyalty_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  cashback_rate REAL NOT NULL DEFAULT 1,
  gold_min REAL NOT NULL DEFAULT 5000,
  vip_min REAL NOT NULL DEFAULT 20000,
  cashback_per_500 REAL NOT NULL DEFAULT 25,
  cashback_step REAL NOT NULL DEFAULT 500
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
    const ucols = db.prepare("PRAGMA table_info(sheet_uploads)").all().map(c => c.name);
    if (!ucols.includes('sheet_month')) db.exec("ALTER TABLE sheet_uploads ADD COLUMN sheet_month TEXT NOT NULL DEFAULT ''");
    const lcols = db.prepare("PRAGMA table_info(loyalty_settings)").all().map(c => c.name);
    if (lcols.length && !lcols.includes('cashback_per_500')) db.exec("ALTER TABLE loyalty_settings ADD COLUMN cashback_per_500 REAL NOT NULL DEFAULT 25");
    if (lcols.length && !lcols.includes('cashback_step')) db.exec("ALTER TABLE loyalty_settings ADD COLUMN cashback_step REAL NOT NULL DEFAULT 500");
    const pcols = db.prepare("PRAGMA table_info(customer_profiles)").all().map(c => c.name);
    if (pcols.length && !pcols.includes('excluded')) db.exec("ALTER TABLE customer_profiles ADD COLUMN excluded REAL NOT NULL DEFAULT 0");
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
    // Mutations must start from the newest snapshot: the Blob list can lag,
    // and trusting its timestamp has already lost writes. Always download.
    if (!force && uploadedAt <= lastBlobUploadedAt) return false;
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
// No-op: Blob persistence is handled by the middleware after every response.
function persistDb() {}
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
// Employee row linked to this login (per-employee accounts, e.g. amr/1234).
// The shared 'employee' account has no linked row -> null (it uses the picker).
function ownEmployeeId(req) {
  if (!req.session.user || req.session.user.role !== 'employee') return null;
  try {
    const row = db.prepare('SELECT id FROM employees WHERE user_id=? AND active=1').get(req.session.user.id);
    return row ? row.id : null;
  } catch (e) { return null; }
}

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
function offDaysFor(employeeId, month) {
  return new Set(db.prepare('SELECT date FROM employee_days_off WHERE employee_id=? AND substr(date,1,7)=?').all(employeeId, month).map(r => r.date));
}
function workingDaysFor(month, offDates) {
  // offDates: Set of 'YYYY-MM-DD' the employee chose. If empty, Fridays are the day off (old rule).
  const { daysInMonth } = monthRange(month);
  const [y, m] = month.split('-').map(Number);
  if (offDates && offDates.size > 0) {
    let n = 0;
    for (let d = 1; d <= daysInMonth; d++) if (!offDates.has(`${month}-${String(d).padStart(2, '0')}`)) n++;
    return n;
  }
  return workingDays(month);
}
function remainingWorkingDaysFor(month, fromDate, offDates) {
  const { daysInMonth } = monthRange(month);
  const [y, m] = month.split('-').map(Number);
  let n = 0;
  for (let d = fromDate; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    if (offDates && offDates.size > 0) { if (!offDates.has(date)) n++; }
    else if (new Date(y, m - 1, d).getDay() !== 5) n++;
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
const fmt0 = n => Math.round(Number(n) || 0).toLocaleString('en-US');

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
  const own = ownEmployeeId(req);
  const rows = db.prepare('SELECT * FROM employees WHERE active=1 ORDER BY name').all();
  if (req.session.user.role === 'employee' && own) {
    return res.json(rows.filter(r => r.id === own).map(r => ({ ...r, custom_items: JSON.parse(r.custom_items || '[]') })));
  }
  if (req.session.user.role === 'employee') {
    return res.json(rows.map(r => ({ id: r.id, name: r.name }))); // shared account: names only, no targets
  }
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
// One-shot batch: add many employees + delete demo ones + tweak branch targets
// in a SINGLE request, so the Blob sync cannot lose writes between calls.
app.post('/api/employees/batch', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  const { employees, delete_ids, branch_invoices } = req.body || {};
  const added = [], skipped = [], deleted = [];
  if (Array.isArray(employees)) {
    for (const emp of employees) {
      const name = String(emp.name || '').trim();
      const username = String(emp.username || '').trim();
      if (!name || !username) { skipped.push({ name, reason: 'missing name/username' }); continue; }
      try {
        const hash = bcrypt.hashSync(String(emp.password || '1234'), 10);
        const u = db.prepare('INSERT INTO users (username, password_hash, role, name) VALUES (?, ?, ?, ?)')
          .run(username, hash, 'employee', name);
        const e = db.prepare('INSERT INTO employees (user_id, name, username, monthly_sales, monthly_invoices, monthly_coding, custom_items) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(u.lastInsertRowid, name, username,
            Number(emp.monthly_sales) || 0, Number(emp.monthly_invoices) || 0, Number(emp.monthly_coding) || 0,
            JSON.stringify(Array.isArray(emp.custom_items) ? emp.custom_items : []));
        added.push({ id: e.lastInsertRowid, name, username });
      } catch (err) {
        skipped.push({ name, username, reason: 'username exists' });
      }
    }
  }
  if (Array.isArray(delete_ids)) {
    for (const id of delete_ids) {
      db.prepare('UPDATE employees SET active=0 WHERE id=?').run(Number(id));
      deleted.push(Number(id));
    }
  }
  if (branch_invoices !== undefined) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('branch_invoices', String(Number(branch_invoices) || 0));
  }
  const updated = [];
  if (Array.isArray(req.body.updates)) {
    for (const u of req.body.updates) {
      db.prepare('UPDATE employees SET monthly_sales=?, monthly_invoices=?, monthly_coding=? WHERE id=?')
        .run(Number(u.monthly_sales) || 0, Number(u.monthly_invoices) || 0, Number(u.monthly_coding) || 0, Number(u.id));
      updated.push(Number(u.id));
    }
  }
  if (req.body.settings && typeof req.body.settings === 'object') {
    const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const k of ['branch_sales', 'branch_invoices', 'branch_coding', 'branch_delivery']) {
      if (req.body.settings[k] !== undefined) set.run(k, String(Number(req.body.settings[k]) || 0));
    }
  }
  audit(me(req).username, 'batch_employees', `إضافة جماعية ${added.length} موظف، حذف ${deleted.length}`);
  res.json({ ok: true, added, skipped, deleted, updated });
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
  const own = ownEmployeeId(req);
  const employee_id = own || req.query.employee_id;
  const { month } = req.query;
  if (!employee_id || !month) return res.status(400).json({ error: 'employee_id و month مطلوبان' });
  const { start, end } = monthRange(month);
  const rows = db.prepare('SELECT * FROM daily_results WHERE employee_id=? AND date>=? AND date<=? ORDER BY date')
    .all(employee_id, start, end);
  res.json(rows);
});
app.post('/api/daily', requireAuth, (req, res) => {
  const own = ownEmployeeId(req);
  const { date, sales, invoices, coding, delivery, preferred_value } = req.body || {};
  const employee_id = own || req.body.employee_id;
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
// Sheet totals for one month: latest upload per (type, filename).
// Items sheets feed branch totals only (no employee names);
// sales sheets also feed per-employee totals.
function sheetTotalsForMonth(month) {
  const sheetRows = db.prepare("SELECT * FROM sheet_uploads WHERE COALESCE(NULLIF(sheet_month,''), substr(created_at,1,7))=? ORDER BY id DESC").all(month);
  const seen = new Set();
  const sheets = { sales: 0, invoices: 0, coding: 0, coded: 0, preferred: 0, itemsCount: 0, totalQty: 0, files: [], byEmployee: {} };
  // The bills sheet and the items sheet are two views of the SAME month's sales.
  // When both exist, the items sheet's total must not be added to branch sales
  // again (its item-level analysis — Preferred, top items, origins — still counts).
  const deduped = [];
  for (const u of sheetRows) {
    const key = `${u.type}|${u.filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(u);
  }
  const hasBills = deduped.some(u => u.type === 'sales');
  for (const u of deduped) {
    const a = analyzeRows(u.type, JSON.parse(u.rows_json || '[]'));
    if (!(hasBills && u.type === 'items')) sheets.sales += a.totalSales || 0;
    sheets.invoices += a.totalInvoices || 0;
    sheets.coding += a.totalCoding || 0;
    sheets.coded += a.totalCoded || 0;
    sheets.preferred += a.preferredValue || 0;
    sheets.itemsCount += a.itemsCount || 0;
    sheets.totalQty += a.totalQty || 0;
    sheets.files.push(u.filename);
    for (const [name, v] of Object.entries(a.byEmployee || {})) {
      const n = String(name).trim();
      sheets.byEmployee[n] = sheets.byEmployee[n] || { sales: 0, invoices: 0, coding: 0, qty: 0, coded: 0 };
      sheets.byEmployee[n].sales += v.sales || 0;
      sheets.byEmployee[n].invoices += v.invoices || 0;
      sheets.byEmployee[n].coding += v.coding || 0;
      sheets.byEmployee[n].qty += v.qty || 0;
      sheets.byEmployee[n].coded += v.coded || 0;
    }
  }
  return sheets;
}
// Milk + diapers (excluded from cashback): infant formula brands and diapers.
// Wipes are NOT diapers. "نان" must be a whole word (not "اسنان" = teeth).
const EXCLUDED_ITEM_RE = /bebelac|aptamil|similac|nestogen|nutrilon|s-26|pampers|molfix|huggies|babyjoy|fine baby|novalac|primalac|liptomil|بيبيلاك|ببلاك|ابتاميل|أبتاميل|سيميلاك|نستوجين|نوفالاك|بريمالاك|ليبتوميل|حليب أطفال|لبن أطفال|حفاض|حفاظ|بامبرز|مولفكس|بيبي جوي|فاين بيبي|هجيز/i;
const NAN_WORD_RE = /(^|[\s\-])نان([\s\-]|$)/;
const HERO_FORMULA_RE = /hero baby\s*[123]/i;
function isExcludedItem(name) {
  const n = String(name || '');
  if (/wipes/i.test(n)) return false;
  return EXCLUDED_ITEM_RE.test(n) || NAN_WORD_RE.test(n) || HERO_FORMULA_RE.test(n);
}
// Branch total of milk + diapers in the month, from the items sheets.
function excludedBranchTotal(month) {
  const uploads = db.prepare("SELECT filename, rows_json FROM sheet_uploads WHERE type='items' AND COALESCE(NULLIF(sheet_month,''), substr(created_at,1,7))=? ORDER BY id DESC").all(month);
  const seen = new Set(); let total = 0;
  for (const u of uploads) {
    if (seen.has(u.filename)) continue; seen.add(u.filename);
    for (const row of JSON.parse(u.rows_json || '[]')) {
      const item = String(row.item || row['الصنف'] || row['الإسم'] || '').trim();
      if (isExcludedItem(item)) total += Number(row.value || row['القيمة'] || row.total || 0) || 0;
    }
  }
  return Math.round(total * 100) / 100;
}
// Cashback rule: every full 500 EGP (after excluding milk/diapers) earns 25.
// 800 -> 25, 1000 -> 50. The 500 step is fixed.
function cashbackFor(sales, excluded, ly) {
  const step = Number(ly.cashback_step) || 500;
  const per = ly.cashback_per_500 ?? 25;
  return Math.floor(Math.max(0, (Number(sales) || 0) - (Number(excluded) || 0)) / step) * per;
}
function prevMonthStr(m) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
app.get('/api/reports/summary', requireAuth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const settings = getSettings();
  const emps = db.prepare('SELECT * FROM employees WHERE active=1').all();
  const wd = workingDays(month);
  const today = new Date().toISOString().slice(0, 10);
  const dayNum = month === today.slice(0, 7) ? Number(today.slice(8, 10)) : monthRange(month).daysInMonth;
  const sheets = sheetTotalsForMonth(month);
  // Branch coded-invoice rate (from bills sheets) and whether ANY new-code
  // data was recorded this month (daily entries). When nobody recorded new
  // codes, the coding part of the index uses the coded-invoice rate instead
  // of 0/new-target — otherwise every employee's index is dragged to ~60%
  // and everyone gets the same "يحتاج دعمًا" label.
  const branchCoded = Object.values(sheets.byEmployee).reduce((a, v) => a + (v.coded || 0), 0);
  const branchInv = Object.values(sheets.byEmployee).reduce((a, v) => a + (v.invoices || 0), 0);
  const sheetBranchRate = branchInv ? Math.round(branchCoded / branchInv * 1000) / 10 : 0;
  const sheetBranchRateTarget = sheetBranchRate ? Math.min(100, Math.round(sheetBranchRate * 1.1 * 10) / 10) : 0;
  const anyCodingData = db.prepare("SELECT COUNT(*) c FROM daily_results WHERE substr(date,1,7)=? AND coding>0").get(month).c > 0;
  const perEmployee = emps.map(e => {
    const t = employeeTotals(e.id, month);
    const offDates = offDaysFor(e.id, month);
    const wdEmp = workingDaysFor(month, offDates);
    const sh = sheets.byEmployee[e.name.trim()] || { sales: 0, invoices: 0, coding: 0, qty: 0, coded: 0 };
    t.sales += sh.sales; t.invoices += sh.invoices; t.coding += sh.coding; t.qty = sh.qty || 0; t.coded = sh.coded || 0;
    t.codingRate = t.invoices ? Math.round(t.coded / t.invoices * 1000) / 10 : 0;
    t.codingRateTarget = t.codingRate ? Math.min(100, Math.round(t.codingRate * 1.1 * 10) / 10) : 0;
    const dailySales = e.monthly_sales / wdEmp;
    const remainingDays = remainingWorkingDaysFor(month, Math.min(dayNum + 1, monthRange(month).daysInMonth), offDates);
    const tomorrowSales = Math.max(0, Math.round((e.monthly_sales - t.sales) / remainingDays));
    const idxParts = [];
    if (e.monthly_sales > 0) idxParts.push(pct(t.sales, e.monthly_sales));
    if (e.monthly_invoices > 0) idxParts.push(pct(t.invoices, e.monthly_invoices));
    if (e.monthly_coding > 0) {
      if (anyCodingData) idxParts.push(pct(t.coding, e.monthly_coding));
      else if (sheetBranchRateTarget > 0) idxParts.push(Math.min(100, Math.round(t.codingRate / sheetBranchRateTarget * 100)));
    }
    const idx = idxParts.length ? Math.round(idxParts.reduce((a, b) => a + b, 0) / idxParts.length) : 0;
    return {
      id: e.id, name: e.name, username: e.username,
      target: { sales: e.monthly_sales, invoices: e.monthly_invoices, coding: e.monthly_coding },
      achieved: t, index: idx,
      classification: idx >= 90 ? 'ممتاز' : idx >= 80 ? 'جيد جدًا' : idx >= 70 ? 'على المسار الصحيح' : idx >= 50 ? 'يحتاج دعمًا' : 'متأخر',
      dailyRequired: { sales: Math.round(dailySales), invoices: Math.round(e.monthly_invoices / wdEmp), coding: Math.round(e.monthly_coding / wdEmp) },
      tomorrow: { sales: tomorrowSales },
      custom_items: JSON.parse(e.custom_items || '[]'),
    };
  });
  const totals = perEmployee.reduce((a, e) => ({
    sales: a.sales + e.achieved.sales, invoices: a.invoices + e.achieved.invoices,
    coding: a.coding + e.achieved.coding, delivery: a.delivery + e.achieved.delivery,
    preferred: a.preferred + e.achieved.preferred,
  }), { sales: 0, invoices: 0, coding: 0, delivery: 0, preferred: 0 });
  // Items sheets carry no employee names, so their branch sales live only here.
  const branchOnlySheetSales = sheets.sales - perEmployee.reduce((a, e) => a + (sheets.byEmployee[e.name.trim()]?.sales || 0), 0);
  totals.sales += branchOnlySheetSales;
  totals.invoices += sheets.invoices - perEmployee.reduce((a, e) => a + (sheets.byEmployee[e.name.trim()]?.invoices || 0), 0);
  totals.coding += sheets.coding - perEmployee.reduce((a, e) => a + (sheets.byEmployee[e.name.trim()]?.coding || 0), 0);
  totals.preferred += sheets.preferred;
  totals.coded = sheets.coded || 0;
  totals.codingRate = totals.invoices ? Math.round(totals.coded / totals.invoices * 1000) / 10 : 0;
  totals.codingRateTarget = totals.codingRate ? Math.min(100, Math.round(totals.codingRate * 1.1 * 10) / 10) : 0;
  const avgInvoice = totals.invoices > 0 ? Math.round(totals.sales / totals.invoices) : 0;
  // Problems, analysed per employee from their REAL numbers — never the same
  // generic text for everyone. Each employee gets at most their top 2 issues.
  // No per-employee data at all this month means "no data yet", not "behind".
  const anyActivity = perEmployee.some(e => e.achieved.sales > 0 || e.achieved.invoices > 0 || e.achieved.coding > 0);
  const problems = [];
  const monthIsPast = month < today.slice(0, 7);
  const teamAtv = totals.invoices > 0 ? totals.sales / totals.invoices : 0;
  const teamQty = perEmployee.reduce((a, e) => a + (e.achieved.qty || 0), 0);
  const teamUpt = totals.invoices > 0 ? teamQty / totals.invoices : 0;
  const branchRate = totals.codingRate || 0;
  for (const e of perEmployee) {
    if (!anyActivity) break;
    const salesPct = pct(e.achieved.sales, e.target.sales);
    const invPct = pct(e.achieved.invoices, e.target.invoices);
    const atv = e.achieved.invoices > 0 ? e.achieved.sales / e.achieved.invoices : 0;
    const upt = e.achieved.invoices > 0 ? (e.achieved.qty || 0) / e.achieved.invoices : 0;
    const rate = e.achieved.codingRate || 0;
    const empProblems = [];
    if (e.target.sales > 0 && salesPct < 80 && dayNum >= 10) {
      const gap = Math.max(0, e.target.sales - e.achieved.sales);
      empProblems.push({ sev: 100 - salesPct, employee: e.name, problem: `مبيعات ${e.name} ${salesPct}% بس من التارجت — ناقص ${fmt0(gap)} جنيه`, cause: `مبيعاته اليومية ${fmt0(Math.round(e.achieved.sales / Math.max(1, dayNum)))} جنيه مقابل مطلوب ${fmt0(e.dailyRequired.sales)} جنيه في اليوم`, solution: monthIsPast ? `الشهر خلص — راجع معاه سبب القصور (متوسط فاتورته ${Math.round(atv)} ج، ${Math.round(upt * 10) / 10} صنف/فاتورة) وحط تارجت الشهر الجاي على أساسه` : `محتاج ${fmt0(e.tomorrow.sales)} جنيه في اليوم من بكره عشان يلحق — ركّز معاه على أصناف الـ Preferred والعملاء المكوّدين`, indicator: 'نسبة تحقيق المبيعات' });
    }
    if (e.target.invoices > 0 && invPct < 80 && dayNum >= 10 && invPct < salesPct) {
      const gapInv = Math.max(0, e.target.invoices - e.achieved.invoices);
      empProblems.push({ sev: 90 - invPct, employee: e.name, problem: `عدد فواتير ${e.name} ${invPct}% بس من التارجت — ناقص ${fmt0(gapInv)} فاتورة`, cause: `بيعمل ${Math.round(e.achieved.invoices / Math.max(1, dayNum))} فاتورة في اليوم مقابل مطلوب ${e.dailyRequired.invoices} فاتورة`, solution: monthIsPast ? 'الشهر خلص — شوف هل كان غياب ورديات ولا فواتير بتتسجل باسم حد تاني، وظبط ورديات الشهر الجاي' : 'سرّع خدمة العملاء على الكاشير وخلّي كل عميل فاتورة لوحده بدل دمج الفواتير', indicator: 'عدد الفواتير اليومي' });
    }
    if (rate > 0 && branchRate > 0 && rate < branchRate * 0.8 && e.achieved.invoices >= 100) {
      const uncoded = e.achieved.invoices - (e.achieved.coded || 0);
      empProblems.push({ sev: 60, employee: e.name, problem: `نسبة الفواتير بكود عند ${e.name} ${rate}% بس — أقل من متوسط الفرع ${branchRate}%`, cause: `${fmt0(uncoded)} فاتورة من ${fmt0(e.achieved.invoices)} طلعت من غير كود عميل`, solution: 'اطلب منه يأكد كود العميل قبل تقفيل أي فاتورة، وراجع معاه الفواتير اللي من غير كود في نهاية كل وردية', indicator: 'نسبة الفواتير بكود' });
    }
    if (e.achieved.invoices >= 20 && teamAtv > 0 && atv < teamAtv * 0.75) {
      empProblems.push({ sev: 40, employee: e.name, problem: `متوسط فاتورة ${e.name} (${Math.round(atv)} ج) أقل بكتير من متوسط الفرع (${Math.round(teamAtv)} ج) — سلال صغيرة`, cause: 'لا يقترح أصناف إضافية مع الفاتورة', solution: 'درّبه يقترح صنفًا مكملًا مع كل فاتورة (Preferred أولًا) وراجع متوسط فاتورته يوميًا', indicator: 'متوسط قيمة الفاتورة' });
    }
    if (e.achieved.invoices >= 20 && teamUpt > 0 && upt < teamUpt * 0.8) {
      empProblems.push({ sev: 30, employee: e.name, problem: `${e.name} بيبيع ${Math.round(upt * 10) / 10} صنف في الفاتورة مقابل متوسط الفرع ${Math.round(teamUpt * 10) / 10}`, cause: 'بيع صنف واحد في أغلب الفواتير', solution: 'اقتراح صنف تاني مناسب مع كل روشتة (فيتامين أو عناية) يرفع عدد الأصناف في الفاتورة', indicator: 'أصناف / فاتورة' });
    }
    if (dayNum >= 15 && e.achieved.invoices > 0 && e.achieved.invoices < 20) {
      empProblems.push({ sev: 70, employee: e.name, problem: `نشاط ${e.name} شبه متوقف — ${e.achieved.invoices} فاتورة بس في الشهر لحد دلوقتي`, cause: 'غياب أو ورديات قليلة أو فواتير بتتسجل باسم حد تاني', solution: 'راجع وردياته وتأكد إن فواتيره بتتسجل باسمه في e-Plus', indicator: 'عدد الفواتير' });
    }
    empProblems.sort((a, b) => b.sev - a.sev);
    problems.push(...empProblems.slice(0, 2).map(({ sev, ...p }) => p));
  }
  // One branch-level note (not per employee): no NEW-code data exists at all.
  if (anyActivity && totals.coding === 0) {
    problems.push({ employee: 'الفرع', problem: 'لا توجد بيانات أكواد جديدة مسجلة في الشهر ده', cause: 'الشيت بيقول كام فاتورة بكود، مش كام كود جديد اتعمل — والتسجيل اليومي فاضي', solution: 'التكويد الجديد يتسجل في "تسجيل نتائج اليوم" بعد كل وردية، أو ابعت شيت سبتمبر عشان نقارن الأكواد اللي ظهرت لأول مرة', indicator: 'بيانات التكويد' });
  }
  if (anyActivity && totals.sales < settings.branch_sales * 0.5 && dayNum >= 15) {
    problems.push({ employee: 'الفرع', problem: 'مبيعات الفرع أقل من 50% من التارجت الشهري', cause: 'إجمالي المبيعات اليومية أقل من المطلوب', solution: 'اجتماع سريع مع الفريق، مراجعة الـ Preferred List، وزيادة المتابعة اليومية', indicator: 'نسبة تحقيق مبيعات الفرع' });
  }
  // Leaderboard: the live month ranks by % of target; a finished month ranks
  // by real sales (its targets were forecast FROM that month, so % would tie
  // everyone). Each row also carries its share of branch sales and the
  // improvement vs last month (null when last month has no data).
  const daysInMonth = monthRange(month).daysInMonth;
  const prevSheets = sheetTotalsForMonth(prevMonthStr(month));
  const isPastMonth = month < today.slice(0, 7);
  const leaderboard = perEmployee.map(e => {
    const salesPct = pct(e.achieved.sales, e.target.sales);
    const prev = prevSheets.byEmployee[e.name.trim()] || { sales: 0 };
    const prevPct = pct(prev.sales || 0, e.target.sales);
    const elapsed = Math.max(1, Math.min(dayNum, daysInMonth));
    const share = totals.sales > 0 ? Math.round((e.achieved.sales / totals.sales) * 100) : 0;
    return {
      id: e.id, name: e.name,
      salesPct, invPct: pct(e.achieved.invoices, e.target.invoices),
      achieved: e.achieved, target: e.target,
      dailyRequired: e.dailyRequired, tomorrow: e.tomorrow,
      projection: Math.round((e.achieved.sales / elapsed) * daysInMonth),
      atv: e.achieved.invoices > 0 ? Math.round(e.achieved.sales / e.achieved.invoices) : 0,
      upt: e.achieved.invoices > 0 ? +((e.achieved.qty || 0) / e.achieved.invoices).toFixed(1) : 0,
      share,
      impact: share >= 15 ? 'مؤثر جدًا' : share >= 10 ? 'مؤثر' : share >= 5 ? 'متوسط' : 'تأثير محدود',
      improved: (prev.sales || 0) > 0 ? salesPct - prevPct : null,
    };
  }).sort((a, b) => isPastMonth ? b.achieved.sales - a.achieved.sales : b.salesPct - a.salesPct)
    .map((r, i) => ({ ...r, rank: i + 1, rankBy: isPastMonth ? 'sales' : 'pct' }));
  const own = ownEmployeeId(req);
  if (req.session.user.role === 'employee' && own) {
    const mine = perEmployee.find(e => e.id === own);
    return res.json({ month, settings, workingDays: wd,
      totals: mine ? mine.achieved : { sales: 0, invoices: 0, coding: 0, delivery: 0, preferred: 0 },
      avgInvoice: 0, perEmployee: mine ? [mine] : [],
      problems: mine ? problems.filter(x => x.employee === mine.name) : [],
      sheets: {}, leaderboard: [] });
  }
  res.json({ month, settings, workingDays: wd, totals, avgInvoice, perEmployee, problems, sheets, leaderboard });
});

// Smart Performance Coach
app.get('/api/coach/:employee_id', requireAuth, (req, res) => {
  const own = ownEmployeeId(req);
  if (own && Number(req.params.employee_id) !== own) return res.status(403).json({ error: 'غير مسموح' });
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.employee_id);
  if (!e) return res.status(404).json({ error: 'موظف غير موجود' });
  const t = employeeTotals(e.id, month);
  // Sheet sales count too (the old coach only saw manual daily entries).
  const sh = sheetTotalsForMonth(month).byEmployee[e.name.trim()] || { sales: 0, invoices: 0, coding: 0 };
  t.sales += sh.sales; t.invoices += sh.invoices; t.coding += sh.coding;
  const tips = [];
  if (t.sales === 0 && t.invoices === 0 && t.coding === 0) {
    tips.push({ cause: 'لا توجد بيانات مسجلة بعد لهذا الشهر', indicator: 'البيانات', amount: 0, suggestion: 'ارفع شيت مبيعات الشهر أو سجّل نتائج اليوم من لوحة الموظف', expected: 'ظهور الأداء الحقيقي بدل التنبيهات' });
    return res.json({ employee: e.name, tips });
  }
  const salesPct = pct(t.sales, e.monthly_sales);
  if (e.monthly_sales > 0 && salesPct < 70) tips.push({ cause: 'المبيعات أقل من المطلوب', indicator: 'المبيعات', amount: Math.round(e.monthly_sales - t.sales), suggestion: 'ركز على أصناف الـ Preferred وعلى العملاء المترددين، وراجع المطلوب اليومي كل صباح', expected: 'رفع نسبة تحقيق المبيعات' });
  if (e.monthly_coding > 0 && pct(t.coding, e.monthly_coding) < 70) tips.push({ cause: 'التكويد أقل من المطلوب', indicator: 'التكويد', amount: Math.round(e.monthly_coding - t.coding), suggestion: 'كوّد كل عميل جديد فورًا قبل نهاية الشيفت', expected: 'زيادة قاعدة العملاء' });
  if (e.monthly_invoices > 0 && pct(t.invoices, e.monthly_invoices) < 70) tips.push({ cause: 'عدد الفواتير أقل من المطلوب', indicator: 'الفواتير', amount: Math.round(e.monthly_invoices - t.invoices), suggestion: 'سرّع خدمة العملاء ولا تدمج فواتير عملاء مختلفين', expected: 'زيادة عدد الفواتير' });
  if (!tips.length) tips.push({ cause: 'لا توجد مشكلة واضحة', indicator: 'الأداء العام', amount: 0, suggestion: 'حافظ على نفس المعدل اليومي حتى نهاية الشهر', expected: 'تحقيق التارجت كاملًا' });
  res.json({ employee: e.name, tips });
});

// Monthly plan calendar for one employee: daily required sales/invoices/items
// (from their target and their October behaviour) + achieved per day.
app.get('/api/employee/:id/plan', requireAuth, (req, res) => {
  const own = ownEmployeeId(req);
  if (own && Number(req.params.id) !== own) return res.status(403).json({ error: 'غير مسموح' });
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'موظف غير موجود' });
  const offDates = offDaysFor(e.id, month);
  const wd = workingDaysFor(month, offDates);
  const prev = prevMonthStr(month);
  let baselineMonth = prev;
  let octSheets = sheetTotalsForMonth(prev).byEmployee[e.name.trim()] || { sales: 0, invoices: 0, qty: 0 };
  let octDaily = employeeTotals(e.id, prev);
  let oct = { sales: octSheets.sales + octDaily.sales, invoices: octSheets.invoices + octDaily.invoices, qty: octSheets.qty || 0 };
  if (oct.sales === 0 && oct.invoices === 0) {
    // No data in the previous month (e.g. viewing October itself) — use this month's own data as the baseline.
    baselineMonth = month;
    octSheets = sheetTotalsForMonth(month).byEmployee[e.name.trim()] || { sales: 0, invoices: 0, qty: 0 };
    octDaily = employeeTotals(e.id, month);
    oct = { sales: octSheets.sales + octDaily.sales, invoices: octSheets.invoices + octDaily.invoices, qty: octSheets.qty || 0 };
  }
  const octWd = workingDays(prev);
  const atv = oct.invoices > 0 ? oct.sales / oct.invoices : 0;
  const upt = oct.invoices > 0 ? oct.qty / oct.invoices : 0;
  const dailySales = wd ? Math.round(e.monthly_sales / wd) : 0;
  const dailyInvoices = wd ? Math.round(e.monthly_invoices / wd * 10) / 10 : 0;
  const dailyQty = Math.round(dailyInvoices * upt * 10) / 10;
  // Achieved per day: manual daily entries + bills-sheet rows (which carry dates).
  const achievedByDate = {};
  const { start, end } = monthRange(month);
  for (const d of db.prepare('SELECT * FROM daily_results WHERE employee_id=? AND date>=? AND date<=?').all(e.id, start, end)) {
    achievedByDate[d.date] = { sales: d.sales, invoices: d.invoices, qty: 0 };
  }
  const uploads = db.prepare("SELECT rows_json FROM sheet_uploads WHERE type='sales' AND COALESCE(NULLIF(sheet_month,''), substr(created_at,1,7))=?").all(month);
  const seenFiles = new Set();
  for (const u of uploads) {
    for (const row of JSON.parse(u.rows_json || '[]')) {
      if (String(row.employee || '').trim() !== e.name.trim() || !row.date) continue;
      const a = achievedByDate[row.date] || (achievedByDate[row.date] = { sales: 0, invoices: 0, qty: 0 });
      a.sales += Number(row.sales || 0); a.invoices += Number(row.invoices || 0); a.qty += Number(row.qty || 0);
    }
  }
  const { daysInMonth } = monthRange(month);
  const [y, m] = month.split('-').map(Number);
  const todayStr = new Date().toISOString().slice(0, 10);
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const isWorking = offDates.size > 0 ? !offDates.has(date) : new Date(y, m - 1, d).getDay() !== 5;
    days.push({ date, day: d, weekday: new Date(y, m - 1, d).getDay(), isWorking,
      required: isWorking ? { sales: dailySales, invoices: dailyInvoices, qty: dailyQty } : null,
      achieved: achievedByDate[date] || null, isPast: date < todayStr, isToday: date === todayStr });
  }
  const monthAchieved = employeeTotals(e.id, month);
  const sh = sheetTotalsForMonth(month).byEmployee[e.name.trim()] || { sales: 0, invoices: 0, qty: 0 };
  monthAchieved.sales += sh.sales; monthAchieved.invoices += sh.invoices; monthAchieved.qty = sh.qty || 0;
  // Catch-up: shortfall on past working days that have recorded data.
  let missedDays = 0, shortfallSales = 0, shortfallInvoices = 0;
  for (const d of days) {
    if (!d.isWorking || !d.isPast || !d.achieved) continue;
    if (d.achieved.sales < d.required.sales) {
      missedDays += 1;
      shortfallSales += d.required.sales - d.achieved.sales;
      shortfallInvoices += Math.max(0, d.required.invoices - d.achieved.invoices);
    }
  }
  const remWd = remainingWorkingDaysFor(month, Math.max(1, Number(todayStr.slice(8, 10))), offDates);
  const compensation = remWd > 0 ? { sales: Math.round(shortfallSales / remWd), invoices: Math.round(shortfallInvoices / remWd * 10) / 10 } : { sales: 0, invoices: 0 };
  const pace = remWd > 0 ? { sales: Math.round(Math.max(0, e.monthly_sales - monthAchieved.sales) / remWd),
    invoices: Math.round(Math.max(0, e.monthly_invoices - monthAchieved.invoices) / remWd * 10) / 10,
    qty: Math.round(Math.max(0, e.monthly_invoices - monthAchieved.invoices) / remWd * upt * 10) / 10 } : { sales: 0, invoices: 0, qty: 0 };
  res.json({ month, baselineMonth, offDays: [...offDates], employee: { id: e.id, name: e.name },
    compensation: { missedDays, shortfallSales, shortfallInvoices, perDay: compensation },
    target: { sales: e.monthly_sales, invoices: e.monthly_invoices },
    october: { ...oct, workingDays: octWd, atv: Math.round(atv), upt: Math.round(upt * 10) / 10,
      dailySales: octWd ? Math.round(oct.sales / octWd) : 0, dailyInvoices: octWd ? Math.round(oct.invoices / octWd * 10) / 10 : 0 },
    daily: { sales: dailySales, invoices: dailyInvoices, qty: dailyQty },
    achievedMonth: monthAchieved, remainingWorkingDays: remWd, paceFromToday: pace, days });
});

// 10-day report: strengths & weaknesses for one employee in one 10-day window.
app.get('/api/employee/:id/ten-day', requireAuth, (req, res) => {
  const own = ownEmployeeId(req);
  if (own && Number(req.params.id) !== own) return res.status(403).json({ error: 'غير مسموح' });
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'موظف غير موجود' });
  const [y, m] = month.split('-').map(Number);
  const { daysInMonth } = monthRange(month);
  const now = new Date();
  const curPeriod = month === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` ? (now.getDate() <= 10 ? 1 : now.getDate() <= 20 ? 2 : 3) : 3;
  const period = Math.min(3, Math.max(1, Number(req.query.period) || curPeriod));
  const from = period === 1 ? 1 : period === 2 ? 11 : 21;
  const to = period === 1 ? 10 : period === 2 ? 20 : daysInMonth;
  const fromStr = `${month}-${String(from).padStart(2, '0')}`, toStr = `${month}-${String(to).padStart(2, '0')}`;
  const wd = workingDays(month);
  const dailySales = wd ? e.monthly_sales / wd : 0;
  const dailyInv = wd ? e.monthly_invoices / wd : 0;
  const dailyCod = wd ? e.monthly_coding / wd : 0;
  let workDays = 0;
  for (let d = from; d <= to; d++) if (new Date(y, m - 1, d).getDay() !== 5) workDays += 1;
  const reqSales = Math.round(dailySales * workDays), reqInv = Math.round(dailyInv * workDays), reqCod = Math.round(dailyCod * workDays);
  // Achieved in the window: manual daily entries + bills-sheet rows (dated).
  const ach = { sales: 0, invoices: 0, coding: 0, qty: 0, coded: 0, daysRecorded: 0 };
  const seenDates = new Set();
  for (const d of db.prepare('SELECT * FROM daily_results WHERE employee_id=? AND date>=? AND date<=?').all(e.id, fromStr, toStr)) {
    ach.sales += d.sales; ach.invoices += d.invoices; ach.coding += d.coding; seenDates.add(d.date);
  }
  ach.daysRecorded = seenDates.size;
  const uploads = db.prepare("SELECT rows_json FROM sheet_uploads WHERE type='sales' AND COALESCE(NULLIF(sheet_month,''), substr(created_at,1,7))=?").all(month);
  let bestDay = null, worstDay = null;
  const byDate = {};
  for (const u of uploads) {
    for (const row of JSON.parse(u.rows_json || '[]')) {
      if (String(row.employee || '').trim() !== e.name.trim() || !row.date || row.date < fromStr || row.date > toStr) continue;
      ach.sales += Number(row.sales || 0); ach.invoices += Number(row.invoices || 0); ach.qty += Number(row.qty || 0);
      if (String(row.code || '').trim()) ach.coded += Number(row.invoices || 0);
      seenDates.add(row.date);
      byDate[row.date] = (byDate[row.date] || 0) + Number(row.sales || 0);
    }
  }
  ach.daysRecorded = seenDates.size;
  for (const [date, v] of Object.entries(byDate)) {
    if (!bestDay || v > bestDay.sales) bestDay = { date, sales: v };
    if (!worstDay || v < worstDay.sales) worstDay = { date, sales: v };
  }
  // Branch averages for the same window (from the month sheets + daily entries).
  const sheets = sheetTotalsForMonth(month);
  const branchInv = sheets.invoices || 0;
  const branchAtv = branchInv ? sheets.sales / branchInv : 0;
  const branchUpt = branchInv ? (sheets.totalQty || 0) / branchInv : 0;
  const branchCodingRate = branchInv ? (sheets.coded || 0) / branchInv * 100 : 0;
  const atv = ach.invoices ? ach.sales / ach.invoices : 0;
  const upt = ach.invoices ? ach.qty / ach.invoices : 0;
  const codingRate = ach.invoices ? ach.coded / ach.invoices * 100 : 0;
  const salesPct = reqSales ? Math.round(ach.sales / reqSales * 100) : 0;
  const invPct = reqInv ? Math.round(ach.invoices / reqInv * 100) : 0;
  const codPct = reqCod ? Math.round(ach.coding / reqCod * 100) : 0;
  const strengths = [], weaknesses = [];
  if (salesPct >= 100) strengths.push(`حقق ${salesPct}% من مبيعات الفترة المطلوبة (${fmt0(ach.sales)} من ${fmt0(reqSales)} جنيه)`);
  else if (salesPct >= 80) strengths.push(`قريب من تارجت الفترة: ${salesPct}% من المبيعات المطلوبة`);
  if (atv > branchAtv && branchAtv > 0) strengths.push(`متوسط فاتورته ${Math.round(atv)} جنيه — أعلى من متوسط الفرع ${Math.round(branchAtv)} جنيه`);
  if (upt > branchUpt && branchUpt > 0) strengths.push(`بيبيع ${Math.round(upt * 10) / 10} صنف في الفاتورة — أعلى من متوسط الفرع ${Math.round(branchUpt * 10) / 10}`);
  if (codingRate > branchCodingRate && branchCodingRate > 0) strengths.push(`نسبة الفواتير بكود ${Math.round(codingRate * 10) / 10}% — أعلى من متوسط الفرع ${Math.round(branchCodingRate * 10) / 10}%`);
  if (invPct >= 100) strengths.push(`حقق ${invPct}% من عدد الفواتير المطلوب في الفترة`);
  if (bestDay) strengths.push(`أفضل يوم: ${bestDay.date} بمبيعات ${fmt0(bestDay.sales)} جنيه`);
  if (salesPct < 80) weaknesses.push(`مبيعات الفترة ${salesPct}% بس من المطلوب — ناقص ${fmt0(Math.max(0, reqSales - ach.sales))} جنيه`);
  if (atv < branchAtv * 0.9 && branchAtv > 0) weaknesses.push(`متوسط فاتورته ${Math.round(atv)} جنيه — أقل من متوسط الفرع ${Math.round(branchAtv)} جنيه (سلال صغيرة)`);
  if (upt < branchUpt * 0.9 && branchUpt > 0) weaknesses.push(`بيبيع ${Math.round(upt * 10) / 10} صنف في الفاتورة — أقل من متوسط الفرع ${Math.round(branchUpt * 10) / 10} (اقترح أصناف إضافية مع كل فاتورة)`);
  if (codingRate < branchCodingRate * 0.9 && branchCodingRate > 0) weaknesses.push(`نسبة الفواتير بكود ${Math.round(codingRate * 10) / 10}% — أقل من متوسط الفرع ${Math.round(branchCodingRate * 10) / 10}% (كوّد كل عميل جديد)`);
  if (invPct < 80) weaknesses.push(`عدد الفواتير ${invPct}% بس من المطلوب — ناقص ${Math.max(0, reqInv - ach.invoices)} فاتورة`);
  if (ach.daysRecorded < workDays) weaknesses.push(`سجّل نتائج ${ach.daysRecorded} يوم بس من ${workDays} يوم شغل في الفترة`);
  if (worstDay && worstDay.sales < dailySales * 0.5) weaknesses.push(`أضعف يوم: ${worstDay.date} بمبيعات ${fmt0(worstDay.sales)} جنيه بس`);
  if (!strengths.length && !weaknesses.length) weaknesses.push('لا توجد بيانات مسجلة في الفترة دي بعد');
  res.json({ month, period, from: fromStr, to: toStr, employee: { id: e.id, name: e.name },
    required: { sales: reqSales, invoices: reqInv, coding: reqCod, workingDays: workDays },
    achieved: ach, salesPct, invPct, codPct,
    averages: { atv: Math.round(atv), upt: Math.round(upt * 10) / 10, codingRate: Math.round(codingRate * 10) / 10,
      branchAtv: Math.round(branchAtv), branchUpt: Math.round(branchUpt * 10) / 10, branchCodingRate: Math.round(branchCodingRate * 10) / 10 },
    strengths, weaknesses });
});

// Employee-chosen days off: the day off is not fixed — the employee picks it from their own calendar.
app.get('/api/employee/:id/days-off', requireAuth, (req, res) => {
  const own = ownEmployeeId(req);
  if (own && Number(req.params.id) !== own) return res.status(403).json({ error: 'غير مسموح' });
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  res.json({ month, offDays: [...offDaysFor(Number(req.params.id), month)] });
});
app.post('/api/employee/:id/day-off', requireAuth, (req, res) => {
  const own = ownEmployeeId(req);
  if (own && Number(req.params.id) !== own) return res.status(403).json({ error: 'غير مسموح' });
  const { date, off } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'تاريخ غير صحيح' });
  if (off) db.prepare('INSERT OR IGNORE INTO employee_days_off (employee_id, date, created_by) VALUES (?,?,?)').run(req.params.id, date, me(req).username);
  else db.prepare('DELETE FROM employee_days_off WHERE employee_id=? AND date=?').run(req.params.id, date);
  res.json({ ok: true, off: !!off, date });
});

// Cashback sheet: one row per customer code — code, name, phone, cashback due,
// redeemed, remaining, and who redeemed it. Shown on every employee dashboard too.
app.get('/api/cashback', requireAuth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const loyalty = db.prepare('SELECT * FROM loyalty_settings WHERE id=1').get()
    || { cashback_rate: 1, gold_min: 5000, vip_min: 20000, cashback_per_500: 25, cashback_step: 500 };
  const profiles = Object.fromEntries(db.prepare('SELECT * FROM customer_profiles').all().map(r => [r.code, r]));
  const uploads = db.prepare("SELECT filename, rows_json FROM sheet_uploads WHERE type='sales' AND COALESCE(NULLIF(sheet_month,''), substr(created_at,1,7))=? ORDER BY id DESC").all(month);
  const seenUp = new Set(); const salesByCode = {};
  for (const u of uploads) {
    if (seenUp.has(u.filename)) continue; seenUp.add(u.filename);
    for (const row of JSON.parse(u.rows_json || '[]')) {
      const code = String(row.code || '').trim();
      if (!code) continue;
      salesByCode[code] = (salesByCode[code] || 0) + (Number(row.sales || 0) || 0);
    }
  }
  const reds = db.prepare('SELECT * FROM cashback_redemptions WHERE month=? ORDER BY id').all(month);
  const byCode = {};
  for (const r of reds) {
    const b = byCode[r.customer_code] || (byCode[r.customer_code] = { redeemed: 0, lastBy: '', list: [] });
    b.redeemed += Number(r.amount) || 0; b.lastBy = r.employee_name; b.list.push({ amount: r.amount, employee_name: r.employee_name, created_at: r.created_at });
  }
  const rows = Object.entries(salesByCode).map(([code, sales]) => {
    const prof = profiles[code] || {};
    const due = cashbackFor(sales, prof.excluded || 0, loyalty);
    if (due <= 0) return null;
    const b = byCode[code] || { redeemed: 0, lastBy: '', list: [] };
    return { code, name: prof.name || '', phone: prof.phone || '', sales: Math.round(sales * 100) / 100,
      cashback: due, redeemed: Math.round(b.redeemed * 100) / 100,
      remaining: Math.max(0, Math.round((due - b.redeemed) * 100) / 100), redeemedBy: b.lastBy, redemptions: b.list };
  }).filter(Boolean).sort((a, b) => b.remaining - a.remaining || b.cashback - a.cashback);
  res.json({ month, rows,
    summary: { totalCashback: rows.reduce((a, r) => a + r.cashback, 0), totalRedeemed: rows.reduce((a, r) => a + r.redeemed, 0), totalRemaining: rows.reduce((a, r) => a + r.remaining, 0), customers: rows.length } });
});
app.post('/api/cashback/redeem', requireAuth, (req, res) => {
  const { code, amount, month: m } = req.body || {};
  const month = m || new Date().toISOString().slice(0, 7);
  const amt = Number(amount) || 0;
  if (!String(code || '').trim()) return res.status(400).json({ error: 'الكود مطلوب' });
  if (amt <= 0) return res.status(400).json({ error: 'المبلغ لازم يكون أكبر من صفر' });
  const meUser = me(req);
  const own = ownEmployeeId(req);
  const empName = own ? (db.prepare('SELECT name FROM employees WHERE id=?').get(own)?.name || meUser.name) : meUser.name;
  // Recompute the remaining balance for this customer in this month.
  const cur = awaitCashbackRemaining(String(code).trim(), month);
  if (!cur) return res.status(404).json({ error: 'العميل ده معندوش كاش باك في الشهر ده' });
  if (amt > cur.remaining) return res.status(400).json({ error: `المبلغ أكبر من الباقي (${cur.remaining} جنيه)` });
  db.prepare('INSERT INTO cashback_redemptions (customer_code, employee_id, employee_name, amount, month) VALUES (?,?,?,?,?)')
    .run(String(code).trim(), own || null, empName, amt, month);
  persistDb();
  res.json({ ok: true, remaining: Math.round((cur.remaining - amt) * 100) / 100, redeemedBy: empName });
});
function awaitCashbackRemaining(code, month) {
  const loyalty = db.prepare('SELECT * FROM loyalty_settings WHERE id=1').get()
    || { cashback_rate: 1, gold_min: 5000, vip_min: 20000, cashback_per_500: 25, cashback_step: 500 };
  const prof = db.prepare('SELECT * FROM customer_profiles WHERE code=?').get(code) || {};
  const uploads = db.prepare("SELECT filename, rows_json FROM sheet_uploads WHERE type='sales' AND COALESCE(NULLIF(sheet_month,''), substr(created_at,1,7))=? ORDER BY id DESC").all(month);
  const seenUp = new Set(); let sales = 0;
  for (const u of uploads) {
    if (seenUp.has(u.filename)) continue; seenUp.add(u.filename);
    for (const row of JSON.parse(u.rows_json || '[]'))
      if (String(row.code || '').trim() === code) sales += Number(row.sales || 0) || 0;
  }
  const due = cashbackFor(sales, prof.excluded || 0, loyalty);
  if (due <= 0) return null;
  const redeemed = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM cashback_redemptions WHERE customer_code=? AND month=?').get(code, month).s;
  return { due, redeemed, remaining: Math.max(0, Math.round((due - redeemed) * 100) / 100) };
}

// Customers dashboard: distinct customers from the bills sheets (by code).
app.get('/api/customers', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const byCode = {};
  const priorCodes = new Set();
  const priorByCode = {};
  const priorMonths = {};
  const allUploads = db.prepare("SELECT rows_json, COALESCE(NULLIF(sheet_month,''), substr(created_at,1,7)) m FROM sheet_uploads WHERE type='sales' ORDER BY id").all();
  for (const u of allUploads) {
    for (const row of JSON.parse(u.rows_json || '[]')) {
      const code = String(row.code || '').trim();
      if (!code) continue;
      if (u.m < month) {
        priorCodes.add(code);
        const pc = priorByCode[code] || (priorByCode[code] = { code, sales: 0, invoices: 0, lastDate: '' });
        pc.sales += Number(row.sales || 0); pc.invoices += 1;
        if (row.date && (!pc.lastDate || row.date > pc.lastDate)) pc.lastDate = row.date;
        const pm = priorMonths[u.m] || (priorMonths[u.m] = { sales: 0, invoices: 0, codes: new Set() });
        pm.sales += Number(row.sales || 0); pm.invoices += 1; pm.codes.add(code);
      }
    }
  }
  const uploads = db.prepare("SELECT filename, rows_json FROM sheet_uploads WHERE type='sales' AND COALESCE(NULLIF(sheet_month,''), substr(created_at,1,7))=? ORDER BY id DESC").all(month);
  const seenUp = new Set();
  let totalInvoices = 0, codedInvoices = 0, uncodedInvoices = 0, uncodedSales = 0;
  for (const u of uploads) {
    if (seenUp.has(u.filename)) continue;
    seenUp.add(u.filename);
    for (const row of JSON.parse(u.rows_json || '[]')) {
      totalInvoices += 1;
      const code = String(row.code || '').trim();
      const sales = Number(row.sales || 0);
      if (!code) { uncodedInvoices += 1; uncodedSales += sales; continue; }
      codedInvoices += 1;
      const c = byCode[code] || (byCode[code] = { code, name: '', invoices: 0, sales: 0, firstDate: row.date || '', lastDate: row.date || '', employees: {}, dates: [], firstHalf: 0, secondHalf: 0 });
      c.invoices += 1; c.sales += sales;
      if (row.customer) c.name = row.customer;
      if (row.date) {
        if (!c.firstDate || row.date < c.firstDate) c.firstDate = row.date;
        if (!c.lastDate || row.date > c.lastDate) c.lastDate = row.date;
        c.dates.push(row.date);
        if (+row.date.slice(8, 10) <= 15) c.firstHalf += 1; else c.secondHalf += 1;
      }
      const emp = String(row.employee || '').trim() || 'غير محدد';
      c.employees[emp] = (c.employees[emp] || 0) + 1;
    }
  }
  const loyalty = db.prepare('SELECT * FROM loyalty_settings WHERE id=1').get()
    || { cashback_rate: 1, gold_min: 5000, vip_min: 20000, cashback_per_500: 25, cashback_step: 500 };
  const profiles = Object.fromEntries(db.prepare('SELECT * FROM customer_profiles').all().map(r => [r.code, r]));
  const openComplaints = db.prepare("SELECT COUNT(*) c FROM complaints WHERE status='open'").get().c;
  const monthEnd = new Date(+month.split('-')[0], +month.split('-')[1], 0);
  const inactiveBefore = new Date(monthEnd.getTime() - 14 * 86400000).toISOString().slice(0, 10);
  const customers = Object.values(byCode).map(c => {
    const prof = profiles[c.code] || {};
    const tier = c.sales >= loyalty.vip_min ? 'VIP' : c.sales >= loyalty.gold_min ? 'Gold' : 'Silver';
    return { ...c,
      name: prof.name || c.name || '',
      phone: prof.phone || '',
      notes: prof.notes || '',
      topEmployee: Object.entries(c.employees).sort((a, b) => b[1] - a[1])[0]?.[0] || '',
      isNew: !priorCodes.has(c.code),
      tier,
      excluded: prof.excluded || 0,
      cashback: cashbackFor(c.sales, prof.excluded || 0, loyalty),
      isInactive: !!c.lastDate && c.lastDate < inactiveBefore,
    };
  }).sort((a, b) => b.sales - a.sales);
  // ---- Advanced analytics (Pharma Care: analytics & reports only) ----
  const totalSales = customers.reduce((a, c) => a + c.sales, 0);
  const repeat = customers.filter(c => c.invoices > 1);
  const top10 = customers.slice(0, 10);
  const churned = Object.values(priorByCode).filter(c => !byCode[c.code]).sort((a, b) => b.sales - a.sales);
  const prevMonthKeys = Object.keys(priorMonths).sort();
  const prevKey = prevMonthKeys.length ? prevMonthKeys[prevMonthKeys.length - 1] : null;
  const prev = prevKey ? { month: prevKey, sales: Math.round(priorMonths[prevKey].sales * 100) / 100, invoices: priorMonths[prevKey].invoices, customers: priorMonths[prevKey].codes.size } : null;
  // ---- Monthly report: chronic customers (regular visitors) + declining ones ----
  // Codes "0" and "1" are generic walk-in codes, not individual customers.
  const generic = c => c.code === '0' || c.code === '1';
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const monthEndIso = monthEnd.toISOString().slice(0, 10);
  const chronic = customers.filter(c => {
    if (generic(c) || c.invoices < 4) return false;
    const days = [...new Set(c.dates)].sort();
    return days.length > 1 && (new Date(days[days.length - 1]) - new Date(days[0])) / 86400000 >= 14;
  }).map(c => {
    const days = [...new Set(c.dates)].sort();
    let sum = 0;
    for (let i = 1; i < days.length; i++) sum += (new Date(days[i]) - new Date(days[i - 1])) / 86400000;
    const avgGap = Math.max(1, Math.round(sum / (days.length - 1)));
    let nextCall = addDays(c.lastDate, avgGap);
    while (nextCall <= monthEndIso) nextCall = addDays(nextCall, avgGap);
    return { code: c.code, name: c.name || '', phone: c.phone || '', invoices: c.invoices, sales: Math.round(c.sales * 100) / 100, avgGap, nextCall, lastDate: c.lastDate };
  }).sort((a, b) => a.nextCall.localeCompare(b.nextCall)).slice(0, 30);
  const declining = customers.filter(c => !generic(c)).map(c => {
    const prev = priorByCode[c.code];
    if (prev && prev.invoices >= 2 && c.invoices < prev.invoices)
      return { code: c.code, name: c.name || '', phone: c.phone || '', prevInvoices: prev.invoices, invoices: c.invoices, dropPct: Math.round((prev.invoices - c.invoices) / prev.invoices * 100), lastDate: c.lastDate, basis: 'prev' };
    if (!prev && c.firstHalf >= 3 && c.secondHalf < c.firstHalf)
      return { code: c.code, name: c.name || '', phone: c.phone || '', prevInvoices: c.firstHalf, invoices: c.secondHalf, dropPct: Math.round((c.firstHalf - c.secondHalf) / c.firstHalf * 100), lastDate: c.lastDate, basis: 'half' };
    return null;
  }).filter(Boolean).sort((a, b) => b.dropPct - a.dropPct).slice(0, 30);
  for (const c of customers) { delete c.dates; delete c.firstHalf; delete c.secondHalf; }
  const analytics = {
    chronic, declining, decliningBasis: prevKey ? 'prev' : 'half',
    repeatCustomers: repeat.length,
    repeatRate: customers.length ? Math.round(repeat.length / customers.length * 1000) / 10 : 0,
    oneTimeCustomers: customers.length - repeat.length,
    avgInvoicesPerCustomer: customers.length ? Math.round(totalInvoices / customers.length * 10) / 10 : 0,
    avgSalesPerCustomer: customers.length ? Math.round(totalSales / customers.length) : 0,
    top10Share: totalSales ? Math.round(top10.reduce((a, c) => a + c.sales, 0) / totalSales * 1000) / 10 : 0,
    top10: top10.map(c => ({ code: c.code, name: c.name || '', sales: Math.round(c.sales * 100) / 100, invoices: c.invoices, tier: c.tier })),
    freqBuckets: {
      one: customers.filter(c => c.invoices === 1).length,
      twoThree: customers.filter(c => c.invoices >= 2 && c.invoices <= 3).length,
      fourTen: customers.filter(c => c.invoices >= 4 && c.invoices <= 10).length,
      overTen: customers.filter(c => c.invoices > 10).length,
    },
    segments: {
      champions: customers.filter(c => c.tier === 'VIP' && c.invoices >= 10).length,
      atRisk: customers.filter(c => c.sales >= loyalty.gold_min && c.isInactive).length,
      loyal: customers.filter(c => c.invoices >= 5 && !c.isInactive).length,
      oneTime: customers.filter(c => c.invoices === 1).length,
      newCount: customers.filter(c => c.isNew).length,
    },
    churned: churned.slice(0, 20).map(c => ({ code: c.code, sales: Math.round(c.sales * 100) / 100, invoices: c.invoices, lastDate: c.lastDate })),
    churnedCount: churned.length,
    churnedSales: Math.round(churned.reduce((a, c) => a + c.sales, 0) * 100) / 100,
    prev,
    salesChangePct: prev && prev.sales ? Math.round((totalSales - prev.sales) / prev.sales * 1000) / 10 : null,
    customersChangePct: prev && prev.customers ? Math.round((customers.length - prev.customers) / prev.customers * 1000) / 10 : null,
  };
  res.json({ month, loyalty,
    summary: { totalCustomers: customers.length, newCustomers: customers.filter(c => c.isNew).length,
      activeCustomers: customers.filter(c => !c.isInactive).length,
      inactiveCustomers: customers.filter(c => c.isInactive).length,
      vipCustomers: customers.filter(c => c.tier === 'VIP').length,
      totalInvoices, codedInvoices, uncodedInvoices, uncodedSales,
      codingRate: totalInvoices ? Math.round(codedInvoices / totalInvoices * 1000) / 10 : 0,
      totalSales,
      totalCashback: Math.round(customers.reduce((a, c) => a + c.cashback, 0) * 100) / 100,
      excludedBranch: excludedBranchTotal(month),
      openComplaints },
    analytics, customers });
});

// Customer profile (name/phone/notes) — data the bills sheet does not carry.
app.post('/api/customers/profile', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  const { code, name, phone, notes, excluded } = req.body || {};
  if (!String(code || '').trim()) return res.status(400).json({ error: 'الكود مطلوب' });
  db.prepare(`INSERT INTO customer_profiles (code, name, phone, notes, excluded, updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, phone=excluded.phone, notes=excluded.notes, excluded=excluded.excluded, updated_at=datetime('now')`)
    .run(String(code).trim(), String(name || '').trim(), String(phone || '').trim(), String(notes || '').trim(), Number(excluded) || 0);
  persistDb(); res.json({ ok: true });
});

// Complaints log.
app.get('/api/complaints', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  res.json(db.prepare("SELECT * FROM complaints ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END, id DESC").all());
});
app.post('/api/complaints', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  const { customer_code, text } = req.body || {};
  if (!String(customer_code || '').trim() || !String(text || '').trim()) return res.status(400).json({ error: 'الكود ونص الشكوى مطلوبين' });
  const r = db.prepare('INSERT INTO complaints (customer_code, text) VALUES (?,?)').run(String(customer_code).trim(), String(text).trim());
  persistDb(); res.json({ ok: true, id: r.lastInsertRowid });
});
app.post('/api/complaints/:id/resolve', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  db.prepare("UPDATE complaints SET status='resolved', resolved_at=datetime('now') WHERE id=?").run(req.params.id);
  persistDb(); res.json({ ok: true });
});

// Loyalty settings: cashback step rule (every full 500 -> 25) and tier thresholds.
app.get('/api/loyalty/settings', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  res.json(db.prepare('SELECT * FROM loyalty_settings WHERE id=1').get() || { cashback_rate: 1, gold_min: 5000, vip_min: 20000, cashback_per_500: 25, cashback_step: 500 });
});
app.post('/api/loyalty/settings', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  const { cashback_per_500, cashback_step, gold_min, vip_min } = req.body || {};
  db.prepare(`INSERT INTO loyalty_settings (id, cashback_per_500, cashback_step, gold_min, vip_min) VALUES (1,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET cashback_per_500=excluded.cashback_per_500, cashback_step=excluded.cashback_step, gold_min=excluded.gold_min, vip_min=excluded.vip_min`)
    .run(Number(cashback_per_500) || 0, Number(cashback_step) || 500, Number(gold_min) || 0, Number(vip_min) || 0);
  persistDb(); res.json({ ok: true });
});

// Customers report CSV export
app.get('/api/customers.csv', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const uploads = db.prepare("SELECT filename, rows_json FROM sheet_uploads WHERE type='sales' AND COALESCE(NULLIF(sheet_month,''), substr(created_at,1,7))=? ORDER BY id DESC").all(month);
  const seenUp = new Set(); const byCode = {};
  for (const u of uploads) {
    if (seenUp.has(u.filename)) continue; seenUp.add(u.filename);
    for (const row of JSON.parse(u.rows_json || '[]')) {
      const code = String(row.code || '').trim(); if (!code) continue;
      const c = byCode[code] || (byCode[code] = { code, name: row.customer || '', invoices: 0, sales: 0, firstDate: '', lastDate: '' });
      c.invoices += 1; c.sales += Number(row.sales || 0);
      if (row.date) { if (!c.firstDate || row.date < c.firstDate) c.firstDate = row.date; if (!c.lastDate || row.date > c.lastDate) c.lastDate = row.date; }
    }
  }
  const profiles = Object.fromEntries(db.prepare('SELECT * FROM customer_profiles').all().map(r => [r.code, r]));
  const loyalty = db.prepare('SELECT * FROM loyalty_settings WHERE id=1').get() || { cashback_rate: 1, gold_min: 5000, vip_min: 20000, cashback_per_500: 25, cashback_step: 500 };
  let csv = '\uFEFFالكود,الاسم,التليفون,المستوى,عدد الفواتير,إجمالي المشتريات,مستبعد (ألبان وحفاضات),كاش باك,أول زيارة,آخر زيارة\n';
  for (const c of Object.values(byCode).sort((a, b) => b.sales - a.sales)) {
    const prof = profiles[c.code] || {};
    const tier = c.sales >= loyalty.vip_min ? 'VIP' : c.sales >= loyalty.gold_min ? 'Gold' : 'Silver';
    const cb = cashbackFor(c.sales, prof.excluded || 0, loyalty);
    csv += `${c.code},"${(prof.name || c.name || '').replace(/"/g, '""')}","${prof.phone || ''}",${tier},${c.invoices},${Math.round(c.sales * 100) / 100},${prof.excluded || 0},${cb},${c.firstDate},${c.lastDate}\n`;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="customers-${month}.csv"`);
  res.send(csv);
});

// CSV export
app.get('/api/export.csv', requireAuth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const ownCsv = ownEmployeeId(req);
  const emps = ownCsv ? db.prepare('SELECT * FROM employees WHERE id=? AND active=1').all(ownCsv)
    : db.prepare('SELECT * FROM employees WHERE active=1').all();
  let csv = 'الموظف,مبيعات محققة,تارجت مبيعات,فواتير محققة,تارجت فواتير,تكويد محقق,تارجت تكويد,قيمة Preferred\n';
  for (const e of emps) {
    const t = employeeTotals(e.id, month);
    csv += `${e.name},${t.sales},${e.monthly_sales},${t.invoices},${e.monthly_invoices},${t.coding},${e.monthly_coding},${t.preferred}\n`;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="report-${month}.csv"`);
  res.send('\ufeff' + csv);
});

// Preferred sales for a month (branch total + per-category), from items sheets.
// Manager/owner only: the items sheets have no employee split, so this is branch-level.
app.get('/api/preferred/sales', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const norm = v => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ').trim();
  const prefMap = new Map(db.prepare('SELECT name, category FROM preferred_items WHERE active=1').all()
    .map(r => [norm(r.name), r.category || 'بدون فئة']));
  const uploads = db.prepare("SELECT * FROM sheet_uploads WHERE type='items' AND COALESCE(NULLIF(sheet_month,''), substr(created_at,1,7))=? ORDER BY id DESC").all(month);
  const seen = new Set();
  let branchPreferred = 0; const byCat = {};
  for (const u of uploads) {
    const key = `${u.type}|${u.filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const row of JSON.parse(u.rows_json || '[]')) {
      const item = String(row.item || row['الصنف'] || row['الإسم'] || '').trim();
      const v = Number(row.value || row['القيمة'] || row.total || 0) || 0;
      const cat = prefMap.get(norm(item));
      if (cat) {
        branchPreferred += v;
        const b = byCat[cat] || (byCat[cat] = { category: cat, value: 0, count: 0 });
        b.value += v; b.count += 1;
      }
    }
  }
  res.json({ month, branchPreferred, byCategory: Object.values(byCat).sort((a, b) => b.value - a.value) });
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
  const ownPref = ownEmployeeId(req);
  const emps = ownPref ? db.prepare('SELECT * FROM employees WHERE id=? AND active=1').all(ownPref)
    : db.prepare('SELECT * FROM employees WHERE active=1').all();
  const prefNames = db.prepare('SELECT name FROM preferred_items WHERE active=1').all().map(r => r.name.trim());
  const prefSetAch = new Set(prefNames.map(n => n.toLowerCase().replace(/\s+/g, ' ').trim()));
  const out = emps.map(e => {
    const t = employeeTotals(e.id, month);
    // From uploaded items sheets
    let sheetValue = 0; let sheetItems = [];
    const uploads = db.prepare("SELECT rows_json FROM sheet_uploads WHERE type='items' AND COALESCE(NULLIF(sheet_month,''), substr(created_at,1,7))=?")
      .all(month);
    for (const u of uploads) {
      for (const row of JSON.parse(u.rows_json || '[]')) {
        const empName = String(row.employee || row['الموظف'] || '').trim();
        const item = String(row.item || row['الصنف'] || '').trim();
        if (empName === e.name && prefSetAch.has(item.toLowerCase().replace(/\s+/g, ' ').trim())) {
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
  let sheetMonth = /^\d{4}-\d{2}$/.test(req.body.month || '') ? req.body.month : new Date().toISOString().slice(0, 7);
  const employee_id = req.body.employee_id ? Number(req.body.employee_id) : null;
  if (!req.file) return res.status(400).json({ error: 'اختر ملف أكسيل أو CSV' });
  let rows = [];
  try {
    const wb = readSheetBuffer(req.file.buffer, req.file.originalname);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (type === 'items') {
      rows = normalizeItemsSheet(ws) || XLSX.utils.sheet_to_json(ws, { defval: '' });
    } else if (type === 'sales') {
      const bills = normalizeSalesBillsSheet(ws);
      if (bills) {
        rows = bills;
        const inferred = inferMonthFromSalesBills(ws);
        if (inferred) sheetMonth = inferred; // the sheet itself knows its month
      } else {
        rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      }
    } else {
      rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'تعذر قراءة الملف' });
  }
  const r = db.prepare('INSERT INTO sheet_uploads (type, filename, employee_id, rows_json, uploaded_by, sheet_month) VALUES (?, ?, ?, ?, ?, ?)')
    .run(type, req.file.originalname, employee_id, JSON.stringify(rows), me(req).username, sheetMonth);
  audit(me(req).username, 'upload', `رفع شيت ${req.file.originalname} (${type})`);
  res.json({ ok: true, id: r.lastInsertRowid, rows: rows.length, analysis: analyzeRows(type, rows) });
});
// Month from a Sales Bills title like "فواتير المبيعات من 01/10/2026 إلى 30/10/2026"
// (uses the end date). Returns 'YYYY-MM' or null.
function inferMonthFromSalesBills(ws) {
  const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  for (let i = 0; i < Math.min(arr.length, 5); i++) {
    for (const cell of arr[i]) {
      const text = String(cell ?? '');
      const dates = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g) || [];
      if (dates.length) {
        const last = dates[dates.length - 1].split('/');
        const mm = last[1].padStart(2, '0');
        if (+mm >= 1 && +mm <= 12) return `${last[2]}-${mm}`;
      }
    }
  }
  return null;
}
// e-Plus "فواتير المبيعات" export: title row, then a header row
// (الرقم، النوع، الكود، العميل، التاريخ، ع.أصناف، ...، ق.الفاتورة، ق.بعد الخصم، ق.الصافى، ...، المستخدم)
// Normalizes each bill to { employee, sales, invoices: 1, qty } so the sales analysis can use it.
function normalizeSalesBillsSheet(ws) {
  const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!arr.length) return null;
  let hi = -1; let cols = {};
  for (let i = 0; i < arr.length; i++) {
    const heads = arr[i].map(h => String(h).trim());
    if (heads.includes('الرقم') && (heads.includes('ق.الصافى') || heads.includes('ق.الفاتورة'))) {
      hi = i;
      heads.forEach((h, j) => { cols[h] = j; });
      break;
    }
  }
  if (hi < 0) return null;
  const num = v => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
  const parseDate = v => {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v === 'number' && v > 30000 && v < 60000) {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return d.toISOString().slice(0, 10);
    }
    const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return '';
  };
  const rows = [];
  for (const r of arr.slice(hi + 1)) {
    const billNo = String(r[cols['الرقم']] ?? '').trim();
    if (!billNo || !/^\d+$/.test(billNo)) continue; // skip footer / empty rows
    const net = cols['ق.الصافى'] !== undefined ? num(r[cols['ق.الصافى']]) : 0;
    const afterDisc = cols['ق.بعد الخصم'] !== undefined ? num(r[cols['ق.بعد الخصم']]) : 0;
    const gross = cols['ق.الفاتورة'] !== undefined ? num(r[cols['ق.الفاتورة']]) : 0;
    rows.push({
      date: cols['التاريخ'] !== undefined ? parseDate(r[cols['التاريخ']]) : '',
      code: cols['الكود'] !== undefined ? String(r[cols['الكود']] ?? '').trim() : '',
      customer: cols['العميل'] !== undefined ? String(r[cols['العميل']] ?? '').trim() : '',
      employee: String(r[cols['المستخدم']] ?? '').trim(),
      sales: net || afterDisc || gross,
      invoices: 1,
      coding: 0,
      qty: cols['ع.أصناف'] !== undefined ? num(r[cols['ع.أصناف']]) : 0,
    });
  }
  return rows;
}
function analyzeRows(type, rows) {
  const s = getSettings();
  if (type === 'items') {
    // Normalized items rows: { item, value, qty, employee, origin, company }
    let totalSales = 0, totalQty = 0;
    const byItem = {};
    const byEmployee = {};
    const byOrigin = {};
    const byCompany = {};
    const prefNames = db.prepare('SELECT name FROM preferred_items WHERE active=1').all().map(r => r.name.trim());
    const prefSet = new Set(prefNames.map(n => n.toLowerCase().replace(/\s+/g, ' ').trim()));
    let preferredValue = 0;
    let highValueCount = 0, highValueTotal = 0;
    for (const row of rows) {
      const value = Number(row.value ?? row['إجمالى س.بيع'] ?? 0) || 0;
      const qty = Number(row.qty ?? row['الكمية'] ?? 0) || 0;
      const item = String(row.item ?? row['الصنف'] ?? row['الإسم'] ?? '').trim();
      const origin = String(row.origin ?? row['المنشأ'] ?? '').trim() || 'غير محدد';
      const company = String(row.company ?? row['الشركة'] ?? '').trim() || 'غير محددة';
      totalSales += value; totalQty += qty;
      if (item) {
        byItem[item] = (byItem[item] || 0) + value;
        if (prefSet.has(item.toLowerCase().replace(/\s+/g, ' ').trim())) preferredValue += value;
        if (value >= 1000) { highValueCount++; highValueTotal += value; }
      }
      byOrigin[origin] = (byOrigin[origin] || 0) + value;
      byCompany[company] = (byCompany[company] || 0) + value;
      const emp = String(row.employee ?? row['الموظف'] ?? '').trim();
      if (emp) {
        byEmployee[emp] = byEmployee[emp] || { sales: 0, invoices: 0, coding: 0 };
        byEmployee[emp].sales += value;
      }
    }
    const topItems = Object.entries(byItem).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([item, value]) => ({ item, value }));
    const itemsCount = Object.keys(byItem).length;
    const branchSalesPct = pct(totalSales, s.branch_sales);
    return {
      totalSales, totalQty, itemsCount,
      avgItemValue: itemsCount ? totalSales / itemsCount : 0,
      avgPiecePrice: totalQty ? totalSales / totalQty : 0,
      byOrigin: Object.entries(byOrigin).sort((a, b) => b[1] - a[1]).map(([origin, value]) => ({ origin, value, pct: pct(value, totalSales) })),
      topCompanies: Object.entries(byCompany).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([company, value]) => ({ company, value })),
      highValueCount, highValueTotal,
      branchSalesPct,
      achieved: totalSales >= s.branch_sales,
      verdict: totalSales >= s.branch_sales
        ? `حققنا تارجت المبيعات في الشيت المرفوع — ${branchSalesPct}% من تارجت الفرع`
        : `لم نحقق تارجت المبيعات بعد — حققنا ${branchSalesPct}% من تارجت الفرع (${s.branch_sales} جنيه)`,
      topItems, preferredValue,
      byEmployee,
    };
  }
  let totalSales = 0, totalInvoices = 0, totalCoding = 0, totalQty = 0, totalCoded = 0;
  const byEmployee = {};
  for (const row of rows) {
    const sales = Number(row.sales || row['المبيعات'] || row['مبيعات'] || 0);
    const inv = Number(row.invoices || row['الفواتير'] || row['فواتير'] || 0);
    const cod = Number(row.coding || row['التكويد'] || row['تكويد'] || 0);
    const qty = Number(row.qty || row['الكمية'] || row['عدد القطع'] || 0);
    const coded = String(row.code || row['الكود'] || '').trim() ? inv : 0;
    totalSales += sales; totalInvoices += inv; totalCoding += cod; totalQty += qty; totalCoded += coded;
    const emp = String(row.employee || row['الموظف'] || 'غير محدد');
    byEmployee[emp] = byEmployee[emp] || { sales: 0, invoices: 0, coding: 0, qty: 0, coded: 0 };
    byEmployee[emp].sales += sales; byEmployee[emp].invoices += inv; byEmployee[emp].coding += cod; byEmployee[emp].qty += qty; byEmployee[emp].coded += coded;
  }
  return {
    totalSales, totalInvoices, totalCoding, totalQty, totalCoded,
    codingRate: totalInvoices ? Math.round(totalCoded / totalInvoices * 1000) / 10 : 0,
    avgInvoiceValue: totalInvoices ? totalSales / totalInvoices : 0,
    avgPiecesPerInvoice: totalInvoices && totalQty ? totalQty / totalInvoices : 0,
    branchSalesPct: pct(totalSales, s.branch_sales),
    achieved: totalSales >= s.branch_sales,
    verdict: totalSales >= s.branch_sales
      ? 'حققنا تارجت المبيعات في الشيت المرفوع'
      : `لم نحقق تارجت المبيعات بعد — حققنا ${pct(totalSales, s.branch_sales)}% من تارجت الفرع (${s.branch_sales} جنيه)`,
    byEmployee,
  };
}
app.get('/api/uploads', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, type, filename, employee_id, uploaded_by, sheet_month, created_at, length(rows_json) rows_size FROM sheet_uploads ORDER BY id DESC LIMIT 50').all();
  res.json(rows);
});
app.get('/api/uploads/:id/analysis', requireAuth, (req, res) => {
  const u = db.prepare('SELECT * FROM sheet_uploads WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'غير موجود' });
  res.json({ ...u, rows: JSON.parse(u.rows_json || '[]'), analysis: analyzeRows(u.type, JSON.parse(u.rows_json || '[]')) });
});
app.delete('/api/uploads/:id', requireRole('owner', 'manager', 'superadmin'), (req, res) => {
  const u = db.prepare('SELECT filename FROM sheet_uploads WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'غير موجود' });
  db.prepare('DELETE FROM sheet_uploads WHERE id=?').run(req.params.id);
  audit(me(req).username, 'upload_delete', `حذف شيت ${u.filename}`);
  res.json({ ok: true });
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
