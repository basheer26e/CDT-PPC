// إقلاع الصفحة المبنية (index.html) كما يفعل المتصفح: تُحمَّل مكتباتها وapp.js عبر وسوم <script> الحقيقية
// من المستودع نفسه (محمّل موارد محلي). لو انكسر أي ملف تبقى شاشة التحميل ويفشل الاختبار.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole, ResourceLoader } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Local extends ResourceLoader {
  constructor(blocked = []) { super(); this.blocked = blocked; this.loaded = []; }
  fetch(url) {
    const rel = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    if (this.blocked.some((b) => rel.includes(b))) return Promise.reject(new Error('blocked: ' + rel));   // يحاكي CDN محجوباً/شبكة بطيئة
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) return Promise.reject(new Error('404: ' + rel));
    this.loaded.push(rel); return Promise.resolve(fs.readFileSync(file));
  }
}

async function bootPage({ lang, blocked = [], waitFor = /Continue locally|المتابعة محلياً/ } = {}) {
  const errors = [], vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.detail?.stack || e.message || e).slice(0, 400)));
  const loader = new Local(blocked);
  const dom = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'dangerously', resources: loader, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.print = () => {}; w.fetch = () => Promise.reject(new Error('offline')); if (lang) w.localStorage.setItem('cdt:lang', JSON.stringify(lang)); },
  });
  const w = dom.window;
  for (let i = 0; i < 80; i++) { await sleep(150); if (waitFor.test(w.document.body.textContent)) break; }
  return { w, errors, loader, text: w.document.body.textContent.replace(/\s+/g, ' ') };
}

test('الصفحة المبنية تُقلع بالعربية: تختفي شاشة التحميل وتظهر شاشة الدخول (بلا Babel وبلا CDN)', async () => {
  const { w, errors, text, loader } = await bootPage();
  assert.match(text, /المتابعة محلياً/, 'التطبيق لم يبدأ: ' + text.slice(0, 120));
  assert.equal(w.document.getElementById('loading').style.display, 'none');
  assert.deepEqual(errors, []);
  assert.ok(loader.loaded.some((f) => f.startsWith('assets/app.js')) && loader.loaded.some((f) => f.includes('react-18.2.0')), 'حُمّلت الملفات المحلية: ' + loader.loaded.join(', '));
  assert.equal(typeof w.XLSX?.read, 'function', 'xlsx (defer) جاهز'); assert.equal(typeof w.Papa?.parse, 'function', 'papaparse (defer) جاهز');
});

test('الصفحة المبنية تُقلع بالإنجليزية', async () => {
  const { w, text, errors } = await bootPage({ lang: 'en', waitFor: /Continue locally/ });
  assert.match(text, /Continue locally/); assert.equal(w.document.getElementById('loading').style.display, 'none'); assert.deepEqual(errors, []);
});

test('فشل تحميل ملف يُظهر رسالة واضحة بدل شاشة تحميل صامتة', async () => {
  for (const blocked of ['assets/app.js', 'react-18.2.0']) {
    const { w } = await bootPage({ blocked: [blocked], waitFor: /Failed to load/ });
    const box = w.document.getElementById('loading');
    assert.notEqual(box.style.display, 'none');
    assert.match(box.textContent, /Failed to load: .*/, 'رسالة الفشل عند حجب ' + blocked + ' — ' + box.textContent.slice(0, 100));
    assert.ok(box.textContent.includes(blocked.includes('app') ? 'assets/app.js' : 'react-18.2.0'));
    assert.ok(box.querySelector('button.reset-btn'), 'زر مسح البيانات');
  }
});
