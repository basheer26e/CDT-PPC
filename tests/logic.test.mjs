// اختبارات منطق التخطيط (MPS / MRP / الصيانة / ما-لو / الذكاء الاصطناعي) على الكود الفعلي داخل index.html
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLogic } from './extract.mjs';

const L = loadLogic()();
const near = (a, b, e = 1) => Math.abs(a - b) <= e;
const START = '2026-11-23';
const costs = { perUnit: 1, workerShiftCost: 50, otHourRate: 20, holdingPct: 0.5, orderCost: 100 };
const demand = L.mkDemand(12, 120000);
const cap = { ...L.mkCapacity(), productionRate: 120, shiftHours: 8, normalDays: 6, maxShifts: 3, defectRateMin: 2, defectRateMax: 2 };
const fgi = { current: 5000, safety: 3000, maxWarehouse: 100000, mode: 'hybrid' };
const bom = [{ id: 'm1', name: 'Milk', qty: 2, unit: 'kg' }, { id: 'm2', name: 'Pack', qty: 1, unit: 'pc' }, { id: 'm3', name: 'Lid', qty: 1, unit: 'pc' }];
const inventory = [
  { id: 'm1', name: 'Milk', unit: 'kg', available: 60000, safety: 2000, leadTime: 2, maxCapacity: 5e5, unitCost: 2 },
  { id: 'm2', name: 'Pack', unit: 'pc', available: 15000, safety: 500, leadTime: 4, maxCapacity: 5e5, unitCost: 0.5 },   // مخزون قليل + توريد طويل → فات الأوان
  { id: 'm3', name: 'Lid', unit: 'pc', available: 2e5, safety: 1000, leadTime: 1, maxCapacity: 5e5, unitCost: 0.1 },
];
const rich = inventory.map(i => ({ ...i, available: 9e6, leadTime: 1 }));
const eng = { intervalHours: 3000, durationHours: 8, remainingHours: 150 };
const sim = (o = {}) => L.runFullSimulation({ demand, cap, fgiConfig: fgi, bom, inventory, engineMaintCfg: eng, poLog: [], planStartDate: START, costs, ...o });

// ───────────── الأساسيات ─────────────
test('MPS: توازن FGI، الحمل ≤ المتاح، good+scrap=production', () => {
  const mps = L.calcMPS(demand, cap, fgi);
  assert.equal(mps.length, 12);
  let fg = fgi.current;
  for (const m of mps) {
    fg = Math.max(0, fg + m.goodUnits - m.demand); assert.equal(m.fgAfter, fg);
    assert.equal(m.goodUnits + m.scrapUnits, m.production);
    if (m.feasible) assert.ok(m.loadH <= m.availH + 1e-6);
  }
});

test('MRP: ending = available − gross + order، ويُكتشف فات الأوان', () => {
  const mrp = L.calcMRP(L.calcMPS(demand, cap, fgi), bom, inventory, [], START, costs);
  for (const mat of mrp) for (const w of mat.weeks) assert.ok(near(w.available - w.gross + w.order, w.ending, 2), `${mat.name} ${w.week}`);
  assert.ok(mrp.find(m => m.id === 'm2').weeks.some(w => w.tooLateToOrder), 'Pack: فات الأوان مُكتشَف');
});

test('الإنتاج يُقيَّد بالمادة ولا يبقى مخزون مادة سالب', () => {
  const r = sim();
  assert.ok(r.anyMaterialConstraint); assert.ok(r.mps.some(m => m.materialConstrained));
  assert.equal(r.mrp.flatMap(m => m.weeks).filter(w => w.ending < 0).length, 0);
});

