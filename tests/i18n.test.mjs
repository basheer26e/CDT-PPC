// اللغة: الواجهة الإنجليزية بلا أي نص عربي، والتبديل أثناء التشغيل يحدّث حتى النصوص المحسوبة (الجدوى والصيانة).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { compileApp, loadLogic } from './extract.mjs';

const NM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
const REACT = fs.readFileSync(path.join(NM, 'react/umd/react.development.js'), 'utf8');
const REACT_DOM = fs.readFileSync(path.join(NM, 'react-dom/umd/react-dom.development.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AR = /[\u0600-\u06FF]/;

const demand = Array.from({ length: 12 }, (_, i) => ({ week: 'W' + (i + 1), qty: 10000 + (i % 3) * 800 }));
const BASE = {
  'cdt:planWeeks': 12, 'cdt:demand': demand,
  'cdt:bom': [{ id: 'm1', name: 'Milk', qty: 2, unit: 'kg' }, { id: 'm2', name: 'Pack', qty: 1, unit: 'pc' }],
  'cdt:inventory': [
    { id: 'm1', name: 'Milk', unit: 'kg', available: 60000, safety: 2000, leadTime: 2, maxCapacity: 5e5, unitCost: 2 },
    { id: 'm2', name: 'Pack', unit: 'pc', available: 15000, safety: 500, leadTime: 4, maxCapacity: 5e5, unitCost: 0.5 }],
  'cdt:capacity': { productionRate: 120, shiftHours: 8, normalDays: 6, maxShifts: 3, defectRateMin: 2, defectRateMax: 3, minimizeIdleDays: true, levelProduction: false, levelingThresholdPct: 35 },
  'cdt:fgi': { current: 5000, safety: 3000, maxWarehouse: 100000, mode: 'hybrid' },
  'cdt:engine': { intervalHours: 250, durationHours: 8, remainingHours: 100 },
  'cdt:polog': [],
};
const PROFILE = { 'cdt:planningprofile': { hasBOM: true, hasFGI: true, hasMaintenance: true } };

function boot(seed, opts = {}) {
  const errors = [], vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.detail?.stack || e.message || e).slice(0, 300)));
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="loading"></div><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window; w.eval(REACT); w.eval(REACT_DOM);
  w.XLSX = {}; w.Papa = { parse: () => ({ data: [] }) }; w.print = () => {}; w.fetch = () => Promise.reject(new Error('offline'));
  Object.entries(seed).forEach(([k, v]) => w.localStorage.setItem(k, JSON.stringify(v)));
  opts.beforeEval?.(w);
  w.eval(opts.transform ? opts.transform(compileApp()) : compileApp());
  const ui = {
    w, errors,
    body: () => w.document.body.textContent.replace(/\s+/g, ' '),
    buttons: () => [...w.document.querySelectorAll('button')],
    labels: () => ui.buttons().map((b) => b.textContent.trim().replace(/\s+/g, ' ')),
    strip: (t) => t.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[◂▾]+$/u, '').trim(),
    byText: (re) => ui.buttons().find((b) => re.test(b.textContent)),
    byLabel: (l) => ui.buttons().find((b) => ui.strip(b.textContent.trim().replace(/\s+/g, ' ')) === l),
    click: (b) => b.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })),
    leaks: new Map(),
    scan(where) {
      const walker = w.document.createTreeWalker(w.document.body, 4); let n;
      while ((n = walker.nextNode())) { const t = n.nodeValue.trim(); if (AR.test(t)) ui.leaks.set(t.slice(0, 90), where); }
      w.document.querySelectorAll('[placeholder],[title]').forEach((e) => { for (const a of ['placeholder', 'title']) { const v = e.getAttribute(a); if (v && AR.test(v)) ui.leaks.set('@' + a + ': ' + v.slice(0, 80), where); } });
    },
  };
  return ui;
}
async function openTab(ui, label, groups) {
  let b = ui.byLabel(label);
  if (!b) for (const g of groups) { const gb = ui.byLabel(g); if (gb) { ui.click(gb); await sleep(150); b = ui.byLabel(label); if (b) break; } }
  assert.ok(b, 'تبويب غير موجود: ' + label);
  ui.click(b); await sleep(250); ui.scan('tab:' + label);
}
const report = (ui) => [...ui.leaks].map(([t, w]) => `[${w}] ${t}`).join('\n');

