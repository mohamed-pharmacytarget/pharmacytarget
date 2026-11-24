// PharmacyTarget frontend — no passwords anywhere in this file.
// All login checks happen on the server; this file only calls the API.
const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
};
const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

let user = null;
let employees = [];
let settings = {};
let month = thisMonth();
let selectedEmployeeId = null;
let tab = 'dashboard';

// ---------- Login ----------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const d = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#username').value.trim(), password: $('#password').value }) });
    user = d.user;
    $('#login-card').hidden = true;
    $('#dashboard').hidden = false;
    $('#who').textContent = `${user.name} — ${roleName(user.role)}`;
    await loadAll();
    renderTabs();
    render();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});
function roleName(r) { return { owner: 'المالك', manager: 'مدير الفرع', employee: 'موظف', superadmin: 'Mohamed — كل الصلاحيات' }[r] || r; }

async function loadAll() {
  employees = await api('/api/employees');
  settings = await api('/api/settings');
  if (!selectedEmployeeId && employees.length) selectedEmployeeId = employees[0].id;
}

function renderTabs() {
  const tabs = [['dashboard', 'لوحة التحكم']];
  if (['owner', 'manager', 'superadmin'].includes(user.role)) {
    tabs.push(['employees', 'إدارة الموظفين'], ['reports', 'تقارير'], ['preferred', 'Preferred List'], ['uploads', 'رفع تقارير أكسيل'], ['customers', 'العملاء']);
  }
  if (user.role === 'employee') tabs.push(['myday', 'تسجيل نتائج اليوم']);
  if (user.role === 'superadmin') {
    tabs.push(['mohamed', 'لوحة Mohamed'], ['audit', 'سجل التعديلات'], ['catalog', 'كتالوج التشغيل']);
  }
  $('#tabs').innerHTML = tabs.map(([id, label]) =>
    `<button data-tab="${id}" class="${tab === id ? 'active' : ''}">${label}</button>`).join('');
  $('#tabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; renderTabs(); render(); }));
}

async function render() {
  const v = $('#view');
  if (tab === 'dashboard') return renderDashboard(v);
  if (tab === 'employees') return renderEmployees(v);
  if (tab === 'reports') return renderReports(v);
  if (tab === 'preferred') return renderPreferred(v);
  if (tab === 'uploads') return renderUploads(v);
  if (tab === 'audit') return renderAudit(v);
  if (tab === 'myday') return renderMyDay(v);
  if (tab === 'mohamed') return renderMohamed(v);
  if (tab === 'catalog') return renderCatalog(v);
  if (tab === 'customers') return renderCustomers(v);
}

// ---------- Dashboard ----------
async function renderDashboard(v) {
  const monthInput = `<label>الشهر <input type="month" id="month-pick" value="${month}"></label>`;
  if (user.role === 'employee') {
    const lockedEmp = employees.length === 1 ? employees[0] : null;
    if (lockedEmp) selectedEmployeeId = lockedEmp.id;
    v.innerHTML = `<div class="card">${monthInput}
      ${lockedEmp ? `<p><b>${lockedEmp.name}</b></p>` : `<label>اختر اسمك <select id="emp-pick">${employees.map(e => `<option value="${e.id}" ${e.id === selectedEmployeeId ? 'selected' : ''}>${e.name}</option>`).join('')}</select></label>`}
      <div id="emp-stats"></div><div id="emp-coach"></div></div>`;
    $('#month-pick').addEventListener('change', (e) => { month = e.target.value; render(); });
    const pickEl = $('#emp-pick');
    if (pickEl) pickEl.addEventListener('change', (e) => { selectedEmployeeId = Number(e.target.value); render(); });
    await renderEmployeeStats($('#emp-stats'), selectedEmployeeId);
    const coach = await api(`/api/coach/${selectedEmployeeId}?month=${month}`);
    $('#emp-coach').innerHTML = `<h3>Smart Performance Coach</h3>` + coach.tips.map(t =>
      `<div class="card"><b>${t.indicator}</b> — ${t.cause}<br>المطلوب: ${fmt(t.amount)}<br>اقتراح: ${t.suggestion}<br>الأثر المتوقع: ${t.expected}</div>`).join('');
    return;
  }
  // owner / manager / superadmin
  const rep = await api(`/api/reports/summary?month=${month}`);
  v.innerHTML = `<div class="card">${monthInput}
    <h2>تارجت الفرع — ${month}</h2>
    <div class="grid">
      <div class="stat">المبيعات<b>${fmt(rep.totals.sales)} / ${fmt(rep.settings.branch_sales)}</b>${Math.round(rep.totals.sales / rep.settings.branch_sales * 100)}%</div>
      <div class="stat">الفواتير<b>${fmt(rep.totals.invoices)} / ${fmt(rep.settings.branch_invoices)}</b></div>
      <div class="stat">التكويد — فواتير بكود<b>${rep.totals.codingRate || 0}%</b>${rep.totals.codingRateTarget ? `تارجت الشهر الجاي: ${rep.totals.codingRateTarget}%` : ''}</div>
      <div class="stat">متوسط الفاتورة<b>${fmt(rep.avgInvoice)} ج</b></div>
      <div class="stat">Preferred<b>${fmt(rep.totals.preferred)} ج</b></div>
      ${rep.sheets && rep.sheets.itemsCount ? `<div class="stat">عدد الأصناف<b>${fmt(rep.sheets.itemsCount)}</b></div>` : ''}
    </div>
    ${rep.sheets && rep.sheets.sales > 0 ? `<p class="ok">من الشيتات المرفوعة في الشهر ده: ${fmt(rep.sheets.sales)} جنيه مبيعات${rep.sheets.invoices ? ` — ${fmt(rep.sheets.invoices)} فاتورة` : ''}${rep.sheets.coding ? ` — تكويد ${fmt(rep.sheets.coding)}` : ''}${rep.sheets.itemsCount ? ` — ${fmt(rep.sheets.itemsCount)} صنف بإجمالي ${fmt(rep.sheets.totalQty)} قطعة` : ''} (${[...new Set(rep.sheets.files)].join('، ')})</p>` : ''}
    <h3>الفريق</h3>
    <table><tr><th>الموظف</th><th>المبيعات</th><th>الفواتير</th><th>التكويد</th><th>المؤشر</th><th>التصنيف</th></tr>
    ${rep.perEmployee.map(e => `<tr><td>${e.name}</td><td>${fmt(e.achieved.sales)} / ${fmt(e.target.sales)}</td><td>${fmt(e.achieved.invoices)} / ${fmt(e.target.invoices)}</td><td>${e.achieved.codingRate || 0}%</td><td>${e.index}%</td><td><span class="badge">${e.classification}</span></td></tr>`).join('')}
    </table>
    <h3>🏆 لوحة الصدارة — ${month}</h3>
    ${rep.leaderboard && rep.leaderboard.some(r => r.achieved.sales > 0 || r.achieved.invoices > 0) ? `
    <p>الترتيب حسب ${rep.leaderboard[0].rankBy === 'sales' ? 'المبيعات الفعلية (الشهر ده خلص، والتارجت كان متوقع منه)' : 'نسبة تحقيق التارجت'}. ${(() => { const imp = [...rep.leaderboard].filter(r => r.improved !== null && r.improved !== undefined).sort((a, b) => b.improved - a.improved)[0]; return imp ? `الأكثر تحسنًا عن الشهر اللي فات: <b>${imp.name} (${imp.improved > 0 ? '+' : ''}${imp.improved}%)</b>` : ''; })()}</p>
    <table><tr><th>#</th><th>الموظف</th><th>نسبة التارجت</th><th>المبيعات</th><th>حصته من التوتال</th><th>التأثير</th><th>متوسط الفاتورة</th><th>أصناف/فاتورة</th><th>المطلوب يوميًا</th><th>المتوقع آخر الشهر</th><th>التحسن</th></tr>
    ${rep.leaderboard.map(r => `<tr><td>${r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank}</td><td>${r.name}</td><td><div style="background:#eee;border-radius:6px;min-width:90px"><div style="background:${r.salesPct >= 90 ? '#2e7d32' : r.salesPct >= 70 ? '#f9a825' : '#c62828'};color:#fff;text-align:center;border-radius:6px;padding:2px 4px;width:${Math.min(100, r.salesPct)}%">${r.salesPct}%</div></div></td><td>${fmt(r.achieved.sales)} / ${fmt(r.target.sales)}</td><td><b>${r.share}%</b></td><td><span style="color:${r.impact === 'مؤثر جدًا' ? '#2e7d32' : r.impact === 'مؤثر' ? '#1565c0' : r.impact === 'متوسط' ? '#f9a825' : '#c62828'}"><b>${r.impact}</b></span></td><td>${fmt(r.atv)} ج</td><td>${r.upt}</td><td>${fmt(r.tomorrow.sales)} ج</td><td>${fmt(r.projection)} ج</td><td>${r.improved === null || r.improved === undefined ? '—' : r.improved > 0 ? '▲ +' + r.improved + '%' : r.improved < 0 ? '▼ ' + r.improved + '%' : '—'}</td></tr>`).join('')}
    </table>` : '<p>لسه مفيش بيانات للشهر ده — ارفع شيت مبيعات الشهر عشان اللوحة تشتغل.</p>'}
    <h3>تنبيهات</h3>
    ${rep.problems.length ? rep.problems.map(p => `<div class="problem"><b>${p.problem}</b><br>السبب: ${p.cause}<br>الحل: ${p.solution}</div>`).join('') : '<p class="ok">لا توجد مشاكل ظاهرة — الأداء على المسار الصحيح.</p>'}
    <h3>تعديل تارجت الفرع</h3>
    <label>مبيعات <input id="s-sales" type="number" value="${rep.settings.branch_sales}"></label>
    <label>فواتير <input id="s-inv" type="number" value="${rep.settings.branch_invoices}"></label>
    <label>تكويد <input id="s-cod" type="number" value="${rep.settings.branch_coding}"></label>
    <label>توصيل <input id="s-del" type="number" value="${rep.settings.branch_delivery}"></label>
    <button id="save-settings">حفظ تارجت الفرع</button> <span id="settings-msg"></span>
    <p><a href="/api/export.csv?month=${month}">تحميل التقرير CSV</a> &nbsp; <a href="/api/backup">تحميل نسخة احتياطية</a></p>
    </div>`;
  $('#month-pick').addEventListener('change', (e) => { month = e.target.value; render(); });
  $('#save-settings').addEventListener('click', async () => {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ branch_sales: $('#s-sales').value, branch_invoices: $('#s-inv').value, branch_coding: $('#s-cod').value, branch_delivery: $('#s-del').value }) });
    $('#settings-msg').textContent = 'تم الحفظ';
    await loadAll(); render();
  });
}

