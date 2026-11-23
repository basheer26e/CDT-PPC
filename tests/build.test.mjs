// الموقع المبني: محدَّث، بلا أي مورد خارجي، شاشة التحميل أول ما يُرسم، وكل صنف CSS مستخدم له قاعدة.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { parse } from '@babel/parser';
import { crawlClasses } from './crawl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const buildTo = (dir) => execFileSync(process.execPath, [path.join(ROOT, 'scripts/build.mjs'), '--out', dir], { cwd: ROOT, stdio: 'pipe' });
const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name))]);

test('الملفات المبنية بالمستودع محدَّثة: لا تغيير بـsrc بدون npm run build', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt-build-'));
  buildTo(tmp);
  const files = [...walk(tmp)].sort();
  assert.ok(files.includes('index.html') && files.includes('assets/app.js') && files.includes('assets/tailwind.css'));
  for (const f of files) assert.ok(fs.readFileSync(path.join(tmp, f)).equals(fs.readFileSync(path.join(ROOT, f))), `${f} قديم — شغّل: npm run build`);
  const extra = walk(path.join(ROOT, 'vendor')).filter((f) => !files.includes('vendor/' + f));
  assert.deepEqual(extra, [], 'ملفات vendor زائدة');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('بنية الصفحة: بلا مورد خارجي، ولا سكربت يحجب الرسم بالرأس، وشاشة التحميل قبل أي سكربت', () => {
  const html = read('index.html'); const doc = new JSDOM(html).window.document;
  const urls = [...doc.querySelectorAll('script[src],link[href]')].map((e) => e.getAttribute('src') || e.getAttribute('href'));
  assert.ok(urls.length >= 6, 'الموارد: ' + urls.join(' | '));
  for (const u of urls) assert.ok(!/^(https?:)?\/\//.test(u), 'مورد خارجي: ' + u);
  assert.equal(doc.head.querySelectorAll('script').length, 0, 'لا سكربتات بالرأس تحجب الرسم');
  const pos = (el) => html.indexOf(el);
  assert.ok(pos('id="loading"') > 0 && pos('id="loading"') < pos('<script'), 'شاشة التحميل قبل أول سكربت');
  assert.ok(!/babel/i.test(html), 'لا Babel بالمتصفح');
  const pkg = JSON.parse(read('package.json'));
  for (const [lib, dep] of [['react-', 'react'], ['react-dom-', 'react-dom'], ['xlsx-', 'xlsx'], ['papaparse-', 'papaparse']]) assert.ok(urls.some((u) => u.includes(`vendor/${lib}${pkg.devDependencies[dep]}`)), `${dep} بإصدار package.json`);
  for (const u of urls) { const f = u.split('?')[0]; assert.ok(fs.existsSync(path.join(ROOT, f)), 'ملف مفقود: ' + f); }
  for (const s of doc.querySelectorAll('script[src*="vendor/xlsx"],script[src*="vendor/papaparse"]')) assert.ok(s.hasAttribute('defer'), 'مكتبات Excel/CSV بـdefer');
});

test('assets/app.js: صالح نحوياً، بلا </script> ولا JSX خام ولا Babel', () => {
  const js = read('assets/app.js');
  assert.doesNotThrow(() => parse(js, { sourceType: 'script' }), 'JS صالح (بلا JSX)');
  assert.ok(!/<\/script/i.test(js)); assert.ok(js.includes('React.createElement'));
});

test('تغطية التنسيق: كل صنف CSS يظهر بالواجهة (كل الحالات) له قاعدة بـtailwind.css أو بنمط الصفحة', async () => {
  const css = read('assets/tailwind.css') + [...read('src/index.template.html').matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('');
  const esc = (t) => t.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  const has = (t) => css.includes('.' + esc(t)) || (/^\d/.test(t) && css.includes('.\\3' + t[0] + ' ' + esc(t.slice(1))));
  const used = await crawlClasses();
  assert.ok(used.size > 250, 'عدد الأصناف المرصودة: ' + used.size);
  const missing = [...used].filter((t) => !has(t));
  assert.deepEqual(missing, [], 'أصناف بلا CSS (أضيفيها لـscripts/safelist.json أو شغّل node scripts/collect-classes.mjs): ' + missing.join(' '));
});