test('الواجهة الإنجليزية: لا نص عربي بأي تبويب ولا نافذة (26 صفحة + المعالج + خطة جديدة)', async () => {
  const ui = boot({ 'cdt:lang': 'en', ...BASE, ...PROFILE });
  await sleep(400); ui.scan('login');
  { const gl = ui.byText(/Continue locally/); if (gl) ui.click(gl); } await sleep(500); ui.scan('start');
  ui.click(ui.byText(/Run the system and create the plan/)); await sleep(5000); ui.scan('after-plan');
  const groups = ui.labels().filter((t) => /[◂▾]\s*$/.test(t)).map(ui.strip);
  assert.ok(groups.length >= 5, 'مجموعات التنقل: ' + groups.join(' | '));
  const tabs = ['Dashboard', 'All Plans', 'Sales Plan', 'BOM', 'Inventory', 'Purchase Orders (SR)', 'FGI', 'Capacity', 'Maintenance', 'Data Import',
    'MPS', 'Shifts', 'MRP', 'CRP', 'AI Agents', 'What-If', 'Suggestion Comparison', 'Daily Schedule', 'Costs', 'Feasibility Report', 'Inventory Update', 'PDF & Email', 'About'];
  for (const t of tabs) await openTab(ui, t, groups);
  await openTab(ui, 'What-If', groups);
  for (let k = 0; k < 4; k++) { const b = ui.byText(/Activate/); if (!b) break; ui.click(b); await sleep(300); ui.scan('whatif-activated'); }
  await openTab(ui, 'AI Agents', groups);
  const run = ui.byText(/Run the AI agents/); assert.ok(run); ui.click(run); await sleep(700); ui.scan('agents-no-key');
  assert.equal(ui.leaks.size, 0, 'نصوص عربية بالواجهة الإنجليزية:\n' + report(ui));
  assert.deepEqual(ui.errors, []);
});

test('الواجهة الإنجليزية: معالج الأسئلة الأولى ونافذة «خطة جديدة» بلا نص عربي', async () => {
  const ui = boot({ 'cdt:lang': 'en', ...BASE });   // بلا ملف تخطيط ← يظهر المعالج
  await sleep(400);
  { const gl = ui.byText(/Continue locally/); if (gl) ui.click(gl); } await sleep(600); ui.scan('wizard-q1');
  for (let q = 0; q < 3; q++) { const yes = ui.buttons().find((x) => /Yes —|We keep safety/.test(x.textContent)); assert.ok(yes, 'زر إجابة المعالج ' + q); ui.click(yes); await sleep(300); ui.scan('wizard-q' + (q + 1)); }
  ui.click(ui.byText(/Start using the system/)); await sleep(500); ui.scan('wizard-done');
  ui.click(ui.buttons().find((x) => /▾/.test(x.textContent))); await sleep(250);
  ui.click(ui.byText(/\+ New plan/)); await sleep(400); ui.scan('new-plan-1');
  const inp = ui.w.document.querySelector('input[placeholder*="Example"]'); assert.ok(inp);
  Object.getOwnPropertyDescriptor(ui.w.HTMLInputElement.prototype, 'value').set.call(inp, 'Test product'); inp.dispatchEvent(new ui.w.Event('input', { bubbles: true })); await sleep(200);
  ui.click(ui.byText(/^Next$/)); await sleep(400); ui.scan('new-plan-2');
  assert.equal(ui.leaks.size, 0, report(ui)); assert.deepEqual(ui.errors, []);
});

test('تبديل اللغة أثناء التشغيل يحدّث حتى النصوص المحسوبة (جدوى، صيانة) ذهاباً وإياباً', async () => {
  const ui = boot({ ...BASE, ...PROFILE });   // عربي افتراضياً
  await sleep(400);
  { const gl = ui.byText(/المتابعة محلياً/); if (gl) ui.click(gl); } await sleep(500);
  ui.click(ui.byText(/تشغيل النظام وإنشاء الخطة/)); await sleep(5000);
  const groups = ui.labels().filter((t) => /[◂▾]\s*$/.test(t)).map(ui.strip);
  await openTab(ui, 'تقرير الجدوى', groups);
  assert.match(ui.body(), /جدوى الطاقة الإنتاجية/, 'عربي أولاً'); assert.ok(!/Production capacity feasibility/.test(ui.body()));
  ui.click(ui.buttons().find((b) => /\bEN$/.test(b.textContent.trim()))); await sleep(500);
  assert.match(ui.body(), /Production capacity feasibility/, 'تحوّل لحظياً للإنجليزية (نص محسوب بالمحرك)');
  assert.ok(!/جدوى الطاقة الإنتاجية/.test(ui.body()));
  await openTab(ui, 'Maintenance', ['Master Data']);
  assert.match(ui.body(), /Periodic maintenance is required \d+ times/, 'تنبيه الصيانة المتعددة بالإنجليزية');
  // اسم الخطة الافتراضي بيانات تُحفظ بلغة لحظة الإنشاء (مثل أي اسم يكتبه المستخدم) فلا يُترجَم لاحقاً
  const visible = ui.body().replace(/الخطة الأولى \(مُرحَّلة\)/g, '');
  assert.ok(!AR.test(visible), 'لا عربي بعد التبديل: ' + (visible.match(/.{20}[\u0600-\u06FF]+.{20}/) || [''])[0]);
  ui.click(ui.buttons().find((b) => /\bAR$/.test(b.textContent.trim()))); await sleep(500);
  assert.match(ui.body(), /الصيانة الدورية مطلوبة \d+ مرات/, 'والعودة للعربية');
  assert.deepEqual(ui.errors, []);
});