async function renderEmployeeStats(el, empId) {
  const rep = await api(`/api/reports/summary?month=${month}`);
  const e = rep.perEmployee.find(x => x.id === empId);
  if (!e) { el.innerHTML = '<p>لا يوجد موظف بعد.</p>'; return; }
  const daily = await api(`/api/daily?employee_id=${empId}&month=${month}`);
  const t = daily.find(d => d.date === today());
  const pref = await api(`/api/preferred/achievement?month=${month}`);
  const myPref = pref.find(p => p.employee_id === empId);
  const daySales = t ? t.sales : 0, dayInv = t ? t.invoices : 0, dayCod = t ? t.coding : 0;
  const ok = (a, b) => a >= b ? '✓ اتحقق' : '✗ لم يتحقق';
  const isPast = month < new Date().toISOString().slice(0, 7);
  const daysInMonth = new Date(+month.split('-')[0], +month.split('-')[1], 0).getDate();
  const salesPct = e.target.sales ? Math.round(e.achieved.sales / e.target.sales * 100) : 0;
  const invPct = e.target.invoices ? Math.round(e.achieved.invoices / e.target.invoices * 100) : 0;
  el.innerHTML = `
    <h2>${e.name} — ${month}</h2>
    <div class="grid">
      <div class="stat">مبيعات الشهر<b>${fmt(e.achieved.sales)} / ${fmt(e.target.sales)}</b>${e.index}%</div>
      <div class="stat">فواتير الشهر<b>${fmt(e.achieved.invoices)} / ${fmt(e.target.invoices)}</b></div>
      <div class="stat">نسبة الفواتير بكود<b>${e.achieved.codingRate || 0}%</b></div>
      ${isPast ? `
      <div class="stat">متوسط المبيعات اليومي<b>${fmt(Math.round(e.achieved.sales / daysInMonth))} ج</b></div>
      <div class="stat">متوسط الفواتير اليومي<b>${fmt(Math.round(e.achieved.invoices / daysInMonth))}</b></div>
      <div class="stat">متوسط الفاتورة<b>${fmt(e.achieved.invoices ? Math.round(e.achieved.sales / e.achieved.invoices) : 0)} ج</b></div>` : `
      <div class="stat">المطلوب اليوم — مبيعات<b>${fmt(e.dailyRequired.sales)} ج</b></div>
      <div class="stat">المطلوب اليوم — فواتير<b>${fmt(e.dailyRequired.invoices)}</b></div>
      <div class="stat">المطلوب اليوم — تكويد<b>${fmt(e.dailyRequired.coding)}</b></div>`}
      <div class="stat">Preferred هذا الشهر<b>${fmt(myPref ? myPref.totalPreferred : 0)} ج</b></div>
    </div>
    ${isPast ? `<h3>📋 تقرير الشهر الكامل — النتيجة النهائية</h3>
    <p>المبيعات: ${fmt(e.achieved.sales)} / ${fmt(e.target.sales)} (${salesPct}%) — ${e.achieved.sales >= e.target.sales ? '✓ التارجت متحقق' : '✗ التارجت لم يتحقق'}</p>
    <p>الفواتير: ${fmt(e.achieved.invoices)} / ${fmt(e.target.invoices)} (${invPct}%)</p>
    <p>نسبة الفواتير بكود: ${e.achieved.codingRate || 0}% — فواتير بكود: ${fmt(e.achieved.coded || 0)} من ${fmt(e.achieved.invoices)} (تارجت النسبة الشهر الجاي: ${e.achieved.codingRateTarget || 0}%)</p>
    <p>متوسط الفاتورة: ${fmt(e.achieved.invoices ? Math.round(e.achieved.sales / e.achieved.invoices) : 0)} جنيه — Preferred هذا الشهر: ${fmt(myPref ? myPref.totalPreferred : 0)} جنيه — المؤشر المركب: ${e.index}% (${e.classification})</p>` : (() => { const repDate = today(); return `<h3>تقرير نهاية اليوم (${repDate})</h3>
    <p>المبيعات: ${fmt(daySales)} / ${fmt(e.dailyRequired.sales)} — ${ok(daySales, e.dailyRequired.sales)}</p>
    <p>الفواتير: ${fmt(dayInv)} / ${fmt(e.dailyRequired.invoices)} — ${ok(dayInv, e.dailyRequired.invoices)}</p>
    <p>التكويد: ${fmt(dayCod)} / ${fmt(e.dailyRequired.coding)} — ${ok(dayCod, e.dailyRequired.coding)}</p>
    <p><b>مطلوب الغد:</b> مبيعات ${fmt(e.tomorrow.sales)} جنيه (وباقي البنود بنفس طريقة الحساب من المتبقي الشهري ÷ الأيام المتبقية).</p>`; })()}
    <div class="card"><b>التكويد:</b> تارجتك ${fmt(e.target.coding)} من الـ 1,000 — حققت ${fmt(e.achieved.coded || 0)} فاتورة بكود (${e.achieved.codingRate || 0}% من فواتيرك)${e.achieved.codingRateTarget ? ` — تارجت النسبة الشهر الجاي: ${e.achieved.codingRateTarget}%` : ''}</div>
    ${e.custom_items.length ? `<h3>بنود خاصة بي</h3><ul>${e.custom_items.map(i => `<li>${i.name} — تارجت ${fmt(i.target)}</li>`).join('')}</ul>` : ''}
    <div id="emp-plan"></div>`;
  try {
    const plan = await api(`/api/employee/${empId}/plan?month=${month}`);
    const wdShort = ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];
    const wdHead = ['سبت', 'أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة'];
    const baseName = plan.baselineMonth === plan.month ? 'نفس الشهر' : plan.baselineMonth;
    const isPastMonth = plan.month < new Date().toISOString().slice(0, 7);
    const pad = (plan.days[0].weekday + 1) % 7;
    const cells = Array(pad).fill('<div></div>').concat(plan.days.map(d => {
      const offBtn = isPastMonth ? '' : `<button class="secondary cal-off" data-off="${d.date}" data-isoff="${d.isWorking ? 0 : 1}">${d.isWorking ? 'Off' : 'إلغاء الإجازة'}</button>`;
      if (!d.isWorking) return `<div class="cal-cell cal-off-day"><div class="cal-day"><b>${d.day}</b> <span>${wdShort[d.weekday]}</span></div><div class="cal-line">🌙 إجازة</div>${offBtn}</div>`;
      const a = d.achieved;
      const okDay = a && a.sales >= d.required.sales;
      const short = a && !okDay ? `<div class="cal-line" style="color:#c62828">قصّر بـ ${fmt(d.required.sales - a.sales)} ج</div>` : '';
      const achHtml = a ? `<div class="cal-line">${okDay ? '✅' : '❌'} حقق: <b>${fmt(a.sales)} ج</b></div>${short}` : (d.isPast ? '<div class="cal-line" style="color:#999">لم يسجّل</div>' : '');
      return `<div class="cal-cell${d.isToday ? ' cal-today' : ''}${a ? (okDay ? ' cal-ok' : ' cal-bad') : ''}"><div class="cal-day"><b>${d.day}</b> <span>${wdShort[d.weekday]}</span>${d.isToday ? ' <span class="cal-today-badge">اليوم</span>' : ''}</div><div class="cal-line">مطلوب: <b>${fmt(d.required.sales)} ج</b></div><div class="cal-line muted">${d.required.invoices} فاتورة • ${d.required.qty} صنف</div>${achHtml}${offBtn}</div>`;
    }));
    const comp = plan.compensation;
    const el2 = document.getElementById('emp-plan');
    if (el2) el2.innerHTML = `<h3>📅 خطة الشهر — ${plan.month}</h3>
      <p>بناء على ${baseName}: متوسط فاتورتك ${fmt(plan.october.atv)} ج، ${plan.october.upt} صنف/فاتورة، وكنت بتبيع ${fmt(plan.october.dailySales)} ج في اليوم. ${isPastMonth ? 'كان مطلوب' : 'مطلوب'} منك يوميًا في ${plan.month}: <b>${fmt(plan.daily.sales)} ج</b>، <b>${plan.daily.invoices} فاتورة</b>، <b>${plan.daily.qty} صنف</b>.</p>
      ${isPastMonth ? '' : `<p class="muted">يوم الإجازة مش ثابت — دوس Off على أي يوم في الكاليندر عشان تاخده إجازة، والمطلوب اليومي هيتعدل لوحده على باقي أيام الشغل.</p>`}
      ${comp && comp.missedDays > 0 ? (isPastMonth ? `<div style="background:#fff3e0;border:1px solid #ffcc80;border-radius:10px;padding:10px;margin:8px 0"><b>⚠️ تقصير الشهر:</b> قصّرت في ${comp.missedDays} يوم بإجمالي ${fmt(comp.shortfallSales)} جنيه (${fmt(comp.shortfallInvoices)} فاتورة) — دي كانت تكلفة القصور في الشهر ده.</div>` : `<div style="background:#fff3e0;border:1px solid #ffcc80;border-radius:10px;padding:10px;margin:8px 0"><b>⚠️ تعويض:</b> قصّرت في ${comp.missedDays} يوم بإجمالي ${fmt(comp.shortfallSales)} جنيه (${fmt(comp.shortfallInvoices)} فاتورة) — عشان تعوّض، زوّد <b>${fmt(comp.perDay.sales)} جنيه</b> كل يوم شغل لحد آخر الشهر.</div>`) : ''}
      ${plan.month === new Date().toISOString().slice(0, 7) ? `<p>المتبقي من التارجت: ${fmt(Math.max(0, plan.target.sales - plan.achievedMonth.sales))} ج — عشان تلحق، مطلوب من النهاردة <b>${fmt(plan.paceFromToday.sales)} ج</b> في اليوم (${plan.paceFromToday.invoices} فاتورة، ${plan.paceFromToday.qty} صنف).</p>` : ''}
      <p style="font-size:12px;color:#888">✅ حقق المطلوب &nbsp; ❌ قصّر &nbsp; لم يسجّل &nbsp; 🌙 إجازة</p>
      <div class="cal-grid">${wdHead.map(w => `<div class="cal-head">${w}</div>`).join('')}${cells.join('')}</div>
      <div id="emp-ten"></div>`;
    el2.querySelectorAll('[data-off]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/employee/${empId}/day-off`, { method: 'POST', body: JSON.stringify({ date: b.dataset.off, off: b.dataset.isoff === '0' }) });
      render();
    }));
    // 10-day report
    const tenEl = document.getElementById('emp-ten');
    const loadTen = async (period) => {
      const r = await api(`/api/employee/${empId}/ten-day?month=${month}&period=${period}`);
      tenEl.innerHTML = `<h3>📋 تقرير العشر أيام — ${r.from} إلى ${r.to}</h3>
        <div style="margin:6px 0">${[1, 2, 3].map(p => `<button class="${p === r.period ? '' : 'secondary'}" data-period="${p}">الفترة ${p === 1 ? 'الأولى (1-10)' : p === 2 ? 'الثانية (11-20)' : 'الثالثة (21-آخر الشهر)'}</button> `).join('')}</div>
        <p>المبيعات: ${fmt(r.achieved.sales)} / ${fmt(r.required.sales)} (${r.salesPct}%) — الفواتير: ${fmt(r.achieved.invoices)} / ${fmt(r.required.invoices)} (${r.invPct}%) — التكويد: ${fmt(r.achieved.coding)} / ${fmt(r.required.coding)} (${r.codPct}%)</p>
        <p>متوسط فاتورتك: ${fmt(r.averages.atv)} ج (الفرع: ${fmt(r.averages.branchAtv)} ج) — أصناف/فاتورة: ${r.averages.upt} (الفرع: ${r.averages.branchUpt}) — فواتير بكود: ${r.averages.codingRate}% (الفرع: ${r.averages.branchCodingRate}%)</p>
        ${r.strengths.length ? `<h4 style="color:#2e7d32">💪 نقاط القوة</h4><ul>${r.strengths.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
        ${r.weaknesses.length ? `<h4 style="color:#c62828">⚠️ نقاط الضعف</h4><ul>${r.weaknesses.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}`;
      tenEl.querySelectorAll('[data-period]').forEach(b => b.addEventListener('click', () => loadTen(Number(b.dataset.period))));
    };
    loadTen();
  } catch (err) { /* plan is optional; stats above already show */ }
}