test('طلبات الشراء المؤكدة SR: تأخير يُجمَّع بالأسبوع 1، received يُتجاهل، ما بعد الأفق يُتجاهل', () => {
  const po = [
    { materialId: 'm2', status: 'pending', qty: 30000, arrivalDate: '2026-11-01' },
    { materialId: 'm2', status: 'pending', qty: 5000, arrivalDate: '2026-12-10' },
    { materialId: 'm2', status: 'received', qty: 99999, arrivalDate: '2026-12-10' },
    { materialId: 'm2', status: 'pending', qty: 777, arrivalDate: '2027-06-01' },
  ];
  assert.equal(L.srForWeek(po, 'm2', START, 0), 30000);
  assert.equal([...Array(12).keys()].reduce((s, w) => s + L.srForWeek(po, 'm2', START, w), 0), 35000);
});

test('التكاليف والجدوى: مجاميع صحيحة ودرجة 0-100', () => {
  const r = sim();
  const c = L.calcCosts(r.mps, r.mrp, costs, cap);
  assert.ok(near(c.total, c.prodCost + c.laborCost + c.otCost + c.holdCost + c.orderCost, 1));
  assert.ok(near(c.breakdown.reduce((s, b) => s + b.pct, 0), 100, 0.01));
  const so = r.mrp.flatMap(m => m.weeks.filter(w => w.stockout));
  const f = L.calcFeasibility(r.mps, r.mrp, so, r.mps.filter(m => !m.feasible).length, r.mps.filter(m => m.otDaysUsed > 0).length,
    +(r.mps.reduce((s, m) => s + m.util, 0) / r.mps.length).toFixed(1), r.mps.filter(m => m.fgBelowSafety).length, r.engineResult, false, r.anyMaterialConstraint);
  assert.ok(f.score >= 0 && f.score <= 100);
});

test('الذكاء الاصطناعي: تحليل JSON والمقترحات', () => {
  const j = L.parseAgentJSON('```json\n{"data_reviewed":"a","rules_applied":"b","reasoning":"c","recommendation":"d","suggestion":{"param":"normalDays","newValue":"7","why":"x"}}\n```');
  assert.equal(j.recommendation, 'd'); assert.equal(j.suggestion.newValue, 7);
  assert.equal(L.parseAgentJSON('نص حر').recommendation, 'نص حر');
  assert.equal(L.parseAgentJSON('{"recommendation":"x","suggestion":{"param":"a","newValue":"abc"}}').suggestion, null);
});

// ───────────── فات أوان الطلب: لا طلب وهمي ولا ازدواج احتساب ─────────────
test('فات أوان الطلب: order=0 وunmetNeed>0، والطلب الحقيقي اللاحق يغطّي العجز', () => {
  const mrp = L.calcMRP(L.calcMPS(demand, cap, fgi), bom, inventory, [], START, costs);
  const pack = mrp.find(m => m.id === 'm2').weeks;
  const late = pack.filter(w => w.tooLateToOrder);
  assert.ok(late.length >= 2, 'سيناريو الاختبار يحوي أسابيع فات أوان');
  for (const w of late) { assert.equal(w.order, 0, `${w.week}: لا طلب صالح`); assert.ok(w.unmetNeed > 0); assert.ok(!w.usedEOQ && !w.capacityConstrained); }
  const firstOk = pack.find((w, i) => i >= 4);   // أول أسبوع بعد مدة التوريد (4)
  assert.ok(firstOk.order > 0, 'الطلب الحقيقي يُطلَب هنا ويغطّي العجز المتراكم');
  assert.ok(firstOk.ending >= 500 - 1 || firstOk.capacityConstrained, 'المخزون يعود لمستوى الأمان');
  for (const mat of mrp) for (const w of mat.weeks) if (!w.tooLateToOrder) assert.equal(w.unmetNeed, 0);
});

test('حفظ الكميات: مخزون النهاية = البداية + المؤكد − المستهلك + الطلبات (بلا ازدواج)', () => {
  for (const mps of [L.calcMPS(demand, cap, fgi), sim().mps]) {
    const mrp = L.calcMRP(mps, bom, inventory, [], START, costs);
    for (const mat of mrp) {
      const sumG = mat.weeks.reduce((s, w) => s + w.gross, 0), sumO = mat.weeks.reduce((s, w) => s + w.order, 0), sumSR = mat.weeks.reduce((s, w) => s + w.sr, 0);
      assert.ok(near(mat.weeks.at(-1).ending, mat.inv.available + sumSR - sumG + sumO, 24), `${mat.name}`);
    }
  }
  const mrp = L.calcMRP(L.calcMPS(demand, cap, fgi), bom, inventory, [], START, costs);
  const pp = L.calcPostPlan(inventory, mrp);
  for (const it of pp) assert.equal(it.totalOrdered, mrp.find(m => m.id === it.id).weeks.reduce((s, w) => s + w.order, 0));
});

