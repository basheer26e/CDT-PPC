// يزحف على التطبيق الحقيقي (jsdom) بكل حالاته ويجمع كل أصناف CSS المستخدمة فعلاً بالـDOM:
// اللغتان، الثيمان، تبويبات البيانات والتخطيط والذكاء الاصطناعي والتقارير، ما-لو، المعالج، خطة جديدة،
// خطة بحمل زائد (تجاوز طاقة/نقص مواد)، ووضع السحابة. يُستخدم لتوليد قائمة الأصناف الآمنة ولاختبار تغطية التنسيق.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { compileApp } from './extract.mjs';

const NM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
const REACT = fs.readFileSync(path.join(NM, 'react/umd/react.development.js'), 'utf8');
const REACT_DOM = fs.readFileSync(path.join(NM, 'react-dom/umd/react-dom.development.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const demand = (base) => Array.from({ length: 12 }, (_, i) => ({ week: 'W' + (i + 1), qty: base + (i % 3) * 800 }));
const seed = ({ lang, base = 10000, rate = 120, profile = true, engine = { intervalHours: 250, durationHours: 8, remainingHours: 100 } } = {}) => ({
  ...(lang ? { 'cdt:lang': lang } : {}),
  'cdt:planWeeks': 12, 'cdt:demand': demand(base),
  'cdt:bom': [{ id: 'm1', name: 'Milk', qty: 2, unit: 'kg' }, { id: 'm2', name: 'Pack', qty: 1, unit: 'pc' }],
  'cdt:inventory': [
    { id: 'm1', name: 'Milk', unit: 'kg', available: 60000, safety: 2000, leadTime: 2, maxCapacity: 5e5, unitCost: 2 },
    { id: 'm2', name: 'Pack', unit: 'pc', available: 15000, safety: 500, leadTime: 4, maxCapacity: 5e5, unitCost: 0.5 }],
  'cdt:capacity': { productionRate: rate, shiftHours: 8, normalDays: 6, maxShifts: 3, defectRateMin: 2, defectRateMax: 3, minimizeIdleDays: true, levelProduction: true, levelingThresholdPct: 35 },
  'cdt:fgi': { current: 5000, safety: 3000, maxWarehouse: 100000, mode: 'hybrid' },
  'cdt:engine': engine,
  'cdt:polog': [{ materialId: 'm2', status: 'pending', qty: 5000, arrivalDate: '2026-12-10' }],
  ...(profile ? { 'cdt:planningprofile': { hasBOM: true, hasFGI: true, hasMaintenance: true } } : {}),
});

function cloudClient() {
  const tables = {
    profiles: [{ id: 'u1', organization_id: 'o1', role: 'admin', full_name: 'N' }], organizations: [{ id: 'o1', name: 'Demo Factory' }],
    products: [{ id: 'p1', organization_id: 'o1', name: 'Ghee' }],
    bom_components: [{ id: 'b1', organization_id: 'o1', product_id: 'p1', material_key: 'm1', material_name: 'Milk', qty_per_unit: '2', unit: 'kg', available: '9000', safety_stock: '100', lead_time_weeks: '2', max_capacity: null }],
    production_lines: [{ id: 'l1', organization_id: 'o1', product_id: 'p1', units_per_hour: '150', shift_hours: '10' }], scheduled_receipts: [],
  };
  const from = (t) => { let rows = tables[t]; const api = { select: () => api, eq: (c, v) => { rows = rows.filter((r) => r[c] === v); return api; }, order: () => api, single: () => Promise.resolve({ data: rows[0] || null, error: rows[0] ? null : { message: 'none' } }), upsert: async () => ({ error: null }), insert: () => api, then: (res) => res({ data: rows, error: null }) }; return api; };
  return { from, functions: { invoke: async () => ({ data: { text: 'ok' }, error: null }) }, auth: { getSession: async () => ({ data: { session: { user: { id: 'u1', email: 'a@a' } } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}) } };
}

function boot(seedObj, { cloud = false, noSession = false } = {}) {
  const errors = [], vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.detail?.stack || e.message || e).slice(0, 300)));
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="loading"></div><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window; w.eval(REACT); w.eval(REACT_DOM);
  w.XLSX = {}; w.Papa = { parse: () => ({ data: [] }) }; w.print = () => {}; w.fetch = () => Promise.reject(new Error('offline'));
  w.open = () => ({ document: { write() {}, close() {} } });
  Object.entries(seedObj).forEach(([k, v]) => w.localStorage.setItem(k, JSON.stringify(v)));
  let code = compileApp();
  if (cloud) { code = code.replace('const SUPABASE_URL = "ضع-رابط-مشروعك-هنا";', 'const SUPABASE_URL = "https://test.supabase.co";').replace('const SUPABASE_ANON_KEY = "ضع-anon-public-key-هنا";', 'const SUPABASE_ANON_KEY = "' + 'k'.repeat(40) + '";'); w.supabase = { createClient: () => { const c = cloudClient(); if (noSession) c.auth.getSession = async () => ({ data: { session: null } }); return c; } }; }
  w.eval(code);
  const ui = {
    w, errors,
    buttons: () => [...w.document.querySelectorAll('button')],
    labels: () => ui.buttons().map((b) => b.textContent.trim().replace(/\s+/g, ' ')),
    strip: (t) => t.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[◂▾]+$/u, '').trim(),
    byText: (re) => ui.buttons().find((b) => re.test(b.textContent)),
    click: (b) => b.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })),
    classes: new Set(),
    scan() { w.document.querySelectorAll('[class]').forEach((e) => String(e.getAttribute('class')).split(/\s+/).filter(Boolean).forEach((c) => ui.classes.add(c))); },
  };
  return ui;
}

