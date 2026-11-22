// إقلاع الصفحة الحقيقية: index.html كاملاً بمحلّل HTML ثم Babel Standalone داخل الصفحة (كما يفعل المتصفح)،
// مع مكتبات CDN محلية بدلاً من الإنترنت. لو انكسر سكربت التطبيق تبقى شاشة التحميل ويفشل هذا الاختبار.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script src="https:\/\/[^"]+"><\/script>/g, '');   // نحمّل المكتبات محلياً
const libs = ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js', '@babel/standalone/babel.min.js'].map((f) => fs.readFileSync(path.join(NM, f), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootPage(lang) {
  const errors = [], vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.detail?.stack || e.message || e).slice(0, 400)));
  const dom = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      libs.forEach((code) => w.eval(code));
      w.XLSX = {}; w.Papa = { parse: () => ({ data: [] }) }; w.print = () => {}; w.fetch = () => Promise.reject(new Error('offline'));
      if (lang) w.localStorage.setItem('cdt:lang', JSON.stringify(lang));
    },
  });
  const w = dom.window;
  for (let i = 0; i < 120; i++) { await sleep(250); if (/Continue locally|المتابعة محلياً/.test(w.document.body.textContent)) break; }
  return { w, errors, text: w.document.body.textContent.replace(/\s+/g, ' ') };
}

test('الصفحة الكاملة تُقلع بالعربية: تختفي شاشة التحميل وتظهر شاشة الدخول', async () => {
  const { w, errors, text } = await bootPage(null);
  assert.match(text, /المتابعة محلياً/, 'التطبيق لم يبدأ — شاشة التحميل ما زالت ظاهرة؟ ' + text.slice(0, 120));
  assert.equal(w.document.getElementById('loading').style.display, 'none', 'شاشة التحميل ما زالت ظاهرة (التطبيق لم يصل لنهاية سكربته)');
  assert.deepEqual(errors, []);
});

test('الصفحة الكاملة تُقلع بالإنجليزية', async () => {
  const { w, text, errors } = await bootPage('en');
  assert.match(text, /Continue locally/); assert.equal(w.document.getElementById('loading').style.display, 'none'); assert.deepEqual(errors, []);
});
