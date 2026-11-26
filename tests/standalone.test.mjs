// النسخة المستقلة (downloads/CDT-PPC-offline.html): ملف واحد يعمل بلا إنترنت ولا استضافة ولا VPN.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'downloads/CDT-PPC-offline.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(lang) {
  const errors = [], vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.detail?.stack || e.message || e).slice(0, 300)));
  // بلا محمّل موارد (resources): لو احتاجت الصفحة أي ملف خارجي لفشلت
  const dom = new JSDOM(html, { url: 'http://localhost/CDT-PPC-offline.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.print = () => {}; w.fetch = () => Promise.reject(new Error('offline')); if (lang) w.localStorage.setItem('cdt:lang', JSON.stringify(lang)); } });
  const w = dom.window;
  for (let i = 0; i < 80; i++) { await sleep(150); if (/Before we start|قبل ما نبدأ/.test(w.document.body.textContent)) break; }
  return { w, dom, errors, text: w.document.body.textContent.replace(/\s+/g, ' ') };
}

test('الملف المستقل: بلا أي مورد خارجي وبنية السكربتات سليمة (لم يُقتطع أي سكربت)', () => {
  const doc = new JSDOM(html).window.document;
  assert.deepEqual([...doc.querySelectorAll('script[src],link[href]')].map((e) => e.getAttribute('src') || e.getAttribute('href')), [], 'موارد خارجية');
  assert.equal(doc.querySelectorAll('script').length, 6, 'سكربت مبكر + 4 مكتبات + التطبيق');
  assert.ok(doc.querySelector('style').textContent.length > 20000, 'CSS مضمَّن');
  assert.ok(doc.querySelector('#loading'), 'شاشة التحميل');
  assert.ok(html.length > 1_000_000 && html.length < 3_000_000, 'الحجم: ' + html.length);
});

test('الملف المستقل يُقلع بالعربية بلا أخطاء ولا شبكة، وتجهز مكتبتا Excel وCSV', async () => {
  const { w, errors, text } = await boot();
  assert.match(text, /قبل ما نبدأ/, 'التطبيق لم يبدأ: ' + text.slice(0, 100));
  assert.equal(w.document.getElementById('loading').style.display, 'none');
  assert.equal(typeof w.XLSX?.read, 'function'); assert.equal(typeof w.Papa?.parse, 'function');
  assert.deepEqual(errors, []);
});

test('الملف المستقل يُقلع بالإنجليزية', async () => {
  const { w, text, errors } = await boot('en');
  assert.match(text, /Before we start/);
  const app = w.document.getElementById('root').textContent.replace(/\s+/g, ' ');   // شاشة التحميل الثابتة (مخفية بعد الإقلاع) ثنائية اللغة عمداً
  assert.ok(!/[\u0600-\u06FF]/.test(app), 'عربي بالإنجليزية: ' + (app.match(/.{20}[\u0600-\u06FF]+.{20}/) || [''])[0]);
  assert.deepEqual(errors, []);
});