test('تكلفة الطلبيات لا تحتسب أسابيع فات الأوان', () => {
  const r = sim({ cap: { ...cap, productionRate: 90 } });
  const mrp = L.calcMRP(L.calcMPS(demand, cap, fgi), bom, inventory, [], START, costs);
  const c = L.calcCosts(L.calcMPS(demand, cap, fgi), mrp, costs, cap);
  const real = mrp.reduce((s, m) => s + m.weeks.filter(w => w.order > 0).length, 0);
  assert.equal(c.orderCost, real * costs.orderCost);
  assert.ok(mrp.flatMap(m => m.weeks).some(w => w.tooLateToOrder), 'السيناريو يحوي فات أوان'); void r;
});

// ───────────── ما-لو = نفس المحرك ─────────────
test('ما-لو بدون أي تغيير يطابق الخطة الأساسية تماماً (بما فيها الصيانة وقيود المواد وسعة التخزين)', () => {
  const caps = inventory.map(i => ({ ...i, maxCapacity: i.id === 'm1' ? 90000 : i.maxCapacity }));
  for (const [label, o] of [['قيد مادة + صيانة', {}], ['مخزون وفير', { inventory: rich }], ['سعة تخزين محدودة', { inventory: caps }], ['تسوية', { cap: { ...cap, productionRate: 100, levelProduction: true }, inventory: rich }]]) {
    const base = sim(o), wi = sim({ ...o, rateFactors: {}, supplierDelays: {} });
    assert.deepEqual(wi.mps, base.mps, label + ': MPS'); assert.deepEqual(wi.mrp, base.mrp, label + ': MRP'); assert.deepEqual(wi.engineResult, base.engineResult, label + ': صيانة');
  }
});

test('ما-لو: عطل جزئي بأسبوع يرفع الحمل ويُعلَّم، وتأخير مورد يطيل مدة التوريد الفعلية', () => {
  const base = sim({ inventory: rich });
  const down = sim({ inventory: rich, rateFactors: { W3: 0.5 } });
  const b = base.mps[2], d = down.mps[2];
  assert.ok(d.machineDown && !b.machineDown);
  assert.ok(near(d.loadH, b.loadH * 2, 0.3), `الحمل ${b.loadH} → ${d.loadH}`);
  assert.deepEqual(down.mps.filter(m => m.machineDown).map(m => m.week), ['W3']);
  const delayed = sim({ supplierDelays: { m1: 3 } });
  assert.equal(delayed.mrp.find(m => m.id === 'm1').inv.leadTime, inventory[0].leadTime + 3);
  const lateBase = sim().mrp.find(m => m.id === 'm1').weeks.filter(w => w.tooLateToOrder).length;
  assert.ok(delayed.mrp.find(m => m.id === 'm1').weeks.filter(w => w.tooLateToOrder).length >= lateBase);
});

test('ما-لو لا ينهار لو مادة BOM بلا سجل مخزون', () => {
  assert.doesNotThrow(() => sim({ bom: [...bom, { id: 'zz', name: 'New', qty: 1, unit: 'kg' }], supplierDelays: { zz: 2 } }));
});

