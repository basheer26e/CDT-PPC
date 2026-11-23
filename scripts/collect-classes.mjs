// يولّد scripts/safelist.json من زحف حقيقي على التطبيق (يُشغَّل عند إضافة واجهات جديدة): node scripts/collect-classes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawlClasses } from '../tests/crawl.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, 'scripts/safelist.json');
const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
const classes = [...(await crawlClasses())].sort();
fs.writeFileSync(file, JSON.stringify({ classes, patterns: cur.patterns }, null, 1) + '\n');
console.log('safelist classes:', classes.length);
process.exit(0);