const SKIP = /delete|clear|erase|reset|sign out|generate a comprehensive|send|export|excel|run the system|fetch|sync|confirm the plan|confirm purchase|new plan|cancel|add as|actually arrived|حذف|مسح|إعادة|خروج|توليد|أرسل|بريد|تصدير|تشغيل النظام|جلب|مزامنة|تأكيد|خطة جديدة|إلغاء|وصلت/i;

// يمرّ على كل تبويب (بأي لغة) ويفعّل أزرار ما-لو والوكلاء
async function walk(ui, { deep = true } = {}) {
  const groups = ui.labels().filter((t) => /[◂▾]\s*$/.test(t)).map(ui.strip);
  const baseline = new Set(ui.labels().map(ui.strip));
  const byLabel = (l) => ui.buttons().find((x) => ui.strip(x.textContent.trim().replace(/\s+/g, ' ')) === l);
  const visitSubs = async () => {
    for (const t of new Set(ui.labels().map(ui.strip).filter((x) => x && !baseline.has(x) && !SKIP.test(x)))) {
      const b = byLabel(t); if (!b) continue;
      ui.click(b); await sleep(160); ui.scan();
      if (deep) {
        for (const a of ui.buttons().filter((x) => /Activate|تفعيل|^W\d+$/.test(x.textContent.trim()) && !SKIP.test(x.textContent)).slice(0, 5)) { ui.click(a); await sleep(120); ui.scan(); }
        const run = ui.buttons().find((x) => /Run the AI agents|تشغيل الوكلاء|تشغيل وكلاء/.test(x.textContent)); if (run) { ui.click(run); await sleep(500); ui.scan(); }
      }
    }
  };
  await visitSubs();   // المجموعة المفتوحة افتراضياً
  for (const g of groups) { const gb = byLabel(g); if (!gb) continue; ui.click(gb); await sleep(150); ui.scan(); await visitSubs(); }
}

async function run(ui, { goLocalRe, runRe, light = false }) {
  await sleep(400); ui.scan();
  { const gl = ui.byText(goLocalRe); if (gl) ui.click(gl); } await sleep(500); ui.scan();
  ui.click(ui.byText(runRe)); await sleep(5000); ui.scan();
  await walk(ui);
  if (light) { const t = ui.byText(/Light|فاتح/); if (t) { ui.click(t); await sleep(250); ui.scan(); await walk(ui, { deep: false }); } }
}

export async function crawlClasses() {
  const all = new Set(); const add = (ui) => ui.classes.forEach((c) => all.add(c));
  // 1) إنجليزي + ثيم فاتح
  let ui = boot(seed({ lang: 'en' })); await run(ui, { goLocalRe: /Continue locally/, runRe: /Run the system and create the plan/, light: true }); add(ui);
  // 2) عربي + حمل زائد (تجاوز طاقة، نقص مواد، صيانة متعددة)
  ui = boot(seed({ base: 60000, rate: 70 })); await run(ui, { goLocalRe: /المتابعة محلياً/, runRe: /تشغيل النظام وإنشاء الخطة/, light: true }); add(ui);
  // 3) المعالج الأول ونافذة خطة جديدة (إنجليزي)
  ui = boot(seed({ lang: 'en', profile: false })); await sleep(400); ui.scan();
  { const gl = ui.byText(/Continue locally/); if (gl) ui.click(gl); } await sleep(600); ui.scan();
  for (let q = 0; q < 3; q++) { const y = ui.buttons().find((x) => /Yes —|We keep safety/.test(x.textContent)); if (!y) break; ui.click(y); await sleep(300); ui.scan(); }
  const no = ui.buttons().find((x) => /^No —|^No —/.test(x.textContent.trim())); void no;
  const st = ui.byText(/Start using the system/); if (st) { ui.click(st); await sleep(500); ui.scan(); }
  const sw = ui.buttons().find((x) => /▾/.test(x.textContent)); if (sw) { ui.click(sw); await sleep(250); ui.scan(); const np = ui.byText(/\+ New plan/); if (np) { ui.click(np); await sleep(400); ui.scan(); } }
  add(ui);
  // 4) وضع السحابة
  ui = boot(seed({ lang: 'en' }), { cloud: true }); await sleep(1800); ui.scan();
  const rn = ui.byText(/Run the system and create the plan/); if (rn) { ui.click(rn); await sleep(5000); ui.scan(); await walk(ui); }
  add(ui);
  // 5) شاشة الدخول (سحابة مُعَدّة بلا جلسة) بالإنجليزية والعربية
  for (const lang of ['en', null]) { ui = boot(seed({ lang }), { cloud: true, noSession: true }); await sleep(1500); ui.scan(); add(ui); }
  return all;
}
