// يشغّل التطبيق الحقيقي (index.html مُترجَماً) داخل jsdom: الإقلاع، توليد الخطة، كل التبويبات، ما-لو، الدخول السحابي.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { compileApp } from './extract.mjs';

const NM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
const REACT = fs.readFileSync(path.join(NM, 'react/umd/react.development.js'), 'utf8');
const REACT_DOM = fs.readFileSync(path.join(NM, 'react-dom/umd/react-dom.development.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const demand = Array.from({ length: 12 }, (_, i) => ({ week: 'W' + (i + 1), qty: 10000 + (i % 3) * 800 }));
const SEED = {
  'cdt:planWeeks': 12, 'cdt:demand': demand,
  'cdt:bom': [{ id: 'm1', name: 'Milk', qty: 2, unit: 'kg' }, { id: 'm2', name: 'Pack', qty: 1, unit: 'pc' }],
  'cdt:inventory': [
    { id: 'm1', name: 'Milk', unit: 'kg', available: 60000, safety: 2000, leadTime: 2, maxCapacity: 5e5, unitCost: 2 },
    { id: 'm2', name: 'Pack', unit: 'pc', available: 15000, safety: 500, leadTime: 4, maxCapacity: 5e5, unitCost: 0.5 }],
  'cdt:capacity': { productionRate: 120, shiftHours: 8, normalDays: 6, maxShifts: 3, defectRateMin: 2, defectRateMax: 3, minimizeIdleDays: true, levelProduction: false, levelingThresholdPct: 35 },
  'cdt:fgi': { current: 5000, safety: 3000, maxWarehouse: 100000, mode: 'hybrid' },
  'cdt:engine': { intervalHours: 3000, durationHours: 8, remainingHours: 150 },
  'cdt:planningprofile': { hasBOM: true, hasFGI: true, hasMaintenance: true },
  'cdt:polog': [],
};

function boot({ seed = SEED, code = compileApp(), beforeEval } = {}) {
  const errors = [], vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.detail?.stack || e.message || e).slice(0, 300)));
  vc.on('error', (...a) => errors.push(a.map((x) => x?.stack || String(x)).join(' ').slice(0, 300)));
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="loading"></div><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.eval(REACT); w.eval(REACT_DOM);
  w.XLSX = {}; w.Papa = { parse: () => ({ data: [] }) }; w.print = () => {}; w.fetch = () => Promise.reject(new Error('offline'));
  Object.entries(seed).forEach(([k, v]) => w.localStorage.setItem(k, JSON.stringify(v)));
  beforeEval?.(w);
  w.eval(code);
  const ui = {
    w, errors,
    body: () => w.document.body.textContent.replace(/\s+/g, ' '),
    boundary: () => w.document.body.textContent.includes('حدث خطأ أثناء تشغيل التطبيق'),
    labels: () => [...w.document.querySelectorAll('button')].map((b) => b.textContent.trim().replace(/\s+/g, ' ')),
    strip: (t) => t.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[◂▾]+$/u, '').trim(),
    find: (label) => [...w.document.querySelectorAll('button')].find((b) => ui.strip(b.textContent.trim().replace(/\s+/g, ' ')) === label),
    click: (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })),
    ls: (k) => JSON.parse(w.localStorage.getItem(k)),
  };
  return ui;
}
const goLocal = async (ui) => { await sleep(400); const b = [...ui.w.document.querySelectorAll('button')].find((x) => /المتابعة محلياً/.test(x.textContent)); assert.ok(b, 'زر المتابعة المحلية'); ui.click(b); await sleep(500); };
const generate = async (ui) => { const g = [...ui.w.document.querySelectorAll('button')].find((b) => /تشغيل النظام وإنشاء الخطة/.test(b.textContent)); assert.ok(g, 'زر توليد الخطة'); ui.click(g); await sleep(5000); };

test('الكود يُترجم (JSX سليم) ويُقلع بلا انهيار', async () => {
  const ui = boot(); await goLocal(ui);
  assert.ok(!ui.boundary()); assert.deepEqual(ui.errors, []);
});