// ---------- Employees (Add Employee unified) ----------
function renderEmployees(v) {
  v.innerHTML = `<div class="card"><h2>Add Employee — إضافة موظف</h2>
    <form id="add-emp">
      <label>الاسم <input id="f-name" required></label>
      <label>اسم المستخدم <input id="f-user" required></label>
      <label>كلمة المرور <input id="f-pass" type="password" required></label>
      <label>تارجت المبيعات الشهري <input id="f-sales" type="number" value="0"></label>
      <label>تارجت عدد الفواتير الشهري <input id="f-inv" type="number" value="0"></label>
      <label>تارجت التكويد الشهري <input id="f-cod" type="number" value="0"></label>
      <h3>بنود خاصة بالموظف</h3>
      <div id="custom-items"></div>
      <button type="button" id="add-item" class="secondary">+ إضافة item</button>
      <button type="submit">حفظ الموظف</button> <span id="emp-msg"></span>
    </form></div>
    <div class="card"><h3>الموظفون الحاليون</h3>
    <table><tr><th>الاسم</th><th>اليوزر</th><th>مبيعات</th><th>فواتير</th><th>تكويد</th><th>بنود خاصة</th><th></th><th></th></tr>
    ${employees.map(e => `<tr><td>${e.name}</td><td>${e.username}</td><td>${fmt(e.monthly_sales)}</td><td>${fmt(e.monthly_invoices)}</td><td>${fmt(e.monthly_coding)}</td><td>${e.custom_items.map(i => i.name).join('، ') || '—'}</td><td><button data-edit="${e.id}">تعديل</button></td><td><button class="danger" data-del="${e.id}">حذف</button></td></tr>`).join('')}
    </table></div>
    <div class="card" id="edit-emp" style="display:none"></div>`;
  const items = [];
  const renderItems = () => {
    $('#custom-items').innerHTML = items.map((it, i) => `<div><label>اسم البند <input data-i="${i}" data-f="name" value="${it.name}"></label><label>التارجت <input data-i="${i}" data-f="target" type="number" value="${it.target}"></label><button type="button" data-rm="${i}" class="danger">شيل البند</button></div>`).join('');
    $('#custom-items').querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => { items[Number(inp.dataset.i)][inp.dataset.f] = inp.dataset.f === 'target' ? Number(inp.value) : inp.value; }));
    $('#custom-items').querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { items.splice(Number(b.dataset.rm), 1); renderItems(); }));
  };
  $('#add-item').addEventListener('click', () => { items.push({ name: '', target: 0 }); renderItems(); });
  renderItems();
  $('#add-emp').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/employees', { method: 'POST', body: JSON.stringify({ name: $('#f-name').value, username: $('#f-user').value, password: $('#f-pass').value, monthly_sales: $('#f-sales').value, monthly_invoices: $('#f-inv').value, monthly_coding: $('#f-cod').value, custom_items: items }) });
      $('#emp-msg').textContent = 'تمت إضافة الموظف';
      await loadAll(); renderEmployees(v);
    } catch (err) { $('#emp-msg').textContent = err.message; }
  });
  v.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('حذف هذا الموظف؟')) return;
    await api(`/api/employees/${b.dataset.del}`, { method: 'DELETE' });
    await loadAll(); renderEmployees(v);
  }));
  v.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const e = employees.find(x => x.id === Number(b.dataset.edit));
    if (!e) return;
    const box = $('#edit-emp');
    const items = JSON.parse(JSON.stringify(e.custom_items || []));
    box.style.display = 'block';
    box.innerHTML = `<h3>تعديل ${e.name}</h3>
      <form id="edit-form">
        <label>الاسم <input id="e-name" value="${e.name}" required></label>
        <label>تارجت المبيعات الشهري <input id="e-sales" type="number" value="${e.monthly_sales}"></label>
        <label>تارجت عدد الفواتير الشهري <input id="e-inv" type="number" value="${e.monthly_invoices}"></label>
        <label>تارجت التكويد الشهري <input id="e-cod" type="number" value="${e.monthly_coding}"></label>
        <h3>بنود خاصة بالموظف</h3>
        <div id="edit-items"></div>
        <button type="button" id="e-add-item" class="secondary">+ إضافة item</button>
        <button type="submit">حفظ التعديل</button> <span id="edit-msg"></span>
      </form>`;
    const renderEditItems = () => {
      $('#edit-items').innerHTML = items.map((it, i) => `<div><label>اسم البند <input data-i="${i}" data-f="name" value="${it.name}"></label><label>التارجت <input data-i="${i}" data-f="target" type="number" value="${it.target}"></label><button type="button" data-rm="${i}" class="danger">شيل البند</button></div>`).join('');
      $('#edit-items').querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => { items[Number(inp.dataset.i)][inp.dataset.f] = inp.dataset.f === 'target' ? Number(inp.value) : inp.value; }));
      $('#edit-items').querySelectorAll('[data-rm]').forEach(x => x.addEventListener('click', () => { items.splice(Number(x.dataset.rm), 1); renderEditItems(); }));
    };
    $('#e-add-item').addEventListener('click', () => { items.push({ name: '', target: 0 }); renderEditItems(); });
    renderEditItems();
    $('#edit-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      await api(`/api/employees/${e.id}`, { method: 'PUT', body: JSON.stringify({ name: $('#e-name').value, monthly_sales: $('#e-sales').value, monthly_invoices: $('#e-inv').value, monthly_coding: $('#e-cod').value, custom_items: items }) });
      $('#edit-msg').textContent = 'تم الحفظ';
      await loadAll(); renderEmployees(v);
    });
    box.scrollIntoView();
  }));
}

