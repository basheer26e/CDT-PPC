// يستخرج من index.html كود الواجهة (text/babel) ودوال الحساب النقية بالاسم — بلا الاعتماد على أرقام الأسطر.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import * as standalone from '@babel/standalone';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const appPath = path.join(ROOT, 'src/app.jsx');
export const templatePath = path.join(ROOT, 'src/index.template.html');
export const builtHtmlPath = path.join(ROOT, 'index.html');

export function readAppSource() {
  return fs.readFileSync(appPath, 'utf8');
}

export function compileApp() {
  // نفس مكتبة Babel وإصدارها وإعدادها (data-presets="react") التي تحمّلها الصفحة في المتصفح
  const src = readAppSource();
  return standalone.transform(src, { presets: ['react'], filename: 'app.jsx' }).code;
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