test('توليد الخطة ثم فتح كل التبويبات وأزرار ما-لو بلا انهيار', async () => {
  const ui = boot(); await goLocal(ui); await generate(ui);
  assert.ok(/جاهزة/.test(ui.body()), 'الخطة وُلّدت (حالة: جاهزة)');
  const SKIP = /حذف|مسح|إعادة|خروج|توليد|أرسل|بريد|تصدير|Excel|تشغيل النظام|جلب|مزامنة|تأكيد الخطة|خطة جديدة/;
  const visited = [];
  const visit = async (label) => { const b = ui.find(label); if (!b) return false; ui.click(b); await sleep(200); assert.ok(!ui.boundary(), 'انهيار عند فتح: ' + label); visited.push(label); return true; };
  await visit('لوحة التحكم');
  const baseline = new Set(ui.labels().map(ui.strip));
  for (const g of ['التخطيط', 'الذكاء الاصطناعي والسيناريوهات', 'الجدولة والتكاليف', 'التقارير والمخرجات']) {
    await visit(g);
    for (const t of new Set(ui.labels().map(ui.strip).filter((t) => t && !baseline.has(t) && !SKIP.test(t)))) await visit(t);
  }
  if (!ui.find('BOM')) { const g = ui.find('البيانات الرئيسية'); if (g) { ui.click(g); await sleep(200); } }
  for (const t of ['خطة المبيعات', 'BOM', 'المخزون', 'طلبات الشراء (SR)', 'FGI', 'الطاقة', 'الصيانة', 'استيراد البيانات']) await visit(t);
  await visit('ماذا لو؟');
  for (const t of ui.labels().filter((t) => /تفعيل|W\d+/.test(t) && !SKIP.test(t)).slice(0, 8)) { const b = ui.labels().includes(t) && [...ui.w.document.querySelectorAll('button')].find((x) => x.textContent.trim().replace(/\s+/g, ' ') === t); if (b) { ui.click(b); await sleep(150); assert.ok(!ui.boundary(), 'انهيار ما-لو: ' + t); } }
  assert.ok(visited.length >= 20, 'فُتح ' + visited.length + ' تبويباً');
  assert.deepEqual(ui.errors, []);
});

// ── الدخول السحابي: عميل Supabase تجريبي ──
function cloudClient() {
  const tables = {
    profiles: [{ id: 'u1', organization_id: 'o1', role: 'admin', full_name: 'N' }],
    organizations: [{ id: 'o1', name: 'Qamariya' }],
    products: [{ id: 'p1', organization_id: 'o1', name: 'Ghee' }],
    bom_components: [{ id: 'b1', organization_id: 'o1', product_id: 'p1', material_key: 'm1', material_name: 'Milk', qty_per_unit: '2', unit: 'kg', available: '9000', safety_stock: '100', lead_time_weeks: '2', max_capacity: null },
                     { id: 'b2', organization_id: 'o1', product_id: 'p1', material_key: 'm2', material_name: 'Pack', qty_per_unit: '1', unit: 'pc', available: '7000', safety_stock: '50', lead_time_weeks: '4', max_capacity: null }],
    production_lines: [{ id: 'l1', organization_id: 'o1', product_id: 'p1', units_per_hour: '150', shift_hours: '10' }],
    scheduled_receipts: [],
  };
  const from = (t) => { let rows = tables[t]; const api = { select: () => api, eq: (c, v) => { rows = rows.filter((r) => r[c] === v); return api; }, order: () => api, single: () => Promise.resolve({ data: rows[0] || null, error: rows[0] ? null : { message: 'none' } }), upsert: async () => ({ error: null }), insert: () => api, then: (res) => res({ data: rows, error: null }) }; return api; };
  const session = { user: { id: 'u1', email: 'a@a' } };
  return { from, functions: { invoke: async () => ({ data: { text: 'ok' }, error: null }) }, auth: { getSession: async () => ({ data: { session } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}) } };
}

test('الدخول السحابي يدمج بيانات السحابة ولا يمسح تكلفة الوحدة ولا إعدادات الطاقة المحلية', async () => {
  const code = compileApp()
    .replace('const SUPABASE_URL = "ضعي-رابط-مشروعك-هنا";', 'const SUPABASE_URL = "https://test.supabase.co";')
    .replace('const SUPABASE_ANON_KEY = "ضعي-anon-public-key-هنا";', 'const SUPABASE_ANON_KEY = "' + 'k'.repeat(40) + '";');
  assert.ok(code.includes('https://test.supabase.co'), 'تم ضبط عنوان Supabase للاختبار');
  const ui = boot({ code, seed: {}, beforeEval: (w) => { w.supabase = { createClient: () => cloudClient() }; } });
  await sleep(1500);
  assert.ok(!ui.boundary(), 'لا انهيار'); assert.deepEqual(ui.errors, []);
  // خطة المنتج السحابي → مفاتيح محلية
  const keys = Object.keys(ui.w.localStorage).filter((k) => /^cdt:plan:.*:(inventory|capacity)$/.test(k));
  assert.ok(keys.length >= 2, 'كُتبت بيانات الخطة المحلية: ' + keys.join(','));
  const inv = ui.ls(keys.find((k) => k.endsWith(':inventory'))), capacity = ui.ls(keys.find((k) => k.endsWith(':capacity')));
  assert.equal(inv.find((i) => i.id === 'm1').available, 9000, 'قيمة السحابة هي المعتمدة للمخزون');
  assert.equal(capacity.productionRate, 150); assert.equal(capacity.shiftHours, 10);
});