// ---------- Reports ----------
async function renderReports(v) {
  const rep = await api(`/api/reports/summary?month=${month}`);
  // Full target report: why achieved / not, how to achieve, solutions
  const [yy, mm] = month.split('-').map(Number);
  const daysInMonth = new Date(yy, mm, 0).getDate();
  const now = new Date();
  const isCurrent = month === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const elapsed = isCurrent ? Math.max(1, now.getDate() - 1) : daysInMonth;
  const remaining = Math.max(0, daysInMonth - elapsed);
  const bTarget = rep.settings.branch_sales, bSales = rep.totals.sales;
  const bPct = bTarget ? Math.round(bSales / bTarget * 100) : 0;
  const shortfall = Math.max(0, bTarget - bSales);
  const avgDaily = elapsed ? bSales / elapsed : 0;
  const requiredDaily = remaining ? shortfall / remaining : 0;
  const projection = bSales + avgDaily * remaining;
  const verdict = bPct >= 100
    ? 'حققنا تارجت الفرع هذا الشهر.'
    : remaining === 0
      ? 'الشهر انتهى ولم نحقق تارجت الفرع.'
      : avgDaily >= requiredDaily
        ? 'على المسار الصحيح — بالمعدل اليومي الحالي سنحقق التارجت قبل نهاية الشهر.'
        : 'متأخرون — المعدل اليومي الحالي أقل من المطلوب لتحقيق التارجت.';
  const sheetSales = rep.sheets ? rep.sheets.sales : 0;
  const dailySales = bSales - sheetSales;
  const noEmpData = rep.perEmployee.every(e => e.achieved.sales === 0 && e.achieved.invoices === 0);
  v.innerHTML = `<div class="card"><h2>تقارير شهرية — ${month}</h2>
    <label>الشهر <input type="month" id="month-pick" value="${month}"></label>
    <p>إجمالي المبيعات: ${fmt(rep.totals.sales)} جنيه — الفواتير: ${fmt(rep.totals.invoices)} — متوسط الفاتورة: ${fmt(rep.avgInvoice)} جنيه — التكويد: ${fmt(rep.totals.coding)} — التوصيل: ${fmt(rep.totals.delivery)} — Preferred: ${fmt(rep.totals.preferred)} جنيه</p>
    <table><tr><th>الموظف</th><th>مبيعات</th><th>فواتير</th><th>تكويد</th><th>Preferred</th><th>المؤشر</th><th>التصنيف</th></tr>
    ${rep.perEmployee.map(e => `<tr><td>${e.name}</td><td>${fmt(e.achieved.sales)} / ${fmt(e.target.sales)}</td><td>${fmt(e.achieved.invoices)} / ${fmt(e.target.invoices)}</td><td>${fmt(e.achieved.coding)} / ${fmt(e.target.coding)}</td><td>${fmt(e.achieved.preferred)}</td><td>${e.index}%</td><td>${e.classification}</td></tr>`).join('')}
    </table>
    <h3>المشاكل الظاهرة في التقارير وحلولها</h3>
    ${rep.problems.length ? rep.problems.map(p => `<div class="problem"><b>${p.problem}</b><br>السبب: ${p.cause}<br>الحل: ${p.solution}<br>مؤشر المتابعة: ${p.indicator}</div>`).join('') : '<p class="ok">لا توجد مشاكل ظاهرة هذا الشهر.</p>'}
    <h3>تقرير التارجت الكامل</h3>
    <div class="${bPct >= 100 ? 'good' : 'problem'}"><b>${verdict}</b><br>
      تارجت الفرع: ${fmt(bTarget)} جنيه — حققنا: ${fmt(bSales)} جنيه (${bPct}%)<br>
      ${bPct < 100 ? `المتبقي لتحقيق التارجت: ${fmt(shortfall)} جنيه<br>` : ''}
      الأيام المنقضية: ${elapsed} من ${daysInMonth} — الأيام المتبقية: ${remaining}<br>
      متوسط المبيعات اليومي حتى الآن: ${fmt(avgDaily)} جنيه
      ${remaining > 0 && bPct < 100 ? ` — المطلوب يوميًا في الأيام المتبقية: ${fmt(requiredDaily)} جنيه` : ''}<br>
      ${remaining > 0 && bPct < 100 ? `التوقع بالمعدل الحالي: ${fmt(projection)} جنيه بنهاية الشهر<br>` : ''}
      منها من الشيتات المرفوعة: ${fmt(sheetSales)} جنيه — ومن تسجيل نتائج اليوم: ${fmt(dailySales)} جنيه
    </div>
    <h3>ليه حققنا / ليه محققناش</h3>
    <p>${bPct >= 100
      ? 'حققنا التارجت لأن إجمالي المبيعات (من الشيتات المرفوعة وتسجيل نتائج اليوم) وصل إلى التارجت أو تجاوزه.'
      : remaining === 0
        ? `لم نحقق التارجت لأن إجمالي المبيعات ${fmt(bSales)} جنيه أقل من التارجت ${fmt(bTarget)} جنيه بفارق ${fmt(shortfall)} جنيه، والشهر انتهى.`
        : `لم نحقق التارجت بعد لأن الشهر لم ينتهِ — حققنا ${bPct}% حتى الآن، والمتبقي ${fmt(shortfall)} جنيه في ${remaining} أيام.`}
      ${sheetSales > 0 && dailySales === 0 ? ' كل الأرقام الحالية من الشيتات المرفوعة فقط، ولا توجد نتائج يومية مسجلة من الموظفين.' : ''}
    </p>
    ${noEmpData ? '<p>لا يمكن تقسيم التحقيق على الموظفين: لا توجد نتائج يومية مسجلة، والشيت المرفوع لا يفصل المبيعات حسب اسم الموظف.</p>' : ''}
    <h3>إزاي نحقق التارجت</h3>
    ${bPct >= 100 ? '<p>التارجت متحقق — حافظ على نفس المعدل اليومي لباقي الشهر.</p>' : remaining === 0 ? '<p>الشهر انتهى — راجع التارجت للشهر القادم من «تعديل تارجت الفرع» في لوحة التحكم.</p>' : `<p>المطلوب يوميًا في الأيام المتبقية: مبيعات ${fmt(requiredDaily)} جنيه${rep.settings.branch_invoices ? ` — فواتير ${fmt(Math.max(0, rep.settings.branch_invoices - rep.totals.invoices) / remaining)}` : ''}${rep.settings.branch_coding ? ` — تكويد ${fmt(Math.max(0, rep.settings.branch_coding - rep.totals.coding) / remaining)}` : ''}.</p>
    <table><tr><th>الموظف</th><th>المتبقي من تارجت المبيعات</th><th>المطلوب منه يوميًا</th></tr>
    ${rep.perEmployee.map(e => `<tr><td>${e.name}</td><td>${fmt(Math.max(0, e.target.sales - e.achieved.sales))}</td><td>${fmt(Math.max(0, e.target.sales - e.achieved.sales) / remaining)}</td></tr>`).join('')}
    </table>`}
    <h3>الحلول المطلوبة</h3>
    ${rep.problems.length ? rep.problems.map(p => `<div class="problem"><b>${p.employee} — ${p.problem}</b><br>الحل: ${p.solution}</div>`).join('') : '<p class="ok">لا توجد مشاكل ظاهرة — حافظ على المتابعة اليومية.</p>'}
    <p>حلول عامة: سجّل كل موظف نتائج يومه من «تسجيل نتائج اليوم» حتى يظهر تحقيقه هو شخصيًا؛ ركّز على أصناف الـ Preferred؛ راجع أعلى 10 أصناف مبيعًا في تحليل الشيت ووفّرها دائمًا؛ ولو الشيت الجديد فيه اسم الموظف لكل فاتورة سيظهر التحقيق لكل موظف تلقائيًا.</p>
    <p><a href="/api/export.csv?month=${month}">تحميل التقرير CSV</a></p></div>`;
  $('#month-pick').addEventListener('change', (e) => { month = e.target.value; render(); });
}