// ───────────── الصيانة ─────────────
test('الصيانة: لا خصم مزدوج ولا تحذير كاذب، وأسبوعها ثابت بعد تقييد المادة', () => {
  for (const remaining of [150, 60, 20]) {
    const r = sim({ inventory: rich, engineMaintCfg: { ...eng, remainingHours: remaining } });
    for (const m of r.engineResult.maintenances) {
      const wk = r.mps.find(x => x.week === m.week);
      assert.ok(wk.maintenanceWeek); assert.ok(near(m.netAvailH, wk.availH, 0.2));
      if (wk.loadH <= wk.availH) assert.ok(m.feasibleWithMaint);
    }
  }
  const c = sim();
  assert.deepEqual(c.mps.filter(m => m.maintenanceWeek).map(m => m.week), c.engineResult.maintenanceWeeks);
});

test('الصيانة: تُجدوَل كل المواعيد بالخطة الطويلة (وليس أولها فقط)', () => {
  const cfg = { intervalHours: 100, durationHours: 8, remainingHours: 30 };
  const r = sim({ inventory: rich, engineMaintCfg: cfg });
  const totalLoad = r.mps.reduce((s, m) => s + m.loadH, 0);
  const expected = Math.floor((cfg.intervalHours - cfg.remainingHours + totalLoad) / cfg.intervalHours);
  assert.ok(expected >= 5, 'السيناريو يتطلب عدة صيانات: ' + expected);
  assert.equal(r.engineResult.maintenanceCount, expected);
  assert.equal(r.engineResult.maintenanceWeeks.length, new Set(r.engineResult.maintenanceWeeks).size);
  for (const m of r.engineResult.maintenances) assert.equal(r.mps.find(x => x.week === m.week).maintHours, m.count * cfg.durationHours, 'الساعات المخصومة = عدد الصيانات × المدة');
  assert.ok(r.engineResult.postPlanRemaining >= 0 && r.engineResult.postPlanRemaining <= cfg.intervalHours);
  assert.match(r.engineResult.alert, /مرات/);
});

test('الصيانة: بلا صيانة تبقى النتيجة كما كانت، وcalcMPS ما زال يقبل كائن صيانة واحداً (توافق)', () => {
  const r = sim({ inventory: rich, engineMaintCfg: { intervalHours: 1e9, durationHours: 0, remainingHours: 1e9 } });
  assert.equal(r.engineResult.maintenanceDone, false); assert.deepEqual(r.engineResult.maintenanceWeeks, []);
  const m = L.calcMPS(demand, cap, fgi, { week: 'W2', hours: 8 });
  assert.ok(m[1].maintenanceWeek && m[1].maintHours === 8 && !m[0].maintenanceWeek);
});

// ───────────── مدة التوريد صفر ومعدل الإنتاج صفر ─────────────
test('مدة التوريد 0 تبقى 0 بالاستيراد والتطبيع والمزامنة السحابية', async () => {
  assert.equal(L.numOr(0, 3), 0); assert.equal(L.numOr('', 3), 3); assert.equal(L.numOr(undefined, 3), 3); assert.equal(L.numOr('abc', 3), 3); assert.equal(L.numOr('4', 3), 4);
  assert.equal(L.reconcileInventory([{ name: 'Milk', available: 5, safety: 1, leadTime: 0, maxCapacity: 100 }], [bom[0]], [inventory[0]]).inventory[0].leadTime, 0);
  assert.equal(L.normalizeInventoryRow({ name: 'Milk', leadTime: 0, available: 1 }).leadTime, 0);
  assert.equal(L.normalizeInventoryRow({ name: 'Milk', available: 1 }).leadTime, 3);
  let row = null;
  const client = { from: () => ({ upsert: async (rows) => { row = rows[0]; return { error: null }; } }) };
  await L.syncBomToCloud(client, 'o', 'p', [bom[0]], [{ id: 'm1', available: 1, safety: 0, leadTime: 0, maxCapacity: 10 }]);
  assert.equal(row.lead_time_weeks, 0);
});

test('معدل إنتاج صفر وعطل أكبر من الطاقة: قيم محدودة وخطة غير مجدولة (لا Infinity)', () => {
  const r = sim({ cap: { ...cap, productionRate: 0 }, inventory: rich });
  assert.ok(r.mps.every(m => [m.loadH, m.util, m.availH].every(Number.isFinite)));
  assert.ok(r.mps.some(m => !m.feasible), 'تُعلَّم أسابيع غير مجدولة');
  const rtf = L.calcRunToFailure(sim({ inventory: rich }).mps, 'W1', 99999);
  assert.ok(Number.isFinite(rtf.newUtil));
});

