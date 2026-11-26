// يبني الموقع الجاهز للنشر من المصدر:
//   src/app.jsx + src/index.template.html  →  index.html + assets/app.js + assets/tailwind.css + vendor/*
// بلا Babel بالمتصفح (الترجمة هنا) وبلا CDN (كل المكتبات من المستودع نفسه) وبلا Tailwind JIT بالمتصفح (CSS مبني مسبقاً).
// التشغيل:  npm run build            (يكتب بجذر المستودع)
//           node scripts/build.mjs --out DIR   (لمقارنة أو اختبار)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as standalone from '@babel/standalone';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : ROOT;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ver = (name) => pkg.devDependencies[name];
const VENDOR = [
  { out: `react-${ver('react')}.production.min.js`, from: 'react/umd/react.production.min.js', defer: false },
  { out: `react-dom-${ver('react-dom')}.production.min.js`, from: 'react-dom/umd/react-dom.production.min.js', defer: false },
  // مكتبتا Excel/CSV لا تُستخدمان إلا عند ضغط المستخدم على الاستيراد → defer (لا تؤخّر ظهور الصفحة)
  { out: `xlsx-${ver('xlsx')}.full.min.js`, from: 'xlsx/dist/xlsx.full.min.js', defer: true },
  { out: `papaparse-${ver('papaparse')}.min.js`, from: 'papaparse/papaparse.min.js', defer: true },
];
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);

// 1) ترجمة JSX → JS (نفس مكتبة Babel وإعدادها التي كانت الصفحة تحمّلها بالمتصفح)
const appSrc = fs.readFileSync(path.join(ROOT, 'src/app.jsx'), 'utf8');
const js = '/* CDT-PPC — ملف مُولَّد من src/app.jsx بـ npm run build — لا تعدّليه يدوياً */\n' + standalone.transform(appSrc, { presets: ['react'], filename: 'app.jsx' }).code + '\n';

// 2) CSS لـTailwind: نفس إصدار الـCDN المستخدم سابقاً (3.4.17) لكن مبني مسبقاً للأصناف المستخدمة فقط
const tplPath = path.join(ROOT, 'src/index.template.html');
const safelist = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/safelist.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt-tw-'));
const cfgPath = path.join(tmp, 'tailwind.config.cjs'), inPath = path.join(tmp, 'in.css'), outCss = path.join(tmp, 'out.css');
fs.writeFileSync(cfgPath, `module.exports = ${JSON.stringify({ content: [path.join(ROOT, 'src/app.jsx'), tplPath] })};
module.exports.safelist = [...${JSON.stringify(safelist.classes)}, ...${JSON.stringify(safelist.patterns)}.map((p) => ({ pattern: new RegExp(p) }))];`);
fs.writeFileSync(inPath, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
execFileSync(process.execPath, [require.resolve('tailwindcss/lib/cli.js'), '-c', cfgPath, '-i', inPath, '-o', outCss, '--minify'], { cwd: tmp, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, BROWSERSLIST_IGNORE_OLD_DATA: '1' } });
const css = fs.readFileSync(outCss, 'utf8');
fs.rmSync(tmp, { recursive: true, force: true });

// 3) تجميع الصفحة
const jsHash = sha(js), cssHash = sha(css);
let html = fs.readFileSync(tplPath, 'utf8');
const need = ['<!--CSS-->', '<!--VENDOR-->', '<!--APP-->'];
for (const m of need) if (html.split(m).length !== 2) throw new Error('علامة القالب مفقودة أو مكررة: ' + m);
html = html.replace('<!--CSS-->', `<link rel="stylesheet" href="assets/tailwind.css?v=${cssHash}">`)
  .replace('<!--VENDOR-->', VENDOR.map((v) => `<script ${v.defer ? 'defer ' : ''}src="vendor/${v.out}"></script>`).join('\n'))
  .replace('<!--APP-->', `<script src="assets/app.js?v=${jsHash}"></script>`);

// 3ب) نسخة مستقلة بملف واحد (للعرض والمشاركة بلا إنترنت ولا استضافة): كل شيء مضمَّن داخل HTML.
//     escape: </script داخل الكود المضمَّن كان سيُنهي السكربت مبكراً بالمتصفح، و<!-- قد يغيّر حالة محلّل HTML.
const inline = (code) => code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const standalone1 = fs.readFileSync(tplPath, 'utf8')
  .replace('<!--CSS-->', () => `<style>\n${css}\n</style>`)
  .replace('<!--VENDOR-->', () => VENDOR.map((v) => `<script>\n${inline(fs.readFileSync(path.join(ROOT, 'node_modules', v.from), 'utf8'))}\n</script>`).join('\n'))
  .replace('<!--APP-->', () => `<script>\n${inline(js)}\n</script>`);

// 4) الكتابة
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
for (const f of fs.readdirSync(path.join(OUT, 'vendor'))) if (!VENDOR.some((v) => v.out === f)) fs.rmSync(path.join(OUT, 'vendor', f));
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.mkdirSync(path.join(OUT, 'downloads'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'downloads/CDT-PPC-offline.html'), standalone1);
fs.writeFileSync(path.join(OUT, 'assets/app.js'), js);
fs.writeFileSync(path.join(OUT, 'assets/tailwind.css'), css);
for (const v of VENDOR) fs.copyFileSync(path.join(ROOT, 'node_modules', v.from), path.join(OUT, 'vendor', v.out));
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`built → ${OUT}\n  index.html ${kb(html.length)} | assets/app.js ${kb(js.length)} (v=${jsHash}) | assets/tailwind.css ${kb(css.length)} (v=${cssHash}) | vendor ${VENDOR.length} files | downloads/CDT-PPC-offline.html ${kb(standalone1.length)}`);