test('دوال الترجمة: العربية افتراضياً، والمتغيرات تُستبدل', () => {
  const L = loadLogic()();
  assert.equal(L.__t('عربي', 'English'), 'عربي');
  assert.equal(L.__tf('أسبوع {0} من {1}', 'week {0} of {1}', [3, 12]), 'أسبوع 3 من 12');
});

test('تقرير PDF بالإنجليزية: بلا أي حرف عربي، اتجاه LTR، بلا قيم فاسدة — وبالعربية يبقى RTL', async () => {
  const run = async (lang) => {
    let html = '';
    const seed = { ...(lang === 'en' ? { 'cdt:lang': 'en' } : {}), ...BASE, ...PROFILE };
    const ui = boot(seed);
    ui.w.open = () => ({ document: { write: (h) => { html += h; }, close() {} } });
    await sleep(400);
    { const gl = ui.byText(lang === 'en' ? /Continue locally/ : /المتابعة محلياً/); if (gl) ui.click(gl); } await sleep(500);
    ui.click(ui.byText(lang === 'en' ? /Run the system and create the plan/ : /تشغيل النظام وإنشاء الخطة/)); await sleep(5000);
    const groups = ui.labels().filter((t) => /[◂▾]\s*$/.test(t)).map(ui.strip);
    await openTab(ui, lang === 'en' ? 'PDF & Email' : 'PDF وإرسال', groups);
    ui.click(ui.byText(lang === 'en' ? /Generate a comprehensive PDF report/ : /إنشاء تقرير PDF شامل/)); await sleep(400);
    assert.deepEqual(ui.errors, []);
    return html;
  };
  const en = await run('en');
  assert.ok(en.length > 5000);
  assert.ok(!AR.test(en), 'عربي بتقرير PDF الإنجليزي: ' + (en.match(/.{30}[\u0600-\u06FF]+.{30}/) || [''])[0]);
  assert.match(en, /dir="ltr" lang="en"/); assert.match(en, /Production planning & control report/);
  assert.match(en, /Machine maintenance \(operating hours\)/); assert.match(en, /Material requirements/);
  assert.ok(!/undefined|NaN|Infinity|\{\d+\}/.test(en), 'قيم فاسدة/متغيرات غير مستبدلة: ' + (en.match(/.{25}(undefined|NaN|Infinity|\{\d+\}).{25}/) || [''])[0]);
  const ar = await run('ar');
  assert.match(ar, /dir="rtl" lang="ar"/); assert.match(ar, /تقرير تخطيط الإنتاج والتحكم/);
  assert.ok(!/undefined|NaN|Infinity|\{\d+\}/.test(ar));
});

test('شاشة الدخول (عند إعداد السحابة بلا جلسة): بلا نص عربي بالإنجليزية', async () => {
  const noSession = { from: () => ({}), functions: { invoke: async () => ({}) }, auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}) } };
  const ui = boot({ 'cdt:lang': 'en', ...BASE, ...PROFILE }, {
    transform: (c) => c.replace('const SUPABASE_URL = "ضع-رابط-مشروعك-هنا";', 'const SUPABASE_URL = "https://test.supabase.co";').replace('const SUPABASE_ANON_KEY = "ضع-anon-public-key-هنا";', 'const SUPABASE_ANON_KEY = "' + 'k'.repeat(40) + '";'),
    beforeEval: (w) => { w.supabase = { createClient: () => noSession }; },
  });
  await sleep(1500); ui.scan('login');
  assert.match(ui.body(), /Sign in/); assert.match(ui.body(), /Continue locally/);
  assert.equal(ui.leaks.size, 0, report(ui)); assert.deepEqual(ui.errors, []);
});