// ---------- Preferred ----------
async function renderPreferred(v) {
  const items = await api('/api/preferred');
  const ach = await api(`/api/preferred/achievement?month=${month}`);
  const canEdit = ['owner', 'manager', 'superadmin'].includes(user.role);
  const rep = canEdit ? await api(`/api/reports/summary?month=${month}`) : null;
  const prefSales = canEdit ? await api(`/api/preferred/sales?month=${month}`) : null;
  const cats = [];
  for (const i of items) { const c = i.category || 'بدون فئة'; if (!cats.find(x => x.name === c)) cats.push({ name: c, items: [] }); cats.find(x => x.name === c).items.push(i); }
  const sharePct = rep && rep.totals.sales > 0 ? Math.round(rep.totals.preferred / rep.totals.sales * 1000) / 10 : 0;
  v.innerHTML = `<div class="card"><h2>Preferred List — ${month}</h2>
    <label>الشهر <input type="month" id="pref-month" value="${month}"></label>
    ${canEdit && rep && prefSales ? `
    <h3>مبيعات الـ Preferred في ${month}</h3>
    <div class="grid">
      <div class="stat">مبيعات Preferred<b>${fmt(rep.totals.preferred)} ج</b></div>
      <div class="stat">إجمالي مبيعات الفرع<b>${fmt(rep.totals.sales)} ج</b></div>
      <div class="stat">نسبة الـ Preferred من المبيعات<b>${sharePct}%</b></div>
    </div>
    ${prefSales.byCategory.length ? `<table><tr><th>الفئة</th><th>مبيعات Preferred</th><th>عدد الأصناف المباعة</th></tr>
    ${prefSales.byCategory.map(c => `<tr><td>${c.category}</td><td>${fmt(Math.round(c.value))} ج</td><td>${c.count}</td></tr>`).join('')}
    </table>` : '<p>لسه مفيش مبيعات Preferred مسجلة في الشهر ده.</p>'}` : ''}
    ${canEdit ? `
    <form id="pref-form"><label>اسم الصنف <input id="pref-name" required></label><label>السعر <input id="pref-price" type="number" value="0"></label><label>الفئة <input id="pref-cat" placeholder="مثال: كوزمتكس"></label><button type="submit">إضافة صنف</button></form>
    <form id="pref-up-form"><label>رفع شيت Preferred (Excel أو CSV) <input id="pref-up-file" type="file" accept=".xlsx,.xls,.csv" required></label><button type="submit">رفع وتحليل</button></form>
    <p>أعمدة الشيت: اسم الصنف، السعر، الفئة — التطبيق يصنّف الأصناف حسب الفئة تلقائيًا، والصنف بلا فئة يروح «بدون فئة». لو الصنف موجود قبل كده بيتحدّث سعره وفئته.</p>
    <div id="pref-up-result"></div>` : ''}
    ${cats.map(c => `<h3>${c.name} — ${c.items.length} صنف — إجمالي أسعار القايمة ${fmt(c.items.reduce((s, i) => s + Number(i.price || 0), 0))} ج</h3>
    <table><tr><th>الصنف</th><th>السعر</th>${canEdit ? '<th></th>' : ''}</tr>
    ${c.items.map(i => `<tr><td>${i.name}</td><td>${fmt(i.price)}</td>${canEdit ? `<td><button class="danger" data-delpref="${i.id}">حذف</button></td>` : ''}</tr>`).join('')}
    </table>`).join('') || '<p>لا توجد أصناف بعد.</p>'}
    <h3>إنجاز الموظفين من الـ Preferred</h3>
    <table><tr><th>الموظف</th><th>من التسجيل اليومي</th><th>من شيت الأصناف</th><th>الإجمالي</th></tr>
    ${ach.map(a => `<tr><td>${a.name}</td><td>${fmt(a.dailyPreferred)}</td><td>${fmt(a.sheetPreferred)}</td><td><b>${fmt(a.totalPreferred)}</b></td></tr>`).join('')}
    </table></div>`;
  $('#pref-month').addEventListener('change', (e) => { month = e.target.value; render(); });
  const form = $('#pref-form');
  if (form) form.addEventListener('submit', async (e) => { e.preventDefault(); await api('/api/preferred', { method: 'POST', body: JSON.stringify({ name: $('#pref-name').value, price: $('#pref-price').value, category: $('#pref-cat').value }) }); render(); });
  const upForm = $('#pref-up-form');
  if (upForm) upForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('file', $('#pref-up-file').files[0]);
    const r = await fetch('/api/preferred/upload', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) { $('#pref-up-result').innerHTML = `<p class="error">${d.error}</p>`; return; }
    $('#pref-up-result').innerHTML = `<div class="good"><b>تم رفع الشيت وتحليله: ${d.total} صنف في ${d.categories.length} فئة</b> (جديد: ${d.added} — محدّث: ${d.updated}${d.skipped ? ` — صفوف فاضية متخطاة: ${d.skipped}` : ''})<br>
      ${d.categories.map(c => `${c.category}: ${c.count} صنف — إجمالي ${fmt(c.total)} ج`).join('<br>')}</div>`;
    render();
  });
  v.querySelectorAll('[data-delpref]').forEach(b => b.addEventListener('click', async () => { await api(`/api/preferred/${b.dataset.delpref}`, { method: 'DELETE' }); render(); }));
}

