// سلسلة التوريد: كل مكتبة خارجية بإصدار مثبَّت، ومكتبة Supabase (تلمس كلمات المرور) ببصمة SRI تطابق الحزمة الأصلية.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { htmlPath } from './extract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(htmlPath, 'utf8');

test('كل <script src> الخارجية بإصدار مثبَّت (لا @latest ولا نطاقات ولا بلا رقم)', () => {
  const urls = [...html.matchAll(/<script[^>]*\ssrc="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(urls.length >= 6);
  for (const u of urls) assert.match(u, /\d+\.\d+\.\d+/, 'إصدار غير مثبَّت: ' + u);
});

test('Supabase: الإصدار مثبَّت وبصمة SRI تطابق الحزمة الأصلية من npm وتعرّف createClient', () => {
  const m = html.match(/script\.src = "https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@(\d+\.\d+\.\d+)\/dist\/umd\/supabase\.js";\s*\n\s*script\.integrity = "(sha384-[^"]+)";\s*\n\s*script\.crossOrigin = "anonymous";/);
  assert.ok(m, 'تحميل Supabase بإصدار مثبَّت + integrity + crossOrigin');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies['@supabase/supabase-js'], m[1], 'package.json يطابق الإصدار المثبَّت بالصفحة');
  const bundle = fs.readFileSync(path.join(ROOT, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'));
  assert.equal(m[2], 'sha384-' + crypto.createHash('sha384').update(bundle).digest('base64'), 'البصمة تطابق الملف الأصلي');
  const w = new JSDOM('<body></body>', { runScripts: 'outside-only' }).window;
  w.eval(bundle.toString('utf8'));
  assert.equal(typeof w.supabase.createClient, 'function');
});

test('سكربت التطبيق يصل المتصفح كاملاً: لا </script> داخل الكود (كان سيُبقي الصفحة على شاشة التحميل)', async () => {
  const { readAppSource, compileApp } = await import('./extract.mjs');
  const src = readAppSource();
  assert.ok(src.length > 250000, 'طول الكود بعد محلّل HTML: ' + src.length);
  assert.ok(src.includes('function generatePDF') && src.includes('class ErrorBoundary') && /ReactDOM\.createRoot|ReactDOM\.render/.test(src), 'الكود كامل حتى نهايته');
  assert.ok(!/<\/script/i.test(src), 'يوجد </script> داخل نص السكربت');
  // ما يقرؤه محلّل HTML = كل ما بين وسم السكربت وآخر </script> قبل <noscript> (أي لم يُقتطع مبكراً)
  const m = html.match(/<script type="text\/babel"[^>]*>([\s\S]*)<\/script>\s*<noscript>/);
  assert.ok(m, 'بنية الصفحة');
  assert.equal(src, m[1], 'السكربت كما قرأه المتصفح مطابق للمكتوب (لم ينتهِ مبكراً)');
  assert.doesNotThrow(() => compileApp());
});
