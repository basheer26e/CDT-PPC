// يستخرج من index.html كود الواجهة (text/babel) ودوال الحساب النقية بالاسم — بلا الاعتماد على أرقام الأسطر.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import babel from '@babel/core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const htmlPath = path.join(ROOT, 'index.html');

export function readAppSource() {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>\s*\n\s*<noscript>/);
  if (!m) throw new Error('لم أجد <script type="text/babel"> في index.html');
  return m[1];
}

export function compileApp() {
  const src = readAppSource();
  return babel.transformSync(src, { presets: [['@babel/preset-react', { runtime: 'classic' }]], filename: 'app.jsx' }).code;
}

const LOGIC = new Set(`DEFAULT_WEEKS DEMAND_HIGH_UTIL mkDemand mkBOM mkInventory mkCapacity mkFGIConfig mkEngineMaint seededRandom
calcMPS addDays weekRange srForWeek calcEOQ calcMRP computeMaterialCaps levelProduction runFullSimulation calcEngineMaintenance
calcPostPlan calcNextMonthRec calcRunToFailure numOr calcCosts calcFeasibility computeCapacityOverlaps
normalizeName reconcileInventory autoRepairInventory parseAgentJSON normalizeInventoryRow mapExcelRowsToCapacity mapExcelRowsToEngine
mapExcelRowsToFGI __LANG __t __tf callClaudeDirect callAIProviderViaProxy callAIProvider fetchOrgData pushNewProductToCloud syncBomToCloud syncCapacityToCloud`.split(/\s+/));

export function loadLogic() {
  const src = readAppSource();
  const ast = parse(src, { sourceType: 'script', plugins: ['jsx'] });
  const parts = [], names = [];
  for (const node of ast.program.body) {
    let name = null;
    if (node.type === 'FunctionDeclaration') name = node.id.name;
    else if (node.type === 'VariableDeclaration' && node.declarations.length === 1 && node.declarations[0].id.type === 'Identifier') name = node.declarations[0].id.name;
    if (name && LOGIC.has(name)) { parts.push(src.slice(node.start, node.end)); names.push(name); }
  }
  const missing = [...LOGIC].filter((n) => !names.includes(n));
  if (missing.length) throw new Error('دوال لم تُستخرج: ' + missing.join(', '));
  const factory = new Function('fetch', parts.join('\n') + `\nreturn { ${names.join(', ')} };`);
  return (fetchImpl) => factory(fetchImpl || globalThis.fetch);
}