test('إعادة الدخول السحابي: unitCost وإعدادات الطاقة المحلية تبقى (لا تُستبدل)', async () => {
  const code = compileApp()
    .replace('const SUPABASE_URL = "ضعي-رابط-مشروعك-هنا";', 'const SUPABASE_URL = "https://test.supabase.co";')
    .replace('const SUPABASE_ANON_KEY = "ضعي-anon-public-key-هنا";', 'const SUPABASE_ANON_KEY = "' + 'k'.repeat(40) + '";');
  // الجولة الأولى: ينشئ التطبيق الخطة المحلية للمنتج السحابي
  const first = boot({ code, seed: {}, beforeEval: (w) => { w.supabase = { createClient: () => cloudClient() }; } });
  await sleep(1500);
  const invKey = Object.keys(first.w.localStorage).find((k) => /^cdt:plan:.*:inventory$/.test(k));
  const capKey = invKey.replace(':inventory', ':capacity');
  // المستخدمة تضيف محلياً: تكلفة وحدة + نسب عيوب/أيام عمل مخصّصة
  const inv = first.ls(invKey).map((i) => ({ ...i, unitCost: i.id === 'm1' ? 7.5 : 1.25 }));
  const cap = { ...first.ls(capKey), normalDays: 5, defectRateMin: 4.4, defectRateMax: 6.6, maxShifts: 2 };
  const stored = Object.fromEntries(Object.keys(first.w.localStorage).map((k) => [k, JSON.parse(first.w.localStorage.getItem(k))]));
  stored[invKey] = inv; stored[capKey] = cap;
  // الجولة الثانية = «تسجيل دخول جديد» بنفس المتصفح
  const second = boot({ code, seed: stored, beforeEval: (w) => { w.supabase = { createClient: () => cloudClient() }; } });
  await sleep(1500);
  assert.ok(!second.boundary());
  const inv2 = second.ls(invKey), cap2 = second.ls(capKey);
  assert.equal(inv2.find((i) => i.id === 'm1').unitCost, 7.5, 'unitCost لم يُمسح');
  assert.equal(inv2.find((i) => i.id === 'm1').available, 9000, 'وما زالت قيم السحابة هي المعتمدة للكميات');
  assert.equal(cap2.normalDays, 5); assert.equal(cap2.defectRateMin, 4.4); assert.equal(cap2.maxShifts, 2);
  assert.equal(cap2.productionRate, 150, 'سرعة الخط من السحابة');
});