// ───────────── اختبارات الانحدار القديمة ─────────────
test('استيراد المخزون يحافظ على unitCost', () => {
  assert.equal(L.reconcileInventory([{ name: 'Milk', available: 5, safety: 1, leadTime: 2, maxCapacity: 100 }], [bom[0]], [inventory[0]]).inventory[0].unitCost, 2);
});

test('مسار Claude يمرّر الـprompt ويستخدم نموذجاً حالياً', async () => {
  let body = null;
  const L2 = loadLogic()(async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ content: [{ text: 'ok' }] }), text: async () => '' }; });
  await L2.callAIProvider({ provider: 'claude', claude: 'sk-ant-test' }, 'PROMPT-123');
  assert.equal(body.messages[0].content, 'PROMPT-123');
  assert.ok(!/claude-3-5-sonnet-20241022/.test(body.model));
});

// ───────────── اختبار عشوائي: 3000 سيناريو (يشمل عطل الآلة وتأخير الموردين وصيانات متعددة) ─────────────
test('عشوائي: ثوابت MPS/MRP/التسوية/الصيانة/ما-لو عبر 3000 سيناريو', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const ri = (a, b) => Math.floor(a + rnd() * (b - a + 1)), rf = (a, b) => a + rnd() * (b - a);
  let smoothed = 0, maint = 0, multi = 0, downs = 0, delays = 0;
  for (let t = 0; t < 3000; t++) {
    const weeks = ri(4, 16), base = ri(3000, 20000);
    const dem = Array.from({ length: weeks }, (_, i) => ({ week: `W${i + 1}`, qty: Math.max(0, Math.round(base * rf(0.5, 1.6))) }));
    const c = { productionRate: ri(60, 200), shiftHours: ri(6, 10), normalDays: ri(4, 6), maxShifts: ri(1, 3), defectRateMin: rf(0.5, 2), defectRateMax: rf(2, 5), minimizeIdleDays: rnd() < 0.8, levelProduction: rnd() < 0.5, levelingThresholdPct: 35 };
    const f = rnd() < 0.9 ? { current: ri(0, 60000), safety: ri(1000, 12000), maxWarehouse: 2e5, mode: ['hybrid', 'pull', 'push'][ri(0, 2)] } : null;
    const b = Array.from({ length: ri(1, 4) }, (_, i) => ({ id: 'm' + i, name: 'M' + i, qty: +rf(0.3, 3).toFixed(2), unit: 'kg' }));
    const richInv = rnd() < 0.35;
    const inv = b.map(x => ({ id: x.id, name: x.name, unit: 'kg', available: richInv ? 1e8 : ri(0, base * weeks * 1.2), safety: ri(0, 3000), leadTime: ri(0, 5), maxCapacity: rnd() < 0.25 ? ri(20000, 150000) : 1e9, unitCost: 1 }));
    const e = { intervalHours: ri(150, 4000), durationHours: ri(4, 24), remainingHours: ri(20, 1500) };
    const rateFactors = rnd() < 0.33 ? Object.fromEntries(dem.filter(() => rnd() < 0.3).map(d => [d.week, 1 - ri(1, 9) / 10])) : null;
    const supplierDelays = rnd() < 0.33 ? Object.fromEntries(b.filter(() => rnd() < 0.5).map(x => [x.id, ri(1, 4)])) : null;
    if (rateFactors && Object.keys(rateFactors).length) downs++; if (supplierDelays && Object.keys(supplierDelays).length) delays++;
    const r = L.runFullSimulation({ demand: dem, cap: c, fgiConfig: f, bom: b, inventory: inv, engineMaintCfg: e, poLog: [], planStartDate: START, costs, rateFactors, supplierDelays });
    if (r.mps.some(m => m.smoothed)) smoothed++;
    for (const m of r.mps) {
      assert.ok([m.production, m.goodUnits, m.loadH, m.availH, m.util].every(Number.isFinite), 'NaN/Infinity');
      assert.equal(m.goodUnits + m.scrapUnits, m.production);
      if (m.feasible) assert.ok(m.loadH <= m.availH + 0.06, `${m.week}: load ${m.loadH} > avail ${m.availH}`);
      if (m.smoothed) assert.ok(!m.machineDown, 'لا تسوية بأسبوع عطل');
      assert.equal(m.machineDown, !!(rateFactors && rateFactors[m.week] < 1));
    }
    if (f) { let fg = f.current; for (const m of r.mps) { fg = Math.max(0, fg + m.goodUnits - m.demand); assert.ok(near(m.fgAfter, fg, 1)); } }
    for (const mat of r.mrp) {
      let sumG = 0, sumO = 0, sumSR = 0;
      for (const w of mat.weeks) {
        assert.ok(near(w.available - w.gross + w.order, w.ending, 2), 'معادلة التوازن');
        if (w.tooLateToOrder) { assert.equal(w.order, 0, 'لا طلب بأسبوع فات أوانه'); assert.ok(w.unmetNeed > 0); } else assert.equal(w.unmetNeed, 0);
        sumG += w.gross; sumO += w.order; sumSR += w.sr;
      }
      assert.ok(near(mat.weeks.at(-1).ending, mat.inv.available + sumSR - sumG + sumO, mat.weeks.length * 3), 'حفظ الكميات');
      const delay = (supplierDelays && supplierDelays[mat.id]) || 0;
      assert.equal(mat.inv.leadTime, inv.find(i => i.id === mat.id).leadTime + delay);
    }
    const er = r.engineResult;
    assert.deepEqual(r.mps.filter(m => m.maintenanceWeek).map(m => m.week), er.maintenanceWeeks, 'أسابيع الصيانة المخصومة = المُبلَّغ عنها');
    if (er.maintenanceDone) {
      maint++; if (er.maintenanceCount > 1) multi++;
      for (const m of er.maintenances) {
        const wk = r.mps.find(x => x.week === m.week);
        assert.equal(wk.maintHours, m.count * e.durationHours, 'الساعات المخصومة = عدد الصيانات × المدة');
        if (wk.loadH <= wk.availH) assert.ok(m.feasibleWithMaint, 'لا تحذير كاذب بالصيانة');
      }
      // مقياس مستقل لعدد الصيانات (بلا تعادل حدّي)
      const before0 = e.intervalHours - e.remainingHours, total = before0 + r.mps.reduce((s, m) => s + m.loadH, 0);
      if (before0 >= 0 && Math.abs(total / e.intervalHours - Math.round(total / e.intervalHours)) > 1e-6) assert.equal(er.maintenanceCount, Math.floor(total / e.intervalHours), 'عدد الصيانات');
    }
    assert.ok(er.postPlanRemaining >= 0 && er.postPlanRemaining <= Math.max(e.intervalHours, e.remainingHours));
    // ما-لو بلا تغيير = الأساس (نفس المدخلات بلا عوامل)
    if (t % 25 === 0) {
      const a = L.runFullSimulation({ demand: dem, cap: c, fgiConfig: f, bom: b, inventory: inv, engineMaintCfg: e, poLog: [], planStartDate: START, costs });
      const z = L.runFullSimulation({ demand: dem, cap: c, fgiConfig: f, bom: b, inventory: inv, engineMaintCfg: e, poLog: [], planStartDate: START, costs, rateFactors: {}, supplierDelays: {} });
      assert.deepEqual(z, a);
    }
  }
  assert.ok(smoothed > 80 && maint > 800 && multi > 100 && downs > 500 && delays > 500, `التغطية: تسوية ${smoothed}، صيانة ${maint}، متعددة ${multi}، أعطال ${downs}، تأخيرات ${delays}`);
});