// ---------- Customers ----------
async function renderCustomers(v) {
  const data = await api(`/api/customers?month=${month}`);
  const complaints = await api('/api/complaints');
  const sm = data.summary, ly = data.loyalty, an = data.analytics || {};
  let q = '', filter = 'all';
  const tierBadge = t => t === 'VIP' ? '<span class="badge" style="background:#fef3c7">👑 VIP</span>' : t === 'Gold' ? '<span class="badge" style="background:#fef9c3">🥇 Gold</span>' : '<span class="badge">🥈 Silver</span>';
  const draw = () => {
    const list = data.customers.filter(c => {
      if (q && !(c.code.includes(q) || (c.name || '').includes(q) || (c.phone || '').includes(q))) return false;
      if (filter === 'inactive') return c.isInactive;
      if (filter === 'vip') return c.tier === 'VIP';
      if (filter === 'new') return c.isNew;
      return true;
    });
    const inactive = data.customers.filter(c => c.isInactive).sort((a, b) => b.sales - a.sales).slice(0, 20);
    const vips = data.customers.filter(c => c.tier === 'VIP').slice(0, 10);
    const openC = complaints.filter(c => c.status === 'open');
    v.innerHTML = `<div class="card"><h2>العملاء — ${month}</h2>
    <label>الشهر <input type="month" id="cust-month" value="${month}"></label>
    <div class="grid">
      <div class="stat">عدد العملاء<b>${fmt(sm.totalCustomers)}</b></div>
      <div class="stat">عملاء جدد<b>${fmt(sm.newCustomers)}</b></div>
      <div class="stat">نشطين<b>${fmt(sm.activeCustomers)}</b></div>
      <div class="stat">غير نشطين<b>${fmt(sm.inactiveCustomers)}</b></div>
      <div class="stat">VIP<b>${fmt(sm.vipCustomers)}</b></div>
      <div class="stat">فواتير بكود<b>${fmt(sm.codedInvoices)} / ${fmt(sm.totalInvoices)}</b>${sm.codingRate}%</div>
      <div class="stat">فواتير بدون كود<b>${fmt(sm.uncodedInvoices)}</b>${fmt(sm.uncodedSales)} ج</div>
      <div class="stat">شكاوى مفتوحة<b>${fmt(sm.openComplaints)}</b></div>
    </div>
    <h3>📊 تحليلات متقدمة — ${month}</h3>
    <div class="grid">
      <div class="stat">معدل تكرار الشراء<b>${an.repeatRate}%</b>${fmt(an.repeatCustomers)} عميل رجعوا تاني</div>
      <div class="stat">عملاء مرة واحدة<b>${fmt(an.oneTimeCustomers)}</b></div>
      <div class="stat">متوسط فواتير العميل<b>${an.avgInvoicesPerCustomer}</b></div>
      <div class="stat">متوسط مشتريات العميل<b>${fmt(an.avgSalesPerCustomer)} ج</b></div>
      <div class="stat">أعلى 10 عملاء<b>${an.top10Share}%</b>من مبيعات العملاء المكوّدين</div>
      ${an.prev ? `<div class="stat">مقارنة بـ ${an.prev.month}<b>${an.salesChangePct !== null ? (an.salesChangePct >= 0 ? '+' : '') + an.salesChangePct + '%' : '—'}</b>مبيعات (${fmt(an.prev.sales)} ج) — عملاء ${an.customersChangePct !== null ? (an.customersChangePct >= 0 ? '+' : '') + an.customersChangePct + '%' : '—'}</div>` : ''}
    </div>
    <h4>شرائح العملاء (RFM)</h4>
    <div class="grid">
      <div class="stat">🏆 أبطال<b>${fmt(an.segments.champions)}</b>VIP وبيشتروا كتير</div>
      <div class="stat">⚠️ معرّضين للفقد<b>${fmt(an.segments.atRisk)}</b>مشتريات عالية ومفيش زيارة من 14 يوم</div>
      <div class="stat">💚 مخلصين<b>${fmt(an.segments.loyal)}</b>5 فواتير أو أكتر ونشطين</div>
      <div class="stat">🆕 جدد<b>${fmt(an.segments.newCount)}</b></div>
      <div class="stat">1️⃣ مرة واحدة<b>${fmt(an.segments.oneTime)}</b></div>
    </div>
    <h4>توزيع تكرار الشراء</h4>
    ${[['فاتورة واحدة', an.freqBuckets.one], ['2-3 فواتير', an.freqBuckets.twoThree], ['4-10 فواتير', an.freqBuckets.fourTen], ['أكتر من 10', an.freqBuckets.overTen]].map(([label, n]) => `<div style="display:flex;align-items:center;gap:8px;margin:4px 0"><span style="width:110px;font-size:13px">${label}</span><div style="flex:1;background:#eee;border-radius:6px;height:18px"><div style="background:#0b5e3a;height:18px;border-radius:6px;width:${sm.totalCustomers ? Math.round(n / sm.totalCustomers * 100) : 0}%"></div></div><b style="width:70px;text-align:left">${fmt(n)}</b></div>`).join('')}
    <h4>🏆 أعلى 10 عملاء</h4>
    ${an.top10.length ? `<table><tr><th>#</th><th>الكود</th><th>الاسم</th><th>الفواتير</th><th>المشتريات</th><th>الحصة</th><th>المستوى</th></tr>${an.top10.map((c, i) => `<tr><td>${i + 1}</td><td>${c.code}</td><td>${c.name || '—'}</td><td>${c.invoices}</td><td>${fmt(c.sales)} ج</td><td>${sm.totalSales ? Math.round(c.sales / sm.totalSales * 1000) / 10 : 0}%</td><td>${c.tier}</td></tr>`).join('')}</table>` : ''}
    ${an.churnedCount ? `<h4>💔 عملاء فقدناهم (كانوا بيشتروا قبل كده ومجوش الشهر ده)</h4><p><b>${fmt(an.churnedCount)} عميل</b> بقيمة مبيعات سابقة <b>${fmt(an.churnedSales)} جنيه</b> — دول أول ناس تتواصل معاهم.</p><table><tr><th>الكود</th><th>مشترياته قبل كده</th><th>فواتيره</th><th>آخر زيارة</th></tr>${an.churned.map(c => `<tr><td>${c.code}</td><td>${fmt(c.sales)} ج</td><td>${c.invoices}</td><td>${c.lastDate || '—'}</td></tr>`).join('')}</table>` : ''}
    <p><a href="/api/customers.csv?month=${month}">📄 تحميل تقرير العملاء الكامل (CSV)</a></p>
    <h3>📋 التقرير الشهري — ${month}</h3>
    <h4>💊 العملاء المزمنون (بييجوا بانتظام — اتصل بيهم قبل موعد التجديد)</h4>
    ${an.chronic.length ? `<p class="muted">دول أكتر عملاء بييجوا بانتظام (4 فواتير أو أكتر في الشهر). "اتصل به يوم" = آخر زيارة + متوسط الفاصل بين زياراته — اتصل قبلها بيومين عشان تذكّره بتجديد الدواء.</p><table><tr><th>الكود</th><th>الاسم</th><th>التليفون</th><th>زيارات</th><th>مشتريات</th><th>بييجي كل</th><th>اتصل به يوم</th></tr>${an.chronic.map(c => `<tr><td>${c.code}</td><td>${c.name || '—'}</td><td>${c.phone || '—'}</td><td>${c.invoices}</td><td>${fmt(c.sales)} ج</td><td>${c.avgGap} يوم</td><td><b>${c.nextCall}</b></td></tr>`).join('')}</table>` : '<p>لا يوجد عملاء مزمنون في الشهر ده.</p>'}
    <h4>📉 عملاء تواصلهم قل — نوصي بالاتصال بيهم</h4>
    ${an.declining.length ? `<p class="muted">${an.decliningBasis === 'prev' ? 'مقارنة بعدد فواتير الشهر اللي فات.' : 'لسه مفيش شيت للشهر اللي فات — المقارنة هنا بين النصف الأول والنصف التاني من نفس الشهر.'}</p><table><tr><th>الكود</th><th>الاسم</th><th>التليفون</th><th>${an.decliningBasis === 'prev' ? 'الشهر اللي فات' : 'النصف الأول'}</th><th>${an.decliningBasis === 'prev' ? 'الشهر ده' : 'النصف التاني'}</th><th>نسبة الانخفاض</th><th>آخر زيارة</th></tr>${an.declining.map(c => `<tr><td>${c.code}</td><td>${c.name || '—'}</td><td>${c.phone || '—'}</td><td>${c.prevInvoices} فاتورة</td><td>${c.invoices} فاتورة</td><td><b>${c.dropPct}%</b></td><td>${c.lastDate || '—'}</td></tr>`).join('')}</table><p class="muted">التوصية: اتصل بيهم واسأل عن سبب الغياب — ممكن يكون راح صيدلية تانية أو الدواء مش متوفر.</p>` : '<p>مفيش عملاء قلّ تواصلهم في الشهر ده.</p>'}
    <h3>📋 مهام اليوم — المتابعة الذكية</h3>
    ${inactive.length ? `<p><b>اتصل بالعملاء غير النشطين (مفيش زيارة من 14 يوم):</b></p><ul>${inactive.map(c => `<li>${c.name || 'عميل'} (كود ${c.code})${c.phone ? ' — ' + c.phone : ''} — آخر زيارة ${c.lastDate || '—'} — مشترياته ${fmt(c.sales)} ج</li>`).join('')}</ul>` : '<p class="muted">مفيش عملاء غير نشطين في الشهر ده.</p>'}
    ${vips.length ? `<p><b>تواصل مع عملاء VIP وقدّم لهم مزايا الولاء:</b></p><ul>${vips.map(c => `<li>${c.name || 'عميل'} (كود ${c.code})${c.phone ? ' — ' + c.phone : ''} — مشترياته ${fmt(c.sales)} ج</li>`).join('')}</ul>` : ''}
    ${openC.length ? `<p><b>شكاوى مفتوحة لازم تتحل:</b></p><ul>${openC.map(c => `<li>كود ${c.customer_code}: ${c.text} <button class="secondary" data-resolve="${c.id}">تم الحل</button></li>`).join('')}</ul>` : ''}
    <h3>💳 إعدادات مستويات الولاء</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
      <label style="flex:1;min-width:120px">Gold من مشتريات <input id="ly-gold" type="number" value="${ly.gold_min}"></label>
      <label style="flex:1;min-width:120px">VIP من مشتريات <input id="ly-vip" type="number" value="${ly.vip_min}"></label>
      <button id="ly-save">حفظ</button>
    </div>
    <h3>👤 بيانات عميل (الاسم والتليفون — مش موجودين في الشيت)</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
      <label style="flex:1;min-width:100px">الكود <input id="pf-code" placeholder="مثال: 12345"></label>
      <label style="flex:1;min-width:120px">الاسم <input id="pf-name"></label>
      <label style="flex:1;min-width:120px">التليفون <input id="pf-phone"></label>
      <label style="flex:2;min-width:150px">ملاحظات <input id="pf-notes"></label>
      <button id="pf-save">حفظ بيانات العميل</button>
    </div>
    <h3>📝 شكوى جديدة</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
      <label style="flex:1;min-width:100px">كود العميل <input id="cp-code"></label>
      <label style="flex:3;min-width:200px">نص الشكوى <input id="cp-text"></label>
      <button id="cp-save">تسجيل الشكوى</button>
    </div>
    ${complaints.filter(c => c.status === 'resolved').length ? `<h3>الشكاوى المحلولة</h3><ul>${complaints.filter(c => c.status === 'resolved').slice(0, 10).map(c => `<li>كود ${c.customer_code}: ${c.text}</li>`).join('')}</ul>` : ''}
    <h3>جدول العملاء</h3>
    <div style="margin:6px 0">${['all', 'inactive', 'vip', 'new'].map(f => `<button class="${filter === f ? '' : 'secondary'}" data-filter="${f}">${f === 'all' ? 'الكل' : f === 'inactive' ? 'غير نشطين' : f === 'vip' ? 'VIP' : 'جدد'}</button> `).join('')}</div>
    <label>بحث بالكود أو الاسم أو التليفون <input id="cust-q" value="${q}" placeholder="مثال: 12345"></label>
    ${list.length ? `<table><tr><th>الكود</th><th>الاسم</th><th>التليفون</th><th>المستوى</th><th>الفواتير</th><th>إجمالي المشتريات</th><th>أول زيارة</th><th>آخر زيارة</th><th>الموظف الأساسي</th><th></th></tr>
    ${list.slice(0, 200).map(c => `<tr><td>${c.code}</td><td>${c.name || '—'}</td><td>${c.phone || '—'}</td><td>${tierBadge(c.tier)}</td><td>${c.invoices}</td><td>${fmt(c.sales)} ج</td><td>${c.firstDate || '—'}</td><td>${c.lastDate || '—'}</td><td>${c.topEmployee}</td><td>${c.isNew ? '<span class="badge">جديد</span>' : ''}${c.isInactive ? ' <span class="badge" style="background:#fee4e2">غير نشط</span>' : ''} <button class="secondary" data-edit="${c.code}">تعديل</button></td></tr>`).join('')}
    </table>${list.length > 200 ? `<p class="muted">معروض أول 200 عميل من ${list.length} — ضيّق البحث عشان تشوف الباقي.</p>` : ''}` : '<p>لا يوجد عملاء في الشهر ده — ارفع شيت فواتير الشهر.</p>'}
    <p class="muted">البيانات من شيت فواتير المبيعات. العميل "جديد" يعني كوده أول مرة يظهر في الشيتات، و"غير نشط" يعني مفيش زيارة من 14 يوم لآخر الشهر.</p></div>`;
    $('#cust-month').addEventListener('change', (e) => { month = e.target.value; render(); });
    const qEl = $('#cust-q');
    qEl.addEventListener('input', () => { q = qEl.value; const pos = qEl.selectionStart; draw(); const nq = $('#cust-q'); nq.focus(); nq.setSelectionRange(pos, pos); });
    v.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { filter = b.dataset.filter; draw(); }));
    v.querySelectorAll('[data-resolve]').forEach(b => b.addEventListener('click', async () => { await api(`/api/complaints/${b.dataset.resolve}/resolve`, { method: 'POST' }); render(); }));
    v.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
      const c = data.customers.find(x => x.code === b.dataset.edit);
      if (!c) return;
      $('#pf-code').value = c.code; $('#pf-name').value = c.name || ''; $('#pf-phone').value = c.phone || ''; $('#pf-notes').value = c.notes || '';
      $('#pf-code').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
    $('#ly-save').addEventListener('click', async () => {
      await api('/api/loyalty/settings', { method: 'POST', body: JSON.stringify({ gold_min: $('#ly-gold').value, vip_min: $('#ly-vip').value }) });
      render();
    });
    $('#pf-save').addEventListener('click', async () => {
      await api('/api/customers/profile', { method: 'POST', body: JSON.stringify({ code: $('#pf-code').value, name: $('#pf-name').value, phone: $('#pf-phone').value, notes: $('#pf-notes').value }) });
      render();
    });
    $('#cp-save').addEventListener('click', async () => {
      await api('/api/complaints', { method: 'POST', body: JSON.stringify({ customer_code: $('#cp-code').value, text: $('#cp-text').value }) });
      render();
    });
  };
  draw();
}

// ---------- Uploads ----------
function showUploadAnalysis(a) {
  if (a.topItems) {
    const emps = Object.entries(a.byEmployee);
    $('#up-result').innerHTML = `<div class="${a.achieved ? 'good' : 'problem'}"><b>${a.verdict}</b><br>
      إجمالي المبيعات في الشيت: ${fmt(a.totalSales)} جنيه — نسبة تحقيق تارجت الفرع: ${a.branchSalesPct}%<br>
      عدد الأصناف: ${fmt(a.itemsCount)} — إجمالي الكمية: ${fmt(a.totalQty)}<br>
      متوسط قيمة الصنف: ${fmt(a.avgItemValue)} جنيه — متوسط سعر القطعة: ${fmt(a.avgPiecePrice)} جنيه<br>
      قيمة الـ Preferred في الشيت: ${fmt(a.preferredValue)} جنيه<br>
      أصناف فوق 1000 جنيه: ${fmt(a.highValueCount)} صنف بإجمالي ${fmt(a.highValueTotal)} جنيه<br>
      <h3>المبيعات حسب المنشأ</h3>
      <table><tr><th>المنشأ</th><th>القيمة</th><th>النسبة</th></tr>${a.byOrigin.map(o => `<tr><td>${o.origin}</td><td>${fmt(o.value)} ج</td><td>${o.pct}%</td></tr>`).join('')}</table>
      <h3>أعلى 5 شركات مبيعًا</h3>
      <table><tr><th>الشركة</th><th>القيمة</th></tr>${a.topCompanies.map(c => `<tr><td>${c.company}</td><td>${fmt(c.value)} ج</td></tr>`).join('')}</table>
      <h3>أعلى 10 أصناف مبيعًا</h3>
      <table><tr><th>الصنف</th><th>القيمة</th></tr>${a.topItems.map(t => `<tr><td>${t.item}</td><td>${fmt(t.value)} ج</td></tr>`).join('')}</table>
      ${emps.length ? emps.map(([n, x]) => `${n}: مبيعات ${fmt(x.sales)}`).join('<br>') : '<p>الشيت مفيهوش اسم موظف لكل صنف، فمفيش تقسيم حسب الموظف.</p>'}
      </div>`;
    return;
  }
  $('#up-result').innerHTML = `<div class="${a.achieved ? 'good' : 'problem'}"><b>${a.verdict}</b><br>
    إجمالي المبيعات في الشيت: ${fmt(a.totalSales)} جنيه — الفواتير: ${fmt(a.totalInvoices)} — التكويد: ${fmt(a.totalCoding)}<br>
    نسبة تحقيق تارجت الفرع: ${a.branchSalesPct}%<br>
    متوسط سعر الفاتورة: ${fmt(a.avgInvoiceValue)} جنيه${a.avgPiecesPerInvoice ? ` — متوسط عدد القطع في كل فاتورة: ${fmt(a.avgPiecesPerInvoice)}` : ''}<br>
    ${Object.entries(a.byEmployee).map(([n, x]) => `${n}: مبيعات ${fmt(x.sales)}، فواتير ${fmt(x.invoices)}، تكويد ${fmt(x.coding)}`).join('<br>')}
    </div>`;
}
function renderUploads(v) {
  v.innerHTML = `<div class="card"><h2>رفع تقارير أكسيل</h2>
    <p>اسحب تقرير المبيعات الشهري أو تقرير مبيعات الأصناف من تطبيق الصيدلية وارفعه هنا (Excel أو CSV). التطبيق يحلل الشيت ويقول حققنا ولا لأ.</p>
    <form id="up-form">
      <label>نوع التقرير <select id="up-type"><option value="sales">تقرير مبيعات شهري</option><option value="items">تقرير مبيعات أصناف</option></select></label>
      <label>الشهر <input id="up-month" type="month"></label>
      <label>الملف <input id="up-file" type="file" accept=".xlsx,.xls,.csv" required></label>
      <button type="submit">رفع وتحليل</button>
    </form>
    <div id="up-result"></div>
    <h3>ملفات مرفوعة سابقًا</h3><div id="up-list"></div></div>`;
  api('/api/uploads').then(list => {
    $('#up-list').innerHTML = list.length ? `<table><tr><th>الملف</th><th>النوع</th><th>الشهر</th><th>رفعه</th><th>التاريخ</th><th></th><th></th></tr>${list.map(u => `<tr><td>${u.filename}</td><td>${u.type === 'sales' ? 'مبيعات شهري' : u.type === 'preferred' ? 'شيت Preferred' : 'مبيعات أصناف'}</td><td>${u.sheet_month || u.created_at.slice(0, 7)}</td><td>${u.uploaded_by}</td><td>${u.created_at}</td><td><button data-viewup="${u.id}">عرض التحليل</button></td><td><button class="danger" data-delup="${u.id}">حذف</button></td></tr>`).join('')}</table>` : '<p>لا توجد ملفات بعد.</p>';
    document.querySelectorAll('[data-viewup]').forEach(b => b.addEventListener('click', async () => {
      const d = await api(`/api/uploads/${b.dataset.viewup}/analysis`);
      showUploadAnalysis(d.analysis);
      document.getElementById('up-result').scrollIntoView();
    }));
    document.querySelectorAll('[data-delup]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('تحذف الشيت ده؟')) return;
      await api(`/api/uploads/${b.dataset.delup}`, { method: 'DELETE' });
      render();
    }));
  });
  $('#up-month').value = new Date().toISOString().slice(0, 7);
  $('#up-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('file', $('#up-file').files[0]);
    fd.append('type', $('#up-type').value);
    fd.append('month', $('#up-month').value);
    const r = await fetch('/api/uploads', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) { $('#up-result').innerHTML = `<p class="error">${d.error}</p>`; return; }
    showUploadAnalysis(d.analysis);
  });
}

// ---------- Audit ----------
async function renderAudit(v) {
  const rows = await api('/api/audit');
  v.innerHTML = `<div class="card"><h2>سجل التعديلات</h2>
    <table><tr><th>الوقت</th><th>المستخدم</th><th>الإجراء</th><th>التفاصيل</th></tr>
    ${rows.map(r => `<tr><td>${r.created_at}</td><td>${r.username}</td><td>${r.action}</td><td>${r.details || ''}</td></tr>`).join('')}
    </table></div>`;
}

// ---------- Employee daily entry ----------
async function renderMyDay(v) {
  const lockedEmp = employees.length === 1 ? employees[0] : null;
  if (lockedEmp) selectedEmployeeId = lockedEmp.id;
  v.innerHTML = `<div class="card"><h2>تسجيل نتائج اليوم — بعد نهاية الشيفت</h2>
    ${lockedEmp ? `<p><b>${lockedEmp.name}</b></p>` : `<label>اختر اسمك <select id="emp-pick">${employees.map(e => `<option value="${e.id}" ${e.id === selectedEmployeeId ? 'selected' : ''}>${e.name}</option>`).join('')}</select></label>`}
    <form id="day-form">
      <label>التاريخ <input id="d-date" type="date" value="${today()}" required></label>
      <label>المبيعات (جنيه) <input id="d-sales" type="number" value="0"></label>
      <label>عدد الفواتير <input id="d-inv" type="number" value="0"></label>
      <label>التكويد <input id="d-cod" type="number" value="0"></label>
      <label>قيمة Preferred اليوم (جنيه) <input id="d-pref" type="number" value="0"></label>
      <button type="submit">حفظ نتائج اليوم</button> <span id="day-msg"></span>
    </form>
    <div id="day-report"></div></div>`;
  const pickEl = $('#emp-pick');
  if (pickEl) pickEl.addEventListener('change', (e) => { selectedEmployeeId = Number(e.target.value); render(); });
  const showReport = async () => { await renderEmployeeStats($('#day-report'), selectedEmployeeId); };
  await showReport();
  $('#day-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/daily', { method: 'POST', body: JSON.stringify({ employee_id: selectedEmployeeId, date: $('#d-date').value, sales: $('#d-sales').value, invoices: $('#d-inv').value, coding: $('#d-cod').value, preferred_value: $('#d-pref').value }) });
    $('#day-msg').textContent = 'تم الحفظ — ظهرت النتائج في لوحة المدير فورًا';
    await showReport();
  });
}

// ---------- Mohamed superadmin ----------
async function renderMohamed(v) {
  const users = await api('/api/users');
  const reqs = await api('/api/change-requests');
  v.innerHTML = `<div class="card"><h2>لوحة Mohamed — كل الصلاحيات</h2>
    <p class="muted">هذه اللوحة مخفية تمامًا عن المالك والمدير.</p>
    <h3>كل المستخدمين</h3>
    <table><tr><th>اليوزر</th><th>الاسم</th><th>الدور</th><th>نشط</th></tr>
    ${users.map(u => `<tr><td>${u.username}</td><td>${u.name}</td><td>${u.role}</td><td>${u.active ? 'نعم' : 'لا'}</td></tr>`).join('')}
    </table>
    <h3>تغيير باسورد أي حساب</h3>
    <form id="pw-form"><label>اليوزر <input id="pw-user" required></label><label>الباسورد الجديد <input id="pw-new" type="password" required></label><button type="submit">تغيير الباسورد</button> <span id="pw-msg"></span></form>
    <h3>طلب تعديل جديد للتطبيق</h3>
    <form id="cr-form"><label>التعديل المطلوب <textarea id="cr-text" rows="3" required></textarea></label><button type="submit">حفظ الطلب</button></form>
    <button id="wa-btn" class="secondary">تواصل مع Muse من التطبيق</button>
    <p class="small muted">الزرار بينسخ رسالة تبدأ بـ "أنا محمد، جاي من تطبيق PharmacyTarget" ويفتح واتساب لتبعتها.</p>
    <h3>طلبات التعديل السابقة</h3>
    ${reqs.length ? reqs.map(r => `<div class="card">${r.text} <span class="muted small">— ${r.username} — ${r.created_at}</span></div>`).join('') : '<p>لا توجد طلبات بعد.</p>'}
    <h3>نسخ احتياطي / استعادة</h3>
    <p><a href="/api/backup">تحميل نسخة احتياطية من قاعدة البيانات</a></p>
    <form id="restore-form"><label>استعادة من ملف <input id="restore-file" type="file" accept=".db" required></label><button type="submit">استعادة</button></form>
    </div>`;
  $('#pw-form').addEventListener('submit', async (e) => { e.preventDefault(); await api('/api/users/change-password', { method: 'POST', body: JSON.stringify({ username: $('#pw-user').value, newPassword: $('#pw-new').value }) }); $('#pw-msg').textContent = 'تم تغيير الباسورد'; });
  $('#cr-form').addEventListener('submit', async (e) => { e.preventDefault(); await api('/api/change-requests', { method: 'POST', body: JSON.stringify({ text: $('#cr-text').value }) }); render(); });
  $('#wa-btn').addEventListener('click', async () => {
    const text = $('#cr-text') ? $('#cr-text').value : '';
    const msg = `أنا محمد، جاي من تطبيق PharmacyTarget\n${text ? 'عايز تعديل: ' + text : 'عايز تعديل في التطبيق'}`;
    try { await navigator.clipboard.writeText(msg); } catch (e) { /* clipboard may need permission */ }
    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
  });
  $('#restore-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(); fd.append('file', $('#restore-file').files[0]);
    const r = await fetch('/api/restore', { method: 'POST', body: fd });
    alert(r.ok ? 'تمت الاستعادة — سجل الدخول مرة أخرى' : 'فشلت الاستعادة');
  });
}

// ---------- Operation catalog ----------
function renderCatalog(v) {
  v.innerHTML = `<div class="card"><h2>كتالوج التشغيل</h2>
    <h3>كلام جاهز للعرض أمام الإدارة</h3>
    <p>«نظام PharmacyTarget بيتابع تارجت الفرع الشهري ويقسمه على الموظفين بشكل عادل حسب أيام العمل، وكل موظف بيعرف مطلوبه اليومي وبيسجل نتائجه بعد الشيفت، والمدير بيشوف كل حاجة لحظة بلحظة، والتقارير الشهرية بتكشف المشاكل وحلولها، والـ Preferred List بتضمن تركيز الفريق على الأصناف الأهم.»</p>
    <h3>دورة العمل اليومية</h3>
    <ol><li>المدير يتأكد من تارجت الفرع والـ Preferred List.</li><li>كل موظف يشوف مطلوبه اليومي في لوحته.</li><li>بعد الشيفت: الموظف يسجل نتائج اليوم ويدوس حفظ.</li><li>المدير يراجع لوحة الفريق والتنبيهات.</li><li>آخر الشهر: المدير يرفع شيت المبيعات والأصناف، والتطبيق يحلل ويقول حققنا ولا لأ.</li></ol>
    <h3>خطة أول شهر (تجريبي)</h3>
    <p>الأسبوع الأول: تدريب الفريق على تسجيل النتائج. الأسبوع الثاني: متابعة يومية للمطلوب اليومي. الأسبوع الثالث: أول تقرير شهري جزئي وحلول للمشاكل. الأسبوع الرابع: تقييم كامل وقرار الاستمرار.</p>
    <h3>أسئلة متوقعة من الإدارة</h3>
    <p><b>البيانات بتتزامن؟</b> أيوه، كل البيانات على الخادم وبتظهر لكل الأجهزة فورًا.<br>
    <b>الباسوردات آمنة؟</b> أيوه، مشفرة على الخادم ولا تظهر في كود الصفحة.<br>
    <b>لو النت قطع؟</b> سجل النتائج عند عودة الاتصال؛ النسخة الاحتياطية الأسبوعية من قاعدة البيانات إلزامية.</p>
    </div>`;
}

// ---------- Boot: check existing session ----------
(async () => {
  try {
    const d = await api('/api/me');
    user = d.user;
    $('#login-card').hidden = true;
    $('#dashboard').hidden = false;
    $('#who').textContent = `${user.name} — ${roleName(user.role)}`;
    await loadAll();
    renderTabs();
    render();
  } catch (e) { /* stay on login */ }
})();