// ── ما-لو من الواجهة: بدون تغيير = صفر فروقات؛ وعطل أسبوع واحد يغيّر ذلك الأسبوع فقط ──
test('ما-لو (واجهة): "بدون تغيير" فروقاته صفر، وعطل W8 يغيّر W8 فقط', async () => {
  const ui = boot(); await goLocal(ui); await generate(ui);
  for (const g of ['التخطيط', 'الذكاء الاصطناعي والسيناريوهات']) { const b = ui.find(g); if (b) { ui.click(b); await sleep(150); } }
  ui.click(ui.find('ماذا لو؟')); await sleep(250);
  const btn = (re) => [...ui.w.document.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
  ui.click(btn(/تفعيل/)); await sleep(400);
  const table = () => [...ui.w.document.querySelectorAll('table')].find((t) => /استخدام أساسي/.test(t.textContent));
  const rows = () => [...table().querySelectorAll('tbody tr')].map((r) => { const td = r.querySelectorAll('td'); return { week: td[0].textContent.replace(/[^W\d]/g, ''), base: td[1].textContent, scen: td[2].textContent, delta: td[3].textContent.trim() }; });
  assert.ok(table(), 'جدول المقارنة ظاهر');
  assert.ok(rows().length === 12 && rows().every((r) => r.delta === '0%' && r.base === r.scen), 'بدون تغيير: ' + JSON.stringify(rows().filter((r) => r.delta !== '0%')));
  ui.click([...ui.w.document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'W8')); await sleep(400);
  const after = rows();
  assert.notEqual(after.find((r) => r.week === 'W8').delta, '0%', 'W8 تغيّر');
  assert.ok(after.filter((r) => r.week !== 'W8').every((r) => r.delta === '0%'), 'باقي الأسابيع لم تتغيّر');
  assert.ok(!ui.boundary()); assert.deepEqual(ui.errors, []);
});

// ── تقرير PDF وعرض الصيانة المتعددة وعجز "فات الأوان" ──
async function findAndOpen(ui, predicate) {
  const SKIP = /حذف|مسح|إعادة|خروج|توليد|أرسل|بريد|تصدير|Excel|تشغيل النظام|جلب|مزامنة|تأكيد الخطة|خطة جديدة/;
  const has = () => [...ui.w.document.querySelectorAll('button')].find((b) => predicate(b.textContent.trim()));
  if (has()) return has();
  const dash = ui.find('لوحة التحكم'); if (dash) { ui.click(dash); await sleep(150); }
  const groups = ['البيانات الرئيسية', 'التخطيط', 'الذكاء الاصطناعي والسيناريوهات', 'الجدولة والتكاليف', 'التقارير والمخرجات'];
  const baseline = new Set(ui.labels().map(ui.strip));
  for (const g of groups) {
    const gb = ui.find(g); if (!gb) continue;
    ui.click(gb); await sleep(150);
    for (const t of new Set(ui.labels().map(ui.strip).filter((x) => x && !baseline.has(x) && !SKIP.test(x)))) {
      const b = ui.find(t); if (!b) continue;
      ui.click(b); await sleep(150);
      if (has()) return has();
    }
  }
  return null;
}

test('تقرير PDF: يُولَّد بدون قيم فاسدة، ويعرض "عجز" بدل كمية طلب وهمية لأسابيع فات الأوان', async () => {
  let html = '';
  const ui = boot({ beforeEval: (w) => { w.open = () => ({ document: { write: (h) => { html += h; }, close() {} } }); w.alert = (m) => { throw new Error('alert: ' + m); }; } });
  await goLocal(ui); await generate(ui);
  const btn = await findAndOpen(ui, (t) => /إنشاء تقرير PDF شامل/.test(t));
  assert.ok(btn, 'زر إنشاء PDF');
  ui.click(btn); await sleep(300);
  assert.ok(html.length > 5000, 'التقرير وُلّد');
  assert.ok(!/undefined|NaN|Infinity/.test(html), 'لا قيم فاسدة بالتقرير: ' + (html.match(/.{30}(undefined|NaN|Infinity).{30}/) || [''])[0]);
  assert.match(html, /عجز [\d,٬]+/, 'عمود عجز لأسابيع فات الأوان');
  assert.match(html, /متأخر/);
  assert.deepEqual(ui.errors, []);
});

test('صيانات متعددة: تظهر كل الأسابيع بالواجهة وبالتقرير', async () => {
  let html = '';
  const seed = { ...SEED,
    'cdt:inventory': SEED['cdt:inventory'].map((i) => ({ ...i, available: 9e6, leadTime: 1 })),
    'cdt:engine': { intervalHours: 250, durationHours: 8, remainingHours: 100 } };
  const ui = boot({ seed, beforeEval: (w) => { w.open = () => ({ document: { write: (h) => { html += h; }, close() {} } }); } });
  await goLocal(ui); await generate(ui);
  const tab = ui.find('الصيانة'); if (!tab) { const g = ui.find('البيانات الرئيسية'); if (g) { ui.click(g); await sleep(150); } }
  ui.click(ui.find('الصيانة')); await sleep(250);
  assert.ok(!ui.boundary());
  const body = ui.body();
  assert.match(body, /أسابيع الصيانة/, 'عنوان الجمع (أكثر من موعد)');
  assert.match(body, /مطلوبة \d+ مرات/, 'نص التنبيه بصيغة المتعدد');
  const weeksShown = (body.match(/W\d+(?:، W\d+)+/) || [''])[0];
  assert.ok(weeksShown.split('، ').length >= 3, 'عدة أسابيع صيانة معروضة: ' + weeksShown);
  const pdfBtn = await findAndOpen(ui, (t) => /إنشاء تقرير PDF شامل/.test(t));
  ui.click(pdfBtn); await sleep(300);
  assert.match(html, /في الأسابيع W\d+/, 'التقرير يذكر الأسابيع المتعددة');
  assert.ok(!/undefined|NaN|Infinity/.test(html));
  assert.deepEqual(ui.errors, []);
});
