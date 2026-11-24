/* CDT-PPC — ملف مُولَّد من src/app.jsx بـ npm run build — لا تعدّليه يدوياً */
// ── الترجمة: __t(عربي, English) و__tf(قالب عربي, English, [قيم]) — اللغة الحالية بالمتغير __LANG ──
let __LANG = (() => {
  try {
    return JSON.parse(localStorage.getItem("cdt:lang")) === "en" ? "en" : "ar";
  } catch (e) {
    return "ar";
  }
})();
function __t(ar, en) {
  return __LANG === "en" && en ? en : ar;
}
function __tf(ar, en, args) {
  return (__LANG === "en" && en ? en : ar).replace(/\{(\d+)\}/g, (m, i) => args[i]);
}
const {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef
} = React;

// ═══════════════════════════════════════════════════════════════════
//  CONSTANTS & DEFAULTS
// ═══════════════════════════════════════════════════════════════════
const DEFAULT_WEEKS = 12;
const DEMAND_HIGH_UTIL = 85;
const mkDemand = (n = DEFAULT_WEEKS, totalMonthly = null) => {
  const perWeek = totalMonthly ? Math.round(totalMonthly / n) : 150000;
  return Array.from({
    length: n
  }, (_, i) => ({
    week: `W${i + 1}`,
    qty: perWeek
  }));
};

// النظام يبدأ فارغًا تمامًا — لا افتراضات لأي منتج معيّن. صاحب الحساب يضيف مكوّناته بنفسه من تبويب BOM
const mkBOM = () => [];
const mkInventory = () => [];

// نسبة العيوب أصبحت مدى (من-إلى) وليست رقماً ثابتاً — تختلف كل أسبوع ضمن هذا المدى
// القيم الافتراضية عامة ومحايدة — صاحب الحساب يعدّلها من تبويب "الطاقة" لتطابق خطه الفعلي
const mkCapacity = () => ({
  productionRate: 100,
  shiftHours: 8,
  normalDays: 6,
  maxShifts: 3,
  defectRateMin: 1.5,
  defectRateMax: 3.5,
  minimizeIdleDays: true,
  levelProduction: false,
  levelingThresholdPct: 35
});
// حُذف reorderPoint وأي مفهوم lead time خاص بـ FGI — لا يوجد "توريد" لمنتج نُنتجه نحن أنفسنا
// يبدأ من صفر — صاحب الحساب يدخل أرقامه الفعلية من تبويب FGI
const mkFGIConfig = () => ({
  current: 0,
  safety: 0,
  maxWarehouse: 100000,
  mode: "hybrid"
});
const mkEngineMaint = () => ({
  intervalHours: 3000,
  durationHours: 8,
  remainingHours: 800
});
const mkApiKeys = () => ({
  provider: "gemini",
  gemini: "",
  geminiModel: "",
  openrouter: "",
  openrouterModel: "meta-llama/llama-3.1-8b-instruct:free",
  claude: ""
});
const mkCsvUrls = () => ({
  inventory: "",
  capacity: "",
  engine: "",
  fgi: ""
});

// ═══════════════════════════════════════════════════════════════════
//  توليد رقم شبه-عشوائي ثابت (Seeded) — يجعل نسبة العيوب "تتغيّر أسبوعياً"
//  لكن بشكل قابل لإعادة الإنتاج (نفس المدخلات = نفس النتيجة دائماً)
// ═══════════════════════════════════════════════════════════════════
function seededRandom(seed) {
  let t = seed + 0x6d2b79f5;
  t = Math.imul(t ^ t >>> 15, t | 1);
  t ^= t + Math.imul(t ^ t >>> 7, t | 61);
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

// ═══════════════════════════════════════════════════════════════════
//  ENGINE — MPS (Pull / Push / Hybrid — FGI aware)
//  يقبل الآن: maintHit (أثر الصيانة على أسبوع محدد) و materialCaps
//  (سقف إنتاج مفروض بسبب نقص مادة خام حرج) — لضمان ترابط النظام بالكامل
// ═══════════════════════════════════════════════════════════════════
// قيمة رقمية مع احتياطي: الصفر قيمة صالحة (مثلاً مدة توريد 0)، أما الفارغ/غير الرقمي فيأخذ الافتراضي
// (الصيغة القديمة Number(x) || 3 كانت تحوّل الصفر إلى 3 بصمت)
function numOr(v, d) {
  if (v === null || v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function calcMPS(demand, cap, fgiConfig, maintHit = null, materialCaps = null, rateFactors = null) {
  const {
    productionRate,
    shiftHours,
    normalDays,
    maxShifts,
    defectRateMin,
    defectRateMax
  } = cap;
  let fg = fgiConfig ? Number(fgiConfig.current) : null;
  // الصيانة: كائن واحد {week,hours} (توافق قديم) أو مصفوفة (عدة صيانات دورية ضمن الخطة)
  const maintList = Array.isArray(maintHit) ? maintHit : maintHit ? [maintHit] : [];
  return demand.map((d, wi) => {
    const maintHrs = maintList.filter(h => h.week === d.week).reduce((sum, h) => sum + (Number(h.hours) || 0), 0);
    const hasMaint = maintList.some(h => h.week === d.week);
    // عامل سرعة الآلة لهذا الأسبوع (1 = طبيعي؛ <1 = عطل جزئي بسيناريو ما-لو)
    const rateFactor = rateFactors && Number.isFinite(rateFactors[d.week]) ? rateFactors[d.week] : 1;
    // حارس: معدل صفر/سالب (قد يصل من Excel أو السحابة) كان يعطي حملاً لا نهائياً — يصير خطة غير مجدولة بقيم محدودة
    const effRate = Math.max(productionRate * rateFactor, 0.001);
    // ── نسبة عيوب هذا الأسبوع تحديداً (ضمن المدى المُدخل، تختلف كل أسبوع) ──
    const rand = seededRandom(wi * 7919 + 13);
    const defectRate = defectRateMin + rand * Math.max(0, defectRateMax - defectRateMin);

    // ── Pull / Hybrid / Push: تحديد الكمية المستهدفة (وحدات جيدة) ──
    let baseQty = d.qty;
    if (fgiConfig && fg !== null) {
      if (fgiConfig.mode === "hybrid") {
        // ينتج الطلب دائماً + تعويض إضافي إن كان المخزون دون الأمان
        baseQty = d.qty + Math.max(0, fgiConfig.safety - fg);
      } else if (fgiConfig.mode === "pull") {
        // ينتج حسب طلب السوق الفعلي: أي فائض حالي فوق الأمان يُستهلك أولاً قبل زيادة الإنتاج
        baseQty = Math.max(0, d.qty - Math.max(0, fg - fgiConfig.safety));
      }
      // push: baseQty = d.qty كما هي دائماً، بغض النظر عن المخزون
    }

    // ── الإنتاج الإجمالي المطلوب (يشمل الهالك) ليصل لعدد الوحدات الجيدة المستهدف ──
    let grossProd = baseQty > 0 ? Math.ceil(baseQty / (1 - defectRate / 100)) : 0;

    // ── سقف مادة خام حرجة (إن وُجد من الحساب التكراري) ──
    let materialConstrained = false;
    if (materialCaps && Number.isFinite(materialCaps[wi]) && materialCaps[wi] < grossProd) {
      grossProd = Math.max(0, Math.floor(materialCaps[wi]));
      materialConstrained = true;
    }
    const goodUnits = Math.floor(grossProd * (1 - defectRate / 100));
    const scrapUnits = grossProd - goodUnits;
    const loadH = grossProd / effRate;
    const maxExtraDays = Math.max(0, 7 - normalDays); // كل الأيام الإضافية الممكنة نظرياً (مو يوم واحد ثابت)
    let shifts = 0,
      workDays = 0,
      otDaysUsed = 0,
      availH = shiftHours * normalDays,
      found = true;
    if (grossProd > 0) {
      found = false;
      // جرّب: أقل عدد أيام يغطي الحمل (بدل افتراض كل الأيام العادية دائماً) بكل مستوى ورديات،
      // ثم أضف يوم إضافي واحد في كل مرة (سادس، سابع، ...) حتى تغطية أسبوع كامل إن لزم.
      // مبدأ هندسة صناعية: لا تجدول طاقة أكبر من الحمل الفعلي المطلوب — كل ساعة خاملة مدفوعة = هدر.
      // (قابل للتعطيل عبر cap.minimizeIdleDays لو يُفضَّل جدول أيام ثابت أسبوعياً)
      search: for (let extraDays = 0; extraDays <= maxExtraDays; extraDays++) {
        const maxDaysThisLevel = normalDays + extraDays;
        for (let s = 1; s <= maxShifts; s++) {
          const dayOptions = cap.minimizeIdleDays === false ? [maxDaysThisLevel] // وضع الجدول الثابت: استخدم كل الأيام العادية+الإضافية دائماً كما كان سابقاً
          : Array.from({
            length: maxDaysThisLevel
          }, (_, i) => i + 1); // جرّب من يوم واحد صعوداً
          for (const days of dayOptions) {
            let avail = shiftHours * s * days;
            if (maintHrs > 0) avail = Math.max(0, avail - maintHrs);
            if (loadH <= avail) {
              shifts = s;
              workDays = days;
              otDaysUsed = Math.max(0, days - normalDays);
              availH = avail;
              found = true;
              break search;
            }
          }
        }
      }
      if (!found) {
        shifts = maxShifts;
        workDays = normalDays + maxExtraDays;
        otDaysUsed = maxExtraDays;
        availH = shiftHours * maxShifts * (normalDays + maxExtraDays);
        if (maintHrs > 0) availH = Math.max(0, availH - maintHrs);
      }
    }
    const fgBefore = fg;
    const fgAfter = fg !== null ? Math.max(0, fg + goodUnits - d.qty) : null;
    if (fg !== null) fg = fgAfter;
    return {
      week: d.week,
      demand: d.qty,
      production: grossProd,
      goodUnits,
      scrapUnits,
      defectRateUsed: +defectRate.toFixed(2),
      loadH: +loadH.toFixed(1),
      availH: +availH.toFixed(1),
      spareH: +(availH - loadH).toFixed(1),
      util: availH > 0 ? Math.min(999.9, +(loadH / availH * 100).toFixed(1)) : 0,
      shifts,
      workDays,
      otDaysUsed,
      feasible: found,
      infeasible: !found,
      machineDown: rateFactor < 1,
      fgBefore,
      fgAfter,
      fgBelowSafety: fgAfter !== null && fgiConfig && fgAfter < fgiConfig.safety,
      fgAboveMax: fgAfter !== null && fgiConfig && fgAfter > fgiConfig.maxWarehouse,
      maintenanceWeek: hasMaint,
      maintHours: maintHrs,
      materialConstrained,
      idle: grossProd === 0
    };
  });
}

// ═══════════════════════════════════════════════════════════════════
//  ENGINE — MRP (Backward Scheduling + سعة تخزين المواد الخام)
//  يكشف الآن حالات "فات أوان الطلب" (tooLateToOrder) — نقص حقيقي لا يمكن تفاديه
//  ضمن أفق الخطة الحالي، وهو ما يُستخدم لتقييد الإنتاج الفعلي في MPS
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
//  DATE HELPERS — تحويل رقم الأسبوع (W1..Wn) إلى تاريخ حقيقي، بدءاً من
//  planStartDate (تاريخ بداية الخطة الحالية = "اليوم" وقت إنشائها)
// ═══════════════════════════════════════════════════════════════════
function addDays(dateStr, days) {
  // نحسب بتوقيت UTC صراحة لتفادي انزياح يوم كامل بسبب فرق توقيت الجهاز المحلي
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function weekRange(planStartDate, wi) {
  const start = addDays(planStartDate, wi * 7);
  const end = addDays(planStartDate, wi * 7 + 6);
  return {
    start,
    end
  };
}
// كمية أي طلبات شراء مؤكدة (SR) من سجل poLog والتي ستصل فعلياً خلال الأسبوع wi
// أي SR متأخر (تاريخ وصوله قبل بداية هذا الأسبوع ولم يُستهلك بعد) يُجمَّع في أول أسبوع بدل ضياعه
function srForWeek(poLog, materialId, planStartDate, wi) {
  if (!poLog || !poLog.length) return 0;
  const {
    end
  } = weekRange(planStartDate, wi);
  const prevEnd = wi === 0 ? null : weekRange(planStartDate, wi - 1).end;
  return poLog.filter(p => p.materialId === materialId && p.status === "pending").filter(p => p.arrivalDate <= end && (wi === 0 || p.arrivalDate > prevEnd)).reduce((s, p) => s + Number(p.qty || 0), 0);
}

// كمية الطلب الاقتصادية (EOQ) — توازن بين تكلفة الطلبيات المتكررة وتكلفة تخزين الفائض
// EOQ = √(2×الطلب الأسبوعي×تكلفة الطلبية ÷ تكلفة التخزين لكل وحدة أسبوعياً)
// ⚠️ شرط الجدوى: تجميع الطلبية بكمية أكبر مفيد فقط لو تكلفة الطلبية نفسها أكبر من
// ضعف تكلفة تخزين احتياج أسبوع واحد — غير هذا، الطلب حسب الاحتياج الفوري (lot-for-lot)
// أرخص فعلياً لأنه يخلي المخزون عند حد الأمان دائماً بدون أي فائض يُدفع تخزينه.
// (تحقّق هذا رقمياً باختبار قبل الشحن: بدون هذا الشرط كان EOQ يرفع التكلفة الإجمالية أحياناً بدل تخفيضها)
function calcEOQ(weeklyDemand, orderCost, unitCost, holdingPctPerWeek) {
  if (!(weeklyDemand > 0) || !(unitCost > 0) || !(orderCost > 0) || !(holdingPctPerWeek > 0)) return 0;
  const holdingCostPerUnitPerWeek = unitCost * (holdingPctPerWeek / 100);
  const worthBatching = orderCost > 2 * weeklyDemand * holdingCostPerUnitPerWeek;
  if (!worthBatching) return 0;
  return Math.sqrt(2 * weeklyDemand * orderCost / holdingCostPerUnitPerWeek);
}
function calcMRP(mps, bom, inventory, poLog = [], planStartDate = null, costs = null, supplierDelays = null) {
  const startDate = planStartDate || new Date().toISOString().slice(0, 10);
  const avgWeeklyProduction = mps.length ? mps.reduce((s, m) => s + m.production, 0) / mps.length : 0;
  return bom.map(bomItem => {
    const baseInv = inventory.find(i => i.id === bomItem.id) || {
      available: 0,
      safety: 0,
      leadTime: 3,
      maxCapacity: 999999999,
      unit: bomItem.unit,
      id: bomItem.id,
      name: bomItem.name,
      unitCost: 0
    };
    // تأخير المورد (ما-لو) يخص الطلبات الجديدة فقط؛ الوارد المؤكد SR التزام بتاريخ حقيقي لا يتأثر به
    const effLT = baseInv.leadTime + (supplierDelays && supplierDelays[bomItem.id] || 0);
    const inv = effLT === baseInv.leadTime ? baseInv : {
      ...baseInv,
      leadTime: effLT
    };
    let stock = inv.available ?? 0;
    const maxCap = Number(inv.maxCapacity) || Infinity;
    const weeklyDemand = avgWeeklyProduction * bomItem.qty;
    const eoq = costs ? calcEOQ(weeklyDemand, costs.orderCost, inv.unitCost, costs.holdingPct) : 0;
    const weeks = mps.map((m, wi) => {
      const gross = m.production * bomItem.qty;
      // وارد مؤكد (Scheduled Receipts) لهذا الأسبوع تحديداً — من مشتريات سبق تأكيدها فعلياً،
      // بتاريخ وصول حقيقي ثابت (ليس مفترضاً أنه يصل بنفس أسبوع الحاجة)
      const sr = srForWeek(poLog, bomItem.id, startDate, wi);
      const avail = stock + sr; // المتاح الفعلي هذا الأسبوع = المخزون السابق + الوارد المؤكد
      const netReq = Math.max(0, gross - avail + inv.safety);
      const spaceLeft = Math.max(0, maxCap - avail);
      const orderWeekIndex = wi - inv.leadTime;
      // فات أوان الطلب: نحتاج نطلب قبل بداية أفق الخطة — نقص حقيقي غير قابل للتلافي بالشراء.
      // لا يوجد طلب صالح لهذا الأسبوع (order=0)؛ العجز يُحمَل كمخزون سالب ويغطّيه أول طلب يصل (الأسبوع = مدة التوريد)،
      // وإلا تُحتسب الكمية مرتين (طلب وهمي بهذا الأسبوع + الطلب الحقيقي اللاحق) فتتضخم المشتريات والتكاليف.
      const tooLateToOrder = orderWeekIndex < 0 && netReq > 0;

      // لو فيه احتياج فعلي: اطلب أكبر قيمة بين الاحتياج الفوري وEOQ — طلبية أكبر أحياناً أرخص إجمالاً
      // (توفير بتكلفة الطلبيات المتكررة) من تكرار طلبيات صغيرة كل أسبوع بنمط "اطلب بالضبط قد الحاجة"
      const desiredOrder = netReq > 0 ? Math.max(netReq, eoq) : 0;
      // هذا "order" هو توصية جديدة (لم تُؤكَّد بعد) — تبقى مفترضة الوصول بنفس أسبوع الحاجة
      // لأنها اقتراح تخطيطي، وتتحول لواقع فعلي (SR بتاريخ حقيقي) فقط بعد أن يضغط المخطِّط "تأكيد الشراء"
      const order = tooLateToOrder ? 0 : Math.min(desiredOrder, spaceLeft);
      const usedEOQ = !tooLateToOrder && netReq > 0 && eoq > netReq + 0.5 && order >= eoq - 0.5;
      const capacityConstrained = !tooLateToOrder && desiredOrder > spaceLeft;
      const ending = avail - gross + order;
      const stockout = ending < inv.safety;
      stock = ending;
      return {
        week: m.week,
        gross: Math.round(gross),
        available: Math.round(avail),
        openingStock: Math.round(avail - sr),
        sr: Math.round(sr),
        netReq: Math.round(netReq),
        order: Math.round(order),
        unmetNeed: tooLateToOrder ? Math.round(netReq) : 0,
        ending: Math.round(ending),
        stockout,
        orderWeek: orderWeekIndex >= 0 ? `W${orderWeekIndex + 1}` : __t("فوري", "Immediate"),
        capacityConstrained,
        tooLateToOrder,
        usedEOQ,
        spaceLeft: Math.round(spaceLeft)
      };
    });
    return {
      ...bomItem,
      inv,
      weeks,
      eoq: Math.round(eoq)
    };
  });
}

// حساب سقف الإنتاج الأسبوعي الذي تفرضه ندرة مادة خام (فات أوان طلبها)
function computeMaterialCaps(mps, mrp, bom) {
  return mps.map((m, wi) => {
    let cap = Infinity;
    bom.forEach(b => {
      const matRec = mrp.find(x => x.id === b.id);
      const w = matRec?.weeks?.[wi];
      if (w?.tooLateToOrder && b.qty > 0) {
        const maxUnits = Math.floor(w.available / b.qty);
        cap = Math.min(cap, maxUnits);
      }
    });
    return cap;
  });
}

// ═══════════════════════════════════════════════════════════════════
//  🔬 تسوية الإنتاج بين الأسابيع (Production Leveling) — تجريبي، معطّل افتراضياً
//  (cap.levelProduction=true لتفعيله من تبويب الطاقة).
//  الفكرة: لو آخر يوم إنتاج مجدوَل بأسبوع ما "شبه فارغ" (مثال: 141 وحدة فقط من سعة يوم
//  كامل 800 وحدة)، بدل فتح يوم كامل بأسبوع المصدر لكمية ضئيلة، تُسحب هذي الكمية من FGI
//  مؤقتاً، وتُعوَّض من "الوقت الحر الحقيقي" بالأسابيع اللاحقة — وهذا الوقت الحر يُمسَح
//  ويُجمَّع عبر عدة أسابيع لاحقة إن لزم (وليس أسبوعاً واحداً فقط)، لأن أسبوعاً وحيداً قد لا
//  يملك وحده وقتاً كافياً بينما يكفي مجموع عدة أسابيع صغيرة الفراغ. التغطية دائماً كل-أو-لا-شيء:
//  لو تعذّرت تغطية كامل الكمية المؤجَّلة بأمان (ولو وحدة واحدة ناقصة)، لا تُطبَّق أي تسوية لهذا
//  الأسبوع إطلاقاً — لأن فتح اليوم سيحدث بغض النظر ما دام جزء من الكمية غير مُغطّى، فالتسوية
//  الجزئية بلا فائدة (لسنا نتجنّب تكلفة فتح اليوم) وتُضيف فقط مخاطرة سحب FGI بلا مقابل.
//  ضمانات الأمان: (1) لا تُطبَّق إطلاقاً لو بالخطة أي نقص مادة خام أصلاً (يُفحص خارج هذي الدالة
//  قبل استدعائها)، (2) FGI لا ينزل دون حد الأمان بأي أسبوع عبر كامل مسار السحب/التعويض،
//  (3) كل أسبوع مُستقبِل يُحوَّل نصيبه عبر معدّل عيوبه الخاص هو (لا معدّل أسبوع المصدر)،
//  (4) شبكة أمان أخيرة: لو التعديلات مجتمعة أحدثت نقص مادة خام جديد لم يكن موجوداً، يُلغى
//  كامل التعديل تلقائياً (rollback إلى الخطة الأصلية دون تسوية).
// ═══════════════════════════════════════════════════════════════════
function levelProduction(mps, cap, fgiConfig, bom, inventory, poLog, planStartDate, costs, thresholdPct = 35, mrpFn = null) {
  const mrpOf = mrpFn || (m => calcMRP(m, bom, inventory, poLog, planStartDate, costs));
  const original = mps;
  const out = mps.map(m => ({
    ...m,
    smoothed: false,
    smoothedNote: null
  }));
  for (let i = 0; i < out.length; i++) {
    const src = out[i];
    if (src.idle || src.workDays <= 1 || !src.feasible || src.materialConstrained || src.machineDown) continue;
    if (src.fgBefore === null || src.fgBefore === undefined) continue; // بلا FGI فعّال، لا ضمانة لعدم انقطاع التوريد
    if (!(fgiConfig && fgiConfig.safety > 0)) continue; // بدون مخزون أمان موجب، فحص "البقاء فوق الأمان" لا يحمي فعلياً — التسوية أخطر مما تستاهل

    const dayCap = cap.shiftHours * Math.max(1, src.shifts);
    if (!(dayCap > 0)) continue;
    const fullDays = Math.floor(src.loadH / dayCap + 1e-6);
    const remainderH = +(src.loadH - fullDays * dayCap).toFixed(4);
    if (!(remainderH > 0.01) || fullDays !== src.workDays - 1) continue; // ما فيه "يوم أخير جزئي" بالمعنى المقصود

    const trailingPct = remainderH / dayCap * 100;
    if (trailingPct >= thresholdPct) continue; // اليوم الأخير مُستغل بما يكفي — لا داعي للتسوية

    const deferredGross = Math.floor(remainderH * cap.productionRate);
    const deferredGood = Math.floor(deferredGross * (1 - src.defectRateUsed / 100));
    if (deferredGood <= 0) continue;
    const newSrcProd = Math.round(fullDays * dayCap * cap.productionRate);
    const newSrcGood = src.goodUnits - deferredGood;
    const fgAfterSrc = Math.max(0, src.fgBefore + newSrcGood - src.demand);
    if (fgiConfig && fgAfterSrc < fgiConfig.safety) continue; // حتى بدون أي تعويض، سحب أسبوع المصدر وحده يخترق الأمان

    // 🔎 امسح "الوقت الحر" الحقيقي بكل الأسابيع اللاحقة (وليس أسبوعاً واحداً فقط)، ووزّع عليها
    // الكمية المؤجَّلة تدريجياً بالترتيب الزمني، مع تحويل نصيب كل أسبوع عبر معدّل عيوبه الخاص هو
    let remaining = deferredGood;
    const allocations = []; // [{ idx, extraGood, extraGross, extraH }]
    let fgRun = fgAfterSrc;
    let safe = true;
    for (let k = i + 1; k < out.length; k++) {
      const wk = out[k];
      let extraGood = 0,
        extraGross = 0,
        extraH = 0;
      if (remaining > 0 && wk.feasible && !wk.idle && !wk.materialConstrained && !wk.machineDown && wk.spareH > 0.01) {
        const capGrossHere = Math.floor(wk.spareH * cap.productionRate);
        const capGoodHere = Math.floor(capGrossHere * (1 - wk.defectRateUsed / 100));
        extraGood = Math.min(remaining, Math.max(0, capGoodHere));
        if (extraGood > 0) {
          extraGross = Math.ceil(extraGood / (1 - wk.defectRateUsed / 100));
          extraH = +(extraGross / cap.productionRate).toFixed(4);
          if (extraH > wk.spareH) {
            extraGross -= 1;
            extraGood = Math.floor(extraGross * (1 - wk.defectRateUsed / 100));
            extraH = +(extraGross / cap.productionRate).toFixed(4);
          }
        }
      }
      const goodThisWeek = wk.goodUnits + extraGood;
      fgRun = Math.max(0, fgRun + goodThisWeek - wk.demand);
      if (fgiConfig && fgRun < fgiConfig.safety) {
        safe = false;
        break;
      }
      if (extraGood > 0) {
        allocations.push({
          idx: k,
          extraGood,
          extraGross,
          extraH
        });
        remaining -= extraGood;
      }
    }
    if (!safe || remaining > 0) continue; // تعذّرت التغطية الكاملة بأمان — كل-أو-لا-شيء: لا تُطبَّق أي تسوية لهذا الأسبوع

    // ✅ التغطية كاملة وآمنة عبر كل الأسابيع بين i وآخر أسبوع استقبل جزءاً — ثبّت التعديل على نسخة العمل
    const targetWeeksLabel = allocations.map(a => out[a.idx].week).join(__t("، ", ", "));
    out[i] = {
      ...src,
      production: newSrcProd,
      workDays: src.workDays - 1,
      goodUnits: newSrcGood,
      scrapUnits: newSrcProd - newSrcGood,
      loadH: +(fullDays * dayCap).toFixed(1),
      availH: +(fullDays * dayCap).toFixed(1),
      spareH: 0,
      util: 100,
      smoothed: true,
      smoothedNote: __tf("نُقل {0} وحدة إلى {1} (اليوم الأخير كان سيُستغل {2}% فقط)", "Moved {0} units to {1} (the last day would have used only {2}%)", [deferredGood.toLocaleString(), targetWeeksLabel, trailingPct.toFixed(0)])
    };
    allocations.forEach(a => {
      const wk = out[a.idx];
      const newProd = wk.production + a.extraGross;
      const newGood = wk.goodUnits + a.extraGood;
      out[a.idx] = {
        ...wk,
        production: newProd,
        goodUnits: newGood,
        scrapUnits: newProd - newGood,
        loadH: +(wk.loadH + a.extraH).toFixed(1),
        spareH: +Math.max(0, wk.spareH - a.extraH).toFixed(1),
        util: +((wk.loadH + a.extraH) / wk.availH * 100).toFixed(1),
        smoothed: true,
        smoothedNote: __tf("استُقبل {0} وحدة مؤجّلة من {1} (ضمن وقتها الحر أصلاً، دون فتح يوم/وردية إضافية)", "Received {0} deferred units from {1} (within its free time, without opening an extra day/shift)", [a.extraGood.toLocaleString(), src.week])
      };
    });

    // أعد ربط fgBefore/fgAfter لكل أسبوع بين i وآخر أسبوع تأثّر، بالقيم النهائية المثبَّتة
    const lastIdx = allocations.length ? allocations[allocations.length - 1].idx : i;
    let run2 = src.fgBefore;
    for (let k = i; k <= lastIdx; k++) {
      const after = Math.max(0, run2 + out[k].goodUnits - out[k].demand);
      out[k] = {
        ...out[k],
        fgBefore: run2,
        fgAfter: after,
        fgBelowSafety: fgiConfig ? after < fgiConfig.safety : false
      };
      run2 = after;
    }
  }
  if (!out.some(m => m.smoothed)) return original;

  // شبكة أمان أخيرة: لو التعديلات مجتمعة أحدثت نقص مادة خام جديد لم يكن موجوداً بالخطة الأصلية، ألغِ التسوية بالكامل
  const hadIssue = mrpList => mrpList.some(mat => mat.weeks.some(w => w.stockout || w.tooLateToOrder));
  const originalMrp = mrpOf(original);
  if (!hadIssue(originalMrp)) {
    const newMrp = mrpOf(out);
    if (hadIssue(newMrp)) return original.map(m => ({
      ...m,
      smoothed: false,
      smoothedNote: null,
      levelingRolledBack: true
    }));
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
//  🔗 المنسّق الرئيسي — يربط MPS بالصيانة وبتوفر المواد الخام فعلياً
//  (Multi-pass): تعذّر إنتاج بسبب مادة خام = خطة غير مكتملة في كل التبويبات
// ═══════════════════════════════════════════════════════════════════
function runFullSimulation({
  demand,
  cap,
  fgiConfig,
  bom,
  inventory,
  engineMaintCfg,
  poLog,
  planStartDate,
  costs,
  rateFactors = null,
  supplierDelays = null
}) {
  // rateFactors/supplierDelays: لسيناريوهات "ماذا لو؟" فقط (عطل آلة جزئي بأسابيع محددة / تأخير موردين).
  // بدونهما = الخطة الأساسية. نفس المسار الكامل للاثنين ⇒ نتيجة "بدون أي تغيير" تطابق الأساس تماماً.
  const mrpOf = m => calcMRP(m, bom, inventory, poLog, planStartDate, costs, supplierDelays);
  const hitsOf = eng => eng.maintenances.map(m => ({
    week: m.week,
    hours: m.count * engineMaintCfg.durationHours
  }));
  const sameHits = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Pass 1: خطة أولية بدون معرفة أثر الصيانة بعد
  let mps = calcMPS(demand, cap, fgiConfig, null, null, rateFactors);
  let maintHits = hitsOf(calcEngineMaintenance(mps, engineMaintCfg));

  // Pass 2: أعد الحساب مع خصم ساعات الصيانة من الأسابيع المتأثرة فعلياً (قد تكون أكثر من صيانة)
  mps = calcMPS(demand, cap, fgiConfig, maintHits, null, rateFactors);
  let mrp = mrpOf(mps);

  // اكتشاف نقص مواد خام حرج (فات أوان الطلب) وتقييد الإنتاج فعلياً إن وُجد
  const materialCaps = computeMaterialCaps(mps, mrp, bom);
  const anyMaterialConstraint = materialCaps.some(c => Number.isFinite(c));
  if (anyMaterialConstraint) {
    // Pass 3: أعد حساب MPS بالكامل مع تقييد الإنتاج فعلياً + FGI/الورديات تعكس ذلك
    mps = calcMPS(demand, cap, fgiConfig, maintHits, materialCaps, rateFactors);
    // تقييد الإنتاج يغيّر الأحمال التراكمية → قد تتحرك مواعيد الصيانة. أعد اشتقاقها من الخطة المقيَّدة
    // ثم أعد توزيع الورديات (الإنتاج نفسه لا يتغيّر بتغيّر ساعات الصيانة، فيكفي مرور واحد إضافي)
    const cappedHits = hitsOf(calcEngineMaintenance(mps, engineMaintCfg));
    if (!sameHits(cappedHits, maintHits)) {
      maintHits = cappedHits;
      mps = calcMPS(demand, cap, fgiConfig, maintHits, materialCaps, rateFactors);
    }
    mrp = mrpOf(mps);
  }

  // Pass 4 (اختياري وتجريبي): تسوية الإنتاج بين الأسابيع — تُعطَّل تلقائياً لو بالخطة أي نقص
  // مادة خام (لتفادي تعقيد تداخل قيدين معاً)، وتعمل فقط لو فعّلها المستخدم صراحة (تبويب الطاقة)
  if (cap.levelProduction && !anyMaterialConstraint) {
    const leveled = levelProduction(mps, cap, fgiConfig, bom, inventory, poLog, planStartDate, costs, Number(cap.levelingThresholdPct) || 35, mrpOf);
    // التسوية تنقل أحمالاً بين الأسابيع فقد تحرّك موعد الصيانة، وصفوفها لا تُعاد جدولتها بـcalcMPS.
    // لو تحرّك الموعد نُلغي التسوية (ضمان تطابق أسبوع الصيانة المخصوم مع المُبلَّغ عنه)
    if (leveled.some(m => m.smoothed) && !sameHits(hitsOf(calcEngineMaintenance(leveled, engineMaintCfg)), maintHits)) {
      mps = mps.map(m => ({
        ...m,
        smoothed: false,
        smoothedNote: null,
        levelingRolledBack: true
      }));
    } else {
      mps = leveled;
      mrp = mrpOf(mps);
    }
  }

  // الصيانة على النسخة النهائية
  const engineResult = calcEngineMaintenance(mps, engineMaintCfg);
  return {
    mps,
    mrp,
    engineResult,
    materialCaps,
    anyMaterialConstraint
  };
}

// ═══════════════════════════════════════════════════════════════════
//  ENGINE — Engine Maintenance (Running Hours) — المصدر الوحيد للصيانة
// ═══════════════════════════════════════════════════════════════════
function calcEngineMaintenance(mps, cfg) {
  let since = cfg.intervalHours - cfg.remainingHours; // ساعات التشغيل منذ آخر صيانة
  const maintenances = [];
  const weeks = [];
  for (const week of mps) {
    const before = since;
    let remainingLoad = week.loadH;
    let count = 0,
      firstInto = 0;
    // قد تقع أكثر من صيانة بالخطة (وأكثر من واحدة بنفس الأسبوع لو الفاصل أقصر من حمل الأسبوع)
    while (cfg.intervalHours > 0 && since + remainingLoad >= cfg.intervalHours && count < 50) {
      const until = Math.max(0, cfg.intervalHours - since); // ساعات حمل حتى لحظة التوقف
      if (count === 0) firstInto = until;
      remainingLoad -= until;
      since = 0;
      count++;
    }
    if (count > 0) {
      const durTotal = count * cfg.durationHours;
      // availH بصفوف MPS المُعلَّمة مخصوم منها ساعات الصيانة أصلاً (calcMPS) — نخصم فقط ما لم يُخصم بعد
      const netAvailH = week.availH - Math.max(0, durTotal - (week.maintHours || 0));
      const feasibleWithMaint = week.loadH <= netAvailH;
      const data = {
        week: week.week,
        count,
        loadH: week.loadH,
        hoursIntoWeekAtTrigger: +firstInto.toFixed(1),
        hoursAfterMaint: +remainingLoad.toFixed(1),
        maintenanceDurationH: cfg.durationHours,
        totalDurationH: durTotal,
        netAvailH: +netAvailH.toFixed(1),
        spareAfterMaint: +(netAvailH - week.loadH).toFixed(1),
        feasibleWithMaint,
        needsExtraShift: !feasibleWithMaint
      };
      maintenances.push(data);
      since = remainingLoad;
      weeks.push({
        ...data,
        week: week.week,
        loadH: week.loadH,
        cumulativeH: +(before + week.loadH).toFixed(1),
        maintenanceDue: true,
        remainingToNext: +(cfg.intervalHours - since).toFixed(1)
      });
    } else {
      since = before + week.loadH;
      weeks.push({
        week: week.week,
        loadH: week.loadH,
        cumulativeH: +since.toFixed(1),
        maintenanceDue: false,
        remainingToMaint: +(cfg.intervalHours - since).toFixed(1),
        percentToMaint: +(since / cfg.intervalHours * 100).toFixed(1)
      });
    }
  }
  const maintenanceDone = maintenances.length > 0;
  const first = maintenances[0] || null;
  const totalCount = maintenances.reduce((a, m) => a + m.count, 0);
  const allFeasibleWithMaint = maintenances.every(m => m.feasibleWithMaint);
  const totalPlanLoadH = +mps.reduce((s, m) => s + m.loadH, 0).toFixed(1);
  const postPlanRemaining = +(cfg.intervalHours - since).toFixed(1);
  const weeksList = maintenances.map(m => m.week).join(__t("، ", ", "));
  return {
    weeks,
    maintenanceDone,
    maintenanceWeek: first?.week || null,
    maintenanceWeeks: maintenances.map(m => m.week),
    maintenances,
    maintenanceCount: totalCount,
    maintenanceData: first,
    allFeasibleWithMaint,
    totalPlanLoadH,
    originalRemaining: cfg.remainingHours,
    postPlanRemaining: +Math.max(0, postPlanRemaining).toFixed(1),
    alert: !maintenanceDone ? __tf("✅ لا صيانة دورية مطلوبة في هذه الخطة — المتبقي حتى الصيانة القادمة: {0}h", "✅ No periodic maintenance required in this plan — remaining until next maintenance: {0}h", [postPlanRemaining]) : totalCount === 1 ? __tf("🔧 الصيانة الدورية ستكون مطلوبة في {0} — بعد {1}h من بداية الأسبوع (كل {2}h تشغيل). {3}", "🔧 Periodic maintenance will be required in {0} — {1}h after the start of the week (every {2}h of operation). {3}", [first.week, first.hoursIntoWeekAtTrigger, cfg.intervalHours, first.feasibleWithMaint ? __t("تمت زيادة الورديات تلقائياً لتعويض الوقت المفقود.", "Shifts were increased automatically to make up for the lost time.") : __t("⚠️ حتى بأقصى الورديات لا يكفي الوقت — يلزم تدخّل يدوي.", "⚠️ Even with maximum shifts the time is not enough — manual intervention required.")]) : __tf("🔧 الصيانة الدورية مطلوبة {0} مرات في {1} (كل {2}h تشغيل). {3}", "🔧 Periodic maintenance is required {0} times in {1} (every {2}h of operation). {3}", [totalCount, weeksList, cfg.intervalHours, allFeasibleWithMaint ? __t("تمت زيادة الورديات تلقائياً لتعويض الوقت المفقود.", "Shifts were increased automatically to make up for the lost time.") : __t("⚠️ حتى بأقصى الورديات لا يكفي الوقت في بعض الأسابيع — يلزم تدخّل يدوي.", "⚠️ Even with maximum shifts the time is not enough in some weeks — manual intervention required.")])
  };
}

// ═══════════════════════════════════════════════════════════════════
//  ENGINE — Post-Plan Inventory + Next Month Purchase Recommendations
// ═══════════════════════════════════════════════════════════════════
function calcPostPlan(inventory, mrp) {
  return inventory.map(inv => {
    const m = mrp.find(x => x.id === inv.id);
    if (!m) return {
      ...inv,
      endingStock: inv.available,
      totalConsumed: 0,
      totalOrdered: 0,
      anyCapacityConstrained: false,
      anyTooLate: false
    };
    const last = m.weeks[m.weeks.length - 1];
    return {
      // ⚠️ لا تُصفَّر هنا: القيمة الحقيقية (وقد تكون سالبة) لازم تنتقل كما هي
      // تُستخدم لاحقاً في: 1) حجم طلب الشهر القادم (calcNextMonthRec) 2) رصيد بداية الشهر القادم (handleConfirmPlan → setInv)
      // تصفيرها يعني ضياع أي عجز حقيقي متراكم — حتى مع وجود SR، قد يبقى عجز إذا لم يغطِ الوارد المؤكد كامل الحاجة
      ...inv,
      endingStock: last.ending,
      totalConsumed: Math.round(m.weeks.reduce((s, w) => s + w.gross, 0)),
      totalOrdered: Math.round(m.weeks.reduce((s, w) => s + w.order, 0)),
      anyCapacityConstrained: m.weeks.some(w => w.capacityConstrained),
      anyTooLate: m.weeks.some(w => w.tooLateToOrder)
    };
  });
}
function calcNextMonthRec(postPlan, bom, avgDemand) {
  return postPlan.map(item => {
    const b = bom.find(x => x.id === item.id);
    if (!b) return null;
    const weekly = avgDemand * b.qty;
    const weeksLeft = weekly > 0 ? item.endingStock / weekly : 999;
    const buffer = item.leadTime + 2;
    const needsOrder = weeksLeft < buffer;
    const maxCap = Number(item.maxCapacity) || Infinity;
    // العجز (endingStock سالب) يعني لا يوجد مخزون فعلي بالمخزن (0)، وليس "مساحة أكبر من الطاقة"
    const spaceLeft = Math.max(0, maxCap - Math.max(0, item.endingStock));
    const desiredQty = needsOrder ? Math.max(0, Math.ceil((buffer + item.leadTime) * weekly + item.safety - item.endingStock)) : 0;
    const qty = Math.min(desiredQty, spaceLeft);
    const capacityConstrained = desiredQty > spaceLeft;
    return {
      id: item.id,
      name: item.name,
      unit: item.unit,
      leadTime: item.leadTime,
      endingStock: item.endingStock,
      maxCapacity: maxCap,
      weeklyConsumption: Math.round(weekly),
      weeksLeft: +weeksLeft.toFixed(1),
      needsOrder,
      recommendedQty: qty,
      capacityConstrained,
      urgency: weeksLeft < item.leadTime ? __t("🔴 عاجل جداً", "🔴 Very urgent") : weeksLeft < buffer ? __t("🟡 عاجل", "🟡 Urgent") : weeksLeft < buffer + 2 ? __t("🟠 متوسط", "🟠 Medium") : __t("🟢 طبيعي", "🟢 Normal")
    };
  }).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════
//  WHAT-IF — يستخدم runFullSimulation نفسها (عطل آلة جزئي: rateFactors، تأخير موردين: supplierDelays)
//  + سيناريو عطل مفاجئ (Run to Failure) أدناه
// ═══════════════════════════════════════════════════════════════════

// ملاحظة: تأخير المورد الافتراضي (supplierDelays) يخص فقط الطلبات الجديدة المحتملة (لم تُؤكد بعد)
// أما الوارد المؤكد فعلياً (SR من poLog) فهو التزام ثابت بتاريخ وصول حقيقي، ولا يتأثر بسيناريو افتراضي عام

// ═══ سيناريو عطل مفاجئ (Run to Failure) — منفصل عن الصيانة الدورية المخطّطة ═══
function calcRunToFailure(mps, weekId, downtimeHours) {
  const week = mps.find(m => m.week === weekId);
  if (!week) return null;
  const netAvailH = Math.max(0, week.availH - downtimeHours);
  const feasibleAfterFailure = week.loadH <= netAvailH;
  const deficitH = Math.max(0, week.loadH - netAvailH);
  // كم وردية/ساعة إضافية تلزم لتعويض العجز؟
  const shiftHoursNeeded = deficitH > 0 ? Math.ceil(deficitH) : 0;
  return {
    week: weekId,
    originalAvailH: week.availH,
    downtimeHours,
    netAvailH: +netAvailH.toFixed(1),
    loadH: week.loadH,
    feasibleAfterFailure,
    deficitH: +deficitH.toFixed(1),
    shiftHoursNeeded,
    originalUtil: week.util,
    newUtil: netAvailH > 0 ? Math.min(999.9, +(week.loadH / netAvailH * 100).toFixed(1)) : 999.9,
    recommendation: !feasibleAfterFailure ? __tf("⚠️ عجز {0}h — يلزم إضافة وردية طارئة أو نقل {1} وحدة إنتاج لأسبوع آخر", "⚠️ Shortfall of {0}h — add an emergency shift or move {1} units of production to another week", [deficitH.toFixed(1), Math.round(deficitH / week.loadH * week.production).toLocaleString()]) : __tf("✅ يمكن امتصاص العطل ضمن الوقت الحر المتاح ({0}h)", "✅ The breakdown can be absorbed within the available free time ({0}h)", [week.spareH])
  };
}

// ═══════════════════════════════════════════════════════════════════
//  COST ANALYSIS
// ═══════════════════════════════════════════════════════════════════
function calcCosts(mps, mrp, costs, cap) {
  const prodCost = mps.reduce((s, m) => s + m.production * costs.perUnit, 0);
  const laborCost = mps.reduce((s, m) => s + m.shifts * m.workDays * costs.workerShiftCost, 0);
  const otCost = mps.reduce((s, m) => s + m.otDaysUsed * m.shifts * cap.shiftHours * costs.otHourRate, 0);
  const holdCost = Math.round(mrp.reduce((s, mat) => {
    const avg = mat.weeks.reduce((ws, w) => ws + Math.max(0, w.ending), 0) / mat.weeks.length;
    const unitCost = Number(mat.inv?.unitCost) || 0;
    return s + avg * unitCost * (costs.holdingPct / 100) * mps.length;
  }, 0));
  const orderCost = mrp.reduce((s, mat) => s + mat.weeks.filter(w => w.order > 0).length * costs.orderCost, 0);
  const total = prodCost + laborCost + otCost + holdCost + orderCost;
  const safePct = v => total > 0 ? v / total * 100 : 0;
  return {
    prodCost,
    laborCost,
    otCost,
    holdCost,
    orderCost,
    total,
    breakdown: [{
      name: __t("إنتاج", "Production"),
      value: prodCost,
      pct: safePct(prodCost),
      color: "#3B82F6"
    }, {
      name: __t("عمالة", "Labor"),
      value: laborCost,
      pct: safePct(laborCost),
      color: "#8B5CF6"
    }, {
      name: "OT",
      value: otCost,
      pct: safePct(otCost),
      color: "#F59E0B"
    }, {
      name: __t("تخزين", "Storage"),
      value: holdCost,
      pct: safePct(holdCost),
      color: "#10B981"
    }, {
      name: __t("طلبيات", "Orders"),
      value: orderCost,
      pct: safePct(orderCost),
      color: "#EF4444"
    }]
  };
}

// ═══════════════════════════════════════════════════════════════════
//  FEASIBILITY REPORT — الصيانة الدورية أُزيلت من المعايير (لم تعد موجودة)
// ═══════════════════════════════════════════════════════════════════
function calcFeasibility(mps, mrp, stockoutAll, overloaded, needsOT, avgUtil, fgiBelowCount, engineResult, anyCapacityConstrained, anyMaterialConstraint) {
  const c = [{
    name: __t("جدوى الطاقة الإنتاجية", "Production capacity feasibility"),
    w: 3,
    pass: overloaded === 0,
    detail: overloaded === 0 ? __t("جميع الأسابيع ضمن الطاقة", "All weeks within capacity") : __tf("{0} أسابيع تتجاوز الطاقة", "{0} weeks exceed capacity", [overloaded])
  }, {
    name: __t("توفر المواد الأولية", "Raw material availability"),
    w: 3,
    pass: stockoutAll.length === 0,
    detail: stockoutAll.length === 0 ? __t("لا نقص متوقع", "No shortage expected") : __tf("{0} تنبيه نقص", "{0} shortage alerts", [stockoutAll.length])
  }, {
    name: __t("اكتمال الخطة بلا نقص حرج", "Plan completed with no critical shortage"),
    w: 4,
    pass: !anyMaterialConstraint,
    detail: !anyMaterialConstraint ? __t("لا يوجد نقص مادة خام يحد الإنتاج", "No raw material shortage limits production") : __t("⚠️ نقص مادة خام حرج يمنع تحقيق الإنتاج المستهدف في بعض الأسابيع", "⚠️ A critical raw material shortage prevents reaching the target production in some weeks")
  }, {
    name: __t("الطاقة دون عمل إضافي (OT)", "Capacity without overtime (OT)"),
    w: 2,
    pass: needsOT === 0,
    detail: needsOT === 0 ? __t("لا يحتاج جمعة OT", "No Friday OT needed") : __tf("{0} أسابيع تحتاج جمعة", "{0} weeks need a Friday", [needsOT])
  }, {
    name: __t("استخدام الطاقة في النطاق", "Capacity utilization within range"),
    w: 2,
    pass: avgUtil >= 60 && avgUtil <= 90,
    detail: `${avgUtil}% — ${avgUtil < 60 ? __t("منخفض", "Low") : avgUtil > 90 ? __t("مرتفع جداً", "Very high") : __t("مثالي", "Ideal")}`
  }, {
    name: __t("مخزون المنتج النهائي (FGI)", "Finished goods inventory (FGI)"),
    w: 3,
    pass: fgiBelowCount === 0,
    detail: fgiBelowCount === 0 ? __t("FGI آمن طوال الخطة", "FGI is safe throughout the plan") : __tf("{0} أسابيع دون الحد الأدنى", "{0} weeks below the minimum", [fgiBelowCount])
  }, {
    name: __t("توافق صيانة الآلة مع الطاقة", "Machine maintenance fits the capacity"),
    w: 2,
    pass: !engineResult?.maintenanceDone || engineResult?.allFeasibleWithMaint !== false,
    detail: !engineResult?.maintenanceDone ? __t("لا صيانة دورية في هذه الخطة", "No periodic maintenance in this plan") : engineResult?.allFeasibleWithMaint !== false ? __tf("صيانة في {0} — تمت زيادة الورديات تلقائياً", "Maintenance in {0} — shifts were increased automatically", [engineResult.maintenanceWeeks.join(__t("، ", ", "))]) : __tf("⚠️ صيانة في {0} تتجاوز الطاقة حتى بأقصى الورديات", "⚠️ Maintenance in {0} exceeds capacity even with maximum shifts", [engineResult?.maintenanceWeeks?.join(__t("، ", ", "))])
  }, {
    name: __t("سعة تخزين المواد الخام", "Raw material storage capacity"),
    w: 2,
    pass: !anyCapacityConstrained,
    detail: !anyCapacityConstrained ? __t("كل الطلبيات ضمن السعة المتاحة", "All orders are within the available capacity") : __t("⚠️ بعض الطلبيات مقيّدة بسعة التخزين", "⚠️ Some orders are limited by storage capacity")
  }];
  const totalW = c.reduce((s, x) => s + x.w, 0);
  const passW = c.reduce((s, x) => s + (x.pass ? x.w : 0), 0);
  const score = Math.round(passW / totalW * 100);
  return {
    criteria: c,
    score,
    verdict: score >= 80 ? __t("✅ مجدية تماماً", "✅ Fully feasible") : score >= 60 ? __t("🟡 مجدية مع تحفظات", "🟡 Feasible with reservations") : __t("🔴 تحتاج مراجعة جوهرية", "🔴 Needs a fundamental review"),
    passCount: c.filter(x => x.pass).length,
    totalCount: c.length
  };
}

// ═══════════════════════════════════════════════════════════════════
//  🔗 تقاطع الطاقة/الموارد بين خطط مرتبطة (Cross-Plan Capacity Overlap)
//  إعلامي بحت — لا يحاول حل التعارض تلقائياً (هذي مشكلة جدولة بسعة محدودة عبر منتجات متعددة،
//  من أصعب مسائل بحوث العمليات، وحلّها الحقيقي خارج نطاق هذا النظام). كل ما تفعله هذي الدالة:
//  تقارن الأسابيع التقويمية الفعلية (لا رقم الأسبوع النسبي W1/W2) بين أي خطتين "مرتبطتين"
//  (شاركتا مادة خام عند الإنشاء)، وتُبلّغ فقط لو مجموع ساعات حملهما بأسبوع متداخل يتجاوز
//  رياضياً أقصى طاقة ممكنة لأضعف الخطتين إعداداً — أي تعارض لا يمكن حله بأي ترتيب ورديات.
// ═══════════════════════════════════════════════════════════════════
function computeCapacityOverlaps(plans) {
  const overlaps = [];
  const seenPairs = new Set();
  plans.forEach(planA => {
    (planA.linkedPlanIds || []).forEach(linkedId => {
      const pairKey = [planA.id, linkedId].sort().join("|");
      if (seenPairs.has(pairKey)) return;
      seenPairs.add(pairKey);
      const planB = plans.find(p => p.id === linkedId);
      const wA = planA.lastSummary?.weeklyCapacity,
        wB = planB?.lastSummary?.weeklyCapacity;
      if (!planB || !wA || !wB) return; // إحدى الخطتين لم تُشغَّل بعد — لا بيانات كافية للفحص
      const ceiling = Math.min(planA.lastSummary.capHoursPerWeek, planB.lastSummary.capHoursPerWeek);
      wA.forEach(weekA => {
        wB.forEach(weekB => {
          const overlapStart = weekA.start > weekB.start ? weekA.start : weekB.start;
          const overlapEnd = weekA.end < weekB.end ? weekA.end : weekB.end;
          if (overlapStart > overlapEnd) return; // بلا تقاطع تقويمي فعلي بين هذا الأسبوعين
          const combined = +(weekA.loadH + weekB.loadH).toFixed(1);
          if (combined > ceiling) {
            overlaps.push({
              planAId: planA.id,
              planAName: planA.productName || __t("بدون اسم", "Unnamed"),
              planBId: planB.id,
              planBName: planB.productName || __t("بدون اسم", "Unnamed"),
              weekStart: overlapStart,
              weekEnd: overlapEnd,
              combinedLoadH: combined,
              ceiling: +ceiling.toFixed(1)
            });
          }
        });
      });
    });
  });
  return overlaps;
}

// ═══════════════════════════════════════════════════════════════════
//  STORAGE HOOK (localStorage — نسخة مستقلة، لا تعتمد على أي خدمة خارجية)
// ═══════════════════════════════════════════════════════════════════
function usePersistedState(key, def) {
  const [val, setVal] = useState(def);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("idle");
  // مرجع دائم لآخر "قيمة افتراضية" — يُستخدم فقط عند تبديل المفتاح نفسه (مثلاً تبديل الخطة النشطة)
  // بدون ما نُجبر التأثير (useEffect) يعتمد على def مباشرة (لأنها غالباً كائن/مصفوفة جديدة بكل Render)
  const defRef = useRef(def);
  defRef.current = def;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      setVal(raw ? JSON.parse(raw) : defRef.current); // ⚠️ لو المفتاح تغيّر (خطة جديدة) ولا يوجد شيء محفوظ به، ارجع للافتراضي — لا تُبقي قيمة الخطة السابقة
    } catch {
      setVal(defRef.current);
    }
    setReady(true);
  }, [key]);
  const set = useCallback(async v => {
    const next = typeof v === "function" ? v(val) : v;
    setVal(next);
    setStatus("saving");
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 1500);
    } catch {
      setStatus("error");
    }
  }, [key, val]);
  return [val, set, ready, status];
}

// مسح كامل لكل بيانات النظام المحفوظة (لإصلاح أي تلف بالبيانات)
function clearAllPersistedData() {
  Object.keys(localStorage).filter(k => k.startsWith("cdt:")).forEach(k => localStorage.removeItem(k));
}

// ═══════════════════════════════════════════════════════════════════
//  🗂️ ترحيل تعدد الخطط (Multi-Plan Migration) — تُنفَّذ مرة واحدة فقط، مباشرة عند تحميل
//  الصفحة (قبل أي Render لـReact)، حتى تكون activePlanId جاهزة قبل أول قراءة لأي حقل بالخطة.
//  حالتان:
//   1) نسخة أقدم (خطة واحدة فقط، مفاتيح ثابتة زي cdt:bom): تُنقَل كل بياناتها لخطة واحدة مُسمّاة
//      "الخطة الأولى" ضمن السجل الجديد — لا يُفقد أي شيء، فقط يتغيّر مكان تخزينه.
//   2) تثبيت جديد كلياً: تُنشأ خطة فارغة واحدة، بنفس فلسفة "يبدأ فارغاً" المُتّبعة بالنظام.
// ═══════════════════════════════════════════════════════════════════
const OLD_FLAT_KEY_MAP = {
  "cdt:planWeeks": "planWeeks",
  "cdt:demand": "demand",
  "cdt:bom": "bom",
  "cdt:inventory": "inventory",
  "cdt:capacity": "capacity",
  "cdt:fgi": "fgi",
  "cdt:engine": "engine",
  "cdt:polog": "polog",
  "cdt:planstartdate": "planstartdate",
  "cdt:planningprofile": "planningprofile"
};
function ensurePlanRegistryMigrated() {
  try {
    if (localStorage.getItem("cdt:plans")) return; // سبق ترحيلها أو تطبيق يستخدم تعدد الخطط أصلاً — لا شيء لفعله
    const hadOldSingleplan = localStorage.getItem("cdt:bom") !== null;
    const newId = "plan_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (hadOldSingleplan) {
      Object.entries(OLD_FLAT_KEY_MAP).forEach(([oldKey, suffix]) => {
        const val = localStorage.getItem(oldKey);
        if (val !== null) localStorage.setItem(`cdt:plan:${newId}:${suffix}`, val);
      });
      // orgLabel لم تكن تُحفَظ إطلاقاً بالنسخة القديمة (كانت useState عادية) — لا يوجد اسم منتج حقيقي لاسترجاعه،
      // فنزرع نفس اسم السجل الافتراضي هنا حتى لا يظهر عنوان الهيدر فارغاً بينما قائمة تبديل الخطط تعرض اسماً
      localStorage.setItem(`cdt:plan:${newId}:orglabel`, JSON.stringify({
        factoryName: "",
        productName: __t("الخطة الأولى (مُرحَّلة)", "First plan (migrated)"),
        fgUnit: ""
      }));
    }
    const registry = [{
      id: newId,
      productName: hadOldSingleplan ? __t("الخطة الأولى (مُرحَّلة)", "First plan (migrated)") : "",
      createdAt: new Date().toISOString().slice(0, 10)
    }];
    localStorage.setItem("cdt:plans", JSON.stringify(registry));
    localStorage.setItem("cdt:activeplanid", JSON.stringify(newId));
  } catch (e) {
    console.error("plan migration failed:", e);
  }
}
ensurePlanRegistryMigrated();

// ═══════════════════════════════════════════════════════════════════
//  RECONCILIATION — يضمن تطابق كل مادة في BOM مع سجل في المخزون
//  (هذا هو الإصلاح الجذري لخطأ "Cannot read properties of undefined")
// ═══════════════════════════════════════════════════════════════════
function normalizeName(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// يوحّد أي صفوف مستوردة (Excel/CSV) مع BOM الحالي بمطابقة الاسم أولاً
// وإن لم يوجد تطابق: يُبقي القيمة القديمة، ولا يترك أي مادة بلا سجل إطلاقاً
function reconcileInventory(importedRows, bom, existingInventory) {
  let matchedCount = 0;
  const rows = importedRows || [];
  const usedIdx = new Set();

  // 1) طابق الصفوف المستوردة مع مواد BOM الموجودة فعلاً — حدّث أرقامها فقط
  const inventory = bom.map(b => {
    const idx = rows.findIndex((r, i) => !usedIdx.has(i) && (normalizeName(r.name) === normalizeName(b.name) || r.id && normalizeName(r.id) === normalizeName(b.id)));
    if (idx !== -1) {
      usedIdx.add(idx);
      matchedCount++;
      const match = rows[idx];
      const prevInv = existingInventory.find(i => i.id === b.id);
      return {
        id: b.id,
        name: b.name,
        unit: b.unit,
        available: Number(match.available) || 0,
        safety: Number(match.safety) || 0,
        leadTime: numOr(match.leadTime, 3),
        maxCapacity: Number(match.maxCapacity) || 999999999,
        unitCost: Number(prevInv?.unitCost) || 0
      };
    }
    const existing = existingInventory.find(i => i.id === b.id);
    return existing || {
      id: b.id,
      name: b.name,
      unit: b.unit,
      available: 0,
      safety: 0,
      leadTime: 3,
      maxCapacity: 999999999
    };
  });

  // 2) أي صف مستورد ما تطابق مع مادة موجودة = مادة جديدة كليًا لهذا المنتج — أسّسيها تلقائيًا
  //    (هذا يسمح ببناء BOM كامل من ملف إكسل واحد، بدل الاقتصار على مطابقة مواد موجودة سلفًا)
  const newBom = [],
    newInv = [];
  rows.forEach((r, i) => {
    if (usedIdx.has(i) || !r.name) return;
    const id = "mat_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + i;
    newBom.push({
      id,
      name: r.name,
      qty: r.qty != null ? Number(r.qty) : 1,
      unit: r.unit || "kg"
    });
    newInv.push({
      id,
      name: r.name,
      unit: r.unit || "kg",
      available: Number(r.available) || 0,
      safety: Number(r.safety) || 0,
      leadTime: numOr(r.leadTime, 3),
      maxCapacity: Number(r.maxCapacity) || 999999999
    });
  });
  return {
    bom: [...bom, ...newBom],
    inventory: [...inventory, ...newInv],
    matchedCount,
    totalBom: bom.length,
    newCount: newBom.length,
    unmatchedCount: bom.length - matchedCount
  };
}

// شبكة أمان: يُصلح تلقائياً أي تعارض قديم بين BOM والمخزون عند الإقلاع
// (يحل مشكلة بيانات تالفة محفوظة مسبقاً في localStorage من محاولة استيراد سابقة)
function autoRepairInventory(bom, inventory) {
  let changed = false;
  const repaired = bom.map(b => {
    const inv = inventory.find(i => i.id === b.id);
    if (inv) return inv;
    changed = true;
    return {
      id: b.id,
      name: b.name,
      unit: b.unit,
      available: 0,
      safety: 0,
      leadTime: 3,
      maxCapacity: 999999999
    };
  });
  return {
    repaired,
    changed
  };
}

// ═══════════════════════════════════════════════════════════════════
//  AI PROVIDERS — مرن: Gemini (مجاني) أو OpenRouter (مجاني جزئياً) أو Claude
// ═══════════════════════════════════════════════════════════════════
// كاش بسيط لتذكّر آخر موديل جيمناي ناجح (لتفادي إعادة الاكتشاف في كل استدعاء)
let _cachedGeminiModel = null;

// يكتشف أي نماذج Gemini متاحة فعلياً لهذا المفتاح (يدعم generateContent)
async function discoverGeminiModels(apiKey) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  if (!r.ok) throw new Error(__tf("تعذّر جلب قائمة نماذج Gemini ({0})", "Could not fetch the Gemini model list ({0})", [r.status]));
  const data = await r.json();
  const names = (data.models || []).filter(m => m.supportedGenerationMethods?.includes("generateContent")).map(m => m.name.replace("models/", ""));
  if (!names.length) throw new Error(__t("لا يوجد أي نموذج Gemini متاح لهذا المفتاح", "No Gemini model is available for this key"));
  // رتّب الأفضل أولاً: flash (أسرع وأرخص) ثم pro ثم أي شيء آخر
  const rank = n => n.includes("flash") ? 0 : n.includes("pro") ? 1 : 2;
  return names.sort((a, b) => rank(a) - rank(b));
}

// قائمة احتياطية مُجرَّبة يدوياً (تُستخدم فقط إن فشل اكتشاف القائمة الحية)
const GEMINI_FALLBACK_CHAIN = ["gemini-2.0-flash", "gemini-1.5-flash-latest", "gemini-1.5-flash", "gemini-1.5-pro-latest", "gemini-1.5-pro", "gemini-pro"];
async function tryGeminiModel(apiKey, model, prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: prompt
        }]
      }]
    })
  });
  if (!r.ok) {
    const err = new Error(`model_failed:${r.status}`);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || __t("لا توجد استجابة من الوكيل", "No response from the agent");
}

// يتصل بأي نوع Gemini متاح تلقائياً — يجرّب: تفضيل المستخدم ← الكاش ← الاكتشاف الحي ← القائمة الاحتياطية
async function callGemini(apiKey, prompt, preferredModel = "") {
  if (!apiKey) throw new Error(__t("لم يتم إدخال مفتاح Gemini API", "No Gemini API key entered"));
  const candidates = [];
  if (preferredModel) candidates.push(preferredModel);
  if (_cachedGeminiModel && _cachedGeminiModel !== preferredModel) candidates.push(_cachedGeminiModel);

  // أضف نتائج الاكتشاف الحي إن أمكن
  try {
    const discovered = await discoverGeminiModels(apiKey);
    discovered.forEach(m => {
      if (!candidates.includes(m)) candidates.push(m);
    });
  } catch {/* تجاهل فشل الاكتشاف، انتقل للقائمة الاحتياطية */}
  GEMINI_FALLBACK_CHAIN.forEach(m => {
    if (!candidates.includes(m)) candidates.push(m);
  });
  let lastErr = null;
  for (const model of candidates) {
    try {
      const text = await tryGeminiModel(apiKey, model, prompt);
      _cachedGeminiModel = model; // نجح — تذكّره للمرة القادمة
      return text;
    } catch (err) {
      lastErr = err;
      continue; // جرّب التالي في القائمة
    }
  }
  throw new Error(__tf("تعذّر الاتصال بأي نموذج Gemini متاح. آخر خطأ: {0}", "Could not connect to any available Gemini model. Last error: {0}", [lastErr?.message || __t("غير معروف", "Unknown")]));
}
async function callOpenRouter(apiKey, model, prompt) {
  if (!apiKey) throw new Error(__t("لم يتم إدخال مفتاح OpenRouter API", "No OpenRouter API key entered"));
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || "meta-llama/llama-3.1-8b-instruct:free",
      messages: [{
        role: "user",
        content: prompt
      }]
    })
  });
  if (!r.ok) throw new Error(`OpenRouter API error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || __t("لا توجد استجابة من الوكيل", "No response from the agent");
}
async function callClaudeDirect(apiKey, prompt) {
  if (!apiKey) throw new Error(__t("لم يتم إدخال مفتاح Anthropic API", "No Anthropic API key entered"));
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5-5",
      max_tokens: 700,
      messages: [{
        role: "user",
        content: prompt
      }]
    })
  });
  if (!r.ok) throw new Error(`Claude API error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  return data.content?.[0]?.text || __t("لا توجد استجابة من الوكيل", "No response from the agent");
}

// تحليل مخرجات الوكيل: نتوقع JSON منظّم (بيانات/قواعد/استدلال/توصية) — مع خطة احتياط
// إذا لم يلتزم النموذج بالصيغة (نص حر بدلاً من JSON)
function parseAgentJSON(raw) {
  if (!raw) return {
    data_reviewed: "",
    rules_applied: "",
    reasoning: "",
    recommendation: ""
  };
  let cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "");
  try {
    const obj = JSON.parse(cleaned);
    // تحقّق دفاعي من suggestion: لازم كائن فيه param+newValue رقمي صالح، وإلا نتجاهله بدل ما نعرض شي مكسور
    let suggestion = null;
    if (obj.suggestion && typeof obj.suggestion === "object" && obj.suggestion.param && Number.isFinite(Number(obj.suggestion.newValue))) {
      suggestion = {
        param: String(obj.suggestion.param),
        newValue: Number(obj.suggestion.newValue),
        why: obj.suggestion.why || ""
      };
    }
    return {
      data_reviewed: obj.data_reviewed || obj["البيانات"] || "",
      rules_applied: obj.rules_applied || obj["القواعد"] || "",
      reasoning: obj.reasoning || obj["الاستدلال"] || "",
      recommendation: obj.recommendation || obj["التوصية"] || cleaned,
      suggestion
    };
  } catch {
    // النموذج رجّع نصاً حراً — نعرضه كتوصية بدون تفكيك، بدل ما نفشل بالكامل
    return {
      data_reviewed: "",
      rules_applied: "",
      reasoning: "",
      recommendation: cleaned,
      suggestion: null
    };
  }
}
// نص مختصر يُستخدم كسياق للوكيل التالي في السلسلة (بدل تمرير JSON كامل)
function agentSummaryText(a) {
  if (!a) return "";
  return [a.reasoning, a.recommendation].filter(Boolean).join(" ← ");
}

// ☁️ يُستدعى فقط لو المستخدم مسجّل دخول سحابياً — يمرّر الطلب لدالة الخادم (Edge Function)
// بدل استدعاء مزوّد الذكاء الاصطناعي مباشرة، فمفتاح API الحقيقي يبقى بالخادم ولا يوصل للمتصفح إطلاقاً
async function callAIProviderViaProxy(supabaseClient, prompt) {
  const {
    data,
    error
  } = await supabaseClient.functions.invoke("ai-proxy", {
    body: {
      prompt
    }
  });
  if (error) throw new Error(__tf("تعذّر الاتصال بخادم الذكاء الاصطناعي: {0}", "Could not connect to the AI server: {0}", [error.message]));
  if (data?.error) throw new Error(data.error);
  if (!data?.text) throw new Error(__t("الخادم رجّع استجابة بلا نص", "The server returned a response with no text"));
  return data.text;
}
async function callAIProvider(apiKeys, prompt, supabaseClient = null) {
  // نصوص الوكلاء مكتوبة بالعربية؛ بالواجهة الإنجليزية نطلب الإجابة بالإنجليزية
  if (__LANG === "en") prompt = prompt + "\n\nIMPORTANT: Write every text value in your JSON answer in English.";
  // الوضع السحابي: مفتاح مركزي على الخادم، المستخدم ما يحتاج يدخل أي مفتاح إطلاقاً
  if (supabaseClient) return callAIProviderViaProxy(supabaseClient, prompt);
  // الوضع المحلي (بلا تسجيل دخول): كل مستخدم يستخدم مفتاحه الشخصي كما كان دائماً
  const provider = apiKeys.provider || "gemini";
  if (provider === "gemini") return callGemini(apiKeys.gemini, prompt, apiKeys.geminiModel);
  if (provider === "openrouter") return callOpenRouter(apiKeys.openrouter, apiKeys.openrouterModel, prompt);
  if (provider === "claude") return callClaudeDirect(apiKeys.claude, prompt);
  throw new Error(__t("مزود ذكاء اصطناعي غير معروف", "Unknown AI provider"));
}

// ═══════════════════════════════════════════════════════════════════
//  EXCEL IMPORT — SheetJS — يقرأ ملف بعدة شيتات
// ═══════════════════════════════════════════════════════════════════
const EXCEL_SHEET_MAP = {
  "المخزون": "inventory",
  "Inventory": "inventory",
  "الطاقة": "capacity",
  "Capacity": "capacity",
  "الآلة": "engine",
  "Machine": "engine",
  "FGI": "fgi",
  "المنتج": "fgi"
};
function parseExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, {
          type: "binary"
        });
        const result = {};
        wb.SheetNames.forEach(sheetName => {
          const key = EXCEL_SHEET_MAP[sheetName.trim()];
          if (!key) return;
          result[key] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
            defval: ""
          });
        });
        resolve({
          result,
          foundSheets: wb.SheetNames
        });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error(__t("فشل قراءة الملف", "Failed to read the file")));
    reader.readAsBinaryString(file);
  });
}

// تطبيع صف عام (أسماء أعمدة مرنة عربي/إنجليزي) — للمخزون فقط (يُطابَق بالاسم لاحقاً)
function normalizeInventoryRow(r) {
  return {
    id: String(r.id || r.material_id || r["المعرف"] || "").trim(),
    name: String(r.name || r.material_name || r["الاسم"] || r["المادة"] || "").trim(),
    qty: r.qty ?? r.qtyPerUnit ?? r["الكمية لكل وحدة"] ?? r["الكمية/وحدة"] ?? null,
    unit: String(r.unit || r["الوحدة"] || "kg").trim(),
    available: Number(r.available || r.current_stock || r["المخزون الحالي"] || 0),
    safety: Number(r.safety || r.safety_stock || r["مخزون الأمان"] || 0),
    leadTime: numOr(r.leadTime ?? r.lead_time_weeks ?? r["مدة التوريد"], 3),
    maxCapacity: Number(r.maxCapacity || r.max_capacity || r["أقصى سعة"] || r["سعة التخزين"] || 999999999)
  };
}
function mapExcelRowsToCapacity(rows) {
  if (!rows?.length) return null;
  const r = rows[0];
  return {
    productionRate: Number(r.productionRate || r.production_rate_hour || r["معدل الإنتاج"] || 100),
    shiftHours: Number(r.shiftHours || r.shift_hours || r["ساعات الوردية"] || 8),
    normalDays: Number(r.normalDays || r.normal_days_per_week || r["أيام العمل"] || 6),
    maxShifts: Number(r.maxShifts || r.max_shifts_per_day || r["أقصى ورديات"] || 3),
    defectRateMin: Number(r.defectRateMin || r.defect_rate_min || r["نسبة العيوب الدنيا"] || r.defectRate || r.defect_rate_pct || r["نسبة العيوب"] || 1.5),
    defectRateMax: Number(r.defectRateMax || r.defect_rate_max || r["نسبة العيوب القصوى"] || r.defectRate || r.defect_rate_pct || r["نسبة العيوب"] || 3.5)
  };
}
function mapExcelRowsToEngine(rows) {
  if (!rows?.length) return null;
  const r = rows[0];
  return {
    intervalHours: Number(r.intervalHours || r.maintenance_interval_hours || r["فترة الصيانة"] || 3000),
    durationHours: Number(r.durationHours || r.maintenance_duration_hours || r["مدة الصيانة"] || 8),
    remainingHours: Number(r.remainingHours || r.remaining_hours_to_maintenance || r["الساعات المتبقية"] || 800)
  };
}
function mapExcelRowsToFGI(rows) {
  if (!rows?.length) return null;
  const r = rows[0];
  return {
    current: Number(r.current || r.current_fgi || r["المخزون الحالي"] || 80000),
    safety: Number(r.safety || r.safety_fgi || r["مخزون الأمان"] || 20000),
    maxWarehouse: Number(r.maxWarehouse || r.max_fgi || r["أقصى سعة"] || 500000),
    mode: "hybrid"
  };
}

// ═══════════════════════════════════════════════════════════════════
//  CSV SYNC — بديل عن Google Sheets API (بلا مفتاح API، بلا مشاكل CORS
//  أو قيود Referrer). يعتمد على "نشر على الويب" العام من جوجل شيتس.
//  File → Share → Publish to web → اختر الشيت → CSV → انسخ الرابط
// ═══════════════════════════════════════════════════════════════════
function parseCSVText(text) {
  const parsed = Papa.parse(text.trim(), {
    header: true,
    skipEmptyLines: true
  });
  return parsed.data;
}
async function fetchPublishedCSV(url) {
  if (!url) return null;
  const r = await fetch(url);
  if (!r.ok) throw new Error(__tf("فشل الجلب ({0}) — تأكد أن الرابط منشور للعامة (Publish to web)", "Fetch failed ({0}) — make sure the link is published publicly (Publish to web)", [r.status]));
  const text = await r.text();
  return parseCSVText(text);
}

// ═══════════════════════════════════════════════════════════════════
//  PDF REPORT — بدون صيانة دورية (أُزيلت) | يعرض قيود سعة التخزين
// ═══════════════════════════════════════════════════════════════════
function generatePDF(mps, mrp, postPlan, nextRec, agentOutputs, engineData, fgiData, planWeeks, feasibility, costAnalysis, productName = __t("المنتج", "Product"), fgUnit = __t("وحدة", "unit")) {
  const now = new Date().toLocaleDateString(__LANG === "en" ? "en-GB" : "ar-SA", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const totalDemand = mps.reduce((s, m) => s + m.demand, 0);
  const avgUtil = (mps.reduce((s, m) => s + m.util, 0) / mps.length).toFixed(1);
  const overloaded = mps.filter(m => !m.feasible).length;
  const stockouts = mrp.flatMap(m => m.weeks.filter(w => w.stockout)).length;
  const totalScrap = mps.reduce((s, m) => s + (m.scrapUnits || 0), 0);
  const materialConstrainedWeeks = mps.filter(m => m.materialConstrained);
  const fgiRows = mps.filter(m => m.fgAfter !== null).map(m => `<tr style="border-bottom:1px solid #e2e8f0;${m.fgBelowSafety ? "background:#fff5f5" : ""}">
    <td>${m.week}</td><td>${m.demand.toLocaleString()}</td><td>${m.production.toLocaleString()}</td>
    <td>${m.defectRateUsed ?? "-"}%</td><td style="color:#dc2626">${(m.scrapUnits || 0).toLocaleString()}</td>
    <td>${(m.goodUnits ?? m.production).toLocaleString()}</td>
    <td style="color:${m.fgBelowSafety ? "#dc2626" : "#16a34a"};font-weight:bold">${m.fgAfter?.toLocaleString() ?? "-"}</td>
    <td>${m.fgBelowSafety ? __t("⚠️ دون الأمان", "⚠️ Below safety") : "✓"}</td></tr>`).join("");
  const engineSection = engineData ? __tf("<h2>⏱️ صيانة الآلة (ساعات التشغيل) — المصدر الوحيد للصيانة الدورية</h2>\n    <div style=\"background:#f5f3ff;border:1px solid #ddd6fe;border-radius:6px;padding:12px;font-size:11px\">\n      <div><b>الصيانة كل:</b> {0} ساعة تشغيل | <b>مدة الصيانة:</b> {1}h | <b>المتبقي عند بدء الخطة:</b> {2}h</div>\n      <div style=\"margin-top:6px\"><b>الصيانة في هذه الخطة:</b> {3}</div>\n    </div>", "<h2>⏱️ Machine maintenance (operating hours) — the only source of periodic maintenance</h2>\n    <div style=\"background:#f5f3ff;border:1px solid #ddd6fe;border-radius:6px;padding:12px;font-size:11px\">\n      <div><b>Maintenance every:</b> {0} operating hours | <b>Maintenance duration:</b> {1}h | <b>Remaining at plan start:</b> {2}h</div>\n      <div style=\"margin-top:6px\"><b>Maintenance in this plan:</b> {3}</div>\n    </div>", [(engineData.intervalHours ?? 0).toLocaleString(), engineData.durationHours ?? "-", engineData.remainingHours ?? "-", engineData.maintenanceDone ? __tf("<span style=\"color:#7c3aed\">نعم — في {0} {1} | المتبقي بعد الخطة: {2}h — الورديات زيدت تلقائياً في MPS لتعويض الوقت المفقود.</span>", "<span style=\"color:#7c3aed\">Yes — in {0} {1} | Remaining after the plan: {2}h — shifts were increased automatically in the MPS to make up for the lost time.</span>", [engineData.maintenanceWeeks?.length > 1 ? __t("الأسابيع", "weeks") : __t("الأسبوع", "week"), engineData.maintenanceWeeks?.join(__t("، ", ", ")) || engineData.maintenanceWeek, engineData.postPlanRemaining]) : __tf("<span style=\"color:#16a34a\">لا — المتبقي بعد الخطة: {0}h</span>", "<span style=\"color:#16a34a\">No — remaining after the plan: {0}h</span>", [engineData.postPlanRemaining ?? "-"])]) : "";
  const materialConstraintSection = materialConstrainedWeeks.length ? __tf("<h2>🚫 نقص مادة خام حرج (يحد الإنتاج فعلياً)</h2>\n    <div style=\"background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px;font-size:11px\">\n      الأسابيع التالية لا تحقق الإنتاج المستهدف بسبب نقص مادة خام فات أوان طلبها ضمن أفق الخطة:\n      <b>{0}</b>. هذا يؤثر تلقائياً على FGI والجدوى (انظر أدناه).\n    </div>", "<h2>🚫 Critical raw-material shortage (effectively limits production)</h2>\n    <div style=\"background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px;font-size:11px\">\n      The following weeks do not reach the target production because of a raw-material shortage whose order deadline fell within the plan horizon:\n      <b>{0}</b>. This automatically affects FGI and feasibility (see below).\n    </div>", [materialConstrainedWeeks.map(m => m.week).join(", ")]) : "";
  const fgiSection = fgiData ? __tf("<h2>🔄 مخزون المنتج النهائي FGI</h2>\n    <div style=\"background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:8px;margin-bottom:8px;font-size:11px\">\n      <b>وضع الإنتاج:</b> {0} | <b>الحد الأدنى:</b> {1} {2} |\n      <b>نهاية الخطة:</b> <span style=\"color:{3};font-weight:bold\">{4}</span> {5} |\n      <b>إجمالي الهالك (لا يدخل FGI):</b> <span style=\"color:#dc2626\">{6}</span>\n    </div>\n    <table style=\"width:100%;border-collapse:collapse;font-size:10px\"><thead>\n    <tr style=\"background:#dcfce7\"><th>الأسبوع</th><th>الطلب</th><th>إجمالي</th><th>عيوب%</th><th>هالك</th><th>وحدات جيدة</th><th>FGI بعد</th><th>حالة</th></tr></thead>\n    <tbody>{7}</tbody></table>", "<h2>🔄 Finished-goods inventory FGI</h2>\n    <div style=\"background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:8px;margin-bottom:8px;font-size:11px\">\n      <b>Production mode:</b> {0} | <b>Minimum:</b> {1} {2} |\n      <b>End of plan:</b> <span style=\"color:{3};font-weight:bold\">{4}</span> {5} |\n      <b>Total scrap (does not enter FGI):</b> <span style=\"color:#dc2626\">{6}</span>\n    </div>\n    <table style=\"width:100%;border-collapse:collapse;font-size:10px\"><thead>\n    <tr style=\"background:#dcfce7\"><th>Week</th><th>Demand</th><th>Gross</th><th>Defect%</th><th>Scrap</th><th>Good units</th><th>FGI after</th><th>Status</th></tr></thead>\n    <tbody>{7}</tbody></table>", [fgiData.mode, (fgiData.safety ?? 0).toLocaleString(), fgUnit, fgiData.endOfPlan < fgiData.safety ? "#dc2626" : "#16a34a", (fgiData.endOfPlan ?? 0).toLocaleString(), fgUnit, totalScrap.toLocaleString(), fgiRows]) : "";
  const feasSection = feasibility ? __tf("<h2>📊 تقرير الجدوى</h2>\n    <div style=\"background:{0};border:1px solid {1};border-radius:6px;padding:10px;font-size:11px;margin-bottom:8px\">\n      <b>النتيجة: {2}/100</b> — {3} (اجتاز {4}/{5})\n    </div>\n    <table style=\"width:100%;border-collapse:collapse;font-size:10px\"><thead><tr style=\"background:#e2e8f0\"><th>المعيار</th><th>التفاصيل</th><th>النتيجة</th></tr></thead>\n    <tbody>{6}</tbody></table>", "<h2>📊 Feasibility report</h2>\n    <div style=\"background:{0};border:1px solid {1};border-radius:6px;padding:10px;font-size:11px;margin-bottom:8px\">\n      <b>Score: {2}/100</b> — {3} (passed {4}/{5})\n    </div>\n    <table style=\"width:100%;border-collapse:collapse;font-size:10px\"><thead><tr style=\"background:#e2e8f0\"><th>Criterion</th><th>Details</th><th>Result</th></tr></thead>\n    <tbody>{6}</tbody></table>", [feasibility.score >= 80 ? "#f0fdf4" : feasibility.score >= 60 ? "#fffbeb" : "#fef2f2", feasibility.score >= 80 ? "#bbf7d0" : feasibility.score >= 60 ? "#fde68a" : "#fecaca", feasibility.score, feasibility.verdict, feasibility.passCount, feasibility.totalCount, feasibility.criteria.map(c => `<tr style="border-bottom:1px solid #e2e8f0"><td>${c.name}</td><td>${c.detail}</td><td style="color:${c.pass ? "#16a34a" : "#dc2626"}">${c.pass ? "✓" : "✗"}</td></tr>`).join("")]) : "";
  const costSection = costAnalysis ? __tf("<h2>💵 ملخص التكاليف</h2>\n    <table style=\"width:100%;border-collapse:collapse;font-size:10px\"><thead><tr style=\"background:#e0e7ff\"><th>البند</th><th>القيمة (ريال)</th><th>%</th></tr></thead>\n    <tbody>{0}\n    <tr style=\"font-weight:bold;background:#f1f5f9\"><td>الإجمالي</td><td>{1}</td><td>100%</td></tr></tbody></table>", "<h2>💵 Cost summary</h2>\n    <table style=\"width:100%;border-collapse:collapse;font-size:10px\"><thead><tr style=\"background:#e0e7ff\"><th>Item</th><th>Value (riyal)</th><th>%</th></tr></thead>\n    <tbody>{0}\n    <tr style=\"font-weight:bold;background:#f1f5f9\"><td>Total</td><td>{1}</td><td>100%</td></tr></tbody></table>", [costAnalysis.breakdown.map(c => `<tr style="border-bottom:1px solid #e2e8f0"><td>${c.name}</td><td>${c.value.toLocaleString(undefined, {
    maximumFractionDigits: 0
  })}</td><td>${c.pct.toFixed(1)}%</td></tr>`).join(""), costAnalysis.total.toLocaleString(undefined, {
    maximumFractionDigits: 0
  })]) : "";
  const mpsRows = mps.map(m => `<tr style="border-bottom:1px solid #e2e8f0;${m.materialConstrained ? "background:#fef2f2" : !m.feasible ? "background:#fff5f5" : ""}">
    <td>${m.week}${engineData?.maintenanceWeeks?.includes(m.week) ? " ⏱" : ""}${m.materialConstrained ? " 🚫" : ""}</td><td>${m.demand.toLocaleString()}</td><td>${m.production.toLocaleString()}</td>
    <td>${m.shifts}</td><td>${m.workDays}${m.otDaysUsed > 0 ? ` (+${m.otDaysUsed})` : ""}</td>
    <td>${m.loadH}h</td><td>${m.spareH}h</td>
    <td style="color:${m.util > 100 ? "#dc2626" : m.util > 85 ? "#d97706" : "#16a34a"};font-weight:bold">${m.util}%</td>
    <td>${m.materialConstrained ? __t("🚫 نقص مادة خام", "🚫 Material shortage") : !m.feasible ? __t("✗ متعذر", "✗ Infeasible") : m.otDaysUsed > 0 ? "⏱ OT" : __t("✓ ممكن", "✓ Feasible")}</td></tr>`).join("");
  const mrpSec = mrp.map(mat => __tf("<h3 style=\"color:#1e40af;font-size:12px;margin-top:16px\">📦 {0} | توريد:{1}W | سعة قصوى: {2} {3}</h3>\n    <table style=\"width:100%;border-collapse:collapse;font-size:10px\"><thead>\n    <tr style=\"background:#dbeafe\"><th>W</th><th>إجمالي</th><th>متاح</th><th>صافي</th><th>طلب</th><th>نهاية</th><th>إصدار (خلفي)</th><th>حالة</th></tr></thead><tbody>\n    {4}\n    </tbody></table>", "<h3 style=\"color:#1e40af;font-size:12px;margin-top:16px\">📦 {0} | Lead time:{1}W | Max capacity: {2} {3}</h3>\n    <table style=\"width:100%;border-collapse:collapse;font-size:10px\"><thead>\n    <tr style=\"background:#dbeafe\"><th>W</th><th>Gross</th><th>Available</th><th>Net</th><th>Order</th><th>End</th><th>Release (backward)</th><th>Status</th></tr></thead><tbody>\n    {4}\n    </tbody></table>", [mat.name, mat.inv?.leadTime ?? "-", (mat.inv?.maxCapacity || 0).toLocaleString(), mat.unit, mat.weeks.map(w => `<tr style="border-bottom:1px solid #e2e8f0;${w.stockout ? "background:#fff5f5" : ""}">
    <td>${w.week}</td><td>${w.gross.toLocaleString()}</td><td>${w.available.toLocaleString()}</td>
    <td>${w.netReq > 0 ? w.netReq.toLocaleString() : "—"}</td>
    <td style="color:#16a34a;font-weight:bold">${w.tooLateToOrder ? __tf("<span style=\"color:#dc2626\">عجز {0}</span>", "<span style=\"color:#dc2626\">Shortfall {0}</span>", [(w.unmetNeed || 0).toLocaleString()]) : w.order > 0 ? w.order.toLocaleString() : "—"}${w.capacityConstrained ? " ⚠️" : ""}${w.usedEOQ ? " 🎯" : ""}</td>
    <td>${w.ending.toLocaleString()}</td><td style="color:#2563eb">${w.tooLateToOrder ? __t("متأخر", "Late") : w.order > 0 ? w.orderWeek : "—"}</td>
    <td style="color:${w.stockout ? "#dc2626" : "#16a34a"}">${w.stockout ? "⚠️" : "✓"}</td></tr>`).join("")])).join("");
  const nextRows = (nextRec || []).map(r => `<tr style="border-bottom:1px solid #e2e8f0">
    <td>${r.name}</td><td style="color:${r.endingStock < 0 ? "#dc2626" : "#000"};font-weight:${r.endingStock < 0 ? "bold" : "normal"}">${r.endingStock.toLocaleString()}${r.endingStock < 0 ? __t(" (عجز)", " (shortfall)") : ""}</td><td>${r.unit}</td>
    <td>${r.weeksLeft}</td><td style="color:#16a34a;font-weight:bold">${r.needsOrder ? r.recommendedQty.toLocaleString() : "—"}${r.capacityConstrained ? __t(" ⚠️سعة", " ⚠️Cap") : ""}</td>
    <td>${r.urgency}</td></tr>`).join("");
  const aiSection = agentOutputs?.a4 ? __tf("<h2>🤖 توصية كبير المخططين (AI)</h2>\n    {0}\n    <div style=\"background:#f8fafc;border:1px solid #cbd5e1;border-radius:6px;padding:12px;font-size:11px;line-height:1.8;white-space:pre-wrap\">{1}</div>", "<h2>🤖 Chief planner's recommendation (AI)</h2>\n    {0}\n    <div style=\"background:#f8fafc;border:1px solid #cbd5e1;border-radius:6px;padding:12px;font-size:11px;line-height:1.8;white-space:pre-wrap\">{1}</div>", [agentOutputs.a4.data_reviewed || agentOutputs.a4.rules_applied || agentOutputs.a4.reasoning ? `
    <div style="background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;padding:10px;font-size:10px;line-height:1.8;margin-bottom:8px">
      ${agentOutputs.a4.data_reviewed ? __tf("<div><b>🔍 البيانات التي روجعت:</b> {0}</div>", "<div><b>🔍 Data reviewed:</b> {0}</div>", [agentOutputs.a4.data_reviewed]) : ""}
      ${agentOutputs.a4.rules_applied ? __tf("<div><b>⚖️ القاعدة المطبّقة:</b> {0}</div>", "<div><b>⚖️ Rule applied:</b> {0}</div>", [agentOutputs.a4.rules_applied]) : ""}
      ${agentOutputs.a4.reasoning ? __tf("<div><b>🧠 خطوات الاستدلال:</b> {0}</div>", "<div><b>🧠 Reasoning steps:</b> {0}</div>", [agentOutputs.a4.reasoning]) : ""}
    </div>` : "", agentOutputs.a4.recommendation || ""]) : "";
  const html = __tf("<!DOCTYPE html><html dir=\"rtl\" lang=\"ar\"><head><meta charset=\"UTF-8\">\n<title>تقرير CDT-PPC — {0}</title>\n<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',Tahoma,sans-serif;color:#1e293b;direction:rtl;font-size:11px}\n.page{max-width:960px;margin:0 auto;padding:24px 18px}h1{font-size:17px;color:#1e3a8a;border-bottom:3px solid #2563eb;padding-bottom:8px;margin-bottom:4px}\nh2{font-size:13px;color:#1e40af;margin:20px 0 6px;border-right:4px solid #2563eb;padding-right:8px}\n.meta{font-size:10px;color:#64748b;margin-bottom:14px}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}\n.kpi{border:1px solid #e2e8f0;border-radius:5px;padding:8px;text-align:center}.kpi-v{font-size:18px;font-weight:800;font-family:monospace}\ntable{width:100%;border-collapse:collapse;font-size:10px;margin-bottom:6px}th{background:#dbeafe;color:#1e3a8a;padding:4px 6px;text-align:right}\ntd{padding:3px 6px;text-align:right}.footer{margin-top:20px;border-top:1px solid #e2e8f0;padding-top:8px;font-size:9px;color:#94a3b8;text-align:center}\n@media print{.page{padding:10px}}</style></head><body><div class=\"page\">\n<h1>🏭 تقرير تخطيط الإنتاج والتحكم — {1}</h1>\n<div class=\"meta\">التاريخ: {2} | أفق التخطيط: {3} أسابيع (مرن) | نظام التوأم الرقمي المعرفي CDT-PPC</div>\n<div class=\"kpis\">\n  <div class=\"kpi\"><div class=\"kpi-v\" style=\"color:#2563eb\">{4}</div><div>الطلب الإجمالي</div></div>\n  <div class=\"kpi\"><div class=\"kpi-v\" style=\"color:{5}\">{6}%</div><div>متوسط الاستخدام</div></div>\n  <div class=\"kpi\"><div class=\"kpi-v\" style=\"color:{7}\">{8}</div><div>أسابيع متعذرة</div></div>\n  <div class=\"kpi\"><div class=\"kpi-v\" style=\"color:{9}\">{10}</div><div>تنبيهات نقص</div></div>\n</div>\n{11}\n<h2>📋 MPS + الورديات</h2>\n<table><thead><tr><th>W</th><th>الطلب</th><th>الإنتاج</th><th>الورديات</th><th>الأيام</th><th>حمل</th><th>حر</th><th>%</th><th>حالة</th></tr></thead><tbody>{12}</tbody></table>\n{13}\n{14}\n{15}\n<h2>🔧 MRP — متطلبات المواد (جدولة خلفية Backward Scheduling)</h2>{16}\n{17}\n{18}\n{19}\n<div class=\"footer\">تم إنشاؤه بواسطة نظام التوأم الرقمي المعرفي (CDT-PPC) | {20}</div>\n</div><script>window.onload=()=>window.print()<\/script></body></html>", "<!DOCTYPE html><html dir=\"ltr\" lang=\"en\"><head><meta charset=\"UTF-8\">\n<title>CDT-PPC report — {0}</title>\n<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',Tahoma,sans-serif;color:#1e293b;direction:ltr;font-size:11px}\n.page{max-width:960px;margin:0 auto;padding:24px 18px}h1{font-size:17px;color:#1e3a8a;border-bottom:3px solid #2563eb;padding-bottom:8px;margin-bottom:4px}\nh2{font-size:13px;color:#1e40af;margin:20px 0 6px;border-left:4px solid #2563eb;padding-left:8px}\n.meta{font-size:10px;color:#64748b;margin-bottom:14px}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}\n.kpi{border:1px solid #e2e8f0;border-radius:5px;padding:8px;text-align:center}.kpi-v{font-size:18px;font-weight:800;font-family:monospace}\ntable{width:100%;border-collapse:collapse;font-size:10px;margin-bottom:6px}th{background:#dbeafe;color:#1e3a8a;padding:4px 6px;text-align:left}\ntd{padding:3px 6px;text-align:left}.footer{margin-top:20px;border-top:1px solid #e2e8f0;padding-top:8px;font-size:9px;color:#94a3b8;text-align:center}\n@media print{.page{padding:10px}}</style></head><body><div class=\"page\">\n<h1>🏭 Production planning & control report — {1}</h1>\n<div class=\"meta\">Date: {2} | Planning horizon: {3} weeks (flexible) | Cognitive Digital Twin system CDT-PPC</div>\n<div class=\"kpis\">\n  <div class=\"kpi\"><div class=\"kpi-v\" style=\"color:#2563eb\">{4}</div><div>Total demand</div></div>\n  <div class=\"kpi\"><div class=\"kpi-v\" style=\"color:{5}\">{6}%</div><div>Average utilization</div></div>\n  <div class=\"kpi\"><div class=\"kpi-v\" style=\"color:{7}\">{8}</div><div>Infeasible weeks</div></div>\n  <div class=\"kpi\"><div class=\"kpi-v\" style=\"color:{9}\">{10}</div><div>Shortage alerts</div></div>\n</div>\n{11}\n<h2>📋 MPS + Shifts</h2>\n<table><thead><tr><th>W</th><th>Demand</th><th>Production</th><th>Shifts</th><th>Days</th><th>Load</th><th>Free</th><th>%</th><th>Status</th></tr></thead><tbody>{12}</tbody></table>\n{13}\n{14}\n{15}\n<h2>🔧 MRP — Material requirements (Backward Scheduling)</h2>{16}\n{17}\n{18}\n{19}\n<div class=\"footer\">Generated by the Cognitive Digital Twin system (CDT-PPC) | {20}</div>\n</div><script>window.onload=()=>window.print()<\/script></body></html>", [productName, productName, now, planWeeks, totalDemand.toLocaleString(), parseFloat(avgUtil) > 85 ? "#d97706" : "#16a34a", avgUtil, overloaded > 0 ? "#dc2626" : "#16a34a", overloaded, stockouts > 0 ? "#d97706" : "#16a34a", stockouts, feasSection, mpsRows, materialConstraintSection, fgiSection, engineSection, mrpSec, nextRec?.some(r => r.needsOrder) ? __tf("<h2>📦 توصيات الشهر القادم</h2><table><thead><tr><th>المادة</th><th>نهاية</th><th>الوحدة</th><th>يكفي(W)</th><th>طلب موصى</th><th>أولوية</th></tr></thead><tbody>{0}</tbody></table>", "<h2>📦 Next-month recommendations</h2><table><thead><tr><th>Material</th><th>End</th><th>Unit</th><th>Lasts(W)</th><th>Recommended order</th><th>Priority</th></tr></thead><tbody>{0}</tbody></table>", [nextRows]) : "", costSection, aiSection, now]);
  try {
    const w = window.open("", "_blank");
    if (!w) {
      alert(__t("⚠️ المتصفح منع فتح نافذة التقرير (Popup Blocker). يرجى السماح بالنوافذ المنبثقة لهذا الموقع والمحاولة مجدداً.", "⚠️ The browser blocked the report window from opening (Popup Blocker). Please allow pop-ups for this site and try again."));
      return;
    }
    w.document.write(html);
    w.document.close();
  } catch (err) {
    alert(__t("⚠️ تعذّر إنشاء التقرير: ", "⚠️ Could not generate the report: ") + err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  EMAIL — إرسال ملخص الخطة عبر تطبيق البريد الافتراضي (mailto)
// ═══════════════════════════════════════════════════════════════════
function buildPlanEmail({
  to,
  mps,
  kpi,
  agentOutputs,
  planWeeks,
  productName = __t("المنتج", "Product")
}) {
  const subject = __tf("خطة إنتاج {0} — {1} أسابيع — استخدام {2}%", "{0} production plan — {1} weeks — utilization {2}%", [productName, planWeeks, kpi.avgUtil]);
  const lines = [__tf("ملخص خطة الإنتاج — {0}", "Production plan summary — {0}", [productName]), ``, __tf("أفق التخطيط: {0} أسابيع", "Planning horizon: {0} weeks", [planWeeks]), __tf("إجمالي الطلب: {0} وحدة", "Total demand: {0} units", [kpi.totalDemand?.toLocaleString()]), __tf("متوسط استخدام الطاقة: {0}%", "Average capacity utilization: {0}%", [kpi.avgUtil]), __tf("أسابيع متعذرة: {0}", "Infeasible weeks: {0}", [kpi.overloaded]), __tf("تنبيهات نقص مخزون: {0}", "Stock shortage alerts: {0}", [kpi.stockouts]), ``, agentOutputs?.a4 ? __tf("قرار كبير المخططين:\n{0}", "Chief planner's decision:\n{0}", [agentOutputs.a4.recommendation || ""]) : "", ``, __t("— تم إرسال هذا الملخص من نظام CDT-PPC. يُرجى إرفاق ملف PDF التفصيلي يدوياً (صُدِّر من تبويب التقارير).", "— This summary was sent from the CDT-PPC system. Please attach the detailed PDF file manually (exported from the Reports tab).")].filter(Boolean).join("\n");
  return {
    subject,
    body: lines
  };
}
function openMailClient({
  to,
  subject,
  body
}) {
  const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = url;
}

// ═══════════════════════════════════════════════════════════════════
//  UI ATOMS
// ═══════════════════════════════════════════════════════════════════
const Badge = ({
  ok,
  warn,
  label
}) => {
  const c = ok ? "bg-emerald-900/60 text-emerald-300 border-emerald-700" : warn ? "bg-amber-900/60 text-amber-300 border-amber-700" : "bg-red-900/60 text-red-300 border-red-700";
  return /*#__PURE__*/React.createElement("span", {
    className: `text-xs px-2 py-0.5 rounded border font-medium ${c}`
  }, label);
};
const KPI = ({
  icon,
  label,
  value,
  color = "blue"
}) => {
  const c = {
    blue: "text-blue-400 border-blue-800 bg-blue-950/40",
    green: "text-emerald-400 border-emerald-800 bg-emerald-950/40",
    red: "text-red-400 border-red-800 bg-red-950/40",
    amber: "text-amber-400 border-amber-800 bg-amber-950/40",
    purple: "text-purple-400 border-purple-800 bg-purple-950/40"
  }[color];
  return /*#__PURE__*/React.createElement("div", {
    className: `rounded-xl border p-3 ${c}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-lg"
  }, icon), /*#__PURE__*/React.createElement("div", {
    className: "text-xl font-bold font-mono"
  }, value), /*#__PURE__*/React.createElement("div", {
    className: "text-xs mt-1 opacity-80"
  }, label));
};
const SH = ({
  children
}) => /*#__PURE__*/React.createElement("h2", {
  className: "text-sm font-bold text-slate-200 mb-3 pb-2 border-b border-slate-700"
}, children);
const TT = ({
  payload,
  label
}) => {
  if (!payload?.length) return null;
  return /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 border border-slate-600 rounded-lg p-2 text-xs shadow-xl"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-slate-400 mb-1"
  }, label), payload.map((p, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      color: p.color
    }
  }, p.name, ": ", /*#__PURE__*/React.createElement("span", {
    className: "font-mono font-bold"
  }, p.value?.toLocaleString?.()))));
};
const Field = ({
  label,
  value,
  onChange,
  step = 1
}) => /*#__PURE__*/React.createElement("div", {
  className: "flex flex-col gap-1"
}, /*#__PURE__*/React.createElement("label", {
  className: "text-xs text-slate-400"
}, label), /*#__PURE__*/React.createElement("input", {
  type: "number",
  value: value,
  step: step,
  onChange: e => onChange(Number(e.target.value)),
  className: "bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-slate-100 text-xs focus:border-blue-500 focus:outline-none w-full font-mono"
}));
const TextField = ({
  label,
  value,
  onChange,
  placeholder,
  mono = true
}) => /*#__PURE__*/React.createElement("div", {
  className: "flex flex-col gap-1"
}, /*#__PURE__*/React.createElement("label", {
  className: "text-xs text-slate-400"
}, label), /*#__PURE__*/React.createElement("input", {
  type: "text",
  value: value,
  placeholder: placeholder,
  onChange: e => onChange(e.target.value),
  dir: mono ? "ltr" : "rtl",
  className: `bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-slate-100 text-xs focus:border-blue-500 focus:outline-none w-full ${mono ? "font-mono" : ""}`
}));

// ═══════════════════════════════════════════════════════════════════
//  CUSTOM SVG CHARTS — بديل خفيف عن Recharts (بدون أي مكتبة خارجية)
// ═══════════════════════════════════════════════════════════════════
const fmtK = v => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}K` : `${v}`;
function MiniBarChart({
  data,
  valueKey,
  colorFn,
  height = 190,
  refLines = [],
  legend = [],
  yFormat = fmtK
}) {
  const w = 760,
    h = height;
  const pad = {
    top: 12,
    right: 14,
    bottom: 26,
    left: 46
  };
  const innerW = w - pad.left - pad.right,
    innerH = h - pad.top - pad.bottom;
  const maxVal = Math.max(1, ...data.map(d => d[valueKey] || 0), ...refLines.map(r => r.value || 0));
  const gap = innerW / Math.max(1, data.length);
  const barW = Math.min(38, gap * 0.6);
  const yOf = v => pad.top + innerH - v / maxVal * innerH;
  const [hover, setHover] = useState(null);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${w} ${h}`,
    style: {
      width: "100%",
      height: `${h}px`,
      display: "block"
    }
  }, [0, 0.25, 0.5, 0.75, 1].map((f, i) => /*#__PURE__*/React.createElement("g", {
    key: i
  }, /*#__PURE__*/React.createElement("line", {
    x1: pad.left,
    x2: w - pad.right,
    y1: pad.top + innerH * (1 - f),
    y2: pad.top + innerH * (1 - f),
    stroke: "#1E293B",
    strokeWidth: "1"
  }), /*#__PURE__*/React.createElement("text", {
    x: pad.left - 6,
    y: pad.top + innerH * (1 - f) + 3,
    fill: "#64748B",
    fontSize: "9",
    textAnchor: "end"
  }, yFormat(Math.round(maxVal * f))))), refLines.map((r, i) => /*#__PURE__*/React.createElement("g", {
    key: i
  }, /*#__PURE__*/React.createElement("line", {
    x1: pad.left,
    x2: w - pad.right,
    y1: yOf(r.value),
    y2: yOf(r.value),
    stroke: r.color || "#EF4444",
    strokeDasharray: "5 3",
    strokeWidth: "1.5"
  }), /*#__PURE__*/React.createElement("text", {
    x: w - pad.right,
    y: yOf(r.value) - 4,
    fill: r.color || "#EF4444",
    fontSize: "9",
    textAnchor: "end"
  }, r.label))), data.map((d, i) => {
    const x = pad.left + i * gap + (gap - barW) / 2;
    const val = d[valueKey] || 0;
    const barH = Math.max(0, val / maxVal * innerH);
    const y = pad.top + innerH - barH;
    return /*#__PURE__*/React.createElement("g", {
      key: i,
      onMouseEnter: () => setHover(i),
      onMouseLeave: () => setHover(null),
      style: {
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement("rect", {
      x: x,
      y: pad.top,
      width: barW,
      height: innerH,
      fill: "transparent"
    }), /*#__PURE__*/React.createElement("rect", {
      x: x,
      y: y,
      width: barW,
      height: barH,
      fill: colorFn ? colorFn(d, i) : "#3B82F6",
      rx: "3",
      opacity: hover === null || hover === i ? 1 : 0.4
    }), /*#__PURE__*/React.createElement("text", {
      x: x + barW / 2,
      y: h - pad.bottom + 14,
      fill: "#64748B",
      fontSize: "9",
      textAnchor: "middle"
    }, d.week));
  })), hover !== null && /*#__PURE__*/React.createElement("div", {
    className: "absolute bg-slate-800 border border-slate-600 rounded-lg p-2 text-xs shadow-xl pointer-events-none",
    style: {
      top: 4,
      right: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-slate-400"
  }, data[hover].week), /*#__PURE__*/React.createElement("div", {
    className: "font-mono font-bold text-slate-100"
  }, (data[hover][valueKey] || 0).toLocaleString())), legend.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "flex gap-3 mt-1 text-xs text-slate-500 flex-wrap"
  }, legend.map((l, i) => /*#__PURE__*/React.createElement("span", {
    key: i
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: l.color
    }
  }, "\u25A0"), " ", l.label))));
}
function MiniLineChart({
  data,
  valueKey,
  secondaryKey = null,
  color = "#60A5FA",
  secondaryColor = "#34D399",
  height = 150,
  refLines = [],
  yFormat = fmtK
}) {
  const w = 760,
    h = height;
  const pad = {
    top: 12,
    right: 14,
    bottom: 26,
    left: 46
  };
  const innerW = w - pad.left - pad.right,
    innerH = h - pad.top - pad.bottom;
  const allVals = data.map(d => d[valueKey]).filter(v => v != null).concat(secondaryKey ? data.map(d => d[secondaryKey]).filter(v => v != null) : []).concat(refLines.map(r => r.value));
  const maxVal = Math.max(1, ...allVals);
  const minVal = Math.min(0, ...allVals);
  const range = maxVal - minVal || 1;
  const xStep = innerW / Math.max(1, data.length - 1);
  const yOf = v => pad.top + innerH - (v - minVal) / range * innerH;
  const xOf = i => pad.left + i * xStep;
  const [hover, setHover] = useState(null);
  const pathFor = key => data.map((d, i) => d[key] == null ? null : `${i === 0 ? "M" : "L"} ${xOf(i)} ${yOf(d[key])}`).filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${w} ${h}`,
    style: {
      width: "100%",
      height: `${h}px`,
      display: "block"
    }
  }, [0, 0.5, 1].map((f, i) => /*#__PURE__*/React.createElement("line", {
    key: i,
    x1: pad.left,
    x2: w - pad.right,
    y1: pad.top + innerH * f,
    y2: pad.top + innerH * f,
    stroke: "#1E293B",
    strokeWidth: "1"
  })), refLines.map((r, i) => /*#__PURE__*/React.createElement("g", {
    key: i
  }, /*#__PURE__*/React.createElement("line", {
    x1: pad.left,
    x2: w - pad.right,
    y1: yOf(r.value),
    y2: yOf(r.value),
    stroke: r.color || "#EF4444",
    strokeDasharray: "5 3",
    strokeWidth: "1.5"
  }), /*#__PURE__*/React.createElement("text", {
    x: w - pad.right,
    y: yOf(r.value) - 4,
    fill: r.color || "#EF4444",
    fontSize: "9",
    textAnchor: "end"
  }, r.label))), /*#__PURE__*/React.createElement("path", {
    d: pathFor(valueKey),
    fill: "none",
    stroke: color,
    strokeWidth: "2.5"
  }), secondaryKey && /*#__PURE__*/React.createElement("path", {
    d: pathFor(secondaryKey),
    fill: "none",
    stroke: secondaryColor,
    strokeWidth: "1.5",
    strokeDasharray: "4 2"
  }), data.map((d, i) => d[valueKey] != null && /*#__PURE__*/React.createElement("circle", {
    key: i,
    cx: xOf(i),
    cy: yOf(d[valueKey]),
    r: hover === i ? 5 : 3,
    fill: color,
    style: {
      cursor: "pointer"
    },
    onMouseEnter: () => setHover(i),
    onMouseLeave: () => setHover(null)
  })), data.map((d, i) => /*#__PURE__*/React.createElement("text", {
    key: i,
    x: xOf(i),
    y: h - pad.bottom + 14,
    fill: "#64748B",
    fontSize: "9",
    textAnchor: "middle"
  }, d.week))), hover !== null && /*#__PURE__*/React.createElement("div", {
    className: "absolute bg-slate-800 border border-slate-600 rounded-lg p-2 text-xs shadow-xl pointer-events-none",
    style: {
      top: 4,
      right: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-slate-400"
  }, data[hover].week), /*#__PURE__*/React.createElement("div", {
    className: "font-mono font-bold",
    style: {
      color
    }
  }, (data[hover][valueKey] || 0).toLocaleString())));
}
function MiniHBarChart({
  data,
  height = 180
}) {
  // data: [{name, value, color, pct}] — أفقي بسيط لتوزيع التكاليف
  const max = Math.max(1, ...data.map(d => d.value));
  return /*#__PURE__*/React.createElement("div", {
    className: "space-y-3",
    style: {
      minHeight: height
    }
  }, data.map((d, i) => /*#__PURE__*/React.createElement("div", {
    key: i
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between text-xs mb-1"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-slate-300"
  }, d.name), /*#__PURE__*/React.createElement("span", {
    className: "font-mono",
    style: {
      color: d.color
    }
  }, d.value.toLocaleString(undefined, {
    maximumFractionDigits: 0
  }))), /*#__PURE__*/React.createElement("div", {
    className: "w-full bg-slate-800 rounded-full h-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-3 rounded-full transition-all",
    style: {
      width: `${d.value / max * 100}%`,
      background: d.color
    }
  })))));
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
//  i18n — عربي/إنجليزي (الهيكل العام: الهيدر، الشريط الجانبي، عناوين الأقسام)
//  ملاحظة: تفاصيل الجداول والحقول داخل كل تبويب ما زالت بالعربي فقط حالياً
// ═══════════════════════════════════════════════════════════════════
const UI = {
  ar: {
    brandTitle: "🏭 CDT-PPC",
    brandSubtitle: "Cognitive Digital Twin | نظام تخطيط وتحكم إنتاجي مستقل",
    waitingSales: "⏸ انتظار خطة المبيعات",
    processing: "🔄 معالجة...",
    readyConfirm: "📋 جاهزة — بانتظار التأكيد",
    confirmed: "✅ مؤكدة",
    agentsDone: "🤖 الوكلاء: اكتملوا",
    langBtn: "EN",
    themeBtn: theme => theme === "dark" ? "☀️ فاتح" : "🌙 داكن"
  },
  en: {
    brandTitle: "🏭 CDT-PPC",
    brandSubtitle: "Cognitive Digital Twin | Independent Production Planning & Control System",
    waitingSales: "⏸ Waiting for sales plan",
    processing: "🔄 Processing...",
    readyConfirm: "📋 Ready — awaiting confirmation",
    confirmed: "✅ Confirmed",
    agentsDone: "🤖 Agents: done",
    langBtn: "AR",
    themeBtn: theme => theme === "dark" ? "☀️ Light" : "🌙 Dark"
  }
};
const GROUP_LABELS = {
  ar: {
    dashboard: "لوحة التحكم",
    allplans: "متابعة كل الخطط",
    master: "البيانات الرئيسية",
    planning: "التخطيط",
    ai: "الذكاء الاصطناعي والسيناريوهات",
    schedule: "الجدولة والتكاليف",
    reports: "التقارير والمخرجات",
    about: "عن النظام"
  },
  en: {
    dashboard: "Dashboard",
    allplans: "All Plans",
    master: "Master Data",
    planning: "Planning",
    ai: "AI & Scenarios",
    schedule: "Scheduling & Costs",
    reports: "Reports & Output",
    about: "About"
  }
};
const ITEM_LABELS = {
  ar: {
    salesplan: "خطة المبيعات",
    bom: "BOM",
    inventory: "المخزون",
    polog: "طلبات الشراء (SR)",
    fgi: "FGI",
    capacity: "الطاقة",
    engine: "الصيانة",
    dataImport: "استيراد البيانات",
    mps: "MPS",
    shifts: "الورديات",
    mrp: "MRP",
    crp: "CRP",
    agents: "AI Agents",
    whatif: "ماذا لو؟",
    comparison: "مقارنة المقترح",
    gantt: "الجدول اليومي",
    costs: "التكاليف",
    feasibility: "تقرير الجدوى",
    postupdate: "تحديث المخزون",
    reports: "PDF وإرسال"
  },
  en: {
    salesplan: "Sales Plan",
    bom: "BOM",
    inventory: "Inventory",
    polog: "Purchase Orders (SR)",
    fgi: "FGI",
    capacity: "Capacity",
    engine: "Maintenance",
    dataImport: "Data Import",
    mps: "MPS",
    shifts: "Shifts",
    mrp: "MRP",
    crp: "CRP",
    agents: "AI Agents",
    whatif: "What-If",
    comparison: "Suggestion Comparison",
    gantt: "Daily Schedule",
    costs: "Costs",
    feasibility: "Feasibility Report",
    postupdate: "Inventory Update",
    reports: "PDF & Email"
  }
};
const SECTION_HEADERS = {
  ar: {
    salesplan: "📅 خطة المبيعات — إدخال يدوي دائماً (لا تنبؤ إحصائي)",
    bom: "🏗️ قائمة المواد (BOM)",
    inventory: "📦 بيانات المخزون — يشمل سعة التخزين القصوى (مدخل يدوي)",
    fgi: "🔄 مخزون المنتج النهائي (FGI)",
    capacity: "⚙️ بيانات الطاقة الإنتاجية",
    engine: "🔩 صيانة الآلة — قائمة على ساعات التشغيل فقط",
    dataImport: "📥 استيراد البيانات وتشغيل الوكلاء",
    mps: "📋 خطة الإنتاج الرئيسية (MPS) — Lot-for-Lot",
    shifts: "👥 خطة الورديات الأسبوعية",
    mrp: "🔧 تخطيط متطلبات المواد (MRP) — جدولة خلفية Backward Scheduling",
    crp: "📈 تخطيط متطلبات الطاقة (CRP)",
    agents: "🤖 وكلاء الذكاء الاصطناعي",
    whatif: "🔀 محاكي ماذا لو — Digital Twin Scenarios",
    gantt: "🗓️ جدول الإنتاج اليومي — Production Schedule",
    costs: "💵 تحليل التكاليف الإنتاجية",
    feasibility: "📊 تقرير الجدوى الإنتاجية",
    postupdate: "✅ تحديث المخزون + توصيات الشهر القادم",
    reports: "🖨️ تصدير PDF + إرسال الخطة بالبريد",
    about: "💡 عن النظام",
    provider: "مزوّد"
  },
  en: {
    salesplan: "📅 Sales Plan — Manual Entry Only (No Statistical Forecast)",
    bom: "🏗️ Bill of Materials (BOM)",
    inventory: "📦 Inventory Data — Includes Max Storage Capacity (Manual Entry)",
    fgi: "🔄 Finished Goods Inventory (FGI)",
    capacity: "⚙️ Production Capacity Data",
    engine: "🔩 Machine Maintenance — Based on Running Hours Only",
    dataImport: "📥 Data Import & Run AI Agents",
    mps: "📋 Master Production Schedule (MPS) — Lot-for-Lot",
    shifts: "👥 Weekly Shift Plan",
    mrp: "🔧 Material Requirements Planning (MRP) — Backward Scheduling",
    crp: "📈 Capacity Requirements Planning (CRP)",
    agents: "🤖 AI Agents",
    whatif: "🔀 What-If Simulator — Digital Twin Scenarios",
    gantt: "🗓️ Daily Production Schedule",
    costs: "💵 Production Cost Analysis",
    feasibility: "📊 Production Feasibility Report",
    postupdate: "✅ Inventory Update + Next Month Recommendations",
    reports: "🖨️ Export PDF + Email the Plan",
    about: "💡 About the System",
    provider: "Provider"
  }
};

// ═══════════════════════════════════════════════════════════════════
//  SUPABASE — تسجيل الدخول وجلب بيانات المنظمة (Multi-tenant)
//  المكتبة تُحمَّل ديناميكياً (مو سكربت ثابت) — لو تعذّر وصولها لأي سبب
//  (شبكة، جدار حماية، بيئة معاينة مقيّدة)، التطبيق يكمل يشتغل محلياً بدون ما يعلّق
// ═══════════════════════════════════════════════════════════════════
// ⚠️ عدّل القيمتين هذي بعد ما تجهز مشروع Supabase (Settings → API)
const SUPABASE_URL = "ضع-رابط-مشروعك-هنا";
const SUPABASE_ANON_KEY = "ضع-anon-public-key-هنا";
const supabaseConfigured = SUPABASE_URL.startsWith("http") && SUPABASE_ANON_KEY.length > 20;
function loadSupabaseLib(timeoutMs = 6000) {
  return new Promise(resolve => {
    if (window.supabase) return resolve(true);
    let done = false;
    const finish = ok => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    const script = document.createElement("script");
    // إصدار مثبَّت + بصمة SRI: هذه المكتبة تتعامل مع كلمة المرور والجلسة، فلا نسمح بتغيّرها تلقائياً.
    // عند الترقية: حدّث الرقم هنا وفي package.json ثم شغّل npm test (يتحقق أن البصمة تطابق الحزمة الأصلية).
    script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.js";
    script.integrity = "sha384-uteMfOloLDGt042uDz+xHGF3ym63/WQ6rFq7murQRG8Ih7QrXGEGNtWd8688sb4O";
    script.crossOrigin = "anonymous";
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    document.head.appendChild(script);
    setTimeout(() => finish(false), timeoutMs);
  });
}

// يحوّل صفوف Supabase لنفس الشكل اللي يفهمه التطبيق محلياً (bom / inventory / cap / poLog)
async function fetchOrgData(client, userId) {
  const {
    data: profile,
    error: profErr
  } = await client.from("profiles").select("organization_id, role, full_name").eq("id", userId).single();
  if (profErr || !profile) throw new Error(__t("ما لقيت ملف تعريف مرتبط بحسابك — أضف المصنع والمستخدم أولاً بقالب «إضافة مصنع جديد» في sql/01_schema.sql (القسم 4)", "No profile found linked to your account — first add the factory and the user using the «Add a new factory» template in sql/01_schema.sql (section 4)"));
  const orgId = profile.organization_id;
  const [{
    data: org
  }, {
    data: products,
    error: e0
  }, {
    data: bomRows,
    error: e1
  }, {
    data: lines,
    error: e2
  }, {
    data: receipts,
    error: e3
  }] = await Promise.all([client.from("organizations").select("name").eq("id", orgId).single(), client.from("products").select("id, name").eq("organization_id", orgId), client.from("bom_components").select("*").eq("organization_id", orgId), client.from("production_lines").select("*").eq("organization_id", orgId), client.from("scheduled_receipts").select("*").eq("organization_id", orgId).eq("status", "pending")]);
  if (e0 || e1 || e2 || e3) throw new Error((e0 || e1 || e2 || e3).message);
  const uuidToKey = {};
  (bomRows || []).forEach(r => {
    uuidToKey[r.id] = r.material_key;
  });

  // ⚠️ توافق مع قواعد بيانات لم تُشغَّل عليها ترقية تعدد الخطط بعد (supabase_migration_multiplan.sql):
  // لو عمود product_id غير موجود بعد أو لا توجد صفوف مرتبطة بمنتج معيّن، تُنسب كل الصفوف "اليتيمة"
  // (product_id فارغ) لأول منتج بالمنظمة — نفس السلوك القديم قبل تعدد الخطط، لضمان عدم انكسار حسابات قديمة
  const firstProductId = products && products[0] && products[0].id || null;
  const rowsForProduct = (rows, productId) => (rows || []).filter(r => (r.product_id || firstProductId) === productId);
  const productList = products && products.length ? products : [{
    id: null,
    name: __t("المنتج", "Product")
  }];
  const plans = productList.map(prod => {
    const myBomRows = rowsForProduct(bomRows, prod.id);
    const myLines = rowsForProduct(lines, prod.id);
    const myReceipts = rowsForProduct(receipts, prod.id);
    const bom = myBomRows.map(r => ({
      id: r.material_key,
      name: r.material_name,
      qty: Number(r.qty_per_unit),
      unit: r.unit
    }));
    const inventory = myBomRows.map(r => ({
      id: r.material_key,
      name: r.material_name,
      available: Number(r.available),
      safety: Number(r.safety_stock),
      leadTime: Number(r.lead_time_weeks),
      unit: r.unit,
      maxCapacity: r.max_capacity != null ? Number(r.max_capacity) : Infinity
    }));
    const line = myLines[0];
    const cap = line ? {
      ...mkCapacity(),
      productionRate: Number(line.units_per_hour),
      shiftHours: Number(line.shift_hours)
    } : null;
    const poLog = myReceipts.map(r => ({
      id: r.id,
      materialId: uuidToKey[r.material_id] || r.material_id,
      materialName: (myBomRows.find(b => b.id === r.material_id) || {}).material_name || "",
      qty: Number(r.qty),
      confirmedOn: r.confirmed_on,
      arrivalDate: r.arrival_date,
      status: r.status
    }));
    return {
      cloudProductId: prod.id,
      productName: prod.name || __t("المنتج", "Product"),
      bom,
      inventory,
      cap,
      poLog
    };
  });
  return {
    orgId,
    role: profile.role,
    orgName: org && org.name || __t("المصنع", "Factory"),
    plans
  };
}

// ═══════════════════════════════════════════════════════════════════
//  ☁️ الكتابة الراجعة (Write-Back) — نطاقها محدود عمداً لـBOM/المخزون والطاقة فقط
//  (راجع التعليق بأعلى supabase_migration_multiplan.sql لسبب استثناء طلبات الشراء حالياً)
// ═══════════════════════════════════════════════════════════════════

// تُنشئ صفاً جديداً بجدول products لو الخطة المحلية ما عندها cloudProductId بعد — ترجع الـUUID الجديد
async function pushNewProductToCloud(client, orgId, productName) {
  const {
    data,
    error
  } = await client.from("products").insert({
    organization_id: orgId,
    name: productName || __t("منتج بلا اسم", "Unnamed product")
  }).select("id").single();
  if (error) {
    // الدور مُفعَّل بقاعدة البيانات: إنشاء المنتجات للمسؤول (admin) فقط
    if (error.code === "42501" || /row-level security/i.test(error.message || "")) throw new Error(__t("إنشاء منتج جديد بالسحابة متاح للمسؤول (admin) فقط — اطلب من مسؤول المصنع ربط الخطة بمنتج سحابي.", "Creating a new cloud product is available to the admin only — ask the factory admin to link the plan to a cloud product."));
    throw new Error(__tf("تعذّر إنشاء منتج جديد بالسحابة: {0}", "Could not create a new cloud product: {0}", [error.message]));
  }
  return data.id;
}

// كتابة راجعة لكل مواد BOM + بيانات مخزونها المرتبطة، لمنتج مُحدَّد — upsert بمفتاح منطقي (لا id الصف)
// حتى تُطابق نفس المادة عبر المزامنات المتكررة بدل تكرارها كصف جديد كل مرة
async function syncBomToCloud(client, orgId, productId, bom, inventory) {
  if (!bom.length) return {
    synced: 0
  };
  const rows = bom.map(b => {
    const inv = inventory.find(i => i.id === b.id) || {};
    return {
      organization_id: orgId,
      product_id: productId,
      material_key: b.id,
      material_name: b.name,
      qty_per_unit: Number(b.qty) || 0,
      unit: b.unit || "kg",
      available: Number(inv.available) || 0,
      safety_stock: Number(inv.safety) || 0,
      lead_time_weeks: numOr(inv.leadTime, 3),
      max_capacity: Number.isFinite(inv.maxCapacity) ? Number(inv.maxCapacity) : null
    };
  });
  const {
    error
  } = await client.from("bom_components").upsert(rows, {
    onConflict: "organization_id,product_id,material_key"
  });
  if (error) throw new Error(__tf("تعذّرت مزامنة BOM/المخزون: {0}", "BOM/inventory sync failed: {0}", [error.message]));
  return {
    synced: rows.length
  };
}

// كتابة راجعة لبيانات خط الإنتاج (سطر واحد لكل منتج حالياً) — upsert بـ(organization_id, product_id)
async function syncCapacityToCloud(client, orgId, productId, cap) {
  const row = {
    organization_id: orgId,
    product_id: productId,
    units_per_hour: Number(cap.productionRate) || 0,
    shift_hours: Number(cap.shiftHours) || 8
  };
  const {
    error
  } = await client.from("production_lines").upsert([row], {
    onConflict: "organization_id,product_id"
  });
  if (error) throw new Error(__tf("تعذّرت مزامنة بيانات الطاقة: {0}", "Capacity data sync failed: {0}", [error.message]));
}
function LoginScreen({
  onSkip,
  client,
  unavailableReason
}) {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function handleLogin(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const {
      error
    } = await client.auth.signInWithPassword({
      email,
      password: pass
    });
    if (error) setErr(error.message);
    setBusy(false);
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "min-h-screen flex items-center justify-center bg-slate-950 text-slate-100",
    dir: "rtl"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full max-w-sm bg-slate-900 border border-slate-700 rounded-xl p-6 space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-lg font-bold"
  }, __t("تسجيل الدخول — CDT-PPC", "Sign in — CDT-PPC")), unavailableReason && /*#__PURE__*/React.createElement("div", {
    className: "text-xs bg-amber-900/40 border border-amber-700 text-amber-300 rounded p-2"
  }, "\u26A0\uFE0F ", unavailableReason), /*#__PURE__*/React.createElement("input", {
    type: "email",
    required: true,
    disabled: !client,
    placeholder: __t("البريد الإلكتروني", "Email"),
    value: email,
    onChange: e => setEmail(e.target.value),
    onKeyDown: e => e.key === "Enter" && handleLogin(e),
    className: "w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm disabled:opacity-50"
  }), /*#__PURE__*/React.createElement("input", {
    type: "password",
    required: true,
    disabled: !client,
    placeholder: __t("كلمة المرور", "Password"),
    value: pass,
    onChange: e => setPass(e.target.value),
    onKeyDown: e => e.key === "Enter" && handleLogin(e),
    className: "w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm disabled:opacity-50"
  }), err && /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-red-400"
  }, err), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: handleLogin,
    disabled: busy || !client,
    className: "w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded py-2 text-sm font-bold"
  }, busy ? __t("جارٍ الدخول...", "Signing in...") : __t("دخول", "Sign in")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onSkip,
    className: "w-full text-xs text-slate-400 hover:text-slate-200 underline"
  }, __t("المتابعة محلياً بدون تسجيل دخول (بيانات هذا المتصفح فقط)", "Continue locally without signing in (this browser's data only)"))));
}
function Root() {
  const [libState, setLibState] = useState(supabaseConfigured ? "loading" : "skip"); // loading|ready|failed|skip
  const [client, setClient] = useState(null);
  const [session, setSession] = useState(undefined); // undefined=جارٍ التحقق، null=غير مسجّل، object=مسجّل
  const [cloudSeed, setCloudSeed] = useState(null);
  const [loadErr, setLoadErr] = useState("");
  const [localMode, setLocalMode] = useState(false);

  // 1) حمّلي مكتبة Supabase ديناميكياً — فقط لو تم إعداد الرابط والمفتاح فعلاً
  useEffect(() => {
    if (!supabaseConfigured) return;
    loadSupabaseLib().then(ok => {
      if (ok && window.supabase) {
        setClient(window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
        setLibState("ready");
      } else setLibState("failed");
    });
  }, []);

  // 2) بعد جهوزية العميل، راقب حالة الجلسة
  useEffect(() => {
    if (!client) return;
    client.auth.getSession().then(({
      data
    }) => setSession(data.session || null));
    const {
      data: sub
    } = client.auth.onAuthStateChange((_evt, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [client]);

  // 3) بعد الدخول، اجلب بيانات المنظمة
  useEffect(() => {
    if (!session || !client) return;
    (async () => {
      try {
        setCloudSeed(await fetchOrgData(client, session.user.id));
      } catch (e) {
        setLoadErr(e.message || String(e));
      }
    })();
  }, [session, client]);
  if (localMode) return /*#__PURE__*/React.createElement(App, {
    cloudSeed: null,
    supabaseClient: null
  });
  // السحابة غير مُعَدّة (الوضع الافتراضي للنشر على GitHub Pages): ندخل التطبيق مباشرة — لا نعرض نموذج دخول لا يعمل
  if (libState === "skip") return /*#__PURE__*/React.createElement(App, {
    cloudSeed: null,
    supabaseClient: null
  });
  if (libState === "loading") return /*#__PURE__*/React.createElement("div", {
    className: "min-h-screen flex items-center justify-center bg-slate-950 text-slate-400 text-sm"
  }, __t("جارٍ التحقق من إعداد السحابة... (يمكنك المتابعة محلياً من الشاشة التالية لو تأخّر)", "Checking the cloud setup... (you can continue locally from the next screen if it takes long)"));
  if (libState === "failed") return /*#__PURE__*/React.createElement(LoginScreen, {
    client: null,
    unavailableReason: __t("تعذّر تحميل مكتبة Supabase الآن (اتصال/شبكة) — استخدم المتابعة المحلية بالأسفل", "Could not load the Supabase library now (connection/network) — use local mode below"),
    onSkip: () => setLocalMode(true)
  });
  if (session === undefined) return /*#__PURE__*/React.createElement("div", {
    className: "min-h-screen flex items-center justify-center bg-slate-950 text-slate-400 text-sm"
  }, __t("جارٍ التحقق من الجلسة...", "Checking the session..."));
  if (!session) return /*#__PURE__*/React.createElement(LoginScreen, {
    client: client,
    onSkip: () => setLocalMode(true)
  });
  if (loadErr) return /*#__PURE__*/React.createElement("div", {
    className: "min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 text-sm p-6",
    dir: "rtl"
  }, /*#__PURE__*/React.createElement("div", {
    className: "max-w-md bg-slate-900 border border-red-700 rounded-xl p-5 space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-red-400 font-bold"
  }, __t("تعذّر تحميل بيانات المنظمة", "Could not load the organization data")), /*#__PURE__*/React.createElement("div", {
    className: "text-slate-300"
  }, loadErr), /*#__PURE__*/React.createElement("button", {
    onClick: () => client.auth.signOut(),
    className: "text-xs underline text-slate-400"
  }, __t("تسجيل خروج والمحاولة بحساب ثاني", "Sign out and try with another account"))));
  if (!cloudSeed) return /*#__PURE__*/React.createElement("div", {
    className: "min-h-screen flex items-center justify-center bg-slate-950 text-slate-400 text-sm"
  }, __t("جارٍ تحميل بيانات المصنع...", "Loading factory data..."));
  return /*#__PURE__*/React.createElement(App, {
    cloudSeed: cloudSeed,
    supabaseClient: client
  });
}
function AddMaterialForm({
  onAdd
}) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    name: "",
    qty: "",
    unit: "kg",
    leadTime: 3,
    safety: 0,
    maxCapacity: 999999,
    available: 0,
    unitCost: 0
  });
  function submit(e) {
    e.preventDefault();
    if (!f.name.trim() || f.qty === "") return;
    onAdd({
      name: f.name.trim(),
      qty: Number(f.qty),
      unit: f.unit,
      leadTime: Number(f.leadTime) || 0,
      safety: Number(f.safety) || 0,
      maxCapacity: Number(f.maxCapacity) || 999999999,
      available: Number(f.available) || 0,
      unitCost: Number(f.unitCost) || 0
    });
    setF({
      name: "",
      qty: "",
      unit: "kg",
      leadTime: 3,
      safety: 0,
      maxCapacity: 999999,
      available: 0,
      unitCost: 0
    });
    setOpen(false);
  }
  if (!open) return /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpen(true),
    className: "w-full border border-dashed border-slate-600 hover:border-blue-500 hover:text-blue-400 text-slate-400 rounded-xl py-3 text-sm transition-colors"
  }, __t("+ إضافة مادة جديدة", "+ Add a new material"));
  return /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 border border-blue-800/50 rounded-xl p-4 space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-sm font-bold text-blue-400"
  }, __t("مادة جديدة", "New material")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("اسم المادة *", "Material name *")), /*#__PURE__*/React.createElement("input", {
    required: true,
    value: f.name,
    onChange: e => setF({
      ...f,
      name: e.target.value
    }),
    onKeyDown: e => e.key === "Enter" && submit(e),
    className: "bg-slate-800 border border-slate-700 rounded px-2 py-1.5 w-full text-slate-100 text-sm focus:border-blue-500 focus:outline-none"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("الكمية لكل وحدة منتج *", "Quantity per product unit *")), /*#__PURE__*/React.createElement("input", {
    required: true,
    type: "number",
    step: "0.001",
    value: f.qty,
    onChange: e => setF({
      ...f,
      qty: e.target.value
    }),
    onKeyDown: e => e.key === "Enter" && submit(e),
    className: "bg-slate-800 border border-slate-700 rounded px-2 py-1.5 w-full text-slate-100 font-mono text-sm focus:border-blue-500 focus:outline-none"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("الوحدة", "Unit")), /*#__PURE__*/React.createElement("select", {
    value: f.unit,
    onChange: e => setF({
      ...f,
      unit: e.target.value
    }),
    className: "bg-slate-800 border border-slate-700 rounded px-2 py-1.5 w-full text-slate-300 text-sm focus:border-blue-500 focus:outline-none"
  }, ["kg", "l", "pcs", "unit", "box", "m"].map(u => /*#__PURE__*/React.createElement("option", {
    key: u,
    value: u
  }, u)))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("مدة التوريد (أسابيع)", "Lead time (weeks)")), /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: f.leadTime,
    onChange: e => setF({
      ...f,
      leadTime: e.target.value
    }),
    className: "bg-slate-800 border border-slate-700 rounded px-2 py-1.5 w-full text-slate-100 font-mono text-sm focus:border-blue-500 focus:outline-none"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("المخزون الحالي", "Current stock")), /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: f.available,
    onChange: e => setF({
      ...f,
      available: e.target.value
    }),
    className: "bg-slate-800 border border-slate-700 rounded px-2 py-1.5 w-full text-slate-100 font-mono text-sm focus:border-blue-500 focus:outline-none"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("مخزون الأمان", "Safety stock")), /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: f.safety,
    onChange: e => setF({
      ...f,
      safety: e.target.value
    }),
    className: "bg-slate-800 border border-slate-700 rounded px-2 py-1.5 w-full text-slate-100 font-mono text-sm focus:border-blue-500 focus:outline-none"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("تكلفة الوحدة (ريال) — لحساب EOQ", "Unit cost (riyal) — for EOQ")), /*#__PURE__*/React.createElement("input", {
    type: "number",
    step: "0.01",
    value: f.unitCost,
    onChange: e => setF({
      ...f,
      unitCost: e.target.value
    }),
    className: "bg-slate-800 border border-slate-700 rounded px-2 py-1.5 w-full text-slate-100 font-mono text-sm focus:border-blue-500 focus:outline-none"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2 pt-1"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: submit,
    className: "bg-blue-600 hover:bg-blue-500 rounded px-4 py-1.5 text-xs font-bold"
  }, __t("إضافة", "Add")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setOpen(false),
    className: "text-slate-400 hover:text-slate-200 text-xs px-2"
  }, __t("إلغاء", "Cancel"))));
}

// ═══════════════════════════════════════════════════════════════════
//  🧭 ملف تخطيط الشركة (Planning Profile) — استبيان محدَّد وليس ذكاءً اصطناعياً حراً
//  عمداً: 3 أسئلة صريحة بإجابات ثابتة (نعم/لا) بدل دردشة نص حر يُفسَّرها نموذج ذكاء اصطناعي.
//  السبب: هذا القرار يُغيّر بنية النظام نفسه (أي تبويبات تظهر، وأي حسابات تُشترط) — قرار
//  بهذا الحجم يجب أن يكون قابلاً للتحقق 100% (تعدادياً: كل تركيبة إجابات مُختبَرة فعلياً)
//  ولا يعتمد على تفسير نموذج لغوي قد يخطئ، ولا على وجود مفتاح API (الوكلاء الذكية شيء
//  منفصل تماماً واختياري). القيمة null تعني "لم تُجَب بعد" وتُظهر الاستبيان تلقائياً.
// ═══════════════════════════════════════════════════════════════════
const mkPlanningProfile = () => ({
  hasBOM: null,
  hasFGI: null,
  hasMaintenance: null
});
const getProfileQuestions = () => [{
  key: "hasBOM",
  q: __t("هل يستهلك إنتاج منتجكم مواد خام محدَّدة تحتاجون تتبّعها لكل وحدة (Bill of Materials)؟", "Does your product's output consume specific raw materials that you need to track per unit (Bill of Materials)?"),
  yes: __t("نعم — عندنا مواد خام نتتبّعها بدقة", "Yes — we track raw materials precisely"),
  no: __t("لا — الإنتاج عندنا لا يعتمد على تتبّع مواد خام", "No — our production does not depend on tracking raw materials"),
  onYes: __t("تمام — راح تظهر تبويبات BOM والمخزون وطلبات الشراء وMRP، وتُحسب متطلبات المواد وجدولة الشراء تلقائياً.", "Great — the BOM, inventory, purchase orders and MRP tabs will appear, and material requirements and purchase scheduling will be calculated automatically."),
  onNo: __t("تمام — هذي التبويبات ما تُعنيكم فراح تُخفى، وتخطيط الإنتاج (MPS/الورديات) بيشتغل مباشرة بدون ما يطلب منكم مواد خام.", "Great — these tabs don't concern you so they will be hidden, and production planning (MPS/shifts) will run directly without asking you for raw materials.")
}, {
  key: "hasFGI",
  q: __t("هل تحتفظون بمخزون من المنتج النهائي كحاجز أمان (تُنتجون قبل وصول الطلب الفعلي)، أم تُنتجون فقط بعد تأكيد الطلب مباشرة (Make-to-Order)؟", "Do you keep finished-goods stock as a safety buffer (producing before the actual order arrives), or do you produce only after the order is confirmed (Make-to-Order)?"),
  yes: __t("نحتفظ بمخزون أمان (Make-to-Stock)", "We keep safety stock (Make-to-Stock)"),
  no: __t("ننتج فقط حسب الطلب المؤكد (Make-to-Order)", "We produce only to confirmed orders (Make-to-Order)"),
  onYes: __t("تمام — تبويب FGI بيظهر بخياراته الثلاث (Push/Pull/Hybrid) عشان تحدّدوا استراتيجية تعويض المخزون.", "Great — the FGI tab will appear with its three options (Push/Pull/Hybrid) so you can choose the inventory replenishment strategy."),
  onNo: __t("تمام — تبويب FGI بيُخفى، والنظام بينتج بالضبط كمية الطلب كل أسبوع بدون أي حاجز مخزون.", "Great — the FGI tab will be hidden, and the system will produce exactly the order quantity each week with no inventory buffer.")
}, {
  key: "hasMaintenance",
  q: __t("هل عندكم آلة أو خط إنتاج رئيسي واحد تتبّعون له صيانة دورية بساعات التشغيل؟", "Do you have one main machine or production line whose periodic maintenance you track by operating hours?"),
  yes: __t("نعم — عندنا آلة/خط نتتبّع صيانته بالساعات", "Yes — we have a machine/line whose maintenance we track in hours"),
  no: __t("لا — ينطبق (خطوط متعددة، عملية يدوية، أو الصيانة تُدار بنظام آخر)", "No — not applicable (multiple lines, manual process, or maintenance managed by another system)"),
  onYes: __t("تمام — تبويب الصيانة بيظهر، وبيُحسب تلقائياً متى تقع الصيانة القادمة وأثرها على الطاقة.", "Great — the maintenance tab will appear, and the system will automatically calculate when the next maintenance falls and its effect on capacity."),
  onNo: __t("تمام — تبويب الصيانة بيُخفى، وما راح يُفترض أي توقف صيانة دوري بالخطة.", "Great — the maintenance tab will be hidden, and no periodic maintenance stop will be assumed in the plan.")
}];
function PlanningProfileWizard({
  onComplete
}) {
  const PROFILE_QUESTIONS = getProfileQuestions();
  const [step, setStep] = useState(0); // 0..2 أسئلة، 3 = ملخّص نهائي
  const [answers, setAnswers] = useState({});
  function answer(val) {
    const key = PROFILE_QUESTIONS[step].key;
    setAnswers(p => ({
      ...p,
      [key]: val
    }));
    setStep(s => s + 1);
  }
  const done = step >= PROFILE_QUESTIONS.length;
  return /*#__PURE__*/React.createElement("div", {
    className: "min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4",
    dir: "rtl"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full max-w-xl bg-slate-900 border border-slate-700 rounded-2xl p-6 space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-center space-y-1 mb-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-lg font-bold text-blue-400"
  }, __t("🧭 قبل ما نبدأ — 3 أسئلة عن شكل تخطيطكم", "🧭 Before we start — 3 questions about how you plan")), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500"
  }, __t("إجابات ثابتة (مو دردشة حرة) عشان النظام يعرض بالضبط التبويبات والحسابات التي تخصّكم — وتقدرون تغيّرونها لاحقاً في أي وقت.", "Fixed answers (not free chat) so the system shows exactly the tabs and calculations that concern you — and you can change them later at any time."))), PROFILE_QUESTIONS.slice(0, step).map((pq, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "bg-slate-800/60 border border-slate-700 rounded-xl p-3 text-xs space-y-1"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-slate-400"
  }, pq.q), /*#__PURE__*/React.createElement("div", {
    className: "text-emerald-400 font-medium"
  }, "\u2713 ", answers[pq.key] ? pq.yes : pq.no), /*#__PURE__*/React.createElement("div", {
    className: "text-slate-500"
  }, answers[pq.key] ? pq.onYes : pq.onNo))), !done && /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 border border-blue-800/50 rounded-xl p-4 space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-sm text-slate-100 font-medium"
  }, PROFILE_QUESTIONS[step].q), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => answer(true),
    className: "text-right bg-blue-900/40 hover:bg-blue-900/70 border border-blue-700 rounded-lg px-3 py-2 text-xs text-blue-200"
  }, PROFILE_QUESTIONS[step].yes), /*#__PURE__*/React.createElement("button", {
    onClick: () => answer(false),
    className: "text-right bg-slate-700/60 hover:bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-xs text-slate-200"
  }, PROFILE_QUESTIONS[step].no)), /*#__PURE__*/React.createElement("div", {
    className: "text-[10px] text-slate-600"
  }, __t("سؤال", "Question"), " ", step + 1, " ", __t("من", "of"), " ", PROFILE_QUESTIONS.length)), done && /*#__PURE__*/React.createElement("div", {
    className: "bg-emerald-950/30 border border-emerald-700 rounded-xl p-4 space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-sm font-bold text-emerald-300"
  }, __t("✅ تمام، هذا شكل تخطيطكم:", "✅ Great, this is your planning setup:")), /*#__PURE__*/React.createElement("ul", {
    className: "text-xs text-emerald-200 space-y-1 list-disc pr-4"
  }, /*#__PURE__*/React.createElement("li", null, answers.hasBOM ? __t("تتبّع مواد خام (BOM) + المخزون + طلبات الشراء + MRP", "Raw material tracking (BOM) + inventory + purchase orders + MRP") : __t("بدون تتبّع مواد خام — إنتاج مباشر بلا BOM", "No raw material tracking — direct production without a BOM")), /*#__PURE__*/React.createElement("li", null, answers.hasFGI ? __t("مخزون أمان للمنتج النهائي (FGI) مع Push/Pull/Hybrid", "Finished-goods safety stock (FGI) with Push/Pull/Hybrid") : __t("إنتاج حسب الطلب فقط — بدون حاجز مخزون نهائي", "Make-to-order only — no finished-goods buffer")), /*#__PURE__*/React.createElement("li", null, answers.hasMaintenance ? __t("تتبّع صيانة دورية للآلة بساعات التشغيل", "Periodic machine maintenance tracked by operating hours") : __t("بدون تتبّع صيانة دورية", "No periodic maintenance tracking"))), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500"
  }, __t("تقدرون تغيّرون أي إجابة لاحقاً من تبويب \"عن النظام\" — بدون ما تفقدون أي بيانات مُدخَلة مسبقاً (بس تظهر أو تُخفى حسب اختياركم).", "You can change any answer later from the \"About\" tab — without losing any data you already entered (tabs are simply shown or hidden according to your choice).")), /*#__PURE__*/React.createElement("button", {
    onClick: () => onComplete(answers),
    className: "w-full bg-emerald-600 hover:bg-emerald-500 py-2.5 rounded-xl text-sm font-bold"
  }, __t("🚀 ابدأ استخدام النظام", "🚀 Start using the system")))));
}

// يقرأ حقلاً محفوظاً لخطة أخرى (غير النشطة حالياً) مباشرة من localStorage — يُستخدم فقط
// عند إنشاء خطة جديدة تشارك موارد مع خطة موجودة، لعرض قائمة موادها واختيار المشترك منها
function readPlanField(planId, base, fallback) {
  try {
    const raw = localStorage.getItem(`cdt:plan:${planId}:${base}`);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  🗂️ إنشاء خطة جديدة — استبيان محدَّد (لا AI حر) بنفس فلسفة PlanningProfileWizard:
//  اسم المنتج، ثم هل تشارك موارد مع خطة موجودة، وإن نعم أي مادة بالضبط. المواد المشترَكة
//  تنسخ "المتبقي حالياً" من مخزون الخطة المصدر كنقطة بداية (Snapshot) — وليس ربطاً حياً
//  متزامناً (ذلك يتطلب محرك جدولة موحّد بين الخطط، وهو تعقيد من طبقة مختلفة تماماً —
//  أوضحه صراحة بالواجهة بدل الادّعاء بمزامنة تلقائية غير موجودة فعلياً).
// ═══════════════════════════════════════════════════════════════════
function NewPlanDialog({
  plans,
  onCreate,
  onCancel
}) {
  const [step, setStep] = useState("name"); // name → shareQ → pickPlan → pickMaterials → confirm
  const [productName, setProductName] = useState("");
  const [shares, setShares] = useState(null); // true/false
  const [sourcePlanId, setSourcePlanId] = useState("");
  const [sourceBom, setSourceBom] = useState([]);
  const [sourceInv, setSourceInv] = useState([]);
  const [checkedMatIds, setCheckedMatIds] = useState({});
  function pickSourcePlan(id) {
    setSourcePlanId(id);
    setSourceBom(readPlanField(id, "bom", []));
    setSourceInv(readPlanField(id, "inventory", []));
    setStep("pickMaterials");
  }
  function create() {
    const sharedSpecs = Object.keys(checkedMatIds).filter(id => checkedMatIds[id]).map(id => {
      const b = sourceBom.find(x => x.id === id);
      const inv = sourceInv.find(x => x.id === id) || {};
      return {
        name: b?.name,
        unit: b?.unit,
        sourcePlanId,
        sourceMaterialId: id,
        available: inv.available ?? 0,
        safety: inv.safety ?? 0,
        leadTime: inv.leadTime ?? 3,
        maxCapacity: inv.maxCapacity ?? 999999999,
        unitCost: inv.unitCost ?? 0
      };
    });
    onCreate({
      productName: productName.trim() || __t("منتج بدون اسم", "Unnamed product"),
      sharedMaterials: sharedSpecs
    });
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50",
    dir: "rtl"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl p-6 space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-lg font-bold text-blue-400"
  }, __t("🗂️ خطة جديدة", "🗂️ New plan")), step === "name" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block"
  }, __t("اسم المنتج/الخط الجديد", "New product/line name")), /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    value: productName,
    onChange: e => setProductName(e.target.value),
    onKeyDown: e => e.key === "Enter" && productName.trim() && setStep("shareQ"),
    placeholder: __t("مثال: عصير تفاح 1 لتر", "Example: 1 L apple juice"),
    className: "w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
  }), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2 pt-1"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    className: "text-xs text-slate-400 hover:text-slate-200 px-3 py-2"
  }, __t("إلغاء", "Cancel")), /*#__PURE__*/React.createElement("button", {
    disabled: !productName.trim(),
    onClick: () => setStep("shareQ"),
    className: "flex-1 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg py-2 text-sm font-bold"
  }, __t("التالي", "Next")))), step === "shareQ" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-sm text-slate-100"
  }, __t("هل خطة \"", "Does the plan \""), productName, __t("\" تشارك مواد خام فعلياً (نفس المخزون الفعلي) مع أي خطة موجودة عندكم؟", "\" actually share raw materials (the same physical stock) with any existing plan of yours?")), plans.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-amber-400 bg-amber-950/20 border border-amber-800/40 rounded-lg p-3"
  }, __t("لا توجد خطط أخرى بعد لمشاركتها — سننشئ هذي الخطة مستقلة تماماً.", "There are no other plans to share with yet — this plan will be created fully independent.")) : /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setStep("pickPlan"),
    className: "text-right bg-blue-900/40 hover:bg-blue-900/70 border border-blue-700 rounded-lg px-3 py-2 text-xs text-blue-200"
  }, __t("نعم — تشارك مواد خام مع خطة موجودة", "Yes — shares raw materials with an existing plan")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setStep("confirm"),
    className: "text-right bg-slate-700/60 hover:bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-xs text-slate-200"
  }, __t("لا — مستقلة تماماً (مواد خاصة بها فقط)", "No — fully independent (its own materials only)"))), plans.length === 0 && /*#__PURE__*/React.createElement("button", {
    onClick: () => setStep("confirm"),
    className: "w-full bg-blue-600 hover:bg-blue-500 rounded-lg py-2 text-sm font-bold"
  }, __t("متابعة", "Continue"))), step === "pickPlan" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-sm text-slate-100"
  }, __t("شاركة موارد مع أي خطة بالضبط؟", "Which plan exactly does it share resources with?")), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1.5 max-h-52 overflow-y-auto"
  }, plans.map(p => /*#__PURE__*/React.createElement("button", {
    key: p.id,
    onClick: () => pickSourcePlan(p.id),
    className: "text-right bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200"
  }, p.productName || __t("(بدون اسم)", "(unnamed)")))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setStep("shareQ"),
    className: "text-xs text-slate-400 hover:text-slate-200"
  }, __t("← رجوع", "← Back"))), step === "pickMaterials" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-sm text-slate-100"
  }, __t("أي مادة بالضبط نفس المخزون الفعلي المشترك؟ (اختر كل ما ينطبق)", "Which materials exactly are the same shared physical stock? (select all that apply)")), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500 bg-slate-800/60 rounded-lg p-2"
  }, __t("📌 سيُنسخ \"المتبقي حالياً\" من كل مادة تختارها كنقطة بداية لمخزون الخطة الجديدة — لكن التحديث بعدها يدوي بالطرفين (لا مزامنة تلقائية لحظية بين خطتين مستقلتين)، وستظهر علامة 🔗 بتبويب المخزون تذكيراً بذلك.", "📌 The \"currently remaining\" amount of each selected material will be copied as the starting stock of the new plan — but updates afterwards are manual on both sides (no instant automatic sync between two independent plans), and a 🔗 mark will appear in the Inventory tab as a reminder.")), sourceBom.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500"
  }, __t("هذي الخطة ما فيها أي مواد خام مُسجَّلة بعد.", "This plan has no raw materials registered yet.")) : /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1.5 max-h-52 overflow-y-auto"
  }, sourceBom.map(b => /*#__PURE__*/React.createElement("label", {
    key: b.id,
    className: "flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 cursor-pointer"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: !!checkedMatIds[b.id],
    onChange: e => setCheckedMatIds(p => ({
      ...p,
      [b.id]: e.target.checked
    })),
    className: "accent-blue-500"
  }), /*#__PURE__*/React.createElement("span", null, b.name), /*#__PURE__*/React.createElement("span", {
    className: "text-slate-500 mr-auto"
  }, (sourceInv.find(i => i.id === b.id)?.available ?? 0).toLocaleString(), " ", b.unit, " ", __t("متاح حالياً", "Currently available"))))), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setStep("pickPlan"),
    className: "text-xs text-slate-400 hover:text-slate-200 px-2"
  }, __t("← رجوع", "← Back")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setStep("confirm"),
    className: "flex-1 bg-blue-600 hover:bg-blue-500 rounded-lg py-2 text-sm font-bold"
  }, __t("التالي", "Next")))), step === "confirm" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-emerald-950/30 border border-emerald-700 rounded-xl p-4 text-xs text-emerald-200 space-y-1"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", null, __t("الاسم:", "Name:")), " ", productName || __t("منتج بدون اسم", "Unnamed product")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", null, __t("مواد مشترَكة:", "Shared materials:")), " ", Object.values(checkedMatIds).filter(Boolean).length > 0 ? __tf("{0} مادة", "{0} materials", [Object.values(checkedMatIds).filter(Boolean).length]) : __t("لا شيء — خطة مستقلة تماماً", "None — fully independent plan"))), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    className: "text-xs text-slate-400 hover:text-slate-200 px-3 py-2"
  }, __t("إلغاء", "Cancel")), /*#__PURE__*/React.createElement("button", {
    onClick: create,
    className: "flex-1 bg-emerald-600 hover:bg-emerald-500 rounded-lg py-2.5 text-sm font-bold"
  }, __t("🚀 إنشاء الخطة", "🚀 Create the plan"))))));
}
function App({
  cloudSeed,
  supabaseClient
} = {}) {
  // ═══ 🗂️ تعدد الخطط (Multi-Plan) ═══════════════════════════════════
  // سجل كل الخطط الموجودة (كل خطة = منتج/خط مستقل له بياناته الكاملة) + أي خطة نشطة حالياً.
  // planKey() تبني مفتاح تخزين مُخصَّص للخطة النشطة — فبمجرد تبديل activePlanId، كل حقل
  // بالأسفل (BOM، المخزون، الطاقة، ...) يُعيد تحميل بيانات الخطة الجديدة تلقائياً (usePersistedState
  // يراقب تغيّر المفتاح نفسه). الترحيل من نسخة أقدم (خطة واحدة فقط، مفاتيح ثابتة زي cdt:bom)
  // يحدث مرة واحدة فقط عند تحميل الصفحة عبر ensurePlanRegistryMigrated() (انظر نهاية الملف).
  const [plans, setPlans, rPL2] = usePersistedState("cdt:plans", []);
  const [activePlanId, setActivePlanId, rAPID] = usePersistedState("cdt:activeplanid", null);
  const planKey = useCallback(base => `cdt:plan:${activePlanId || "__pending__"}:${base}`, [activePlanId]);
  const activePlan = plans.find(p => p.id === activePlanId) || null;
  // فحص تقاطع الطاقة بين خطط مرتبطة (شاركت مادة خام عند الإنشاء) — إعلامي بحت، يعتمد على آخر لقطة محسوبة لكل خطة
  const capacityOverlaps = useMemo(() => computeCapacityOverlaps(plans), [plans, __LANG]);
  // كل أزواج الخطط المرتبطة حالياً (بغض النظر عن السبب: مشاركة مادة أو ربط يدوي) — بدون تكرار الزوج مرتين
  const linkedPairs = useMemo(() => {
    const seen = new Set(),
      pairs = [];
    plans.forEach(p => (p.linkedPlanIds || []).forEach(otherId => {
      const key = [p.id, otherId].sort().join("|");
      if (seen.has(key)) return;
      seen.add(key);
      const other = plans.find(x => x.id === otherId);
      if (other) pairs.push([p, other]);
    }));
    return pairs;
  }, [plans, __LANG]);

  // ── Config data (تُحمَّل يدوياً أو عبر استيراد Excel/Google Sheets) — كل حقل خاص بالخطة النشطة فقط ──
  const [planWeeks, setPlanWeeks, rPW] = usePersistedState(planKey("planWeeks"), DEFAULT_WEEKS);
  const [demand, setDemand, rD] = usePersistedState(planKey("demand"), mkDemand(DEFAULT_WEEKS));
  const [bom, setBom, rB] = usePersistedState(planKey("bom"), mkBOM());
  const [inventory, setInv, rI] = usePersistedState(planKey("inventory"), mkInventory());
  const [cap, setCap, rC] = usePersistedState(planKey("capacity"), mkCapacity());
  const [fgiConfig, setFGI, rFG] = usePersistedState(planKey("fgi"), mkFGIConfig());
  const [engineMaint, setEngineMaint, rEM] = usePersistedState(planKey("engine"), mkEngineMaint());
  // مفاتيح API ورابط CSV إعدادات عامة على مستوى التطبيق كله (لا تختلف من خطة لأخرى)
  const [apiKeys, setApiKeys, rAK] = usePersistedState("cdt:apikeys", mkApiKeys());
  const [csvUrls, setCsvUrls, rCU] = usePersistedState("cdt:csvurls", mkCsvUrls());
  // سجل طلبات الشراء المؤكدة (Scheduled Receipts) — خاص بالخطة النشطة، يبقى محفوظاً عبر دورات التخطيط المختلفة لنفس الخطة
  const [poLog, setPoLog, rPL] = usePersistedState(planKey("polog"), []);
  // تاريخ بداية الخطة الحالية (يُستخدم لتحويل W1..Wn إلى تواريخ حقيقية لمطابقة وصول SR)
  const [planStartDate, setPlanStartDate, rPSD] = usePersistedState(planKey("planstartdate"), new Date().toISOString().slice(0, 10));
  // ── ملف تخطيط الشركة: هل عندهم BOM / FGI / صيانة دورية؟ يحدّد أي تبويبات تظهر — خاص بكل خطة (منتجان قد يختلفان تماماً) ──
  const [planningProfile, setPlanningProfile, rPP] = usePersistedState(planKey("planningprofile"), mkPlanningProfile());

  // ── اسم المصنع/المنتج — خاص بكل خطة الآن (كان يُفقد عند إعادة تحميل الصفحة سابقاً لأنه لم يكن محفوظاً إطلاقاً) ──
  const [orgLabel, setOrgLabel, rOL] = usePersistedState(planKey("orglabel"), {
    factoryName: "",
    productName: "",
    fgUnit: ""
  });

  // ── زرع بيانات المنظمة القادمة من Supabase (إن وُجدت) داخل الحالة المحلية عند الدخول ──
  // كل "منتج" بالسحابة = خطة محلية مستقلة (نفس مفهوم تعدد الخطط تماماً) — تُطابَق بمعرّف السحابة
  // (cloudProductId) لا بالاسم، حتى لو غيّرت اسم المنتج لاحقاً تبقى نفس الخطة المحلية مرتبطة به بلا تكرار
  useEffect(() => {
    if (!cloudSeed || !cloudSeed.plans) return;
    const localIdFor = cloudProductId => "plan_cloud_" + cloudProductId;
    setPlans(prevPlans => {
      const next = [...prevPlans];
      cloudSeed.plans.forEach(cp => {
        const localId = localIdFor(cp.cloudProductId);
        const idx = next.findIndex(p => p.id === localId);
        if (idx >= 0) next[idx] = {
          ...next[idx],
          productName: cp.productName
        };else next.push({
          id: localId,
          productName: cp.productName,
          createdAt: new Date().toISOString().slice(0, 10),
          cloudProductId: cp.cloudProductId
        });
      });
      return next;
    });

    // السحابة لا تخزّن unitCost ولا أيام العمل/الورديات/نسب العيوب — تُدمج القيم السحابية فوق المحلية بدل أن تستبدلها
    const readLS = (k, def) => {
      try {
        const raw = localStorage.getItem(k);
        return raw ? JSON.parse(raw) : def;
      } catch {
        return def;
      }
    };
    const mergeInv = (localId, cloudInv) => {
      const prev = readLS(`cdt:plan:${localId}:inventory`, []);
      return cloudInv.map(ci => {
        const old = prev.find(x => x.id === ci.id);
        return old ? {
          ...old,
          ...ci
        } : ci;
      });
    };
    const mergeCap = (localId, cloudCap) => {
      const prev = readLS(`cdt:plan:${localId}:capacity`, null);
      return prev ? {
        ...prev,
        productionRate: cloudCap.productionRate,
        shiftHours: cloudCap.shiftHours
      } : cloudCap;
    };
    cloudSeed.plans.forEach(cp => {
      const localId = localIdFor(cp.cloudProductId);
      const orgLabelSeed = {
        factoryName: cloudSeed.orgName || __t("المصنع", "Factory"),
        productName: cp.productName || __t("المنتج", "Product"),
        fgUnit: __t("وحدة", "unit")
      };
      if (localId === activePlanId) {
        // الخطة النشطة حالياً — استخدم setters الحقيقية عشان تنعكس بالواجهة فوراً (كتابة localStorage
        // المباشرة لا تُحدِّث الحالة الحيّة إلا لو تغيّر مفتاح usePersistedState نفسه)
        if (cp.bom?.length) setBom(cp.bom);
        if (cp.inventory?.length) setInv(mergeInv(localId, cp.inventory));
        if (cp.cap) setCap(mergeCap(localId, cp.cap));
        setPoLog(cp.poLog || []);
        setOrgLabel(orgLabelSeed);
      } else {
        // خطط أخرى غير نشطة حالياً بهذا التحميل — نفس أسلوب زرع بيانات خطة غير نشطة في handleCreatePlan
        if (cp.bom?.length) localStorage.setItem(`cdt:plan:${localId}:bom`, JSON.stringify(cp.bom));
        if (cp.inventory?.length) localStorage.setItem(`cdt:plan:${localId}:inventory`, JSON.stringify(mergeInv(localId, cp.inventory)));
        if (cp.cap) localStorage.setItem(`cdt:plan:${localId}:capacity`, JSON.stringify(mergeCap(localId, cp.cap)));
        localStorage.setItem(`cdt:plan:${localId}:polog`, JSON.stringify(cp.poLog || []));
        localStorage.setItem(`cdt:plan:${localId}:orglabel`, JSON.stringify(orgLabelSeed));
      }
    });
    setActivePlanId(cur => cur || localIdFor(cloudSeed.plans[0]?.cloudProductId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudSeed]);
  useEffect(() => {
    document.title = __tf("CDT-PPC — {0} | نظام تخطيط الإنتاج والتحكم", "CDT-PPC — {0} | Production Planning & Control System", [orgLabel.productName]);
  }, [orgLabel]);

  // أي تعديل لاسم المنتج (من تبويب BOM) يُطابَق فوراً بقائمة تبديل الخطط — بدون هذا، الاسم بالقائمة
  // يبقى "مجمَّداً" على ما كُتب وقت إنشاء الخطة فقط، بينما التطبيق فعلياً يعرض اسماً مختلفاً
  useEffect(() => {
    if (!activePlanId) return;
    setPlans(prev => {
      const cur = prev.find(p => p.id === activePlanId);
      if (!cur || cur.productName === orgLabel.productName) return prev; // ما تغيّر شي فعلياً — لا تحدّث عبثاً
      return prev.map(p => p.id === activePlanId ? {
        ...p,
        productName: orgLabel.productName
      } : p);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgLabel.productName, activePlanId]);

  // ── مطابقة دائمة بين BOM والمخزون وسجل المشتريات: BOM هو مصدر الحقيقة الوحيد ──
  // أي مادة بالمخزون أو طلب شراء ما له مقابل فعلي بالـBOM الحالي (بيانات عالقة من نسخة سابقة
  // مثلاً) يُحذف تلقائياً بدل ما يظل ظاهراً بدون أي تأثير على الحسابات الفعلية
  useEffect(() => {
    const validIds = new Set(bom.map(b => b.id));
    setInv(prev => {
      const cleaned = prev.filter(i => validIds.has(i.id));
      const missing = bom.filter(b => !cleaned.some(i => i.id === b.id)).map(b => ({
        id: b.id,
        name: b.name,
        unit: b.unit,
        available: 0,
        safety: 0,
        leadTime: 3,
        maxCapacity: 999999999,
        unitCost: 0
      }));
      const next = [...cleaned, ...missing];
      const unchanged = next.length === prev.length && next.every((x, idx) => x.id === prev[idx]?.id && x.name === prev[idx]?.name);
      return unchanged ? prev : next;
    });
    setPoLog(prev => {
      const cleaned = prev.filter(p => validIds.has(p.materialId));
      return cleaned.length === prev.length ? prev : cleaned;
    });
  }, [bom]);

  // ── Sales Plan quick-entry (توزيع تلقائي من إجمالي شهري) ──
  const [totalMonthly, setTotalMonthly] = useState(1800000);
  const [demandPriority, setDemandPriority] = useState(2); // 1=عالية 2=متوسطة 3=منخفضة

  // ── Workflow state ──
  const [tab, setTab] = useState("salesplan");
  const [showPlanMenu, setShowPlanMenu] = useState(false); // قائمة تبديل الخطط بالهيدر
  const [linkPickA, setLinkPickA] = useState("");
  const [linkPickB, setLinkPickB] = useState(""); // اختيار ربط خطتين يدوياً
  const [showNewPlan, setShowNewPlan] = useState(false); // نافذة إنشاء خطة جديدة
  const [openGroup, setOpenGroup] = useState("master"); // القسم المفتوح في الشريط الجانبي
  const [lang, setLang] = usePersistedState("cdt:lang", "ar");
  __LANG = lang; // يضبط لغة دوال الترجمة __t/__tf لكل رسم
  const [theme, setTheme] = usePersistedState("cdt:theme", "dark");
  const [expandedTrace, setExpandedTrace] = useState({}); // لعرض "لماذا هذا القرار؟" لكل وكيل
  const [workflow, setWf] = useState("idle"); // idle | syncing | planned | confirmed
  const [syncLog, setSyncLog] = useState([]);
  const [confirmed, setConfirmed] = useState(false);
  const [selMat, setSelMat] = useState(bom[0]?.id || "balm");
  const [srForm, setSrForm] = useState({
    materialId: bom[0]?.id || "balm",
    qty: "",
    weeksFromNow: 1
  });

  // لو تغيّر الـBOM كاملاً (مثلاً دخول عميل سحابي ببيانات مختلفة تمامًا) وصار الاختيار الحالي غير موجود، رجّع لأول مادة متاحة
  useEffect(() => {
    if (bom.length && !bom.some(b => b.id === selMat)) setSelMat(bom[0].id);
    if (bom.length && !bom.some(b => b.id === srForm.materialId)) setSrForm(f => ({
      ...f,
      materialId: bom[0].id
    }));
  }, [bom]);

  // ── AI Agents state ──
  const [agentStatus, setAgentStatus] = useState("idle"); // idle|running|done|error
  const [currentAgent, setCurrentAgent] = useState(0);
  const [agentOutputs, setAgentOutputs] = useState({
    a1: null,
    a2: null,
    a3: null,
    a4: null
  });
  const [comparisonPlan, setComparisonPlan] = useState(null); // نتيجة تطبيق مقترح الوكيل الرابع، لمقارنتها بالخطة الأساسية
  const [comparisonBusy, setComparisonBusy] = useState(false);
  const [scenario, setScenario] = useState("");

  // أي وكلاء فعلياً سيشتغلون؟ MPS وكبير المخططين دائماً، وMRP فقط لو hasBOM، والصيانة+FGI فقط
  // لو ينطبق أحدهما على الأقل — استدعاء وكيل لتحليل بيانات فارغة/غير منطبقة إهدار مال وغير مفيد
  const runsA2 = !!planningProfile.hasBOM;
  const runsA3 = !!(planningProfile.hasFGI || planningProfile.hasMaintenance);
  const activeAgentSteps = 1 + (runsA2 ? 1 : 0) + (runsA3 ? 1 : 0) + 1;

  // ── What-If state ──
  const [whatIf, setWhatIf] = useState({
    demandPct: 0,
    machineDownWeeks: [],
    machinePct: 50,
    active: false
  });
  const [supplierDelays, setSupplierDelays] = useState({});
  const [runToFailure, setRunToFailure] = useState({
    active: false,
    week: "W1",
    downtimeHours: 8
  });

  // ── Costs state ──
  const [costs, setCosts, rCosts] = usePersistedState(planKey("costs"), {
    perUnit: 8,
    workerShiftCost: 500,
    otHourRate: 150,
    holdingPct: 0.5,
    orderCost: 500
  });

  // ── Data Import state ──
  const [importStatus, setImportStatus] = useState({
    type: "idle",
    message: ""
  }); // idle|loading|success|error
  const [cloudSyncStatus, setCloudSyncStatus] = useState({
    type: "idle",
    message: ""
  }); // idle|syncing|success|error
  const fileInputRef = useRef(null);

  // ── Email state ──
  const [emailTo, setEmailTo] = useState("");
  const ready = rPL2 && rAPID && !!activePlanId && rPW && rD && rB && rI && rC && rFG && rEM && rAK && rCU && rPP && rCosts && rOL;

  // ── شبكة أمان: إصلاح تلقائي عند الإقلاع لأي تعارض قديم بين BOM والمخزون ──
  // (يمنع تكرار خطأ "Cannot read properties of undefined" من بيانات محفوظة تالفة)
  const [repairNotice, setRepairNotice] = useState(null);
  useEffect(() => {
    if (!ready) return;
    const {
      repaired,
      changed
    } = autoRepairInventory(bom, inventory);
    if (changed) {
      setInv(repaired);
      setRepairNotice(__t("تم إصلاح تعارض في بيانات المخزون المحفوظة تلقائياً (كانت بعض المواد بلا سجل مخزون).", "A conflict in the saved inventory data was repaired automatically (some materials had no inventory record)."));
    }
    // يعمل مرة واحدة فقط عند اكتمال التحميل
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // ── Derived: workflow readiness ──
  const planReady = workflow === "planned" || workflow === "confirmed";
  const totalDemand = demand.reduce((s, d) => s + d.qty, 0);
  // نهاية أفق الخطة الحالية بتاريخ حقيقي — أي SR يصل ضمن هذا المدى يكون قد اُحتُسب فعلاً
  // ضمن endingStock (عبر srForWeek داخل calcMRP)، وبالتالي لا يجوز اعتباره "يغطي" احتياجاً
  // جديداً يظهره nextMonthRec لاحقاً (راجع تبويب "توصيات الشهر القادم")
  const planHorizonEnd = useMemo(() => weekRange(planStartDate, Math.max(0, planWeeks - 1)).end, [planStartDate, planWeeks, __LANG]);

  // إعدادات "فعلية" للحساب فقط، مبنية على ملف تخطيط الشركة — لا تُغيّر ولا تُكتب فوق القيم
  // المحفوظة الحقيقية إطلاقاً (لو رجّعوا يفعّلون FGI/الصيانة لاحقاً، تُستخدم قيمهم المحفوظة كما هي)
  const effectiveFgiConfig = useMemo(() => planningProfile.hasFGI ? fgiConfig : {
    current: 0,
    safety: 0,
    maxWarehouse: Number.MAX_SAFE_INTEGER,
    mode: "push"
  }, [fgiConfig, planningProfile.hasFGI, __LANG]);
  const effectiveEngineMaint = useMemo(() => planningProfile.hasMaintenance ? engineMaint : {
    intervalHours: Number.MAX_SAFE_INTEGER,
    durationHours: 0,
    remainingHours: Number.MAX_SAFE_INTEGER
  }, [engineMaint, planningProfile.hasMaintenance, __LANG]);

  // ── Core calculations — منسّق واحد يربط MPS/MRP/الصيانة/المواد الخام معاً ──
  const simulation = useMemo(() => runFullSimulation({
    demand,
    cap,
    fgiConfig: effectiveFgiConfig,
    bom,
    inventory,
    engineMaintCfg: effectiveEngineMaint,
    poLog,
    planStartDate,
    costs
  }), [demand, cap, effectiveFgiConfig, bom, inventory, effectiveEngineMaint, poLog, planStartDate, costs, __LANG]);
  const {
    mps,
    mrp,
    engineResult,
    materialCaps,
    anyMaterialConstraint
  } = simulation;
  const postPlan = useMemo(() => calcPostPlan(inventory, mrp), [inventory, mrp, __LANG]);
  const avgDemand = useMemo(() => demand.reduce((s, d) => s + d.qty, 0) / (demand.length || 1), [demand, __LANG]);
  const nextMonthRec = useMemo(() => calcNextMonthRec(postPlan, bom, avgDemand), [postPlan, bom, avgDemand, __LANG]);

  // ── Further derived ──
  const overloaded = mps.filter(m => !m.feasible).length;
  const needsOT = mps.filter(m => m.otDaysUsed > 0).length;
  const idleWeeks = mps.filter(m => m.idle).length;
  const materialConstrainedWeeks = mps.filter(m => m.materialConstrained).length;
  const totalScrap = mps.reduce((s, m) => s + m.scrapUnits, 0);
  const avgDefectRate = +(mps.reduce((s, m) => s + m.defectRateUsed, 0) / (mps.length || 1)).toFixed(2);
  const stockoutAll = mrp.flatMap(m => m.weeks.filter(w => w.stockout));
  const tooLateAll = mrp.flatMap(m => m.weeks.filter(w => w.tooLateToOrder));
  const avgUtil = +(mps.reduce((s, m) => s + m.util, 0) / (mps.length || 1)).toFixed(1);
  const maxShiftsUsed = mps.length ? Math.max(...mps.map(m => m.shifts)) : 1;
  const selMRP = mrp.find(m => m.id === selMat) || mrp[0];
  const fgiEnd = mps[mps.length - 1]?.fgAfter ?? fgiConfig.current;
  const fgiBelowCount = mps.filter(m => m.fgBelowSafety).length;
  const anyCapacityConstrained = mrp.some(m => m.weeks.some(w => w.capacityConstrained));

  // ── What-If derived ──
  const scenarioDemand = useMemo(() => demand.map(d => ({
    ...d,
    qty: Math.round(d.qty * (1 + whatIf.demandPct / 100))
  })), [demand, whatIf.demandPct, __LANG]);
  // ما-لو يمرّ بنفس المحرك الكامل للخطة الأساسية (صيانة، قيود المواد، سعة التخزين، التسوية) — فيطابقها تماماً عند عدم تغيير أي شيء
  const whatIfSim = useMemo(() => whatIf.active ? runFullSimulation({
    demand: scenarioDemand,
    cap,
    fgiConfig: effectiveFgiConfig,
    bom,
    inventory,
    engineMaintCfg: effectiveEngineMaint,
    poLog,
    planStartDate,
    costs,
    rateFactors: Object.fromEntries(whatIf.machineDownWeeks.map(w => [w, 1 - whatIf.machinePct / 100])),
    supplierDelays
  }) : null, [whatIf, scenarioDemand, cap, effectiveFgiConfig, bom, inventory, effectiveEngineMaint, poLog, planStartDate, costs, supplierDelays, __LANG]);
  const whatIfMPS = whatIfSim ? whatIfSim.mps : null;
  const whatIfMRP = whatIfSim ? whatIfSim.mrp : null;
  const runToFailureResult = useMemo(() => runToFailure.active && planReady ? calcRunToFailure(mps, runToFailure.week, runToFailure.downtimeHours) : null, [runToFailure, mps, planReady, __LANG]);

  // ── Plan-only analytics ──
  const costAnalysis = useMemo(() => planReady ? calcCosts(mps, mrp, costs, cap) : null, [mps, mrp, costs, cap, planReady, __LANG]);
  const feasibility = useMemo(() => planReady ? calcFeasibility(mps, mrp, stockoutAll, overloaded, needsOT, avgUtil, fgiBelowCount, engineResult, anyCapacityConstrained, anyMaterialConstraint) : null, [mps, mrp, stockoutAll, overloaded, needsOT, avgUtil, fgiBelowCount, engineResult, anyCapacityConstrained, anyMaterialConstraint, planReady, __LANG]);

  // ── 📊 لقطة ملخّص الخطة على سجل الخطط (يُغذّي "متابعة كل الخطط" وفحص تقاطع الطاقة) ──
  // تتحدّث تلقائياً كلما تغيّرت النتائج الفعلية (لا تُكتب لو القيم نفسها لم تتغيّر، لتفادي دورة تحديث عبثية)
  useEffect(() => {
    if (!activePlanId || !planReady || !feasibility || !costAnalysis) return;
    // مواعيد كل أسبوع الفعلية (تقويمية) + الحمل، لتمكين فحص تقاطع الطاقة مع خطط أخرى مرتبطة لاحقاً
    // بدون الحاجة لإعادة تحميل بيانات BOM/الطلب الكاملة لأي خطة أخرى وقت الفحص
    const weeklyCapacity = mps.map((m, wi) => {
      const {
        start,
        end
      } = weekRange(planStartDate, wi);
      return {
        start,
        end,
        loadH: m.loadH
      };
    });
    const capHoursPerWeek = +(cap.shiftHours * cap.maxShifts * 7).toFixed(1);
    const snap = {
      avgUtil,
      totalDemand,
      feasibilityScore: feasibility.score,
      totalCost: Math.round(costAnalysis.total),
      workflow,
      updatedAt: new Date().toISOString().slice(0, 10),
      weeklyCapacity,
      capHoursPerWeek
    };
    setPlans(prev => {
      const cur = prev.find(p => p.id === activePlanId);
      const s = cur?.lastSummary;
      const changed = !s || s.avgUtil !== snap.avgUtil || s.feasibilityScore !== snap.feasibilityScore || s.totalCost !== snap.totalCost || s.workflow !== snap.workflow || s.totalDemand !== snap.totalDemand || s.capHoursPerWeek !== snap.capHoursPerWeek || JSON.stringify(s.weeklyCapacity) !== JSON.stringify(snap.weeklyCapacity);
      if (!changed) return prev;
      return prev.map(p => p.id === activePlanId ? {
        ...p,
        lastSummary: snap
      } : p);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlanId, planReady, workflow, avgUtil, totalDemand, feasibility, costAnalysis, mps, planStartDate, cap.shiftHours, cap.maxShifts]);

  // ═══════════════════════════════════════════════════════════════
  //  HANDLERS
  // ═══════════════════════════════════════════════════════════════

  // ── توزيع تلقائي: إجمالي شهري → أسابيع (يراعي عدد الأسابيع المُختار) ──
  function autoDistributeDemand() {
    const newDemand = mkDemand(planWeeks, totalMonthly);
    setDemand(newDemand);
  }

  // ── تغيير عدد الأسابيع (مرن، يمكن تغييره متى شاء المستخدم) ──
  function applyPlanWeeksChange(n) {
    const clamped = Math.max(1, Math.min(52, n));
    setPlanWeeks(clamped);
    setDemand(mkDemand(clamped, totalMonthly));
  }
  const SYNC_STEPS = [__t("📦 التحقق من بيانات المخزون الحالي...", "📦 Checking current inventory data..."), __t("🏗️ التحقق من قائمة المواد (BOM)...", "🏗️ Checking the bill of materials (BOM)..."), __t("⚙️ التحقق من بيانات الطاقة الإنتاجية...", "⚙️ Checking production capacity data..."), __t("🔄 التحقق من إعدادات FGI (Pull/Push)...", "🔄 Checking FGI settings (Pull/Push)..."), __t("📋 حساب خطة الإنتاج الرئيسية (MPS)...", "📋 Calculating the master production schedule (MPS)..."), __t("🔧 حساب متطلبات المواد (MRP) — جدولة خلفية...", "🔧 Calculating material requirements (MRP) — backward scheduling..."), __t("📈 تحليل متطلبات الطاقة (CRP)...", "📈 Analyzing capacity requirements (CRP)..."), __t("👥 تحديد الورديات الأمثل لكل أسبوع...", "👥 Determining the optimal shifts for each week..."), __t("⏱️ فحص ساعات تشغيل الآلة والصيانة الدورية...", "⏱️ Checking machine operating hours and periodic maintenance..."), __t("✅ الخطة جاهزة للمراجعة", "✅ The plan is ready for review")];
  async function handleGeneratePlan() {
    setWf("syncing");
    setSyncLog([]);
    setConfirmed(false);
    setAgentStatus("idle");
    setAgentOutputs({
      a1: null,
      a2: null,
      a3: null,
      a4: null
    });
    // تثبيت "اليوم" كنقطة انطلاق حقيقية للخطة — هذا ما يجعل النظام حياً ومدركاً للتاريخ
    // بدل افتراض أن كل شيء يصل بنفس أسبوع الحاجة
    await setPlanStartDate(new Date().toISOString().slice(0, 10));
    for (let i = 0; i < SYNC_STEPS.length; i++) {
      await new Promise(r => setTimeout(r, 220 + Math.random() * 100));
      setSyncLog(p => [...p, SYNC_STEPS[i]]);
    }
    setWf("planned");
    setTab("dashboard");
  }

  // ── تأكيد شراء مادة خام: يُنشئ Scheduled Receipt حقيقي بتاريخ وصول ثابت ──
  // (بدل التوصية الافتراضية التي كانت تفترض الوصول بنفس أسبوع الحاجة)
  async function confirmPurchase(materialId, materialName, qty, leadTimeWeeks) {
    const today = new Date().toISOString().slice(0, 10);
    const entry = {
      id: `po_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      materialId,
      materialName,
      qty: Math.round(qty),
      confirmedOn: today,
      // للتوثيق فقط: متى فعلياً تم تأكيد الشراء
      // مرجع حساب الوصول = بداية الخطة الحالية (planStartDate)، نفس المرجع اللي يستخدمه srForWeek بالضبط —
      // لا نستخدم "اليوم الفعلي" هنا كي لا يختلف المرجعان لو تأخر الضغط على الزر عن وقت توليد الخطة
      arrivalDate: addDays(planStartDate, Math.round(leadTimeWeeks) * 7),
      status: "pending"
    };
    await setPoLog(p => [...p, entry]);
  }
  async function cancelPO(poId) {
    await setPoLog(p => p.filter(x => x.id !== poId));
  }
  async function markPOReceivedManually(poId) {
    await setPoLog(p => p.map(x => x.id === poId ? {
      ...x,
      status: "received"
    } : x));
  }
  // إدخال يدوي أولي: لطلبات شراء موجودة فعلاً قبل تشغيل النظام لأول مرة (أو أي تصحيح يدوي)
  // — هنا المستخدم يحدد الأسبوع/التاريخ بنفسه مباشرة بدل حسابه تلقائياً من مدة التوريد
  async function addManualSR() {
    const b = bom.find(x => x.id === srForm.materialId);
    const qty = Number(srForm.qty);
    const weeks = Number(srForm.weeksFromNow);
    if (!b || !qty || qty <= 0 || weeks < 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const entry = {
      id: `po_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      materialId: b.id,
      materialName: b.name,
      qty: Math.round(qty),
      confirmedOn: today,
      // للتوثيق فقط
      arrivalDate: addDays(planStartDate, Math.round(weeks) * 7),
      // نفس مرجع planStartDate المستخدم بكل مكان آخر
      status: "pending"
    };
    await setPoLog(p => [...p, entry]);
    setSrForm({
      materialId: srForm.materialId,
      qty: "",
      weeksFromNow: 1
    });
  }
  // مسح كل طلبات الشراء والبدء من جديد (بدون التأثير على بقية بيانات النظام)
  async function clearAllSR() {
    if (!confirm(__t("سيتم مسح كل طلبات الشراء المسجلة (المعلّقة والمستلمة). متابعة؟", "All recorded purchase orders (pending and received) will be erased. Continue?"))) return;
    await setPoLog([]);
  }
  async function handleConfirmPlan() {
    const updated = postPlan.map(item => ({
      ...inventory.find(i => i.id === item.id),
      available: item.endingStock
    }));
    await setInv(updated);
    // نكتب فقط لو الشركة فعلياً تتبّع هذا المفهوم (profile flag) — غير كذا القيم المحسوبة هنا وهمية
    // (بُنيت من إعداد فارغ/كبير جداً للتجاهل حسابياً)، وكتابتها فوق المحفوظ الحقيقي يُفسده لو رجّعوا يفعّلونه لاحقاً
    if (planningProfile.hasMaintenance && engineResult) {
      await setEngineMaint({
        ...engineMaint,
        remainingHours: engineResult.postPlanRemaining
      });
    }
    if (planningProfile.hasFGI) {
      await setFGI({
        ...fgiConfig,
        current: fgiEnd
      });
    }
    // أي طلب شراء مؤكد كان مقرراً وصوله ضمن أفق هذه الخطة قد انعكس بالفعل داخل endingStock —
    // نغلقه (received) حتى لا يُحتسب مرة ثانية عند بناء الخطة القادمة
    const horizonEnd = weekRange(planStartDate, Math.max(0, planWeeks - 1)).end;
    await setPoLog(p => p.map(x => x.status === "pending" && x.arrivalDate <= horizonEnd ? {
      ...x,
      status: "received"
    } : x));
    setConfirmed(true);
    setWf("confirmed");
    setTab("postupdate");
  }

  // ── AI Agents — سحابياً عبر الخادم الوسيط (بلا أي مفتاح بالمتصفح)، أو محلياً بمفتاح المستخدم الشخصي ──
  async function runMultiAgent() {
    if (!supabaseClient && !apiKeys[apiKeys.provider]) {
      setAgentOutputs({
        a1: null,
        a2: null,
        a3: null,
        a4: {
          data_reviewed: "",
          rules_applied: "",
          reasoning: "",
          recommendation: __tf("⚠️ لم يتم إدخال مفتاح API لمزوّد \"{0}\" بعد.\nاذهب لتبويب 📥 استيراد البيانات وأدخل المفتاح، أو بدّل المزوّد.", "⚠️ No API key has been entered for provider \"{0}\" yet.\nGo to the 📥 Data Import tab and enter the key, or switch the provider.", [apiKeys.provider])
        }
      });
      setAgentStatus("error");
      return;
    }
    setAgentStatus("running");
    setCurrentAgent(1);
    setAgentOutputs({
      a1: null,
      a2: null,
      a3: null,
      a4: null
    });
    const mpsCtx = mps.map(m => ({
      week: m.week,
      demand: m.demand,
      production: m.production,
      goodUnits: m.goodUnits,
      scrapUnits: m.scrapUnits,
      defectRateUsed: m.defectRateUsed,
      util: m.util,
      shifts: m.shifts,
      workDays: m.workDays,
      otDaysUsed: m.otDaysUsed,
      feasible: m.feasible,
      materialConstrained: m.materialConstrained,
      idle: m.idle,
      spareH: m.spareH,
      fgAfter: m.fgAfter,
      fgBelowSafety: m.fgBelowSafety
    }));
    const mrpCtx = mrp.map(m => ({
      material: m.name,
      leadTime: m.inv?.leadTime,
      maxCapacity: m.inv?.maxCapacity,
      stockouts: m.weeks.filter(w => w.stockout).map(w => w.week),
      tooLateWeeks: m.weeks.filter(w => w.tooLateToOrder).map(w => w.week),
      ordersCount: m.weeks.filter(w => w.order > 0).length,
      capacityConstrained: m.weeks.some(w => w.capacityConstrained),
      orderReleaseWeeks: m.weeks.filter(w => w.order > 0).map(w => ({
        need: w.week,
        releaseAt: w.orderWeek
      })),
      pendingReceipts: poLog.filter(p => p.materialId === m.id && p.status === "pending").map(p => ({
        qty: p.qty,
        arrivalDate: p.arrivalDate
      }))
    }));
    const engineCtx = planningProfile.hasMaintenance ? {
      intervalHours: effectiveEngineMaint.intervalHours,
      remainingHours: effectiveEngineMaint.remainingHours,
      maintenanceDue: engineResult?.maintenanceDone,
      maintenanceWeek: engineResult?.maintenanceWeek,
      maintenanceWeeks: engineResult?.maintenanceWeeks,
      feasibleWithMaint: engineResult?.allFeasibleWithMaint
    } : {
      applicable: false,
      note: "هذا المصنع لا يتتبّع صيانة دورية بالساعات (حسب ملف تخطيطه) — تجاهل هذا المحور كلياً في تحليلك"
    };
    const fgiCtx = planningProfile.hasFGI ? {
      mode: effectiveFgiConfig.mode,
      current: effectiveFgiConfig.current,
      safety: effectiveFgiConfig.safety,
      endOfPlan: fgiEnd,
      weeksBelowSafety: fgiBelowCount,
      totalScrapUnits: totalScrap,
      defectRateRange: [cap.defectRateMin, cap.defectRateMax]
    } : {
      applicable: false,
      note: "هذا المصنع ينتج حسب الطلب المؤكد فقط (Make-to-Order) بلا حاجز مخزون نهائي — تجاهل مفهوم FGI كلياً في تحليلك"
    };
    const kpiCtx = {
      avgUtil,
      overloaded,
      needsOT,
      stockouts: stockoutAll.length,
      maxShiftsUsed,
      totalDemand,
      demandPriority,
      fgiEnd,
      fgiBelowCount,
      planWeeks,
      anyMaterialConstraint,
      materialConstrainedWeeks: mps.filter(m => m.materialConstrained).map(m => m.week),
      hasBOM: planningProfile.hasBOM,
      hasFGI: planningProfile.hasFGI,
      hasMaintenance: planningProfile.hasMaintenance
    };

    // كل الوكلاء يلتزمون بنفس بنية JSON — لجعل "تفكير" الوكيل مرئياً ومفكّكاً بدل فقرة نهائية واحدة (يعالج مشكلة الصندوق الأسود المذكورة بالفصل ١-٢)
    const SCHEMA_INSTRUCTION = `أجب حصراً بصيغة JSON صالحة واحدة (بدون أي نص قبلها أو بعدها، وبدون markdown fences)، بالضبط بهذا الشكل:
{"data_reviewed":"أهم الأرقام/الأسابيع التي راجعتها من البيانات، مختصر جداً","rules_applied":"القاعدة أو الشرط الذي طبّقته بالضبط (بالأسماء والأرقام)","reasoning":"كيف ربطت البيانات بالقاعدة للوصول للاستنتاج، خطوة بخطوة، ٣-٤ أسطر كحد أقصى","recommendation":"التوصية النهائية الفورية، جملة أو جملتين"}
كل القيم نص عادي بالعربية بدون markdown داخلها.`;

    // مخطط الوكيل الرابع فقط: نفس الحقول + اقتراح تحسين قابل للتطبيق والمحاكاة فعلياً (مو نص عام)
    const AGENT4_SCHEMA_INSTRUCTION = `أجب حصراً بصيغة JSON صالحة واحدة (بدون أي نص قبلها أو بعدها، وبدون markdown fences)، بالضبط بهذا الشكل:
{"data_reviewed":"...","rules_applied":"...","reasoning":"...","recommendation":"...",
"suggestion": {"param":"normalDays|shiftHours|maxShifts|fgiSafety|fgiMaxWarehouse","newValue":رقم,"why":"سبب مختصر (سطر واحد)"} أو null}
- suggestion يجب أن يكون تغييراً حقيقياً واحداً فقط على أحد هذي المعاملات بالضبط (لا غيرها)، مبني على أرقام الاستغلال/الطاقة الفعلية أعلاه، قابل للتطبيق والمحاكاة مباشرة.
- استخدم null لـsuggestion فقط لو الخطة الحالية ممتازة فعلاً ولا يوجد تحسين رقمي واضح يستاهل تجربته.
كل القيم نص عادي بالعربية بدون markdown داخلها (ما عدا القيم الرقمية بـsuggestion).`;

    // ── مسار مباشر: Gemini / OpenRouter / Claude (استدعاءات متسلسلة من المتصفح، بعدد يتناسب مع ملف تخطيط الشركة) ──
    try {
      let step = 1;
      const a1raw = await callAIProvider(apiKeys, `أنت وكيل متخصص في تحليل MPS (خطة الإنتاج الرئيسية) لمصنع ينتج "${orgLabel.productName}".
مهمتك: تحليل جدول الإنتاج وتوزيع الورديات فقط — الجدوى، أسابيع الحمل الزائد بالأرقام، كفاءة توزيع الورديات.
${SCHEMA_INSTRUCTION}

بيانات MPS: ${JSON.stringify(mpsCtx)}`, supabaseClient);
      const a1 = parseAgentJSON(a1raw);
      setAgentOutputs(p => ({
        ...p,
        a1
      }));
      step++;
      setCurrentAgent(step);

      // وكيل MRP: يُستدعى فقط لو الشركة فعلياً تتبّع مواد خام — غير كذا استدعاؤه إهدار مال بلا فائدة
      let a2 = null;
      if (runsA2) {
        const a2raw = await callAIProvider(apiKeys, `أنت وكيل متخصص في تحليل MRP لمصنع ينتج "${orgLabel.productName}". النظام يستخدم جدولة خلفية (Backward Scheduling): أمر الشراء يُصدر قبل أسبوع الاحتياج بمقدار مدة التوريد. كميات الطلب مقيّدة بسعة تخزين كل مادة (maxCapacity).
مهمتك: المواد الأكثر خطورة، أسابيع النقص المتوقعة، هل توجد أسابيع "فات فيها أوان الطلب"، وهل أي أمر شراء تأثر بسعة التخزين.
${SCHEMA_INSTRUCTION}

تحليل وكيل MPS السابق: ${agentSummaryText(a1)}

بيانات MRP: ${JSON.stringify(mrpCtx)}`, supabaseClient);
        a2 = parseAgentJSON(a2raw);
        setAgentOutputs(p => ({
          ...p,
          a2
        }));
        step++;
        setCurrentAgent(step);
      }

      // وكيل الصيانة+FGI: يُستدعى فقط لو أحد المحورين ينطبق فعلياً على هذا المصنع
      let a3 = null;
      if (runsA3) {
        const priorLine = [a2 ? `MRP: ${agentSummaryText(a2)}` : null].filter(Boolean).join(" | ");
        const a3raw = await callAIProvider(apiKeys, `أنت وكيل متخصص في ${planningProfile.hasMaintenance ? "صيانة الآلة (القائمة فقط على ساعات التشغيل — لا توجد صيانة دورية أخرى)" : ""}${planningProfile.hasMaintenance && planningProfile.hasFGI ? " و" : ""}${planningProfile.hasFGI ? "إدارة مخزون المنتج النهائي (FGI)" : ""} لمصنع ينتج "${orgLabel.productName}".
مهمتك: ${planningProfile.hasMaintenance ? "هل ستقع الصيانة في هذه الخطة وهل الوقت كافٍ" : ""}${planningProfile.hasMaintenance && planningProfile.hasFGI ? "، و" : ""}${planningProfile.hasFGI ? "هل FGI يبقى فوق الحد الأدنى" : ""}.
${SCHEMA_INSTRUCTION}

تحليلات سابقة — MPS: ${agentSummaryText(a1)}${priorLine ? ` | ${priorLine}` : ""}

${planningProfile.hasMaintenance ? `صيانة الآلة: ${JSON.stringify(engineCtx)}` : ""}
${planningProfile.hasFGI ? `FGI: ${JSON.stringify(fgiCtx)}` : ""}`, supabaseClient);
        a3 = parseAgentJSON(a3raw);
        setAgentOutputs(p => ({
          ...p,
          a3
        }));
        step++;
        setCurrentAgent(step);
      }
      const priorSummaryLines = [`تحليل MPS: ${agentSummaryText(a1)}`, a2 ? `تحليل MRP: ${agentSummaryText(a2)}` : null, a3 ? `تحليل الصيانة/FGI: ${agentSummaryText(a3)}` : null].filter(Boolean).join("\n");
      const a4raw = await callAIProvider(apiKeys, `أنت كبير مخططي الإنتاج (Chief Planning Officer) في مصنع ${orgLabel.factoryName}. راجع تحليلات الفريق وأصدر قراراً نهائياً يشمل: حكم نهائي على الخطة، أولويات فورية هذا الأسبوع، أولويات الأسبوع القادم، وأعلى مخاطرة محتملة وكيفية التعامل معها.
${scenario ? `أجب أيضاً على سؤال المخطط ضمن recommendation: ${scenario}` : ""}
${AGENT4_SCHEMA_INSTRUCTION}
(في recommendation اكتب الحكم النهائي والأولويات مرقمة، حتى ١٨٠ كلمة)

${priorSummaryLines}
مؤشرات النظام: ${JSON.stringify(kpiCtx)}
القيم الحالية القابلة للتعديل: {"normalDays":${cap.normalDays},"shiftHours":${cap.shiftHours},"maxShifts":${cap.maxShifts}${planningProfile.hasFGI ? `,"fgiSafety":${effectiveFgiConfig.safety},"fgiMaxWarehouse":${effectiveFgiConfig.maxWarehouse}` : ""}}${!planningProfile.hasFGI ? "\n(لا تقترح تعديل fgiSafety أو fgiMaxWarehouse — هذا المصنع لا يستخدم مفهوم FGI أصلاً)" : ""}`, supabaseClient);
      const a4 = parseAgentJSON(a4raw);
      setAgentOutputs(p => ({
        ...p,
        a4
      }));
      setAgentStatus("done");
      setCurrentAgent(0);
    } catch (err) {
      setAgentOutputs(p => ({
        ...p,
        a4: {
          data_reviewed: "",
          rules_applied: "",
          reasoning: "",
          recommendation: __tf("❌ خطأ: {0}", "❌ Error: {0}", [err.message])
        }
      }));
      setAgentStatus("error");
      setCurrentAgent(0);
    }
  }

  // ── تطبيق مقترح الوكيل الرابع فعلياً (محاكاة منفصلة كاملة، بدون أي مساس بالخطة الحالية) ومقارنته بها ──
  function applySuggestionAndCompare(suggestion) {
    if (!suggestion || !suggestion.param) return;
    setComparisonBusy(true);
    const v = Number(suggestion.newValue);
    if (!Number.isFinite(v)) {
      setComparisonBusy(false);
      return;
    }
    let newCap = {
        ...cap
      },
      newFgi = {
        ...effectiveFgiConfig
      };
    let oldValue;
    if (suggestion.param === "normalDays") {
      oldValue = cap.normalDays;
      newCap.normalDays = Math.min(7, Math.max(1, Math.round(v)));
    } else if (suggestion.param === "shiftHours") {
      oldValue = cap.shiftHours;
      newCap.shiftHours = Math.max(1, v);
    } else if (suggestion.param === "maxShifts") {
      oldValue = cap.maxShifts;
      newCap.maxShifts = Math.min(3, Math.max(1, Math.round(v)));
    } else if (suggestion.param === "fgiSafety") {
      oldValue = effectiveFgiConfig.safety;
      newFgi.safety = Math.max(0, v);
    } else if (suggestion.param === "fgiMaxWarehouse") {
      oldValue = effectiveFgiConfig.maxWarehouse;
      newFgi.maxWarehouse = Math.max(0, v);
    } else {
      setComparisonBusy(false);
      return;
    }

    // محاكاة كاملة مستقلة بنفس محرك النظام الحقيقي — مو تقدير تقريبي
    const altSim = runFullSimulation({
      demand,
      cap: newCap,
      fgiConfig: newFgi,
      bom,
      inventory,
      engineMaintCfg: effectiveEngineMaint,
      poLog,
      planStartDate,
      costs
    });
    const altStockoutAll = altSim.mrp.flatMap(m => m.weeks.filter(w => w.stockout));
    const altOverloaded = altSim.mps.filter(m => m.util > 100).length;
    const altNeedsOT = altSim.mps.filter(m => m.otDaysUsed > 0).length;
    const altAvgUtil = +(altSim.mps.reduce((s, m) => s + m.util, 0) / (altSim.mps.length || 1)).toFixed(1);
    const altFgiBelowCount = altSim.mps.filter(m => m.fgBelowSafety).length;
    const altCapacityConstrained = altSim.mrp.some(m => m.weeks.some(w => w.capacityConstrained));
    const altCosts = calcCosts(altSim.mps, altSim.mrp, costs, newCap);
    const altFeasibility = calcFeasibility(altSim.mps, altSim.mrp, altStockoutAll, altOverloaded, altNeedsOT, altAvgUtil, altFgiBelowCount, altSim.engineResult, altCapacityConstrained, altSim.anyMaterialConstraint);
    setComparisonPlan({
      suggestion,
      oldValue,
      newValue: v,
      base: {
        avgUtil,
        stockouts: stockoutAll.length,
        needsOT: mps.filter(m => m.otDaysUsed > 0).length,
        overloaded,
        feasScore: feasibility?.score ?? 0,
        total: costAnalysis?.total ?? 0,
        prodCost: costAnalysis?.prodCost ?? 0,
        laborCost: costAnalysis?.laborCost ?? 0,
        otCost: costAnalysis?.otCost ?? 0,
        holdCost: costAnalysis?.holdCost ?? 0,
        orderCost: costAnalysis?.orderCost ?? 0
      },
      alt: {
        avgUtil: altAvgUtil,
        stockouts: altStockoutAll.length,
        needsOT: altNeedsOT,
        overloaded: altOverloaded,
        feasScore: altFeasibility.score,
        total: altCosts.total,
        prodCost: altCosts.prodCost,
        laborCost: altCosts.laborCost,
        otCost: altCosts.otCost,
        holdCost: altCosts.holdCost,
        orderCost: altCosts.orderCost
      }
    });
    setComparisonBusy(false);
    setTab("comparison");
  }

  // ── استيراد Excel — يطابق بالاسم مع BOM الحالي (لا يعتمد على عمود id) ──
  async function handleExcelFile(file) {
    if (!file) return;
    setImportStatus({
      type: "loading",
      message: __t("جاري قراءة الملف...", "Reading the file...")
    });
    try {
      const {
        result,
        foundSheets
      } = await parseExcelFile(file);
      let applied = [];
      if (result.inventory?.length) {
        const rawRows = result.inventory.map(normalizeInventoryRow);
        const {
          bom: mergedBom,
          inventory: reconciled,
          matchedCount,
          totalBom,
          newCount,
          unmatchedCount
        } = reconcileInventory(rawRows, bom, inventory);
        await setBom(mergedBom);
        await setInv(reconciled);
        applied.push(__tf("المخزون ({0}/{1} مادة تطابقت{2}{3})", "Inventory ({0}/{1} materials matched{2}{3})", [matchedCount, totalBom, unmatchedCount > 0 ? __tf("، {0} أُبقيت كما كانت", ", {0} kept as they were", [unmatchedCount]) : "", newCount > 0 ? __tf("، {0} مادة جديدة أُضيفت", ", {0} new materials added", [newCount]) : ""]));
      }
      if (result.capacity) {
        const mapped = mapExcelRowsToCapacity(result.capacity);
        if (mapped) {
          await setCap(mapped);
          applied.push(__t("الطاقة", "Capacity"));
        }
      }
      if (result.engine) {
        const mapped = mapExcelRowsToEngine(result.engine);
        if (mapped) {
          await setEngineMaint(mapped);
          applied.push(__t("الآلة", "Machine"));
        }
      }
      if (result.fgi) {
        const mapped = mapExcelRowsToFGI(result.fgi);
        if (mapped) {
          await setFGI(mapped);
          applied.push("FGI");
        }
      }
      if (applied.length === 0) {
        setImportStatus({
          type: "error",
          message: __tf("لم يتم العثور على شيتات مطابقة. الشيتات الموجودة: {0}. الأسماء المتوقعة: المخزون، الطاقة، الآلة، FGI", "No matching sheets found. Sheets present: {0}. Expected names: Inventory, Capacity, Machine, FGI (or their Arabic names)", [foundSheets.join(", ")])
        });
      } else {
        setImportStatus({
          type: "success",
          message: __tf("تم الاستيراد: {0} ✓", "Imported: {0} ✓", [applied.join(" | ")])
        });
      }
    } catch (err) {
      setImportStatus({
        type: "error",
        message: __tf("فشل الاستيراد: {0}", "Import failed: {0}", [err.message])
      });
    }
  }

  // ── مزامنة عبر روابط CSV منشورة من Google Sheets (بلا مفتاح API) ──
  async function handleCsvSync() {
    const hasAny = csvUrls.inventory || csvUrls.capacity || csvUrls.engine || csvUrls.fgi;
    if (!hasAny) {
      setImportStatus({
        type: "error",
        message: __t("أدخل رابط CSV منشور واحداً على الأقل", "Enter at least one published CSV link")
      });
      return;
    }
    setImportStatus({
      type: "loading",
      message: __t("جاري المزامنة...", "Syncing...")
    });
    try {
      let applied = [];
      if (csvUrls.inventory) {
        const rows = await fetchPublishedCSV(csvUrls.inventory);
        if (rows?.length) {
          const rawRows = rows.map(normalizeInventoryRow);
          const {
            bom: mergedBom,
            inventory: reconciled,
            matchedCount,
            totalBom,
            newCount
          } = reconcileInventory(rawRows, bom, inventory);
          await setBom(mergedBom);
          await setInv(reconciled);
          applied.push(__tf("المخزون ({0}/{1}{2})", "Inventory ({0}/{1}{2})", [matchedCount, totalBom, newCount > 0 ? __tf("، {0} مادة جديدة", ", {0} new materials", [newCount]) : ""]));
        }
      }
      if (csvUrls.capacity) {
        const rows = await fetchPublishedCSV(csvUrls.capacity);
        const mapped = mapExcelRowsToCapacity(rows);
        if (mapped) {
          await setCap(mapped);
          applied.push(__t("الطاقة", "Capacity"));
        }
      }
      if (csvUrls.engine) {
        const rows = await fetchPublishedCSV(csvUrls.engine);
        const mapped = mapExcelRowsToEngine(rows);
        if (mapped) {
          await setEngineMaint(mapped);
          applied.push(__t("الآلة", "Machine"));
        }
      }
      if (csvUrls.fgi) {
        const rows = await fetchPublishedCSV(csvUrls.fgi);
        const mapped = mapExcelRowsToFGI(rows);
        if (mapped) {
          await setFGI(mapped);
          applied.push("FGI");
        }
      }
      setImportStatus({
        type: applied.length ? "success" : "error",
        message: applied.length ? __tf("تمت المزامنة: {0} ✓", "Synced: {0} ✓", [applied.join(" | ")]) : __t("لم يتم جلب أي بيانات", "No data was fetched")
      });
    } catch (err) {
      setImportStatus({
        type: "error",
        message: err.message
      });
    }
  }

  // ── إعادة ضبط كاملة (تُستخدم عند تلف البيانات) ──
  function handleFactoryReset() {
    if (!confirm(__t("سيتم مسح كل البيانات المحفوظة والعودة للإعدادات الافتراضية. متابعة؟", "All saved data will be erased and the defaults restored. Continue?"))) return;
    clearAllPersistedData();
    window.location.reload();
  }

  // ── تعدد الخطط: إنشاء خطة جديدة (باختيار مشاركة موارد مع خطة موجودة) والتبديل بينها ──
  async function handleCreatePlan({
    productName,
    sharedMaterials
  }) {
    const newId = "plan_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    // معرّفات الخطط المصدر (بدون تكرار) — تُسجَّل بسجل الخطط نفسه (لا داخل BOM فقط) حتى يقدر أي طرف
    // يكتشف الارتباط بدون تحميل بيانات BOM الكاملة للطرف الآخر (مفيد لفحص تقاطع الطاقة لاحقاً)
    const linkedIds = [...new Set(sharedMaterials.map(s => s.sourcePlanId).filter(Boolean))];
    await setPlans(p => [...p.map(pl => linkedIds.includes(pl.id) ? {
      ...pl,
      linkedPlanIds: [...new Set([...(pl.linkedPlanIds || []), newId])]
    } : pl), {
      id: newId,
      productName,
      createdAt: new Date().toISOString().slice(0, 10),
      linkedPlanIds: linkedIds
    }]);
    if (sharedMaterials.length) {
      const newBom = sharedMaterials.map(s => ({
        id: "mat_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: s.name,
        qty: 1,
        unit: s.unit || "kg"
      }));
      const newInv = newBom.map((b, i) => ({
        id: b.id,
        name: b.name,
        unit: b.unit,
        available: sharedMaterials[i].available,
        safety: sharedMaterials[i].safety,
        leadTime: sharedMaterials[i].leadTime,
        maxCapacity: sharedMaterials[i].maxCapacity,
        unitCost: sharedMaterials[i].unitCost,
        sharedFromPlanId: sharedMaterials[i].sourcePlanId,
        sharedFromMaterialId: sharedMaterials[i].sourceMaterialId
      }));
      localStorage.setItem(`cdt:plan:${newId}:bom`, JSON.stringify(newBom));
      localStorage.setItem(`cdt:plan:${newId}:inventory`, JSON.stringify(newInv));
    }
    setShowNewPlan(false);
    setActivePlanId(newId);
  }
  function switchPlan(id) {
    setActivePlanId(id);
    setShowPlanMenu(false);
  }
  function deleteActivePlan() {
    if (plans.length <= 1) {
      alert(__t("ما تقدر تحذف آخر خطة موجودة.", "You can't delete the last remaining plan."));
      return;
    }
    if (!confirm(__tf("حذف خطة \"{0}\" نهائياً؟ كل بياناتها (BOM، المخزون، الخطط، إلخ) تُحذف ولا يمكن التراجع.", "Permanently delete plan \"{0}\"? All its data (BOM, inventory, plans, etc.) will be deleted and cannot be undone.", [orgLabel.productName || activePlan?.productName]))) return;
    ["planWeeks", "demand", "bom", "inventory", "capacity", "fgi", "engine", "polog", "planstartdate", "planningprofile", "orglabel", "costs"].forEach(suffix => localStorage.removeItem(`cdt:plan:${activePlanId}:${suffix}`));
    // نظّف أي رابط بخطط أخرى يشير للخطة المحذوفة — غير كذا يبقى معرّف يتيم بمصفوفة linkedPlanIds لخطط أخرى للأبد
    const remaining = plans.filter(p => p.id !== activePlanId).map(p => ({
      ...p,
      linkedPlanIds: (p.linkedPlanIds || []).filter(id => id !== activePlanId)
    }));
    setPlans(remaining);
    setActivePlanId(remaining[0].id);
  }
  // 🔗 ربط/فك ربط خطتين لغرض فحص تقاطع الطاقة فقط — مستقل تماماً عن مشاركة المواد الخام
  // (خطتان قد تستخدمان نفس خط الإنتاج فعلياً بدون أي مادة مشتركة بينهما إطلاقاً)
  function linkPlansForCapacity(idA, idB) {
    if (!idA || !idB || idA === idB) return;
    setPlans(prev => prev.map(p => {
      if (p.id === idA) return {
        ...p,
        linkedPlanIds: [...new Set([...(p.linkedPlanIds || []), idB])]
      };
      if (p.id === idB) return {
        ...p,
        linkedPlanIds: [...new Set([...(p.linkedPlanIds || []), idA])]
      };
      return p;
    }));
  }
  function unlinkPlans(idA, idB) {
    setPlans(prev => prev.map(p => {
      if (p.id === idA) return {
        ...p,
        linkedPlanIds: (p.linkedPlanIds || []).filter(x => x !== idB)
      };
      if (p.id === idB) return {
        ...p,
        linkedPlanIds: (p.linkedPlanIds || []).filter(x => x !== idA)
      };
      return p;
    }));
  }

  // ☁️ مزامنة الخطة النشطة يدوياً مع السحابة — إجراء صريح (مو تلقائي بالخلفية) كي يبقى قابلاً للتتبّع
  // والتحقق بسهولة؛ ينشئ منتجاً سحابياً جديداً أول مرة لو الخطة محلية بحتة، ثم يكتب BOM/المخزون/الطاقة فوق آخر نسخة سحابية
  async function handleSyncActivePlanToCloud() {
    if (!supabaseClient || !activePlanId) return;
    setCloudSyncStatus({
      type: "syncing",
      message: __t("جارٍ المزامنة...", "Syncing...")
    });
    try {
      let cloudProductId = activePlan?.cloudProductId;
      if (!cloudProductId) {
        cloudProductId = await pushNewProductToCloud(supabaseClient, cloudSeed.orgId, orgLabel.productName);
        await setPlans(prev => prev.map(p => p.id === activePlanId ? {
          ...p,
          cloudProductId
        } : p));
      }
      await syncBomToCloud(supabaseClient, cloudSeed.orgId, cloudProductId, bom, inventory);
      await syncCapacityToCloud(supabaseClient, cloudSeed.orgId, cloudProductId, cap);
      setCloudSyncStatus({
        type: "success",
        message: __tf("تمت المزامنة ✓ ({0} مادة)", "Synced ✓ ({0} materials)", [bom.length])
      });
      setTimeout(() => setCloudSyncStatus({
        type: "idle",
        message: ""
      }), 3000);
    } catch (err) {
      setCloudSyncStatus({
        type: "error",
        message: err.message || String(err)
      });
    }
  }

  // ── إرسال بريد ──
  function handleSendPlanEmail() {
    if (!emailTo) return;
    const {
      subject,
      body
    } = buildPlanEmail({
      to: emailTo,
      mps,
      kpi: {
        avgUtil,
        overloaded,
        stockouts: stockoutAll.length,
        totalDemand
      },
      agentOutputs,
      planWeeks,
      productName: orgLabel.productName
    });
    openMailClient({
      to: emailTo,
      subject,
      body
    });
  }

  // ── Navigation — مجموعات رأسية مترابطة بدل شريط أفقي مسطّح ──
  const navGroupsRaw = [{
    id: "dashboard",
    standalone: true,
    label: __t("لوحة التحكم", "Dashboard"),
    icon: "🏭",
    locked: true
  }, {
    id: "allplans",
    standalone: true,
    label: __t("متابعة كل الخطط", "All plans overview"),
    icon: "📊"
  }, {
    id: "master",
    label: __t("البيانات الرئيسية", "Master data"),
    icon: "🗂️",
    items: [{
      id: "salesplan",
      label: __t("خطة المبيعات", "Sales plan"),
      icon: "📅"
    }, {
      id: "bom",
      label: "BOM",
      icon: "🏗️",
      needs: "hasBOM"
    }, {
      id: "inventory",
      label: __t("المخزون", "Inventory"),
      icon: "📦",
      needs: "hasBOM"
    }, {
      id: "polog",
      label: __t("طلبات الشراء (SR)", "Purchase orders (SR)"),
      icon: "🚚",
      needs: "hasBOM"
    }, {
      id: "fgi",
      label: "FGI",
      icon: "🔄",
      needs: "hasFGI"
    }, {
      id: "capacity",
      label: __t("الطاقة", "Capacity"),
      icon: "⚙️"
    }, {
      id: "engine",
      label: __t("الصيانة", "Maintenance"),
      icon: "🔩",
      needs: "hasMaintenance"
    }, {
      id: "dataImport",
      label: __t("استيراد البيانات", "Data import"),
      icon: "📥"
    }]
  }, {
    id: "planning",
    label: __t("التخطيط", "Planning"),
    icon: "📐",
    items: [{
      id: "mps",
      label: "MPS",
      icon: "📋",
      locked: true
    }, {
      id: "shifts",
      label: __t("الورديات", "Shifts"),
      icon: "👥",
      locked: true
    }, {
      id: "mrp",
      label: "MRP",
      icon: "🔧",
      locked: true,
      needs: "hasBOM"
    }, {
      id: "crp",
      label: "CRP",
      icon: "📈",
      locked: true
    }]
  }, {
    id: "ai",
    label: __t("الذكاء الاصطناعي والسيناريوهات", "AI & scenarios"),
    icon: "🤖",
    items: [{
      id: "agents",
      label: "AI Agents",
      icon: "🤖",
      locked: true
    }, {
      id: "whatif",
      label: __t("ماذا لو؟", "What-if?"),
      icon: "🔀",
      locked: true
    }, {
      id: "comparison",
      label: __t("مقارنة المقترح", "Proposal comparison"),
      icon: "⚖️",
      locked: true
    }]
  }, {
    id: "schedule",
    label: __t("الجدولة والتكاليف", "Scheduling & costs"),
    icon: "🗓️",
    items: [{
      id: "gantt",
      label: __t("الجدول اليومي", "Daily schedule"),
      icon: "🗓️",
      locked: true
    }, {
      id: "costs",
      label: __t("التكاليف", "Costs"),
      icon: "💵",
      locked: true
    }]
  }, {
    id: "reports",
    label: __t("التقارير والمخرجات", "Reports & output"),
    icon: "📊",
    items: [{
      id: "feasibility",
      label: __t("تقرير الجدوى", "Feasibility report"),
      icon: "📊",
      locked: true
    }, {
      id: "postupdate",
      label: __t("تحديث المخزون", "Inventory update"),
      icon: "✅",
      locked: true
    }, {
      id: "reports",
      label: __t("PDF وإرسال", "PDF & send"),
      icon: "🖨️",
      locked: true
    }]
  }, {
    id: "about",
    standalone: true,
    label: __t("عن النظام", "About the system"),
    icon: "💡"
  }];
  // فلترة التبويبات فعلياً حسب ملف تخطيط الشركة (planningProfile) — تبويب يحتاج "hasBOM" مثلاً
  // يُخفى إن كانت إجابتهم "لا" على سؤال BOM، دون حذف أي بيانات مُدخَلة مسبقاً لو غيّروا رأيهم لاحقاً
  const navGroups = navGroupsRaw.map(g => g.standalone ? g : {
    ...g,
    items: g.items.filter(it => !it.needs || planningProfile[it.needs])
  }).filter(g => g.standalone || g.items.length > 0);
  const activeGroup = navGroups.find(g => !g.standalone && g.items.some(i => i.id === tab));
  const T = SECTION_HEADERS[lang]; // عناوين الأقسام
  const GL = GROUP_LABELS[lang]; // تسميات المجموعات
  const IL = ITEM_LABELS[lang]; // تسميات العناصر
  const U = UI[lang]; // نصوص الهيدر العامة

  // فتح القسم الصحيح تلقائياً كلما تغيّر التبويب من مكان آخر بالتطبيق
  useEffect(() => {
    if (activeGroup) setOpenGroup(activeGroup.id);
  }, [tab]);

  // شبكة أمان: لو تبويب الحالي صار مخفياً بسبب تغيير ملف تخطيط الشركة (مثلاً غيّروا "عندنا BOM؟" لـ"لا")
  // وهم فعلياً واقفين بتبويب BOM، رجّعهم لمكان آمن بدل صفحة يتيمة فارغة
  useEffect(() => {
    const allVisibleIds = navGroups.flatMap(g => g.standalone ? [g.id] : g.items.map(i => i.id));
    if (!allVisibleIds.includes(tab)) setTab(planReady ? "dashboard" : "salesplan");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planningProfile]);
  if (!ready) return /*#__PURE__*/React.createElement("div", {
    className: "min-h-screen bg-slate-950 flex items-center justify-center text-slate-300"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-center space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-4xl animate-spin"
  }, "\u2699\uFE0F"), /*#__PURE__*/React.createElement("div", null, __t("جاري التحميل...", "Loading..."))));
  if (planningProfile.hasBOM === null) {
    return /*#__PURE__*/React.createElement(PlanningProfileWizard, {
      onComplete: a => setPlanningProfile({
        hasBOM: !!a.hasBOM,
        hasFGI: !!a.hasFGI,
        hasMaintenance: !!a.hasMaintenance
      })
    });
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "h-screen flex flex-col bg-slate-950 text-slate-100 font-sans",
    dir: lang === "ar" ? "rtl" : "ltr",
    "data-theme": theme
  }, /*#__PURE__*/React.createElement("div", {
    className: "shrink-0 bg-slate-900 border-b border-slate-700 px-4 py-2.5 flex items-center justify-between flex-wrap gap-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-base font-bold text-blue-400"
  }, U.brandTitle, " \u2014 ", orgLabel.productName), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500"
  }, U.brandSubtitle)), /*#__PURE__*/React.createElement("div", {
    className: "relative"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowPlanMenu(p => !p),
    className: "flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-lg px-2.5 py-1.5 text-xs text-slate-300"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDDC2\uFE0F"), /*#__PURE__*/React.createElement("span", {
    className: "max-w-[140px] truncate"
  }, activePlan?.productName || __t("خطة بدون اسم", "Unnamed plan")), /*#__PURE__*/React.createElement("span", {
    className: "text-slate-500"
  }, "\u25BE")), showPlanMenu && /*#__PURE__*/React.createElement("div", {
    className: "absolute z-40 top-full mt-1 right-0 w-64 bg-slate-800 border border-slate-600 rounded-xl shadow-2xl p-1.5 space-y-0.5"
  }, plans.map(p => /*#__PURE__*/React.createElement("button", {
    key: p.id,
    onClick: () => switchPlan(p.id),
    className: `w-full text-right px-2.5 py-2 rounded-lg text-xs flex items-center justify-between ${p.id === activePlanId ? "bg-blue-900/50 text-blue-300" : "text-slate-300 hover:bg-slate-700"}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "truncate"
  }, p.productName || __t("(بدون اسم)", "(unnamed)")), p.id === activePlanId && /*#__PURE__*/React.createElement("span", null, "\u2713"))), /*#__PURE__*/React.createElement("div", {
    className: "border-t border-slate-700 my-1"
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setShowPlanMenu(false);
      setShowNewPlan(true);
    },
    className: "w-full text-right px-2.5 py-2 rounded-lg text-xs text-emerald-400 hover:bg-emerald-950/40"
  }, __t("+ خطة جديدة", "+ New plan")), plans.length > 1 && /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setShowPlanMenu(false);
      deleteActivePlan();
    },
    className: "w-full text-right px-2.5 py-2 rounded-lg text-xs text-red-400 hover:bg-red-950/40"
  }, __t("🗑️ حذف الخطة الحالية", "🗑️ Delete the current plan")))), supabaseClient && /*#__PURE__*/React.createElement("button", {
    onClick: handleSyncActivePlanToCloud,
    disabled: cloudSyncStatus.type === "syncing",
    title: activePlan?.cloudProductId ? __t("مزامنة BOM/المخزون/الطاقة مع السحابة", "Sync BOM/inventory/capacity with the cloud") : __t("أول مزامنة — ستُنشئ منتجاً جديداً بالسحابة لهذي الخطة", "First sync — will create a new cloud product for this plan"),
    className: "flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-600 rounded-lg px-2.5 py-1.5 text-xs text-slate-300"
  }, /*#__PURE__*/React.createElement("span", null, cloudSyncStatus.type === "syncing" ? "⏳" : cloudSyncStatus.type === "success" ? "✅" : cloudSyncStatus.type === "error" ? "⚠️" : "☁️"), /*#__PURE__*/React.createElement("span", null, cloudSyncStatus.type === "syncing" ? __t("جارٍ المزامنة...", "Syncing...") : cloudSyncStatus.type === "success" ? cloudSyncStatus.message : activePlan?.cloudProductId ? __t("مزامنة", "Sync") : __t("مزامنة أولى", "First sync")))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3 text-xs font-mono flex-wrap"
  }, workflow === "idle" && /*#__PURE__*/React.createElement("span", {
    className: "bg-slate-800 text-slate-400 px-2 py-1 rounded border border-slate-600"
  }, U.waitingSales), workflow === "syncing" && /*#__PURE__*/React.createElement("span", {
    className: "bg-blue-900/60 text-blue-300 px-2 py-1 rounded border border-blue-700 animate-pulse"
  }, U.processing), workflow === "planned" && /*#__PURE__*/React.createElement("span", {
    className: "bg-amber-900/60 text-amber-300 px-2 py-1 rounded border border-amber-700"
  }, U.readyConfirm), workflow === "confirmed" && /*#__PURE__*/React.createElement("span", {
    className: "bg-emerald-900/60 text-emerald-300 px-2 py-1 rounded border border-emerald-700"
  }, U.confirmed), agentStatus === "done" && /*#__PURE__*/React.createElement("span", {
    className: "bg-purple-900/60 text-purple-300 px-2 py-1 rounded border border-purple-700"
  }, U.agentsDone), planReady && /*#__PURE__*/React.createElement("span", {
    className: avgUtil > 100 ? "text-red-400" : avgUtil > 85 ? "text-amber-400" : "text-emerald-400"
  }, "\u26A1", avgUtil, "%"), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-1.5 border-r border-slate-700 pr-3 mr-1"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setTheme(theme === "dark" ? "light" : "dark"),
    className: "bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded border border-slate-600 transition-colors"
  }, U.themeBtn(theme)), /*#__PURE__*/React.createElement("button", {
    onClick: () => setLang(lang === "ar" ? "en" : "ar"),
    className: "bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded border border-slate-600 font-bold transition-colors"
  }, "\uD83C\uDF10 ", U.langBtn)))), cloudSyncStatus.type === "error" && /*#__PURE__*/React.createElement("div", {
    className: "shrink-0 bg-red-950/40 border-b border-red-800 px-4 py-2 text-xs text-red-300 flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", null, __t("⚠️ فشلت مزامنة السحابة:", "⚠️ Cloud sync failed:"), " ", cloudSyncStatus.message), /*#__PURE__*/React.createElement("button", {
    onClick: () => setCloudSyncStatus({
      type: "idle",
      message: ""
    }),
    className: "text-red-400 hover:text-red-200 font-bold"
  }, "\u2715")), showNewPlan && /*#__PURE__*/React.createElement(NewPlanDialog, {
    plans: plans,
    onCancel: () => setShowNewPlan(false),
    onCreate: handleCreatePlan
  }), /*#__PURE__*/React.createElement("div", {
    className: "flex-1 flex overflow-hidden"
  }, /*#__PURE__*/React.createElement("aside", {
    className: "w-60 shrink-0 border-l border-slate-700 bg-slate-900 overflow-y-auto py-2"
  }, navGroups.map(g => {
    if (g.standalone) {
      const locked = g.locked && !planReady;
      return /*#__PURE__*/React.createElement("button", {
        key: g.id,
        onClick: () => !locked && setTab(g.id),
        className: `w-full flex items-center gap-2 px-3 py-2.5 text-xs font-semibold text-right transition-colors ${tab === g.id ? "bg-blue-900/40 text-blue-300 border-r-2 border-blue-500" : "border-r-2 border-transparent"} ${locked ? "text-slate-600 cursor-not-allowed" : "text-slate-300 hover:bg-slate-800/70"}`
      }, /*#__PURE__*/React.createElement("span", null, g.icon), /*#__PURE__*/React.createElement("span", {
        className: "flex-1"
      }, GL[g.id]), locked && /*#__PURE__*/React.createElement("span", {
        className: "text-[10px]"
      }, "\uD83D\uDD12"));
    }
    const isOpen = openGroup === g.id;
    const isActiveGroup = activeGroup?.id === g.id;
    return /*#__PURE__*/React.createElement("div", {
      key: g.id,
      className: "mb-0.5"
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setOpenGroup(isOpen ? null : g.id),
      className: `w-full flex items-center gap-2 px-3 py-2.5 text-xs font-semibold text-right transition-colors ${isActiveGroup ? "text-blue-300" : "text-slate-300"} hover:bg-slate-800/70`
    }, /*#__PURE__*/React.createElement("span", null, g.icon), /*#__PURE__*/React.createElement("span", {
      className: "flex-1"
    }, GL[g.id]), /*#__PURE__*/React.createElement("span", {
      className: `text-[10px] text-slate-500 transition-transform ${isOpen ? "rotate-90" : ""}`
    }, "\u25C2")), isOpen && /*#__PURE__*/React.createElement("div", {
      className: "pb-1"
    }, g.items.map(t => {
      const locked = t.locked && !planReady;
      const active = tab === t.id;
      return /*#__PURE__*/React.createElement("button", {
        key: t.id,
        onClick: () => !locked && setTab(t.id),
        className: `w-full flex items-center gap-2 pr-8 pl-3 py-2 text-xs text-right transition-colors border-r-2 ${active ? "bg-blue-900/40 text-blue-300 border-blue-500 font-medium" : "border-transparent"} ${locked ? "text-slate-600 cursor-not-allowed" : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-200"}`
      }, /*#__PURE__*/React.createElement("span", null, t.icon), /*#__PURE__*/React.createElement("span", {
        className: "flex-1"
      }, IL[t.id]), locked && /*#__PURE__*/React.createElement("span", {
        className: "text-[10px]"
      }, "\uD83D\uDD12"));
    })));
  })), /*#__PURE__*/React.createElement("main", {
    className: "flex-1 overflow-y-auto"
  }, /*#__PURE__*/React.createElement("div", {
    className: "p-4 max-w-5xl mx-auto"
  }, tab === "salesplan" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.salesplan), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-blue-800/50 p-4 space-y-3"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-semibold text-blue-400"
  }, __t("🧮 إدخال سريع — توزيع تلقائي على الأسابيع", "🧮 Quick entry — automatic distribution across the weeks")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-3 gap-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("إجمالي الطلب الشهري (وحدة)", "Total monthly demand (units)")), /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: totalMonthly,
    onChange: e => setTotalMonthly(Number(e.target.value)),
    className: "w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-slate-100 text-xs font-mono focus:border-blue-500 focus:outline-none"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("عدد أسابيع الخطة (مرن — غيّره متى شئت)", "Number of plan weeks (flexible — change it whenever you like)")), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "1",
    max: "52",
    value: planWeeks,
    onChange: e => applyPlanWeeksChange(Number(e.target.value)),
    className: "w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-slate-100 text-xs font-mono focus:border-blue-500 focus:outline-none"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("أولوية الطلب", "Demand priority")), /*#__PURE__*/React.createElement("select", {
    value: demandPriority,
    onChange: e => setDemandPriority(Number(e.target.value)),
    className: "w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-slate-100 text-xs focus:border-blue-500 focus:outline-none"
  }, /*#__PURE__*/React.createElement("option", {
    value: 1
  }, __t("1 — عالية 🔴", "1 — High 🔴")), /*#__PURE__*/React.createElement("option", {
    value: 2
  }, __t("2 — متوسطة 🟡", "2 — Medium 🟡")), /*#__PURE__*/React.createElement("option", {
    value: 3
  }, __t("3 — منخفضة 🟢", "3 — Low 🟢"))))), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500"
  }, __t("💡 التوزيع الأسبوعي = الإجمالي ÷ عدد الأسابيع (بالتساوي). كمية", "💡 Weekly distribution = total ÷ number of weeks (evenly). The actual"), " ", /*#__PURE__*/React.createElement("b", {
    className: "text-emerald-400"
  }, __t("الإنتاج", "production")), " ", __t("الفعلية تُحسب لاحقاً مع مراعاة مخزون FGI الحالي (Push/Pull/Hybrid في تبويب FGI).", "quantity is calculated later, taking the current FGI stock into account (Push/Pull/Hybrid in the FGI tab).")), /*#__PURE__*/React.createElement("button", {
    onClick: autoDistributeDemand,
    className: "bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg text-xs font-bold"
  }, __t("🔄 توزيع تلقائي على", "🔄 Auto-distribute over"), " ", planWeeks, " ", __t("أسبوع", "weeks"))), demand.length !== planWeeks && /*#__PURE__*/React.createElement("div", {
    className: "bg-amber-950/30 border border-amber-700 rounded-xl p-3 text-xs text-amber-300 flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", null, __t("⚠️ عدد أسابيع الجدول الحالي (", "⚠️ The number of weeks in the current table ("), demand.length, __t(") لا يطابق العدد المُختار (", ") does not match the selected number ("), planWeeks, ")"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setDemand(mkDemand(planWeeks, totalMonthly)),
    className: "bg-amber-700 hover:bg-amber-600 px-3 py-1 rounded text-white"
  }, __t("إعادة التوزيع الآن", "Redistribute now"))), workflow === "syncing" && /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-blue-700 p-4 space-y-1.5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-semibold text-blue-400 mb-2"
  }, __t("🔄 جاري تشغيل النظام...", "🔄 Running the system...")), syncLog.map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "text-xs text-emerald-400 font-mono flex gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\u2713"), /*#__PURE__*/React.createElement("span", null, s))), syncLog.length < 10 && /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500 animate-pulse"
  }, "...")), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-10 text-xs font-semibold text-slate-400 bg-slate-800 px-3 py-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "col-span-2"
  }, __t("الأسبوع", "Week")), /*#__PURE__*/React.createElement("span", {
    className: "col-span-5"
  }, __t("الطلب (وحدة) — قابل للتعديل اليدوي", "Demand (units) — manually editable")), /*#__PURE__*/React.createElement("span", {
    className: "col-span-3"
  }, planReady ? __t("الورديات/الحالة", "Shifts/Status") : __t("ملاحظة", "Note"))), demand.map((d, i) => {
    const m = planReady ? mps[i] : null;
    const isEngineMaintWeek = planReady && !!engineResult?.maintenanceWeeks?.includes(d.week);
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      className: `grid grid-cols-10 items-center px-3 py-2 text-xs border-t border-slate-800 ${m && !m.feasible ? "bg-red-950/20" : m && m.otDaysUsed > 0 ? "bg-amber-950/10" : isEngineMaintWeek ? "bg-purple-950/20" : ""}`
    }, /*#__PURE__*/React.createElement("span", {
      className: "col-span-2 font-mono text-slate-300 font-bold"
    }, d.week, isEngineMaintWeek && /*#__PURE__*/React.createElement("span", {
      className: "text-purple-400 mr-1"
    }, "\u23F1")), /*#__PURE__*/React.createElement("div", {
      className: "col-span-5 pr-4"
    }, /*#__PURE__*/React.createElement("input", {
      type: "number",
      value: d.qty,
      disabled: workflow === "syncing",
      onChange: e => {
        const nd = [...demand];
        nd[i] = {
          ...nd[i],
          qty: Number(e.target.value)
        };
        setDemand(nd);
      },
      className: "bg-slate-800 border border-slate-700 rounded px-2 py-1 w-full text-slate-100 text-xs font-mono focus:border-blue-500 focus:outline-none"
    })), /*#__PURE__*/React.createElement("div", {
      className: "col-span-3 flex items-center gap-1.5 pr-2"
    }, m ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
      className: "text-purple-400 font-mono text-xs"
    }, m.shifts, "W\xD7", m.workDays, "D"), !m.feasible ? /*#__PURE__*/React.createElement(Badge, {
      label: "\u2717"
    }) : m.otDaysUsed > 0 ? /*#__PURE__*/React.createElement(Badge, {
      warn: true,
      label: "OT"
    }) : /*#__PURE__*/React.createElement(Badge, {
      ok: true,
      label: "\u2713"
    })) : /*#__PURE__*/React.createElement("span", {
      className: "text-slate-600"
    }, "\u2014")));
  })), /*#__PURE__*/React.createElement("button", {
    onClick: handleGeneratePlan,
    disabled: workflow === "syncing" || planningProfile.hasBOM && bom.length === 0,
    className: "w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
  }, workflow === "syncing" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    className: "animate-spin"
  }, "\u23F3"), __t("جاري المعالجة...", "Processing...")) : planningProfile.hasBOM && bom.length === 0 ? /*#__PURE__*/React.createElement(React.Fragment, null, __t("⚠️ أضف مكوّنات المنتج من تبويب BOM أولاً", "⚠️ Add the product's components from the BOM tab first")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDE80"), __t("تشغيل النظام وإنشاء الخطة", "Run the system and create the plan")))), tab === "bom" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.bom), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-3"
  }, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("اسم المنتج", "Product name")), /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: orgLabel.productName,
    placeholder: __t("مثال: عصير برتقال 1 لتر", "Example: 1 L orange juice"),
    onChange: e => setOrgLabel({
      ...orgLabel,
      productName: e.target.value
    }),
    className: "bg-slate-800 border border-slate-700 rounded px-3 py-2 w-full text-slate-100 focus:border-blue-500 focus:outline-none text-sm"
  })), bom.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 border border-dashed border-slate-700 rounded-xl p-8 text-center space-y-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-3xl"
  }, "\uD83D\uDCE6"), /*#__PURE__*/React.createElement("div", {
    className: "text-slate-300 font-semibold text-sm"
  }, __t("لا توجد أي مادة بعد", "No materials yet")), /*#__PURE__*/React.createElement("div", {
    className: "text-slate-500 text-xs"
  }, __t("أضف مكوّنات منتجك واحدًا تلو الآخر (الاسم، الكمية لكل وحدة، الوحدة) — النظام يتكيّف مع أي عدد ونوع.", "Add your product's components one by one (name, quantity per unit, unit) — the system adapts to any number and type."))) : bom.some(b => ["بلم", "ستارين", "علبة دائرية", "غطاء (ستيمر)"].includes(b.name)) ? /*#__PURE__*/React.createElement("div", {
    className: "bg-amber-950/20 border border-amber-800/50 rounded-xl p-4 text-center space-y-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-slate-300 text-xs"
  }, __t("👀 هذي بيانات محفوظة سابقًا بمتصفحك (مو موجودة بالكود الحالي) — لو تريد أن تبدأ نظيفاً تمامًا:", "👀 This is data previously saved in your browser (not present in the current code) — if you want to start completely clean:")), /*#__PURE__*/React.createElement("button", {
    onClick: handleFactoryReset,
    className: "text-xs bg-red-900/50 hover:bg-red-900/70 border border-red-800 text-red-200 px-3 py-1.5 rounded-lg"
  }, __t("🗑️ مسح كل البيانات المحفوظة والبدء من جديد", "🗑️ Erase all saved data and start over"))) : /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-12 text-xs font-semibold text-slate-400 bg-slate-800 px-4 py-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "col-span-4"
  }, __t("المادة", "Material")), /*#__PURE__*/React.createElement("span", {
    className: "col-span-2"
  }, __t("الكمية/وحدة", "Qty/unit")), /*#__PURE__*/React.createElement("span", {
    className: "col-span-2"
  }, __t("الوحدة", "Unit")), /*#__PURE__*/React.createElement("span", {
    className: "col-span-3"
  }, __t("استهلاك/أسبوع", "Consumption/week")), /*#__PURE__*/React.createElement("span", {
    className: "col-span-1"
  })), bom.map((item, i) => /*#__PURE__*/React.createElement("div", {
    key: item.id,
    className: "grid grid-cols-12 items-center px-4 py-3 text-xs border-t border-slate-800"
  }, /*#__PURE__*/React.createElement("div", {
    className: "col-span-4 pl-2"
  }, /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: item.name,
    onChange: e => {
      const nb = [...bom];
      nb[i] = {
        ...nb[i],
        name: e.target.value
      };
      setBom(nb);
      setInv(inventory.map(iv => iv.id === item.id ? {
        ...iv,
        name: e.target.value
      } : iv));
    },
    className: "bg-slate-800 border border-slate-700 rounded px-2 py-1 w-full text-slate-200 font-medium focus:border-blue-500 focus:outline-none text-xs"
  })), /*#__PURE__*/React.createElement("div", {
    className: "col-span-2 pr-3"
  }, /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: item.qty,
    step: item.unit === "kg" || item.unit === "l" ? 0.001 : 1,
    onChange: e => {
      const nb = [...bom];
      nb[i] = {
        ...nb[i],
        qty: Number(e.target.value)
      };
      setBom(nb);
    },
    className: "bg-slate-800 border border-slate-700 rounded px-2 py-1 w-full text-slate-100 font-mono focus:border-blue-500 focus:outline-none text-xs"
  })), /*#__PURE__*/React.createElement("div", {
    className: "col-span-2 pr-3"
  }, /*#__PURE__*/React.createElement("select", {
    value: item.unit,
    onChange: e => {
      const nb = [...bom];
      nb[i] = {
        ...nb[i],
        unit: e.target.value
      };
      setBom(nb);
      setInv(inventory.map(iv => iv.id === item.id ? {
        ...iv,
        unit: e.target.value
      } : iv));
    },
    className: "bg-slate-800 border border-slate-700 rounded px-2 py-1 w-full text-slate-300 focus:border-blue-500 focus:outline-none text-xs"
  }, ["kg", "l", "pcs", "unit", "box", "m"].map(u => /*#__PURE__*/React.createElement("option", {
    key: u,
    value: u
  }, u)))), /*#__PURE__*/React.createElement("span", {
    className: "col-span-2 text-slate-400 font-mono"
  }, (avgDemand * item.qty).toLocaleString(undefined, {
    maximumFractionDigits: 0
  })), /*#__PURE__*/React.createElement("div", {
    className: "col-span-1 text-left"
  }, /*#__PURE__*/React.createElement("button", {
    title: __t("حذف المادة", "Delete material"),
    onClick: () => {
      if (!confirm(__tf("حذف \"{0}\" نهائياً من BOM والمخزون؟", "Permanently delete \"{0}\" from the BOM and inventory?", [item.name]))) return;
      setBom(bom.filter((_, idx) => idx !== i));
      setInv(inventory.filter(iv => iv.id !== item.id));
    },
    className: "text-red-400 hover:text-red-300 text-xs"
  }, "\uD83D\uDDD1\uFE0F"))))), /*#__PURE__*/React.createElement(AddMaterialForm, {
    onAdd: mat => {
      const id = "mat_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      setBom([...bom, {
        id,
        name: mat.name,
        qty: mat.qty,
        unit: mat.unit
      }]);
      setInv([...inventory, {
        id,
        name: mat.name,
        unit: mat.unit,
        available: mat.available,
        safety: mat.safety,
        leadTime: mat.leadTime,
        maxCapacity: mat.maxCapacity,
        unitCost: mat.unitCost
      }]);
    }
  })), tab === "inventory" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.inventory), inventory.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 border border-dashed border-slate-700 rounded-xl p-8 text-center space-y-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-3xl"
  }, "\uD83D\uDCCA"), /*#__PURE__*/React.createElement("div", {
    className: "text-slate-300 font-semibold text-sm"
  }, __t("لا يوجد مخزون بعد", "No inventory yet")), /*#__PURE__*/React.createElement("div", {
    className: "text-slate-500 text-xs"
  }, __t("المخزون يُبنى تلقائيًا من مواد BOM — أضف موادك أولاً من تبويب BOM، وراح تظهر هنا فورًا.", "Inventory is built automatically from the BOM materials — add your materials first from the BOM tab and they will appear here immediately."))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "bg-amber-950/20 border border-amber-800/50 rounded-xl p-3 text-xs text-amber-300"
  }, __t("📌 أي أمر شراء مقترح لن يتجاوز", "📌 Any suggested purchase order will not exceed the"), " ", /*#__PURE__*/React.createElement("b", null, __t("\"أقصى سعة تخزين\"", "\"maximum storage capacity\"")), " ", __t("— إن كانت الكمية المطلوبة أكبر من السعة المتاحة، سيُقيَّد الأمر وسيظهر تنبيه ⚠️ في تبويب MRP.", "— if the requested quantity is larger than the available capacity, the order will be capped and a ⚠️ warning will appear in the MRP tab.")), inventory.map((item, i) => {
    const bItem = bom.find(b => b.id === item.id);
    const weeksLeft = bItem && avgDemand > 0 ? +(item.available / (avgDemand * bItem.qty)).toFixed(1) : "∞";
    const sharedWithPlan = bItem?.sharedFromPlanId ? plans.find(p => p.id === bItem.sharedFromPlanId) : null;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex justify-between items-center mb-3"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "text-sm font-semibold text-slate-200 flex items-center gap-1.5"
    }, item.name, sharedWithPlan && /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] font-normal bg-sky-950/50 border border-sky-700 text-sky-300 px-1.5 py-0.5 rounded-full",
      title: __tf("نُسخ رصيدها الابتدائي من خطة \"{0}\" عند الإنشاء — تحديث المخزون بعدها يدوي بالطرفين، لا مزامنة تلقائية بين الخطتين", "Its opening balance was copied from plan \"{0}\" at creation — inventory updates afterwards are manual on both sides, with no automatic sync between the two plans", [sharedWithPlan.productName || __t("بدون اسم", "Unnamed")])
    }, __t("🔗 مشتركة مع \"", "🔗 Shared with \""), sharedWithPlan.productName || __t("بدون اسم", "Unnamed"), "\"")), /*#__PURE__*/React.createElement("span", {
      className: "text-xs text-slate-400 font-mono"
    }, __t("يكفي:", "Lasts:"), " ", /*#__PURE__*/React.createElement("span", {
      className: "text-blue-400"
    }, weeksLeft, "W"))), /*#__PURE__*/React.createElement("div", {
      className: "grid grid-cols-5 gap-3"
    }, /*#__PURE__*/React.createElement(Field, {
      label: __t("المخزون الحالي", "Current stock"),
      value: item.available,
      onChange: v => {
        const ni = [...inventory];
        ni[i] = {
          ...ni[i],
          available: v
        };
        setInv(ni);
      }
    }), /*#__PURE__*/React.createElement(Field, {
      label: __t("مخزون الأمان", "Safety stock"),
      value: item.safety,
      onChange: v => {
        const ni = [...inventory];
        ni[i] = {
          ...ni[i],
          safety: v
        };
        setInv(ni);
      }
    }), /*#__PURE__*/React.createElement(Field, {
      label: __t("مدة التوريد (W)", "Lead time (W)"),
      value: item.leadTime,
      onChange: v => {
        const ni = [...inventory];
        ni[i] = {
          ...ni[i],
          leadTime: v
        };
        setInv(ni);
      }
    }), /*#__PURE__*/React.createElement(Field, {
      label: __t("🔒 أقصى سعة تخزين", "🔒 Max storage capacity"),
      value: item.maxCapacity,
      onChange: v => {
        const ni = [...inventory];
        ni[i] = {
          ...ni[i],
          maxCapacity: v
        };
        setInv(ni);
      }
    }), /*#__PURE__*/React.createElement(Field, {
      label: __t("💰 تكلفة الوحدة (ريال)", "💰 Unit cost (riyal)"),
      value: item.unitCost || 0,
      onChange: v => {
        const ni = [...inventory];
        ni[i] = {
          ...ni[i],
          unitCost: v
        };
        setInv(ni);
      },
      step: 0.01
    })), (() => {
      const m = mrp.find(x => x.id === item.id);
      return m?.eoq > 0 ? /*#__PURE__*/React.createElement("div", {
        className: "mt-2 text-xs text-emerald-400 bg-emerald-950/20 border border-emerald-800/40 rounded-lg px-2 py-1"
      }, __t("🎯 كمية الطلب الاقتصادية (EOQ) المحسوبة:", "🎯 Calculated economic order quantity (EOQ):"), " ", /*#__PURE__*/React.createElement("b", null, m.eoq.toLocaleString()), " ", item.unit, " ", __t("— النظام يطلب هذي الكمية بدل الاحتياج الفوري بس، لو أوفر إجمالاً", "— the system orders this quantity instead of only the immediate need, when it is cheaper overall")) : null;
    })(), /*#__PURE__*/React.createElement("div", {
      className: "mt-2 flex items-center gap-2"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex-1 bg-slate-800 rounded-full h-1.5"
    }, /*#__PURE__*/React.createElement("div", {
      className: "h-1.5 rounded-full bg-blue-500",
      style: {
        width: `${Math.min(100, item.available / item.maxCapacity * 100)}%`
      }
    })), /*#__PURE__*/React.createElement("span", {
      className: "text-xs text-slate-500 font-mono"
    }, (item.available / item.maxCapacity * 100).toFixed(0), __t("% من السعة", "% of capacity"))), /*#__PURE__*/React.createElement("div", {
      className: "mt-1 text-xs text-slate-500"
    }, __t("الوحدة:", "Unit:"), " ", item.unit));
  }))), tab === "polog" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, __t("طلبات الشراء (Scheduled Receipts)", "Purchase orders (Scheduled Receipts)")), /*#__PURE__*/React.createElement("div", {
    className: "bg-amber-950/20 border border-amber-800/50 rounded-xl p-3 text-xs text-amber-300"
  }, __t("📌 هذا التبويب مستقل عن حالة الخطة — استخدمه أولاً عند بدء تشغيل النظام لإدخال أي مادة خام", "📌 This tab is independent of the plan status — use it first when starting the system to enter any raw material"), " ", /*#__PURE__*/React.createElement("b", null, __t("مطلوبة فعلياً وفي طريقها للوصول", "actually ordered and on its way")), " ", __t("(طلبيات سابقة على استخدام النظام)، وحدّد أنت الأسبوع الذي ستصل فيه. أي طلب تؤكده لاحقاً من تبويب \"توصيات الشهر القادم\" يُضاف هنا تلقائياً بنفس الطريقة.", "(orders placed before using the system), and you specify the week in which it will arrive. Any order you confirm later from the \"Next-month recommendations\" tab is added here automatically in the same way.")), bom.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 border border-dashed border-slate-700 rounded-xl p-6 text-center text-slate-500 text-xs"
  }, __t("أضف مكوّنات منتجك من تبويب BOM أولاً قبل تسجيل أي طلب شراء", "Add your product's components from the BOM tab first before recording any purchase order")) : /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-semibold text-slate-200 mb-3"
  }, __t("➕ إضافة طلب شراء يدوياً", "➕ Add a purchase order manually")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-3 gap-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("المادة الخام", "Raw material")), /*#__PURE__*/React.createElement("select", {
    value: srForm.materialId,
    onChange: e => setSrForm({
      ...srForm,
      materialId: e.target.value
    }),
    className: "w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
  }, bom.map(b => /*#__PURE__*/React.createElement("option", {
    key: b.id,
    value: b.id
  }, b.name)))), /*#__PURE__*/React.createElement(Field, {
    label: __t("الكمية", "Quantity"),
    value: srForm.qty,
    onChange: v => setSrForm({
      ...srForm,
      qty: v
    })
  }), /*#__PURE__*/React.createElement(Field, {
    label: __t("سيصل بعد كم أسبوع من اليوم", "Arrives in how many weeks from today"),
    value: srForm.weeksFromNow,
    onChange: v => setSrForm({
      ...srForm,
      weeksFromNow: v
    })
  })), /*#__PURE__*/React.createElement("button", {
    onClick: addManualSR,
    className: "mt-3 bg-sky-700 hover:bg-sky-600 px-4 py-2 rounded-xl text-xs font-bold"
  }, __t("➕ إضافة كـ Scheduled Receipt", "➕ Add as Scheduled Receipt"))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-400 flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", null, __t("🚚 معلّقة (بانتظار الوصول)", "🚚 Pending (awaiting arrival)")), poLog.length > 0 && /*#__PURE__*/React.createElement("button", {
    onClick: clearAllSR,
    className: "bg-red-900 hover:bg-red-800 px-2 py-1 rounded text-[10px] font-bold"
  }, __t("🗑️ مسح كل السجل والبدء من جديد", "🗑️ Clear the whole log and start over"))), poLog.filter(p => p.status === "pending").length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "px-4 py-3 text-xs text-slate-500"
  }, __t("لا توجد طلبات شراء مؤكدة بانتظار الوصول حالياً.", "There are no confirmed purchase orders awaiting arrival right now.")) : /*#__PURE__*/React.createElement("table", {
    className: "w-full text-xs"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "bg-slate-800/50 text-slate-400"
  }, [__t("المادة", "Material"), __t("الكمية", "Quantity"), __t("تاريخ التأكيد", "Confirmation date"), __t("تاريخ الوصول المتوقع", "Expected arrival date"), ""].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    className: "px-3 py-2 text-right"
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, poLog.filter(p => p.status === "pending").map(p => /*#__PURE__*/React.createElement("tr", {
    key: p.id,
    className: "border-t border-slate-800"
  }, /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-medium text-slate-200"
  }, p.materialName), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-sky-400 font-bold"
  }, p.qty.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-slate-400"
  }, p.confirmedOn), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-emerald-400"
  }, p.arrivalDate), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 flex gap-1"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => markPOReceivedManually(p.id),
    className: "bg-emerald-700 hover:bg-emerald-600 px-2 py-1 rounded text-[10px] font-bold whitespace-nowrap"
  }, __t("✓ وصل فعلياً", "✓ Actually arrived")), /*#__PURE__*/React.createElement("button", {
    onClick: () => cancelPO(p.id),
    className: "bg-red-900 hover:bg-red-800 px-2 py-1 rounded text-[10px] font-bold whitespace-nowrap"
  }, __t("✕ إلغاء", "✕ Cancel")))))))), poLog.some(p => p.status === "received") && /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-400"
  }, __t("✅ مستلمة (تم احتسابها ضمن المخزون بالفعل)", "✅ Received (already counted in the inventory)")), /*#__PURE__*/React.createElement("table", {
    className: "w-full text-xs"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "bg-slate-800/50 text-slate-400"
  }, [__t("المادة", "Material"), __t("الكمية", "Quantity"), __t("تاريخ التأكيد", "Confirmation date"), __t("تاريخ الوصول", "Arrival date")].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    className: "px-3 py-2 text-right"
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, poLog.filter(p => p.status === "received").map(p => /*#__PURE__*/React.createElement("tr", {
    key: p.id,
    className: "border-t border-slate-800 text-slate-500"
  }, /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2"
  }, p.materialName), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono"
  }, p.qty.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono"
  }, p.confirmedOn), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono"
  }, p.arrivalDate))))))), tab === "fgi" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.fgi), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mb-3"
  }, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("وحدة المنتج النهائي (علبة / زجاجة / كيس / ...)", "Finished-product unit (box / bottle / bag / ...)")), /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: orgLabel.fgUnit,
    onChange: e => setOrgLabel({
      ...orgLabel,
      fgUnit: e.target.value
    }),
    className: "bg-slate-800 border border-slate-700 rounded px-3 py-1.5 w-40 text-slate-100 text-sm focus:border-blue-500 focus:outline-none"
  })), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3 mb-3"
  }, /*#__PURE__*/React.createElement(Field, {
    label: __tf("المخزون الحالي ({0})", "Current stock ({0})", [orgLabel.fgUnit]),
    value: fgiConfig.current,
    onChange: v => setFGI({
      ...fgiConfig,
      current: v
    })
  }), /*#__PURE__*/React.createElement(Field, {
    label: __tf("مخزون الأمان الأدنى ({0})", "Minimum safety stock ({0})", [orgLabel.fgUnit]),
    value: fgiConfig.safety,
    onChange: v => setFGI({
      ...fgiConfig,
      safety: v
    })
  }), /*#__PURE__*/React.createElement(Field, {
    label: __tf("أقصى طاقة المستودع ({0})", "Maximum warehouse capacity ({0})", [orgLabel.fgUnit]),
    value: fgiConfig.maxWarehouse,
    onChange: v => setFGI({
      ...fgiConfig,
      maxWarehouse: v
    })
  })), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500 bg-slate-800/60 rounded-lg p-2 mb-2"
  }, __t("📖 في هذا النظام (لا يوجد تنبؤ إحصائي إطلاقاً — خطة المبيعات مُدخل مباشر):", "📖 In this system (there is no statistical forecasting at all — the sales plan is direct input):"), " ", /*#__PURE__*/React.createElement("b", {
    className: "text-blue-400"
  }, "Push"), " ", __t("= ينتج وفق رقم الخطة المحدد مسبقاً، بغض النظر عن المخزون الحالي.", "= produces according to the predetermined plan number, regardless of the current stock."), /*#__PURE__*/React.createElement("b", {
    className: "text-emerald-400"
  }, " Pull"), " ", __t("= ينتج حسب طلب السوق الفعلي — أي فائض حالي فوق الأمان يُستهلك أولاً، فيقلّ الإنتاج أو حتى يتوقف مؤقتاً إن كان الفائض كبيراً.", "= produces according to actual market demand — any current surplus above the safety level is consumed first, so production decreases or even pauses temporarily if the surplus is large."), /*#__PURE__*/React.createElement("b", {
    className: "text-purple-400"
  }, " Hybrid"), " ", __t("= ينتج الطلب دائماً + تعويض إضافي إن كان المخزون دون الأمان (لا يقل عن الطلب أبداً).", "= always produces the demand + an extra compensation if the stock is below the safety level (never less than the demand).")), /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("وضع الإنتاج", "Production mode")), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2"
  }, [["push", "📤 Push", __t("ينتج وفق رقم خطة المبيعات فقط — دون النظر للمخزون", "Produces according to the sales plan number only — regardless of stock")], ["hybrid", __t("⚖️ Hybrid (موصى به)", "⚖️ Hybrid (recommended)"), __t("خطة المبيعات + ضمان عدم نفاد المخزون النهائي", "Sales plan + guarantee that finished-goods stock never runs out")], ["pull", "📥 Pull", __t("ينتج حسب طلب السوق الفعلي — يستهلك الفائض قبل زيادة الإنتاج", "Produces according to actual market demand — consumes the surplus before increasing production")]].map(([mode, label, desc]) => /*#__PURE__*/React.createElement("button", {
    key: mode,
    onClick: () => setFGI({
      ...fgiConfig,
      mode
    }),
    className: `flex-1 text-xs p-2 rounded-xl border transition-all text-right ${fgiConfig.mode === mode ? "bg-blue-900/60 border-blue-500 text-blue-300" : "bg-slate-800 border-slate-700 text-slate-400"}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "font-bold"
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "text-xs opacity-70 mt-0.5"
  }, desc))))), planReady && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-2"
  }, /*#__PURE__*/React.createElement(KPI, {
    icon: "\uD83D\uDD04",
    label: __t("FGI الحالي", "Current FGI"),
    value: fgiConfig.current.toLocaleString(),
    color: "blue"
  }), /*#__PURE__*/React.createElement(KPI, {
    icon: "\uD83C\uDFC1",
    label: __t("FGI نهاية الخطة", "FGI at end of plan"),
    value: fgiEnd.toLocaleString(),
    color: fgiEnd < fgiConfig.safety ? "red" : "green"
  }), /*#__PURE__*/React.createElement(KPI, {
    icon: "\u26A0\uFE0F",
    label: __t("أسابيع دون الأمان", "Weeks below safety"),
    value: fgiBelowCount,
    color: fgiBelowCount > 0 ? "red" : "green"
  }), /*#__PURE__*/React.createElement(KPI, {
    icon: "\uD83D\uDDD1\uFE0F",
    label: __t("إجمالي الهالك (لا يدخل FGI)", "Total scrap (not added to FGI)"),
    value: totalScrap.toLocaleString(),
    color: totalScrap > 0 ? "amber" : "green"
  })), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement("h4", {
    className: "text-xs font-semibold text-slate-300 mb-2"
  }, __t("مستوى FGI عبر الأسابيع (الوحدات الجيدة فقط)", "FGI level across the weeks (good units only)")), /*#__PURE__*/React.createElement(MiniLineChart, {
    data: mps,
    valueKey: "fgAfter",
    color: "#10B981",
    height: 150,
    refLines: [{
      value: fgiConfig.safety,
      label: __t("أمان", "Safety"),
      color: "#EF4444"
    }]
  })), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-x-auto"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-400"
  }, __t("📊 تفصيل أسبوعي: إنتاج إجمالي مقابل وحدات جيدة", "📊 Weekly breakdown: gross production vs. good units")), /*#__PURE__*/React.createElement("table", {
    className: "w-full text-xs min-w-max"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "text-slate-400 border-t border-slate-800"
  }, /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("الأسبوع", "Week")), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("نسبة العيوب", "Defect rate")), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("إنتاج إجمالي", "Gross production")), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("هالك (لا يدخل FGI)", "Scrap (not added to FGI)")), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("وحدات جيدة (تدخل FGI)", "Good units (added to FGI)")), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("FGI بعد", "FGI after")))), /*#__PURE__*/React.createElement("tbody", null, mps.map((m, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    className: "border-t border-slate-800"
  }, /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-bold font-mono text-slate-300"
  }, m.week), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-amber-400"
  }, m.defectRateUsed, "%"), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono"
  }, m.production.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-red-400"
  }, "-", m.scrapUnits.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-emerald-400 font-bold"
  }, m.goodUnits.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono font-bold",
    style: {
      color: m.fgBelowSafety ? "#EF4444" : "#10B981"
    }
  }, m.fgAfter?.toLocaleString() ?? "-")))))))), tab === "capacity" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.capacity), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement(Field, {
    label: __t("معدل الإنتاج (وحدة/ساعة)", "Production rate (units/hour)"),
    value: cap.productionRate,
    onChange: v => setCap({
      ...cap,
      productionRate: v
    })
  }), /*#__PURE__*/React.createElement(Field, {
    label: __t("ساعات الوردية الواحدة", "Hours per shift"),
    value: cap.shiftHours,
    onChange: v => setCap({
      ...cap,
      shiftHours: v
    })
  }), /*#__PURE__*/React.createElement(Field, {
    label: __t("أيام العمل العادية بالأسبوع", "Normal working days per week"),
    value: cap.normalDays,
    onChange: v => setCap({
      ...cap,
      normalDays: Math.min(7, Math.max(1, v))
    })
  }), /*#__PURE__*/React.createElement(Field, {
    label: __t("الحد الأقصى للورديات", "Maximum number of shifts"),
    value: cap.maxShifts,
    onChange: v => setCap({
      ...cap,
      maxShifts: Math.min(3, Math.max(1, v))
    })
  })), /*#__PURE__*/React.createElement("label", {
    className: "flex items-center gap-2 mt-3 text-xs text-slate-300 cursor-pointer"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: cap.minimizeIdleDays !== false,
    onChange: e => setCap({
      ...cap,
      minimizeIdleDays: e.target.checked
    }),
    className: "accent-blue-500"
  }), __t("تقليل أيام العمل تلقائيًا عند انخفاض الطلب (بدل تشغيل كل الأيام العادية دائمًا حتى لو الحمل قليل)", "Automatically reduce working days when demand falls (instead of always running all normal days even when the load is small)")), cap.minimizeIdleDays === false && /*#__PURE__*/React.createElement("div", {
    className: "mt-1 text-xs text-amber-400"
  }, __t("⚠️ معطّل: النظام يشغّل كل الأيام العادية دومًا حتى لو الحمل الفعلي أقل بكثير — جدول ثابت أسبوعيًا على حساب كفاءة استغلال الوقت.", "⚠️ Disabled: the system always runs all normal days even when the actual load is much lower — a fixed weekly schedule at the expense of time-utilization efficiency.")), /*#__PURE__*/React.createElement("label", {
    className: "flex items-center gap-2 mt-3 text-xs text-slate-300 cursor-pointer border-t border-slate-800 pt-3"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: !!cap.levelProduction,
    onChange: e => setCap({
      ...cap,
      levelProduction: e.target.checked
    }),
    className: "accent-cyan-500"
  }), __t("🔬 تجريبي — تسوية الإنتاج بين الأسابيع (Production Leveling)", "🔬 Experimental — Production Leveling between weeks")), /*#__PURE__*/React.createElement("div", {
    className: "mt-1 text-xs text-slate-500"
  }, __t("لو آخر يوم إنتاج بأسبوع ما سيُستغل أقل من العتبة أدناه، تُسحب هذي الكمية الصغيرة من FGI مؤقتاً، ويُمسَح \"الوقت الحر\" الحقيقي عبر كل الأسابيع اللاحقة (وليس أسبوعاً واحداً فقط) لتغطيتها بالكامل — بدل فتح يوم كامل بأسبوع المصدر لكمية ضئيلة. التغطية دائماً كل-أو-لا-شيء: لو تعذّر تغطية الكمية بأمان بالكامل (ولو وحدة ناقصة)، لا تُطبَّق أي تسوية لهذا الأسبوع إطلاقاً. يُشترط أيضاً ألا يخترق ذلك حد أمان FGI بأي أسبوع عبر المسار، ويُعطَّل تلقائياً بالكامل لو وُجد أي نقص مادة خام بالخطة، ويتراجع (rollback) من تلقاء نفسه لو أحدث نقص مادة خام جديداً لم يكن موجوداً.", "If the last production day in some week would be used less than the threshold below, that small quantity is temporarily drawn from FGI, and the real \"free time\" is scanned across all later weeks (not just one week) to cover it fully — instead of opening a whole day in the source week for a tiny quantity. Coverage is always all-or-nothing: if the quantity cannot be fully and safely covered (even one unit short), no leveling is applied to that week at all. It also requires that this never breaches the FGI safety limit in any week along the path, it is disabled automatically if there is any raw-material shortage in the plan, and it rolls back on its own if it creates a new raw-material shortage that did not exist before."), cap.levelProduction && /*#__PURE__*/React.createElement("span", {
    className: "text-cyan-400"
  }, " ", __t("راقب علامة 🔀 في جدول MPS للأسابيع المُعدَّلة.", "Watch the 🔀 mark in the MPS table for the adjusted weeks."))), cap.levelProduction && /*#__PURE__*/React.createElement("div", {
    className: "mt-2 max-w-[220px]"
  }, /*#__PURE__*/React.createElement(Field, {
    label: __t("عتبة اليوم الأخير (%) — تحت هذي النسبة يُعتبر الاستغلال ضئيلاً وتُقترح التسوية", "Last-day threshold (%) — below this percentage the utilization is considered negligible and leveling is proposed"),
    value: cap.levelingThresholdPct ?? 35,
    onChange: v => setCap({
      ...cap,
      levelingThresholdPct: Math.min(95, Math.max(1, v))
    }),
    step: 1
  }), /*#__PURE__*/React.createElement("div", {
    className: "mt-1 text-xs text-slate-600"
  }, __t("لا رقم \"صحيح\" واحد يناسب كل مصنع — كلما رفعتها زاد عدد الأسابيع المُرشَّحة للتسوية (وزاد الاعتماد المؤقت على مخزون الأمان)، وكلما خفّضتها اقتصرت التسوية على الحالات الأوضح فقط. جرّب قيماً مختلفة وراقب تقرير الجدوى والتكاليف قبل الاعتماد على أي قيمة فعلياً.", "There is no single \"correct\" number that suits every factory — the higher you set it, the more weeks are candidates for leveling (and the more temporary reliance on safety stock), and the lower you set it, the more leveling is limited to the clearest cases only. Try different values and watch the feasibility and cost reports before relying on any value in practice.")))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-semibold text-slate-300 mb-2"
  }, __t("📉 نسبة العيوب — مدى وليست رقماً ثابتاً", "📉 Defect rate — a range, not a fixed number")), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500 bg-slate-800/60 rounded-lg p-2 mb-3"
  }, __t("النسبة الفعلية تختلف كل أسبوع ضمن هذا المدى (محاكاة واقعية للتذبذب الطبيعي في خط الإنتاج). المواد الخام تُستهلك عن كامل الكمية المُصنَّعة (شاملة الهالك)، لكن الهالك", "The actual rate varies every week within this range (a realistic simulation of natural fluctuation in the production line). Raw materials are consumed for the entire manufactured quantity (including scrap), but the scrap"), " ", /*#__PURE__*/React.createElement("b", {
    className: "text-red-400"
  }, __t("لا يدخل", "does not enter")), " ", __t("مخزون المنتج النهائي.", "finished-goods inventory.")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement(Field, {
    label: __t("الحد الأدنى لنسبة العيوب (%)", "Minimum defect rate (%)"),
    value: cap.defectRateMin,
    onChange: v => setCap({
      ...cap,
      defectRateMin: v
    }),
    step: 0.1
  }), /*#__PURE__*/React.createElement(Field, {
    label: __t("الحد الأقصى لنسبة العيوب (%)", "Maximum defect rate (%)"),
    value: cap.defectRateMax,
    onChange: v => setCap({
      ...cap,
      defectRateMax: Math.max(v, cap.defectRateMin)
    }),
    step: 0.1
  })), planReady && /*#__PURE__*/React.createElement("div", {
    className: "mt-3 grid grid-cols-3 gap-2 text-xs"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 rounded-lg p-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-slate-400"
  }, __t("متوسط فعلي", "Actual average")), /*#__PURE__*/React.createElement("div", {
    className: "text-amber-400 font-bold font-mono"
  }, avgDefectRate, "%")), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 rounded-lg p-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-slate-400"
  }, __t("إجمالي الهالك", "Total scrap")), /*#__PURE__*/React.createElement("div", {
    className: "text-red-400 font-bold font-mono"
  }, totalScrap.toLocaleString())), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 rounded-lg p-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-slate-400"
  }, __t("% من الإنتاج الإجمالي", "% of gross production")), /*#__PURE__*/React.createElement("div", {
    className: "text-slate-300 font-bold font-mono"
  }, mps.length ? (totalScrap / mps.reduce((s, m) => s + m.production, 0) * 100).toFixed(1) : 0, "%")))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-3"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-semibold text-slate-300 mb-2"
  }, __t("جدول الطاقة", "Capacity schedule")), /*#__PURE__*/React.createElement("div", {
    className: "overflow-x-auto"
  }, /*#__PURE__*/React.createElement("table", {
    className: "w-full text-xs min-w-max"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "bg-slate-800 text-slate-400"
  }, /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("الورديات", "Shifts")), Array.from({
    length: 7 - cap.normalDays + 1
  }, (_, k) => cap.normalDays + k).map(d => /*#__PURE__*/React.createElement("th", {
    key: d,
    className: "px-3 py-2 text-right"
  }, d, " ", __t("أيام", "days"), d > cap.normalDays ? __tf(" (+{0} إضافي)", " (+{0} extra)", [d - cap.normalDays]) : "")), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("ساعات/يوم", "hours/day")))), /*#__PURE__*/React.createElement("tbody", null, [1, 2, 3].map(s => /*#__PURE__*/React.createElement("tr", {
    key: s,
    className: "border-t border-slate-800"
  }, /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 text-blue-400 font-bold"
  }, s, " ", __t("وردية", "shift")), Array.from({
    length: 7 - cap.normalDays + 1
  }, (_, k) => cap.normalDays + k).map(d => /*#__PURE__*/React.createElement("td", {
    key: d,
    className: `px-3 py-2 font-mono ${d > cap.normalDays ? "text-amber-400" : ""}`
  }, (cap.productionRate * cap.shiftHours * s * d).toLocaleString())), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-slate-400"
  }, cap.shiftHours * s, "h")))))))), tab === "engine" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.engine), /*#__PURE__*/React.createElement("div", {
    className: "bg-purple-950/20 border border-purple-800/50 rounded-xl p-3 text-xs text-purple-300"
  }, __t("📌 المصدر الوحيد للصيانة الدورية في هذا النظام: كل عدد ساعات تشغيل مُحدد، تحدث صيانة إلزامية بمدة ثابتة. لا توجد مهام صيانة دورية أخرى — أي عطل خارج هذا الجدول يُعامل كـ", "📌 The only source of periodic maintenance in this system: after every set number of operating hours, a mandatory maintenance of fixed duration takes place. There are no other periodic maintenance tasks — any breakdown outside this schedule is treated as a"), /*#__PURE__*/React.createElement("b", null, __t("\"عطل مفاجئ\" (Run to Failure)", "\"sudden breakdown\" (Run to Failure)")), " ", __t("ويُحاكى في تبويب \"ماذا لو؟\".", "and is simulated in the \"What-if?\" tab.")), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement(Field, {
    label: __t("فترة الصيانة (ساعات تشغيل)", "Maintenance interval (operating hours)"),
    value: engineMaint.intervalHours,
    onChange: v => setEngineMaint({
      ...engineMaint,
      intervalHours: v
    })
  }), /*#__PURE__*/React.createElement(Field, {
    label: __t("مدة الصيانة (ساعات توقف)", "Maintenance duration (downtime hours)"),
    value: engineMaint.durationHours,
    onChange: v => setEngineMaint({
      ...engineMaint,
      durationHours: v
    })
  }), /*#__PURE__*/React.createElement(Field, {
    label: __t("ساعات التشغيل الحالية (منذ آخر صيانة)", "Current operating hours (since last maintenance)"),
    value: engineMaint.intervalHours - engineMaint.remainingHours,
    onChange: v => setEngineMaint({
      ...engineMaint,
      remainingHours: Math.max(0, engineMaint.intervalHours - Math.min(v, engineMaint.intervalHours))
    })
  }), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 rounded-xl p-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-400 mb-1"
  }, __t("الساعات المتبقية حتى الصيانة", "Hours remaining until maintenance")), /*#__PURE__*/React.createElement("div", {
    className: "text-lg font-bold font-mono text-blue-400"
  }, engineMaint.remainingHours.toLocaleString(), "h"), /*#__PURE__*/React.createElement("div", {
    className: "w-full bg-slate-700 rounded-full h-2 mt-1"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-2 rounded-full bg-blue-500",
    style: {
      width: `${((engineMaint.intervalHours - engineMaint.remainingHours) / engineMaint.intervalHours * 100).toFixed(0)}%`
    }
  }))))), planReady && engineResult && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: `rounded-xl border p-4 ${engineResult.maintenanceDone ? "bg-purple-950/30 border-purple-700" : "bg-emerald-950/30 border-emerald-700"}`
  }, /*#__PURE__*/React.createElement("div", {
    className: `text-sm font-semibold ${engineResult.maintenanceDone ? "text-purple-300" : "text-emerald-300"}`
  }, engineResult.alert), engineResult.maintenanceDone && engineResult.maintenanceData && /*#__PURE__*/React.createElement("div", {
    className: "mt-2 grid grid-cols-3 gap-2 text-xs"
  }, [[engineResult.maintenanceWeeks.length > 1 ? __t("أسابيع الصيانة", "Maintenance weeks") : __t("أسبوع الصيانة", "Maintenance week"), engineResult.maintenanceWeeks.join(__t("، ", ", ")), "purple"], [__t("ساعات إلى التوقف", "Hours until stop"), `${engineResult.maintenanceData.hoursIntoWeekAtTrigger}h`, "amber"], [__t("مدة الصيانة", "Maintenance duration"), `${engineResult.maintenanceData.maintenanceDurationH}h`, "blue"], [__t("تأثير على الطاقة", "Effect on capacity"), engineResult.allFeasibleWithMaint ? __t("لا", "No") : __t("نعم — يحتاج تعديل", "Yes — needs adjustment"), engineResult.allFeasibleWithMaint ? "green" : "red"], [__t("وقت حر بعد الصيانة", "Free time after maintenance"), `${engineResult.maintenanceData.spareAfterMaint}h`, "green"], [__t("ساعات بعد الصيانة", "Hours after maintenance"), `${engineResult.maintenanceData.hoursAfterMaint}h`, "slate"]].map(([l, v, c], i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "bg-slate-900 rounded-lg p-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-slate-400"
  }, l), /*#__PURE__*/React.createElement("div", {
    className: `text-${c}-400 font-bold`
  }, v))))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-x-auto"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-400"
  }, __t("📊 تراكم ساعات التشغيل أسبوعياً", "📊 Weekly accumulation of operating hours")), /*#__PURE__*/React.createElement("table", {
    className: "w-full text-xs min-w-max"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "text-slate-400 border-t border-slate-800"
  }, /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("الأسبوع", "Week")), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("ساعات الحمل", "Load hours")), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("تراكمي", "Cumulative")), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("متبقٍ", "Remaining")), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("حالة", "Status")))), /*#__PURE__*/React.createElement("tbody", null, engineResult.weeks.map((w, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    className: `border-t border-slate-800 ${w.maintenanceDue ? "bg-purple-950/30" : ""}`
  }, /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-bold font-mono text-slate-300"
  }, w.week), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono"
  }, w.loadH, "h"), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-blue-400"
  }, w.cumulativeH, "h"), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono"
  }, w.maintenanceDue ? /*#__PURE__*/React.createElement("span", {
    className: "text-purple-400 font-bold"
  }, __t("🔧 صيانة!", "🔧 Maintenance!")) : /*#__PURE__*/React.createElement("span", {
    className: w.remainingToMaint < 50 ? "text-red-400 font-bold" : "text-emerald-400"
  }, w.remainingToMaint, "h")), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2"
  }, w.maintenanceDue ? /*#__PURE__*/React.createElement(Badge, {
    label: __t("🔧 صيانة", "🔧 Maintenance")
  }) : /*#__PURE__*/React.createElement(Badge, {
    ok: true,
    label: "\u2713"
  }))))))))), tab === "dataImport" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.dataImport), /*#__PURE__*/React.createElement("div", {
    className: "bg-blue-950/20 border border-blue-800/50 rounded-xl p-3 text-xs text-blue-300"
  }, __t("📌 خطة المبيعات الشهرية دائماً إدخال يدوي (تبويب خطة المبيعات).", "📌 The monthly sales plan is always manual entry (Sales plan tab).")), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-semibold text-slate-300 mb-2"
  }, __t("📄 أو: رفع ملف Excel (بعدة شيتات) — يعمل دائماً بلا اتصال", "📄 Or: upload an Excel file (with several sheets) — always works offline")), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500 mb-3"
  }, __t("أسماء الشيتات المتوقعة (أي منها اختياري):", "Expected sheet names (any of them is optional):"), " ", /*#__PURE__*/React.createElement("code", {
    className: "text-emerald-400"
  }, __t("المخزون", "Inventory")), ", ", /*#__PURE__*/React.createElement("code", {
    className: "text-emerald-400"
  }, __t("الطاقة", "Capacity")), ", ", /*#__PURE__*/React.createElement("code", {
    className: "text-emerald-400"
  }, __t("الآلة", "Machine")), ", ", /*#__PURE__*/React.createElement("code", {
    className: "text-emerald-400"
  }, "FGI")), /*#__PURE__*/React.createElement("input", {
    ref: fileInputRef,
    type: "file",
    accept: ".xlsx,.xls",
    onChange: e => handleExcelFile(e.target.files?.[0]),
    className: "text-xs text-slate-300 file:bg-blue-600 file:text-white file:border-0 file:rounded file:px-3 file:py-1.5 file:ml-2 file:cursor-pointer"
  })), /*#__PURE__*/React.createElement("details", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement("summary", {
    className: "text-xs font-semibold text-slate-400 cursor-pointer"
  }, __t("🔗 بديل: مزامنة مباشرة من Google Sheets (CSV) — قد تواجه قيود CORS", "🔗 Alternative: direct sync from Google Sheets (CSV) — may hit CORS restrictions")), /*#__PURE__*/React.createElement("div", {
    className: "space-y-3 mt-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-amber-400 bg-amber-950/20 rounded-lg p-2"
  }, __t("⚠️ هذه الطريقة تعتمد على قبول متصفحك وGoogle للاتصال المباشر — قد تواجه قيود CORS حسب إعدادات المتصفح.", "⚠️ This method depends on your browser and Google accepting a direct connection — it may hit CORS restrictions depending on browser settings.")), /*#__PURE__*/React.createElement(TextField, {
    label: __t("رابط CSV — المخزون", "CSV link — inventory"),
    value: csvUrls.inventory,
    onChange: v => setCsvUrls({
      ...csvUrls,
      inventory: v
    }),
    placeholder: "https://docs.google.com/.../pub?output=csv"
  }), /*#__PURE__*/React.createElement(TextField, {
    label: __t("رابط CSV — الطاقة", "CSV link — capacity"),
    value: csvUrls.capacity,
    onChange: v => setCsvUrls({
      ...csvUrls,
      capacity: v
    }),
    placeholder: "https://docs.google.com/.../pub?output=csv"
  }), /*#__PURE__*/React.createElement(TextField, {
    label: __t("رابط CSV — الآلة", "CSV link — machine"),
    value: csvUrls.engine,
    onChange: v => setCsvUrls({
      ...csvUrls,
      engine: v
    }),
    placeholder: "https://docs.google.com/.../pub?output=csv"
  }), /*#__PURE__*/React.createElement(TextField, {
    label: __t("رابط CSV — FGI", "CSV link — FGI"),
    value: csvUrls.fgi,
    onChange: v => setCsvUrls({
      ...csvUrls,
      fgi: v
    }),
    placeholder: "https://docs.google.com/.../pub?output=csv"
  }), /*#__PURE__*/React.createElement("button", {
    onClick: handleCsvSync,
    className: "bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-lg text-xs font-bold"
  }, __t("🔄 مزامنة الآن", "🔄 Sync now")))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4 space-y-3"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-semibold text-slate-300"
  }, __t("🤖 مزوّد الذكاء الاصطناعي للوكلاء", "🤖 AI provider for the agents")), supabaseClient ? /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-emerald-300 bg-emerald-950/20 border border-emerald-800/40 rounded-lg p-3"
  }, __t("☁️ أنت مسجّل دخول سحابياً — الذكاء الاصطناعي مُدار مركزياً من المنصة، ما تحتاج تدخل أي مفتاح API بنفسك. الوكلاء يشتغلون مباشرة من تبويب \"AI Agents\".", "☁️ You are signed in to the cloud — AI is managed centrally by the platform, you don't need to enter any API key yourself. The agents run directly from the \"AI Agents\" tab.")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-2"
  }, [["gemini", __t("Gemini مباشر", "Gemini (direct)"), __t("مجاني — قد يواجه CORS", "Free — may hit CORS")], ["openrouter", "OpenRouter", __t("نماذج مجانية — قد يواجه CORS", "Free models — may hit CORS")], ["claude", __t("Claude مباشر", "Claude (direct)"), __t("مدفوع — قد يواجه CORS", "Paid — may hit CORS")]].map(([id, label, desc]) => /*#__PURE__*/React.createElement("button", {
    key: id,
    onClick: () => setApiKeys({
      ...apiKeys,
      provider: id
    }),
    className: `text-xs p-2 rounded-xl border transition-all text-right ${apiKeys.provider === id ? "bg-blue-900/60 border-blue-500 text-blue-300" : "bg-slate-800 border-slate-700 text-slate-400"}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "font-bold"
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "text-xs opacity-70"
  }, desc)))), apiKeys.provider === "gemini" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(TextField, {
    label: "Gemini API Key",
    value: apiKeys.gemini,
    onChange: v => setApiKeys({
      ...apiKeys,
      gemini: v
    }),
    placeholder: "AIza..."
  }), /*#__PURE__*/React.createElement(TextField, {
    label: __t("نموذج محدد (اختياري — يُكتشف تلقائياً إن تُرك فارغاً)", "Specific model (optional — discovered automatically if left empty)"),
    value: apiKeys.geminiModel,
    onChange: v => setApiKeys({
      ...apiKeys,
      geminiModel: v
    }),
    placeholder: __t("مثال: gemini-2.0-flash", "Example: gemini-2.0-flash")
  }), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500"
  }, __t("مجاني — احصل عليه من", "Free — get it from"), " ", /*#__PURE__*/React.createElement("b", {
    className: "text-blue-400"
  }, "aistudio.google.com"), " ", __t("← Get API Key. النظام يكتشف تلقائياً أي نموذج Gemini متاح لمفتاحك ويجرّب عدة أنواع بالتتابع حتى ينجح أحدها.", "← Get API Key. The system automatically discovers which Gemini model is available for your key and tries several kinds in turn until one succeeds."))), apiKeys.provider === "openrouter" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(TextField, {
    label: "OpenRouter API Key",
    value: apiKeys.openrouter,
    onChange: v => setApiKeys({
      ...apiKeys,
      openrouter: v
    }),
    placeholder: "sk-or-..."
  }), /*#__PURE__*/React.createElement(TextField, {
    label: __t("اسم النموذج (اختياري)", "Model name (optional)"),
    value: apiKeys.openrouterModel,
    onChange: v => setApiKeys({
      ...apiKeys,
      openrouterModel: v
    }),
    placeholder: "meta-llama/llama-3.1-8b-instruct:free"
  })), apiKeys.provider === "claude" && /*#__PURE__*/React.createElement(TextField, {
    label: "Anthropic API Key",
    value: apiKeys.claude,
    onChange: v => setApiKeys({
      ...apiKeys,
      claude: v
    }),
    placeholder: "sk-ant-..."
  }))), importStatus.type !== "idle" && /*#__PURE__*/React.createElement("div", {
    className: `rounded-xl border p-3 text-xs ${importStatus.type === "success" ? "bg-emerald-950/30 border-emerald-700 text-emerald-300" : importStatus.type === "error" ? "bg-red-950/30 border-red-700 text-red-300" : "bg-blue-950/30 border-blue-700 text-blue-300"}`
  }, importStatus.type === "loading" && /*#__PURE__*/React.createElement("span", {
    className: "animate-pulse"
  }, "\u23F3 "), importStatus.message), /*#__PURE__*/React.createElement("div", {
    className: "bg-red-950/10 border border-red-900/40 rounded-xl p-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-red-300 mb-2"
  }, __t("⚠️ إن حدث تعارض غير متوقع في البيانات المحفوظة، أعد الضبط الكامل:", "⚠️ If an unexpected conflict occurs in the saved data, do a full reset:")), /*#__PURE__*/React.createElement("button", {
    onClick: handleFactoryReset,
    className: "text-xs bg-red-900/50 hover:bg-red-900/70 border border-red-800 text-red-200 px-3 py-1.5 rounded-lg"
  }, __t("🗑️ إعادة ضبط المصنع (مسح كل شيء)", "🗑️ Factory reset (erase everything)")))), tab === "dashboard" && planReady && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-3"
  }, /*#__PURE__*/React.createElement(KPI, {
    icon: "\uD83D\uDCE6",
    label: __t("إجمالي الطلب", "Total demand"),
    value: totalDemand.toLocaleString(),
    color: "blue"
  }), /*#__PURE__*/React.createElement(KPI, {
    icon: "\u2699\uFE0F",
    label: __t("متوسط الاستخدام", "Average utilization"),
    value: `${avgUtil}%`,
    color: avgUtil > 100 ? "red" : avgUtil > 85 ? "amber" : "green"
  }), /*#__PURE__*/React.createElement(KPI, {
    icon: "\uD83D\uDC65",
    label: __t("أقصى ورديات", "Max shifts"),
    value: `${maxShiftsUsed}/3`,
    color: maxShiftsUsed === 3 ? "amber" : "blue"
  }), /*#__PURE__*/React.createElement(KPI, {
    icon: "\uD83D\uDCE6",
    label: __t("تنبيهات نقص مواد", "Material shortage alerts"),
    value: stockoutAll.length,
    color: stockoutAll.length > 0 ? "amber" : "green"
  })), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-3"
  }, /*#__PURE__*/React.createElement(KPI, {
    icon: "\uD83D\uDD04",
    label: __t("FGI نهاية الخطة", "FGI at end of plan"),
    value: fgiEnd.toLocaleString(),
    color: fgiEnd < fgiConfig.safety ? "red" : "green"
  }), /*#__PURE__*/React.createElement(KPI, {
    icon: "\uD83D\uDEAB",
    label: __t("نقص مادة خام حرج", "Critical raw-material shortage"),
    value: anyMaterialConstraint ? __tf("نعم — {0} أسابيع", "Yes — {0} weeks", [materialConstrainedWeeks]) : __t("لا", "No"),
    color: anyMaterialConstraint ? "red" : "green"
  }), /*#__PURE__*/React.createElement(KPI, {
    icon: "\uD83D\uDDD1\uFE0F",
    label: __t("إجمالي الهالك", "Total scrap"),
    value: totalScrap.toLocaleString(),
    color: totalScrap > 0 ? "amber" : "green"
  }), /*#__PURE__*/React.createElement(KPI, {
    icon: "\u23F1\uFE0F",
    label: __t("صيانة آلة في الخطة", "Machine maintenance in the plan"),
    value: engineResult?.maintenanceDone ? __t("نعم ✓", "Yes ✓") : __t("لا", "No"),
    color: engineResult?.maintenanceDone ? "purple" : "green"
  })), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-semibold text-slate-300 mb-3"
  }, __t("📊 الطلب × الورديات الأسبوعية", "📊 Demand × weekly shifts")), /*#__PURE__*/React.createElement(MiniBarChart, {
    data: mps,
    valueKey: "demand",
    height: 190,
    colorFn: m => m.infeasible ? "#EF4444" : m.materialConstrained ? "#DC2626" : m.otDaysUsed > 0 ? "#F59E0B" : m.shifts === 3 ? "#8B5CF6" : m.shifts === 2 ? "#60A5FA" : "#34D399",
    legend: [{
      color: "#34D399",
      label: "1W"
    }, {
      color: "#60A5FA",
      label: "2W"
    }, {
      color: "#8B5CF6",
      label: "3W"
    }, {
      color: "#F59E0B",
      label: __t("+جمعة", "+Friday")
    }, {
      color: "#DC2626",
      label: __t("نقص مادة خام", "Raw-material shortage")
    }]
  })), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-semibold text-slate-300 mb-2"
  }, __t("🚨 التنبيهات", "🚨 Alerts")), /*#__PURE__*/React.createElement("div", {
    className: "space-y-2"
  }, mps.filter(m => m.materialConstrained).map(m => /*#__PURE__*/React.createElement("div", {
    key: m.week + "mc",
    className: "bg-red-950/50 border border-red-800 rounded-lg p-3 text-xs text-red-300 flex gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDEAB"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("strong", null, m.week, __t(": الخطة غير مكتملة", ": the plan is incomplete")), " ", __t("— نقص مادة خام حرج (فات أوان الطلب) يحد الإنتاج إلى", "— a critical raw-material shortage (order deadline missed) limits production to"), " ", m.production.toLocaleString(), " ", __t("وحدة فقط بدلاً من المستهدف. راجع تبويب MRP لمعرفة المادة المسؤولة، أو ارفع المخزون الافتتاحي لها في تبويب المخزون.", "units only instead of the target. Check the MRP tab to see which material is responsible, or raise its opening stock in the Inventory tab.")))), overloaded > 0 && /*#__PURE__*/React.createElement("div", {
    className: "bg-red-950/50 border border-red-800 rounded-lg p-3 text-xs text-red-300 flex gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDD34"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("strong", null, overloaded, " ", __t("أسابيع متعذرة", "Infeasible weeks")), ": ", mps.filter(m => m.infeasible).map(m => `${m.week}(${m.util}%)`).join(", "))), needsOT > 0 && /*#__PURE__*/React.createElement("div", {
    className: "bg-amber-950/50 border border-amber-800 rounded-lg p-3 text-xs text-amber-300 flex gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDFE1"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("strong", null, needsOT, " ", __t("أسابيع تحتاج الجمعة (OT)", "Weeks needing Friday (OT)")))), mrp.map(m => {
    const iss = m.weeks.filter(w => w.stockout);
    if (!iss.length) return null;
    return /*#__PURE__*/React.createElement("div", {
      key: m.id,
      className: "bg-amber-950/30 border border-amber-800/60 rounded-lg p-3 text-xs text-amber-300 flex gap-2"
    }, /*#__PURE__*/React.createElement("span", null, "\u26A0\uFE0F"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("strong", null, m.name), __t(": نقص في", ": shortage in"), " ", iss.map(w => w.week).join(", ")));
  }), mrp.map(m => {
    const cc = m.weeks.filter(w => w.capacityConstrained);
    if (!cc.length) return null;
    return /*#__PURE__*/React.createElement("div", {
      key: m.id + "cc",
      className: "bg-orange-950/30 border border-orange-800/50 rounded-lg p-3 text-xs text-orange-300 flex gap-2"
    }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDD12"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("strong", null, m.name), __t(": أمر الشراء مقيّد بسعة التخزين في", ": the purchase order is capped by storage capacity in"), " ", cc.map(w => w.week).join(", ")));
  }), planReady && engineResult?.maintenanceDone && /*#__PURE__*/React.createElement("div", {
    className: "bg-purple-950/40 border border-purple-700 rounded-lg p-3 text-xs text-purple-300 flex gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\u23F1\uFE0F"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("strong", null, __t("صيانة الآلة في", "Machine maintenance in"), " ", engineResult.maintenanceWeeks.join(__t("، ", ", "))), " \u2014 ", engineResult.allFeasibleWithMaint ? __t("تمت زيادة الورديات تلقائياً لتعويض الوقت المفقود، فتأثرت أرقام الاستخدام في MPS/CRP لذلك الأسبوع.", "Shifts were increased automatically to make up for the lost time, so the utilization figures in MPS/CRP for that week were affected.") : __t("⚠️ حتى بأقصى الورديات لا يكفي الوقت — يلزم تدخّل يدوي (نقل إنتاج لأسبوع آخر).", "⚠️ Even with maximum shifts the time is not enough — manual intervention required (move production to another week)."))), overloaded === 0 && needsOT === 0 && stockoutAll.length === 0 && !anyMaterialConstraint && /*#__PURE__*/React.createElement("div", {
    className: "bg-emerald-950/50 border border-emerald-800 rounded-lg p-3 text-xs text-emerald-300 flex gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\u2705"), /*#__PURE__*/React.createElement("span", null, __t("الخطة مجدية بالكامل ومتّسقة عبر كل التبويبات — لا توجد تعارضات", "The plan is fully feasible and consistent across all tabs — no conflicts"))))), workflow === "planned" && /*#__PURE__*/React.createElement("button", {
    onClick: handleConfirmPlan,
    className: "w-full bg-emerald-600 hover:bg-emerald-500 py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\u2705"), __t("تأكيد الخطة وتحديث المخزون", "Confirm the plan and update the inventory"))), tab === "mps" && planReady && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.mps), anyMaterialConstraint && /*#__PURE__*/React.createElement("div", {
    className: "bg-red-950/30 border border-red-700 rounded-xl p-3 text-xs text-red-300"
  }, "\uD83D\uDEAB ", /*#__PURE__*/React.createElement("b", null, __t("ملاحظة اتّساق:", "Consistency note:")), " ", __t("بعض الأسابيع أدناه (باللون الأحمر) لا تحقق الإنتاج المستهدف بسبب نقص مادة خام حرج — هذا يتناسق تلقائياً مع تبويب MRP وFGI والجدوى.", "Some weeks below (in red) do not reach the target production because of a critical raw-material shortage — this is automatically consistent with the MRP, FGI and feasibility tabs.")), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-x-auto"
  }, /*#__PURE__*/React.createElement("table", {
    className: "w-full text-xs min-w-max"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "bg-slate-800 text-slate-400"
  }, [__t("الأسبوع", "Week"), __t("الطلب", "Demand"), __t("عيوب%", "Defect%"), __t("إنتاج إجمالي", "Gross production"), __t("هالك", "Scrap"), __t("وحدات جيدة", "Good units"), __t("الورديات", "Shifts"), __t("حمل(h)", "Load(h)"), __t("الاستخدام", "Utilization"), __t("FGI بعد", "FGI after"), __t("حالة", "Status")].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    className: "px-3 py-2 text-right"
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, mps.map((m, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    className: `border-t border-slate-800 ${m.materialConstrained ? "bg-red-950/30" : m.infeasible ? "bg-red-950/20" : m.otDaysUsed > 0 ? "bg-amber-950/10" : m.fgBelowSafety ? "bg-purple-950/10" : ""}`
  }, /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-bold font-mono text-slate-300"
  }, m.week, engineResult?.maintenanceWeeks?.includes(m.week) && /*#__PURE__*/React.createElement("span", {
    className: "text-purple-400 ml-1"
  }, "\u23F1"), m.materialConstrained && /*#__PURE__*/React.createElement("span", {
    className: "text-red-400 ml-1"
  }, "\uD83D\uDEAB"), m.smoothed && /*#__PURE__*/React.createElement("span", {
    className: "text-cyan-400 ml-1",
    title: m.smoothedNote
  }, "\uD83D\uDD00")), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono"
  }, m.demand.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-amber-400"
  }, m.defectRateUsed, "%"), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-blue-400"
  }, m.production.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-red-400"
  }, m.scrapUnits > 0 ? `-${m.scrapUnits.toLocaleString()}` : "—"), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-emerald-400 font-bold"
  }, m.goodUnits.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 text-purple-400 font-bold"
  }, m.idle ? "—" : m.shifts), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono"
  }, m.loadH, "h"), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: `font-mono ${m.util > 100 ? "text-red-400" : m.util > 85 ? "text-amber-400" : "text-slate-300"}`
  }, m.idle ? "—" : `${m.util}%`)), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono font-bold",
    style: {
      color: m.fgBelowSafety ? "#EF4444" : "#10B981"
    }
  }, m.fgAfter?.toLocaleString() ?? "-"), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2"
  }, m.materialConstrained ? /*#__PURE__*/React.createElement(Badge, {
    label: __t("🚫 نقص مادة", "🚫 Material shortage")
  }) : m.infeasible ? /*#__PURE__*/React.createElement(Badge, {
    label: "\u2717"
  }) : m.fgBelowSafety ? /*#__PURE__*/React.createElement(Badge, {
    label: "\u26A0\uFE0FFGI"
  }) : m.otDaysUsed > 0 ? /*#__PURE__*/React.createElement(Badge, {
    warn: true,
    label: "OT"
  }) : m.idle ? /*#__PURE__*/React.createElement(Badge, {
    ok: true,
    label: __t("⏸ متوقف", "⏸ Stopped")
  }) : /*#__PURE__*/React.createElement(Badge, {
    ok: true,
    label: "\u2713"
  }))))))), cap.levelProduction && mps.some(m => m.smoothed) && /*#__PURE__*/React.createElement("div", {
    className: "bg-cyan-950/20 border border-cyan-800/50 rounded-xl p-3 text-xs text-cyan-300"
  }, "\uD83D\uDD00 ", /*#__PURE__*/React.createElement("b", null, __t("تسوية الإنتاج مفعّلة:", "Production leveling is enabled:")), " ", __t("الأسابيع المُعلَّمة أعلاه نُقل منها/إليها هامش يوم أخير كان سيُستغل بنسبة منخفضة جداً. مرّر الفأرة على 🔀 لرؤية تفاصيل كل نقل.", "The weeks marked above had the margin of a last day moved from/to them that would have been used at a very low rate. Hover over 🔀 to see the details of each move.")), cap.levelProduction && mps.some(m => m.levelingRolledBack) && /*#__PURE__*/React.createElement("div", {
    className: "bg-amber-950/20 border border-amber-800/50 rounded-xl p-3 text-xs text-amber-300"
  }, __t("⚠️ تم تفعيل تسوية الإنتاج لكن النظام تراجع عنها تلقائياً هذه المرة لأنها كانت ستُحدث نقص مادة خام جديد لم يكن موجوداً بالخطة الأصلية.", "⚠️ Production leveling was enabled but the system rolled it back automatically this time because it would have created a new raw-material shortage that did not exist in the original plan.")), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-slate-500"
  }, __t("💡 نسبة العيوب تختلف كل أسبوع ضمن المدى المُحدد في تبويب الطاقة. المواد الخام تُستهلك عن \"إنتاج إجمالي\" الكامل، لكن الهالك لا يدخل FGI.", "💡 The defect rate varies every week within the range set in the Capacity tab. Raw materials are consumed for the full \"gross production\", but scrap does not enter FGI."))), tab === "shifts" && planReady && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.shifts), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-hidden"
  }, /*#__PURE__*/React.createElement("table", {
    className: "w-full text-xs"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "bg-slate-800 text-slate-400"
  }, [__t("الأسبوع", "Week"), __t("الطلب", "Demand"), __t("الورديات", "Shifts"), __t("أيام العمل", "Working days"), __t("الجمعة(OT)", "Friday(OT)"), __t("الوقت الحر", "Free time"), __t("الاستخدام", "Utilization")].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    className: "px-3 py-2 text-right"
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, mps.map((m, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    className: `border-t border-slate-800 ${m.infeasible ? "bg-red-950/20" : m.otDaysUsed > 0 ? "bg-amber-950/10" : ""}`
  }, /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-bold font-mono text-slate-300"
  }, m.week), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono"
  }, m.demand.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2"
  }, m.idle ? /*#__PURE__*/React.createElement("span", {
    className: "text-slate-600 text-xs"
  }, __t("⏸ لا حاجة للإنتاج", "⏸ No production needed")) : /*#__PURE__*/React.createElement("div", {
    className: "flex gap-1"
  }, [1, 2, 3].map(s => /*#__PURE__*/React.createElement("div", {
    key: s,
    className: `w-6 h-6 rounded flex items-center justify-center text-xs font-bold ${s <= m.shifts ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-600"}`
  }, s)))), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono"
  }, m.idle ? "—" : m.workDays), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2"
  }, m.otDaysUsed > 0 ? /*#__PURE__*/React.createElement("span", {
    className: "text-amber-400 font-bold"
  }, __t("✓ نعم", "✓ Yes")) : /*#__PURE__*/React.createElement("span", {
    className: "text-slate-600"
  }, "\u2014")), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-emerald-400"
  }, m.spareH, "h"), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: `font-mono ${m.util > 100 ? "text-red-400" : m.util > 85 ? "text-amber-400" : "text-emerald-400"}`
  }, m.idle ? "—" : `${m.util}%`)))))))), tab === "mrp" && planReady && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.mrp), /*#__PURE__*/React.createElement("div", {
    className: "bg-blue-950/20 border border-blue-800/50 rounded-xl p-3 text-xs text-blue-300"
  }, "\uD83D\uDCD6 ", /*#__PURE__*/React.createElement("b", null, __t("الجدولة الخلفية:", "Backward scheduling:")), " ", __t("أمر الشراء يُصدر قبل أسبوع الاحتياج الفعلي بمقدار مدة التوريد (Lead Time) — بحيث تصل المادة في الوقت المناسب بالضبط. الكمية المطلوبة تُقيَّد تلقائياً بسعة التخزين القصوى لكل مادة.", "A purchase order is issued before the actual requirement week by the lead time — so the material arrives exactly on time. The requested quantity is automatically capped by the maximum storage capacity of each material.")), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2 flex-wrap"
  }, mrp.map(m => {
    const h = m.weeks.some(w => w.stockout);
    const cc = m.weeks.some(w => w.capacityConstrained);
    return /*#__PURE__*/React.createElement("button", {
      key: m.id,
      onClick: () => setSelMat(m.id),
      className: `text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${selMat === m.id ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-300 border border-slate-700"}`
    }, h ? "⚠️ " : cc ? "🔒 " : "", m.name);
  })), !selMRP && /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 border border-dashed border-slate-700 rounded-xl p-8 text-center space-y-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-3xl"
  }, "\uD83D\uDCE6"), /*#__PURE__*/React.createElement("div", {
    className: "text-slate-300 font-semibold text-sm"
  }, __t("لا توجد مواد خام مُعرَّفة بعد", "No raw materials defined yet")), /*#__PURE__*/React.createElement("div", {
    className: "text-slate-500 text-xs"
  }, __t("أضف مكوّنات منتجك من تبويب BOM أولاً، ثم أعد توليد الخطة ليظهر تحليل MRP هنا.", "Add your product's components from the BOM tab first, then regenerate the plan so the MRP analysis appears here."))), selMRP && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-3 gap-2 text-xs mb-2"
  }, [[__t("توريد", "Lead time"), `${selMRP.inv.leadTime}W`, "blue"], [__t("مخزون", "Stock"), selMRP.inv.available.toLocaleString(), "purple"], [__t("أمان", "Safety"), selMRP.inv.safety.toLocaleString(), "amber"]].map(([l, v, c], i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "bg-slate-900 border border-slate-700 rounded-xl p-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-slate-400"
  }, l), /*#__PURE__*/React.createElement("div", {
    className: `text-${c}-400 font-bold font-mono`
  }, v)))), selMRP.weeks.some(w => w.tooLateToOrder) && /*#__PURE__*/React.createElement("div", {
    className: "bg-red-950/40 border border-red-700 rounded-xl p-3 text-xs text-red-300"
  }, "\uD83D\uDEAB ", /*#__PURE__*/React.createElement("b", null, __t("فات أوان الطلب", "Order deadline missed")), " ", __t("في", "in"), " ", selMRP.weeks.filter(w => w.tooLateToOrder).map(w => w.week).join(", "), " ", __t("— مدة التوريد (", "— the lead time ("), selMRP.inv.leadTime, " ", __t("أسابيع) أطول من الوقت المتبقي ضمن أفق الخطة. هذا يحدّ الإنتاج فعلياً في تبويبات MPS/الورديات/FGI لتلك الأسابيع (ترابط تلقائي). الحل: ارفع المخزون الافتتاحي، أو قصّر مدة التوريد، أو ابدأ الخطة بأسابيع أكثر.", "weeks) is longer than the time remaining within the plan horizon. This effectively limits production in the MPS/Shifts/FGI tabs for those weeks (automatic linkage). Solution: raise the opening stock, shorten the lead time, or start the plan with more weeks.")), /*#__PURE__*/React.createElement("div", {
    className: "bg-red-950/20 border border-red-800/50 rounded-xl p-3 text-xs mb-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "text-red-400 font-semibold"
  }, __t("📍 نقطة إعادة الطلب (ROP) — للمادة الخام", "📍 Reorder point (ROP) — for the raw material")), /*#__PURE__*/React.createElement("div", {
    className: "text-slate-400 mt-0.5"
  }, __t("ROP = (متوسط الطلب × كمية/وحدة × مدة التوريد) + مخزون الأمان", "ROP = (average demand × quantity/unit × lead time) + safety stock"))), /*#__PURE__*/React.createElement("div", {
    className: "text-red-400 font-bold font-mono text-lg"
  }, Math.round(avgDemand * selMRP.qty * selMRP.inv.leadTime + selMRP.inv.safety).toLocaleString())), /*#__PURE__*/React.createElement("div", {
    className: "mt-1 text-xs"
  }, selMRP.inv.available > Math.round(avgDemand * selMRP.qty * selMRP.inv.leadTime + selMRP.inv.safety) ? /*#__PURE__*/React.createElement("span", {
    className: "text-emerald-400"
  }, __t("✓ المخزون الحالي فوق نقطة الإعادة", "✓ Current stock is above the reorder point")) : (() => {
    const desired = Math.round(avgDemand * selMRP.qty * (selMRP.inv.leadTime + 2));
    const spaceLeft = Math.max(0, selMRP.inv.maxCapacity - Math.max(0, selMRP.inv.available));
    const suggested = Math.min(desired, spaceLeft);
    return /*#__PURE__*/React.createElement("span", {
      className: "text-red-400"
    }, __t("⚠️ دون نقطة الإعادة —", "⚠️ Below the reorder point —"), " ", /*#__PURE__*/React.createElement("b", null, __t("الكمية المقترحة للطلب:", "Suggested order quantity:"), " ", suggested.toLocaleString(), " ", selMRP.unit), " ", desired > spaceLeft ? __t("(مقيّدة بسعة التخزين 🔒)", "(capped by storage capacity 🔒)") : "");
  })())), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-x-auto"
  }, /*#__PURE__*/React.createElement("table", {
    className: "w-full text-xs min-w-max"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "bg-slate-800 text-slate-400"
  }, [__t("الأسبوع", "Week"), __t("إجمالي", "Gross"), __t("مخزون سابق", "Previous stock"), __t("وارد مؤكد SR", "Confirmed SR receipt"), __t("صافي", "Net"), __t("أمر شراء جديد", "New purchase order"), __t("نهاية", "End"), __t("إصدار (خلفي)", "Release (backward)"), __t("حالة", "Status")].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    className: "px-3 py-2 text-right"
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, selMRP.weeks.map((w, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    className: `border-t border-slate-800 ${w.tooLateToOrder ? "bg-red-950/30" : w.stockout ? "bg-red-950/20" : w.capacityConstrained ? "bg-orange-950/10" : ""}`
  }, /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-bold font-mono text-slate-300"
  }, w.week), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono"
  }, w.gross.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-slate-400"
  }, w.openingStock.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-sky-400 font-bold"
  }, w.sr > 0 ? `+${w.sr.toLocaleString()}` : "—"), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-amber-400"
  }, w.netReq > 0 ? w.netReq.toLocaleString() : "—"), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-emerald-400 font-bold"
  }, w.tooLateToOrder ? /*#__PURE__*/React.createElement("span", {
    className: "text-red-400",
    title: __t("عجز لا يمكن تغطيته بالشراء ضمن أفق الخطة — لا يوجد طلب صالح لهذا الأسبوع", "A shortfall that cannot be covered by purchasing within the plan horizon — there is no valid order for this week")
  }, __t("عجز", "Shortfall"), " ", (w.unmetNeed || 0).toLocaleString()) : w.order > 0 ? w.order.toLocaleString() : "—", w.capacityConstrained && /*#__PURE__*/React.createElement("span", {
    className: "text-orange-400"
  }, " \uD83D\uDD12"), w.usedEOQ && /*#__PURE__*/React.createElement("span", {
    className: "text-blue-400",
    title: __t("حُجم الطلب حسب EOQ لتوفير تكلفة الطلبيات", "Order size set by EOQ to save ordering costs")
  }, " \uD83C\uDFAF")), /*#__PURE__*/React.createElement("td", {
    className: `px-3 py-2 font-mono ${w.ending < 0 ? "text-red-400 font-bold" : ""}`
  }, w.ending.toLocaleString(), w.ending < 0 && /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-normal mr-1"
  }, __t("(عجز)", "(shortfall)"))), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-blue-400"
  }, w.tooLateToOrder ? /*#__PURE__*/React.createElement("span", {
    className: "text-red-400"
  }, __t("متأخر!", "Late!")) : w.order > 0 ? w.orderWeek : "—"), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2"
  }, w.tooLateToOrder ? /*#__PURE__*/React.createElement(Badge, {
    label: __t("🚫 فات الأوان", "🚫 Too late")
  }) : w.stockout ? /*#__PURE__*/React.createElement(Badge, {
    label: __t("⚠️ نقص", "⚠️ Shortage")
  }) : w.capacityConstrained ? /*#__PURE__*/React.createElement(Badge, {
    warn: true,
    label: __t("🔒 مقيّد", "🔒 Capped")
  }) : w.order > 0 ? /*#__PURE__*/React.createElement(Badge, {
    warn: true,
    label: __t("📦 طلب", "📦 Order")
  }) : /*#__PURE__*/React.createElement(Badge, {
    ok: true,
    label: "\u2713"
  }))))))))), tab === "crp" && planReady && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.crp), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement(MiniBarChart, {
    data: mps,
    valueKey: "loadH",
    height: 180,
    colorFn: m => m.materialConstrained ? "#DC2626" : m.infeasible ? "#EF4444" : m.otDaysUsed > 0 ? "#F59E0B" : "#8B5CF6",
    legend: [{
      color: "#8B5CF6",
      label: __t("ساعات حمل عادية", "Normal load hours")
    }, {
      color: "#F59E0B",
      label: __t("+جمعة OT", "+Friday OT")
    }, {
      color: "#DC2626",
      label: __t("نقص مادة خام", "Raw-material shortage")
    }, {
      color: "#EF4444",
      label: __t("متعذر", "Infeasible")
    }]
  }))), tab === "agents" && planReady && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.agents, " (", T.provider, ": ", supabaseClient ? __t("☁️ مركزي (مُدار من المنصة)", "☁️ Central (managed by the platform)") : apiKeys.provider === "gemini" ? "Gemini" : apiKeys.provider === "openrouter" ? "OpenRouter" : "Claude", ")"), !supabaseClient && !apiKeys[apiKeys.provider] && /*#__PURE__*/React.createElement("div", {
    className: "bg-amber-950/30 border border-amber-700 rounded-xl p-3 text-xs text-amber-300 flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", null, __t("⚠️ لم يتم إدخال مفتاح API للمزوّد المختار", "⚠️ No API key has been entered for the selected provider")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setTab("dataImport"),
    className: "bg-amber-700 hover:bg-amber-600 px-3 py-1 rounded text-white"
  }, __t("أدخله الآن", "Enter it now"))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-4 gap-2"
  }, /*#__PURE__*/React.createElement(KPI, {
    icon: "\u2699\uFE0F",
    label: __t("متوسط الاستخدام", "Average utilization"),
    value: `${avgUtil}%`,
    color: avgUtil > 100 ? "red" : avgUtil > 85 ? "amber" : "green"
  }), /*#__PURE__*/React.createElement(KPI, {
    icon: "\uD83D\uDC65",
    label: __t("أقصى ورديات", "Max shifts"),
    value: `${maxShiftsUsed}W`,
    color: "purple"
  }), /*#__PURE__*/React.createElement(KPI, {
    icon: "\u23F1\uFE0F",
    label: __t("صيانة آلة", "Machine maintenance"),
    value: engineResult?.maintenanceDone ? __t("نعم", "Yes") : __t("لا", "No"),
    color: engineResult?.maintenanceDone ? "purple" : "green"
  }), /*#__PURE__*/React.createElement(KPI, {
    icon: "\uD83D\uDCE6",
    label: __t("تنبيهات نقص", "Shortage alerts"),
    value: stockoutAll.length,
    color: stockoutAll.length > 0 ? "amber" : "green"
  })), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 border border-slate-700 rounded-xl p-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-semibold text-slate-300 mb-2"
  }, __t("💬 سؤال مخصص / تحليل ماذا لو (اختياري)", "💬 Custom question / what-if analysis (optional)")), /*#__PURE__*/React.createElement("textarea", {
    value: scenario,
    onChange: e => setScenario(e.target.value),
    placeholder: __tf("مثال: ماذا يحدث لو انقطع مورد {0} 3 أسابيع؟", "Example: what happens if the supplier of {0} is cut off for 3 weeks?", [bom[0]?.name || __t("أحد المواد", "one of the materials")]),
    className: "w-full bg-slate-800 border border-slate-600 rounded-lg p-3 text-xs text-slate-200 placeholder-slate-500 resize-none h-16 focus:border-blue-500 focus:outline-none"
  })), /*#__PURE__*/React.createElement("button", {
    onClick: runMultiAgent,
    disabled: agentStatus === "running",
    className: "w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
  }, agentStatus === "running" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    className: "animate-spin inline-block"
  }, "\u23F3"), __t("الوكيل", "Agent"), " ", currentAgent, "/", activeAgentSteps, " ", __t("يعمل...", "Working...")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", null, "\uD83E\uDD16"), __t("تشغيل وكلاء الذكاء الاصطناعي", "Run the AI agents"), " ", activeAgentSteps < 4 ? __tf("({0} وكلاء تخصّ تخطيطكم)", "({0} agents relevant to your planning)", [activeAgentSteps]) : "")), (agentOutputs.a1 || agentOutputs.a2 || agentOutputs.a3 || agentOutputs.a4) && /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, [["a1", "📋", __t("وكيل MPS", "MPS agent"), "blue"], ["a2", "🔧", __t("وكيل MRP", "MRP agent"), "amber"], ["a3", "⏱️", __t("وكيل الصيانة+FGI", "Maintenance + FGI agent"), "purple"], ["a4", "👔", __t("كبير المخططين", "Chief planner"), "emerald"]].map(([key, icon, label, color]) => {
    const a = agentOutputs[key];
    if (!a) return null;
    const isOpen = !!expandedTrace[key];
    const hasTrace = a.data_reviewed || a.rules_applied || a.reasoning;
    return /*#__PURE__*/React.createElement("div", {
      key: key,
      className: `bg-slate-900 border border-${color}-800/50 rounded-xl p-4`
    }, /*#__PURE__*/React.createElement("div", {
      className: `text-xs font-semibold text-${color}-400 mb-2 flex items-center gap-2`
    }, /*#__PURE__*/React.createElement("span", null, icon), /*#__PURE__*/React.createElement("span", null, label), hasTrace && /*#__PURE__*/React.createElement("button", {
      onClick: () => setExpandedTrace(p => ({
        ...p,
        [key]: !p[key]
      })),
      className: "text-[11px] font-normal bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full border border-slate-600 transition-colors"
    }, "\uD83E\uDDE0 ", isOpen ? __t("إخفاء تفكير الوكيل", "Hide the agent's reasoning") : __t("لماذا هذا القرار؟", "Why this decision?")), key === "a4" && agentStatus === "done" && /*#__PURE__*/React.createElement("button", {
      onClick: () => generatePDF(mps, mrp, postPlan, nextMonthRec, agentOutputs, {
        ...engineResult,
        ...engineMaint
      }, {
        ...fgiConfig,
        endOfPlan: fgiEnd
      }, planWeeks, feasibility, costAnalysis, orgLabel.productName, orgLabel.fgUnit),
      className: "mr-auto text-xs bg-slate-700 hover:bg-slate-600 px-2 py-0.5 rounded text-slate-300"
    }, "\uD83D\uDDA8\uFE0F PDF")), isOpen && hasTrace && /*#__PURE__*/React.createElement("div", {
      className: "mb-3 space-y-2 bg-slate-800/50 border border-slate-700 rounded-lg p-3"
    }, a.data_reviewed && /*#__PURE__*/React.createElement("div", {
      className: "text-xs"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-slate-500 font-semibold"
    }, __t("🔍 البيانات التي راجعها:", "🔍 Data it reviewed:"), " "), /*#__PURE__*/React.createElement("span", {
      className: "text-slate-300"
    }, a.data_reviewed)), a.rules_applied && /*#__PURE__*/React.createElement("div", {
      className: "text-xs"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-slate-500 font-semibold"
    }, __t("⚖️ القاعدة المطبّقة:", "⚖️ Rule applied:"), " "), /*#__PURE__*/React.createElement("span", {
      className: "text-slate-300"
    }, a.rules_applied)), a.reasoning && /*#__PURE__*/React.createElement("div", {
      className: "text-xs"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-slate-500 font-semibold"
    }, __t("🧠 خطوات الاستدلال:", "🧠 Reasoning steps:"), " "), /*#__PURE__*/React.createElement("span", {
      className: "text-slate-300 whitespace-pre-wrap"
    }, a.reasoning))), /*#__PURE__*/React.createElement("div", {
      className: "text-sm text-slate-200 leading-relaxed whitespace-pre-wrap"
    }, a.recommendation), key === "a4" && a.suggestion && a.suggestion.param && /*#__PURE__*/React.createElement("div", {
      className: "mt-3 bg-emerald-950/20 border border-emerald-800/50 rounded-lg p-3 space-y-2"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-xs text-emerald-300"
    }, "\uD83D\uDCA1 ", /*#__PURE__*/React.createElement("b", null, __t("مقترح تحسين:", "Improvement suggestion:")), " ", {
      normalDays: __t("أيام العمل العادية", "Normal working days"),
      shiftHours: __t("ساعات الوردية", "Shift hours"),
      maxShifts: __t("أقصى عدد ورديات", "Maximum number of shifts"),
      fgiSafety: __t("مخزون أمان المنتج النهائي", "Finished-product safety stock"),
      fgiMaxWarehouse: __t("أقصى سعة مستودع المنتج النهائي", "Maximum finished-product warehouse capacity")
    }[a.suggestion.param] || a.suggestion.param, " \u2192 ", /*#__PURE__*/React.createElement("b", {
      className: "text-emerald-400"
    }, a.suggestion.newValue), a.suggestion.why && /*#__PURE__*/React.createElement("span", {
      className: "text-slate-400"
    }, " \u2014 ", a.suggestion.why)), /*#__PURE__*/React.createElement("button", {
      onClick: () => applySuggestionAndCompare(a.suggestion),
      disabled: comparisonBusy,
      className: "text-xs bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg font-bold"
    }, comparisonBusy ? __t("جارٍ المحاكاة...", "Simulating...") : __t("🔄 جرّب هذا المقترح وقارن بالخطة الأساسية", "🔄 Try this suggestion and compare with the base plan"))));
  }))), tab === "whatif" && planReady && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.whatif), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4 space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-semibold text-slate-200"
  }, __t("سيناريو الطلب والطاقة", "Demand and capacity scenario")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setWhatIf(p => ({
      ...p,
      active: !p.active
    })),
    className: `px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${whatIf.active ? "bg-blue-600 text-white" : "bg-slate-700 text-slate-300"}`
  }, whatIf.active ? __t("🔵 نشط — إلغاء", "🔵 Active — cancel") : __t("⬜ تفعيل", "⬜ Activate"))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 rounded-xl p-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-semibold text-blue-400 mb-2"
  }, __t("📈 صدمة الطلب", "📈 Demand shock")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3"
  }, /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "-50",
    max: "100",
    step: "5",
    value: whatIf.demandPct,
    onChange: e => setWhatIf(p => ({
      ...p,
      demandPct: Number(e.target.value)
    })),
    className: "flex-1 accent-blue-500"
  }), /*#__PURE__*/React.createElement("span", {
    className: `font-mono font-bold w-16 text-center text-sm ${whatIf.demandPct > 0 ? "text-red-400" : whatIf.demandPct < 0 ? "text-green-400" : "text-slate-400"}`
  }, whatIf.demandPct > 0 ? "+" : "", whatIf.demandPct, "%"))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 rounded-xl p-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-semibold text-amber-400 mb-2"
  }, __t("🔧 توقف آلة جزئي (أسابيع + نسبة تخفيض)", "🔧 Partial machine stoppage (weeks + reduction percentage)")), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-1.5 mb-2"
  }, mps.map(m => /*#__PURE__*/React.createElement("button", {
    key: m.week,
    onClick: () => setWhatIf(p => ({
      ...p,
      machineDownWeeks: p.machineDownWeeks.includes(m.week) ? p.machineDownWeeks.filter(w => w !== m.week) : [...p.machineDownWeeks, m.week]
    })),
    className: `text-xs px-2 py-1 rounded ${whatIf.machineDownWeeks.includes(m.week) ? "bg-amber-600 text-white" : "bg-slate-700 text-slate-400"}`
  }, m.week))), whatIf.machineDownWeeks.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3"
  }, /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "10",
    max: "90",
    step: "10",
    value: whatIf.machinePct,
    onChange: e => setWhatIf(p => ({
      ...p,
      machinePct: Number(e.target.value)
    })),
    className: "flex-1 accent-amber-500"
  }), /*#__PURE__*/React.createElement("span", {
    className: "font-mono font-bold text-amber-400 w-12 text-center"
  }, whatIf.machinePct, "%")))), whatIf.active && whatIfMPS && /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-x-auto"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-400"
  }, __t("مقارنة: الخطة الأساسية vs السيناريو (يراعي FGI)", "Comparison: base plan vs. scenario (accounts for FGI)")), /*#__PURE__*/React.createElement("table", {
    className: "w-full text-xs min-w-max"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "text-slate-400 border-t border-slate-800"
  }, /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("الأسبوع", "Week")), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right text-blue-400"
  }, __t("استخدام أساسي", "Base utilization")), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right text-amber-400"
  }, __t("استخدام سيناريو", "Scenario utilization")), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, "\u0394"), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 text-right"
  }, __t("التأثير", "Impact")))), /*#__PURE__*/React.createElement("tbody", null, mps.map((base, i) => {
    const scen = whatIfMPS[i];
    const delta = +(scen.util - base.util).toFixed(1);
    return /*#__PURE__*/React.createElement("tr", {
      key: i,
      className: `border-t border-slate-800 ${scen.infeasible ? "bg-red-950/20" : ""}`
    }, /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2 font-bold font-mono text-slate-300"
    }, base.week, scen.machineDown && /*#__PURE__*/React.createElement("span", {
      className: "text-amber-400 ml-1"
    }, "\uD83D\uDD27")), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2 font-mono"
    }, base.util, "%"), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2 font-mono"
    }, scen.util, "%"), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2 font-mono font-bold"
    }, /*#__PURE__*/React.createElement("span", {
      className: delta > 5 ? "text-red-400" : delta < -5 ? "text-green-400" : "text-slate-400"
    }, delta > 0 ? "+" : "", delta, "%")), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2"
    }, scen.infeasible ? /*#__PURE__*/React.createElement(Badge, {
      label: __t("✗ متعذر", "✗ Infeasible")
    }) : /*#__PURE__*/React.createElement("span", {
      className: "text-slate-500 text-xs"
    }, "\u2014")));
  })))), /*#__PURE__*/React.createElement("div", {
    className: "bg-red-950/20 border border-red-800/50 rounded-xl p-4 space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-semibold text-red-300"
  }, __t("💥 عطل مفاجئ (Run to Failure)", "💥 Sudden breakdown (Run to Failure)")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setRunToFailure(p => ({
      ...p,
      active: !p.active
    })),
    className: `px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${runToFailure.active ? "bg-red-600 text-white" : "bg-slate-700 text-slate-300"}`
  }, runToFailure.active ? __t("🔴 نشط — إلغاء", "🔴 Active — cancel") : __t("⬜ تفعيل", "⬜ Activate"))), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-400"
  }, __t("يُحاكي عطلاً غير مخطط (خارج جدول الصيانة الدورية بالساعات) — تحديد أسبوع الحدوث وعدد ساعات التوقف اللازمة للإصلاح.", "Simulates an unplanned breakdown (outside the periodic maintenance schedule in hours) — specify the week it happens and the downtime hours needed for repair.")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs text-slate-400 block mb-1"
  }, __t("الأسبوع", "Week")), /*#__PURE__*/React.createElement("select", {
    value: runToFailure.week,
    onChange: e => setRunToFailure(p => ({
      ...p,
      week: e.target.value
    })),
    className: "w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-slate-100 text-xs focus:border-red-500 focus:outline-none"
  }, mps.map(m => /*#__PURE__*/React.createElement("option", {
    key: m.week,
    value: m.week
  }, m.week)))), /*#__PURE__*/React.createElement(Field, {
    label: __t("ساعات التوقف للإصلاح", "Downtime hours for repair"),
    value: runToFailure.downtimeHours,
    onChange: v => setRunToFailure(p => ({
      ...p,
      downtimeHours: v
    }))
  })), runToFailure.active && runToFailureResult && /*#__PURE__*/React.createElement("div", {
    className: `rounded-xl p-3 text-xs ${runToFailureResult.feasibleAfterFailure ? "bg-emerald-950/40 border border-emerald-700 text-emerald-300" : "bg-red-950/40 border border-red-700 text-red-300"}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "font-semibold mb-2"
  }, runToFailureResult.recommendation), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-3 gap-2"
  }, [[__t("الطاقة الأصلية", "Original capacity"), `${runToFailureResult.originalAvailH}h`], [__t("الطاقة بعد العطل", "Capacity after the breakdown"), `${runToFailureResult.netAvailH}h`], [__t("الاستخدام الجديد", "New utilization"), `${runToFailureResult.newUtil}%`]].map(([l, v], i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "bg-slate-900 rounded-lg p-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-slate-400"
  }, l), /*#__PURE__*/React.createElement("div", {
    className: "font-bold font-mono"
  }, v))))))), tab === "comparison" && planReady && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, __t("مقارنة المقترح بالخطة الأساسية", "Comparing the suggestion with the base plan")), !comparisonPlan ? /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 border border-dashed border-slate-700 rounded-xl p-8 text-center space-y-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-3xl"
  }, "\u2696\uFE0F"), /*#__PURE__*/React.createElement("div", {
    className: "text-slate-300 font-semibold text-sm"
  }, __t("ما فيه مقارنة بعد", "There is no comparison yet")), /*#__PURE__*/React.createElement("div", {
    className: "text-slate-500 text-xs"
  }, __t("شغّل وكلاء الذكاء الاصطناعي (تبويب AI Agents)، ولو اقترح كبير المخططين تحسيناً، اضغط \"جرّب هذا المقترح وقارن\".", "Run the AI agents (AI Agents tab), and if the chief planner suggests an improvement, click \"Try this suggestion and compare\"."))) : (() => {
    const {
      suggestion,
      oldValue,
      newValue,
      base,
      alt
    } = comparisonPlan;
    const paramLabel = {
      normalDays: __t("أيام العمل العادية", "Normal working days"),
      shiftHours: __t("ساعات الوردية", "Shift hours"),
      maxShifts: __t("أقصى عدد ورديات", "Maximum number of shifts"),
      fgiSafety: __t("مخزون أمان المنتج النهائي", "Finished-product safety stock"),
      fgiMaxWarehouse: __t("أقصى سعة مستودع المنتج النهائي", "Maximum finished-product warehouse capacity")
    }[suggestion.param] || suggestion.param;
    const rows = [{
      label: __t("متوسط استغلال الطاقة", "Average capacity utilization"),
      base: base.avgUtil + "%",
      alt: alt.avgUtil + "%",
      better: alt.avgUtil <= base.avgUtil ? "alt" : alt.avgUtil <= 100 ? "alt" : "base"
    }, {
      label: __t("أسابيع نقص متوقع (Stockout)", "Weeks with expected shortage (Stockout)"),
      base: base.stockouts,
      alt: alt.stockouts,
      better: alt.stockouts < base.stockouts ? "alt" : alt.stockouts > base.stockouts ? "base" : "eq"
    }, {
      label: __t("أسابيع تحتاج عمل إضافي", "Weeks needing overtime"),
      base: base.needsOT,
      alt: alt.needsOT,
      better: alt.needsOT < base.needsOT ? "alt" : alt.needsOT > base.needsOT ? "base" : "eq"
    }, {
      label: __t("أسابيع تجاوز الطاقة (>100%)", "Weeks exceeding capacity (>100%)"),
      base: base.overloaded,
      alt: alt.overloaded,
      better: alt.overloaded < base.overloaded ? "alt" : alt.overloaded > base.overloaded ? "base" : "eq"
    }, {
      label: __t("درجة الجدوى", "Feasibility score"),
      base: base.feasScore + "/100",
      alt: alt.feasScore + "/100",
      better: alt.feasScore > base.feasScore ? "alt" : alt.feasScore < base.feasScore ? "base" : "eq"
    }, {
      label: __t("التكلفة الإجمالية (ريال)", "Total cost (riyal)"),
      base: base.total.toLocaleString(),
      alt: alt.total.toLocaleString(),
      better: alt.total < base.total ? "alt" : alt.total > base.total ? "base" : "eq"
    }];
    const costSaved = base.total - alt.total;
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      className: "bg-emerald-950/20 border border-emerald-800/50 rounded-xl p-4"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-sm text-emerald-300"
    }, __t("💡 المقترح: تغيير", "💡 The suggestion: change"), " ", /*#__PURE__*/React.createElement("b", null, paramLabel), " ", __t("من", "of"), " ", /*#__PURE__*/React.createElement("b", {
      className: "text-slate-300"
    }, oldValue), " ", __t("إلى", "to"), " ", /*#__PURE__*/React.createElement("b", {
      className: "text-emerald-400"
    }, newValue), suggestion.why && /*#__PURE__*/React.createElement("div", {
      className: "text-xs text-slate-400 mt-1"
    }, suggestion.why))), /*#__PURE__*/React.createElement("div", {
      className: "bg-slate-900 rounded-xl border border-slate-700 overflow-hidden"
    }, /*#__PURE__*/React.createElement("div", {
      className: "grid grid-cols-4 text-xs font-semibold text-slate-400 bg-slate-800 px-4 py-2"
    }, /*#__PURE__*/React.createElement("span", {
      className: "col-span-2"
    }, __t("المؤشر", "Indicator")), /*#__PURE__*/React.createElement("span", null, __t("الخطة الأساسية", "Base plan")), /*#__PURE__*/React.createElement("span", null, __t("مقترح الوكيل", "Agent's suggestion"))), rows.map((r, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "grid grid-cols-4 items-center px-4 py-2.5 text-xs border-t border-slate-800"
    }, /*#__PURE__*/React.createElement("span", {
      className: "col-span-2 text-slate-300"
    }, r.label), /*#__PURE__*/React.createElement("span", {
      className: `font-mono ${r.better === "base" ? "text-emerald-400 font-bold" : "text-slate-400"}`
    }, r.base), /*#__PURE__*/React.createElement("span", {
      className: `font-mono ${r.better === "alt" ? "text-emerald-400 font-bold" : "text-slate-400"}`
    }, r.alt)))), /*#__PURE__*/React.createElement("div", {
      className: `rounded-xl p-4 text-sm font-bold text-center ${costSaved > 0 ? "bg-emerald-950/30 border border-emerald-700 text-emerald-300" : costSaved < 0 ? "bg-red-950/30 border border-red-700 text-red-300" : "bg-slate-900 border border-slate-700 text-slate-400"}`
    }, costSaved > 0 ? __tf("✅ المقترح يوفّر {0} ريال مقارنة بالخطة الأساسية", "✅ The suggestion saves {0} riyal compared with the base plan", [costSaved.toLocaleString()]) : costSaved < 0 ? __tf("⚠️ المقترح يزيد التكلفة {0} ريال — قد يستاهل رغم ذلك لو حسّن مؤشرات أخرى فوق", "⚠️ The suggestion increases the cost by {0} riyal — it may still be worthwhile if it improves other indicators above", [Math.abs(costSaved).toLocaleString()]) : __t("المقترح لا يغيّر التكلفة الإجمالية", "The suggestion does not change the total cost")), /*#__PURE__*/React.createElement("div", {
      className: "text-xs text-slate-500 bg-slate-800/60 rounded-lg p-3"
    }, __t("📌 هذي محاكاة كاملة بنفس محرك النظام الفعلي (MPS/MRP/التكاليف/الجدوى) — مو تقدير تقريبي من الذكاء الاصطناعي. الخطة الأساسية الحالية لم تتغيّر؛ لو عجبك المقترح، طبّقه يدوياً بتبويب الطاقة أو FGI.", "📌 This is a full simulation using the same engine as the actual system (MPS/MRP/costs/feasibility) — not a rough AI estimate. The current base plan has not changed; if you like the suggestion, apply it manually in the Capacity or FGI tab.")));
  })()), tab === "gantt" && planReady && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.gantt), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4 overflow-x-auto"
  }, /*#__PURE__*/React.createElement("div", {
    className: "min-w-max"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex gap-1 mb-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-14 text-xs text-slate-500 font-semibold"
  }, "W"), [__t("سبت", "Sat"), __t("أحد", "Sun"), __t("اثنين", "Mon"), __t("ثلاثاء", "Tue"), __t("أربعاء", "Wed"), __t("خميس", "Thu"), __t("جمعة", "Fri")].map(d => /*#__PURE__*/React.createElement("div", {
    key: d,
    className: "w-14 text-center text-xs text-slate-400 font-semibold"
  }, d)), /*#__PURE__*/React.createElement("div", {
    className: "w-20 text-xs text-slate-400 font-semibold"
  }, __t("الإنتاج", "production")), /*#__PURE__*/React.createElement("div", {
    className: "w-16 text-xs text-slate-400 font-semibold"
  }, __t("الاستخدام", "Utilization"))), mps.map(m => {
    const engineWeekData = engineResult?.maintenances?.find(x => x.week === m.week);
    const isEngineWeek = !!engineWeekData;
    // اليوم الفعلي الذي تقع فيه الصيانة داخل الأسبوع — محسوب من hoursIntoWeekAtTrigger
    // بدلاً من يوم ثابت: نقسّم الساعات على سعة اليوم الواحد (ساعات الوردية × عدد الورديات)
    let maintDayIdx = -1;
    if (isEngineWeek && engineWeekData) {
      const hoursPerDay = cap.shiftHours * Math.max(1, m.shifts);
      maintDayIdx = Math.min(Math.floor(engineWeekData.hoursIntoWeekAtTrigger / hoursPerDay), Math.max(0, m.workDays - 1));
    }
    return /*#__PURE__*/React.createElement("div", {
      key: m.week,
      className: "flex gap-1 mb-1.5 items-center"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-14 text-xs font-bold text-slate-300 font-mono"
    }, m.week), [0, 1, 2, 3, 4, 5, 6].map(dayIdx => {
      const isWorking = dayIdx < m.workDays;
      const isMaintDay = isEngineWeek && dayIdx === maintDayIdx;
      const isOT = isWorking && dayIdx >= cap.normalDays;
      const bg = m.infeasible && isWorking ? "bg-red-900/60 border-red-700" : isMaintDay ? "bg-purple-900/70 border-purple-600" : isOT ? "bg-amber-900/60 border-amber-600" : isWorking ? m.util > 85 ? "bg-orange-900/60 border-orange-700" : "bg-blue-900/50 border-blue-800/60" : "bg-slate-800 border-slate-700";
      return /*#__PURE__*/React.createElement("div", {
        key: dayIdx,
        className: `w-14 h-12 rounded border flex flex-col items-center justify-center shrink-0 ${bg}`
      }, isWorking || isOT ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
        className: "font-bold text-white text-xs"
      }, m.shifts, "W"), isMaintDay && /*#__PURE__*/React.createElement("div", {
        className: "text-purple-200 text-xs"
      }, "\uD83D\uDD29")) : /*#__PURE__*/React.createElement("div", {
        className: "text-slate-600 text-xs"
      }, "\u2014"));
    }), /*#__PURE__*/React.createElement("div", {
      className: "w-20 text-xs font-mono text-blue-400 text-center"
    }, m.production.toLocaleString()), /*#__PURE__*/React.createElement("div", {
      className: "w-16"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-full bg-slate-800 rounded-full h-2"
    }, /*#__PURE__*/React.createElement("div", {
      className: `h-2 rounded-full ${m.util > 100 ? "bg-red-500" : m.util > 85 ? "bg-orange-500" : "bg-blue-500"}`,
      style: {
        width: `${Math.min(m.util, 100)}%`
      }
    })), /*#__PURE__*/React.createElement("div", {
      className: "text-xs text-center font-mono mt-0.5",
      style: {
        color: m.util > 100 ? "#EF4444" : m.util > 85 ? "#F97316" : "#60A5FA"
      }
    }, m.util, "%")));
  }), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-4 mt-3 text-xs text-slate-500 flex-wrap"
  }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "inline-block w-3 h-3 rounded bg-blue-900/70 border border-blue-700 mr-1"
  }), __t("عادي", "Normal")), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "inline-block w-3 h-3 rounded bg-amber-900/60 border border-amber-600 mr-1"
  }), __t("OT جمعة", "Friday OT")), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "inline-block w-3 h-3 rounded bg-purple-900/70 border border-purple-600 mr-1"
  }), __t("🔩 صيانة آلة", "🔩 Machine maintenance")), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "inline-block w-3 h-3 rounded bg-red-900/60 border border-red-700 mr-1"
  }), __t("متعذر", "Infeasible")))))), tab === "costs" && planReady && costAnalysis && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.costs), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-semibold text-slate-300 mb-3"
  }, __t("⚙️ معاملات التكلفة", "⚙️ Cost parameters")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement(Field, {
    label: __t("تكلفة الإنتاج (ريال/وحدة)", "Production cost (riyal/unit)"),
    value: costs.perUnit,
    onChange: v => setCosts(p => ({
      ...p,
      perUnit: v
    })),
    step: 0.5
  }), /*#__PURE__*/React.createElement(Field, {
    label: __t("تكلفة الوردية", "Shift cost"),
    value: costs.workerShiftCost,
    onChange: v => setCosts(p => ({
      ...p,
      workerShiftCost: v
    }))
  }), /*#__PURE__*/React.createElement(Field, {
    label: __t("تكلفة ساعة OT", "OT hour cost"),
    value: costs.otHourRate,
    onChange: v => setCosts(p => ({
      ...p,
      otHourRate: v
    }))
  }), /*#__PURE__*/React.createElement(Field, {
    label: __t("تكلفة التخزين (%/أسبوع)", "Holding cost (%/week)"),
    value: costs.holdingPct,
    onChange: v => setCosts(p => ({
      ...p,
      holdingPct: v
    })),
    step: 0.1
  }), /*#__PURE__*/React.createElement(Field, {
    label: __t("تكلفة أمر الشراء", "Purchase order cost"),
    value: costs.orderCost,
    onChange: v => setCosts(p => ({
      ...p,
      orderCost: v
    }))
  }))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-5 gap-2"
  }, costAnalysis.breakdown.map((c, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "bg-slate-900 border border-slate-700 rounded-xl p-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-400"
  }, c.name), /*#__PURE__*/React.createElement("div", {
    className: "text-base font-bold font-mono",
    style: {
      color: c.color
    }
  }, c.value.toLocaleString(undefined, {
    maximumFractionDigits: 0
  })), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500"
  }, c.pct.toFixed(1), "%")))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement(MiniHBarChart, {
    data: costAnalysis.breakdown,
    height: 180
  })), /*#__PURE__*/React.createElement("div", {
    className: "bg-blue-950/30 border border-blue-700 rounded-xl p-4 flex justify-between items-center"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-sm font-semibold text-blue-300"
  }, __t("إجمالي التكاليف", "Total costs")), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-400 mt-0.5"
  }, __t("تكلفة الوحدة:", "Cost per unit:"), " ", (costAnalysis.total / totalDemand).toFixed(2), " ", __t("ريال", "riyal"))), /*#__PURE__*/React.createElement("div", {
    className: "text-2xl font-black font-mono text-blue-400"
  }, costAnalysis.total.toLocaleString(undefined, {
    maximumFractionDigits: 0
  }), " ", /*#__PURE__*/React.createElement("span", {
    className: "text-sm"
  }, __t("ريال", "riyal"))))), tab === "feasibility" && planReady && feasibility && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.feasibility), /*#__PURE__*/React.createElement("div", {
    className: `rounded-xl border p-5 flex justify-between items-center ${feasibility.score >= 80 ? "bg-emerald-950/30 border-emerald-700" : feasibility.score >= 60 ? "bg-amber-950/30 border-amber-700" : "bg-red-950/30 border-red-700"}`
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-xl font-bold text-slate-100"
  }, feasibility.verdict), /*#__PURE__*/React.createElement("div", {
    className: "text-sm text-slate-400 mt-1"
  }, __t("اجتاز", "Passed"), " ", feasibility.passCount, "/", feasibility.totalCount, " ", __t("معايير", "criteria"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "text-6xl font-black font-mono",
    style: {
      color: feasibility.score >= 80 ? "#10B981" : feasibility.score >= 60 ? "#F59E0B" : "#EF4444"
    }
  }, feasibility.score), /*#__PURE__*/React.createElement("div", {
    className: "text-sm text-slate-400 text-center"
  }, "/ 100"))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-hidden"
  }, /*#__PURE__*/React.createElement("table", {
    className: "w-full text-xs"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "bg-slate-800 text-slate-400"
  }, /*#__PURE__*/React.createElement("th", {
    className: "px-4 py-2 text-right"
  }, __t("المعيار", "Criterion")), /*#__PURE__*/React.createElement("th", {
    className: "px-4 py-2 text-right"
  }, __t("الأهمية", "Importance")), /*#__PURE__*/React.createElement("th", {
    className: "px-4 py-2 text-right"
  }, __t("التفاصيل", "Details")), /*#__PURE__*/React.createElement("th", {
    className: "px-4 py-2 text-right"
  }, __t("النتيجة", "Result")))), /*#__PURE__*/React.createElement("tbody", null, feasibility.criteria.map((c, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    className: `border-t border-slate-800 ${!c.pass ? "bg-red-950/10" : ""}`
  }, /*#__PURE__*/React.createElement("td", {
    className: "px-4 py-3 font-medium text-slate-200"
  }, c.name), /*#__PURE__*/React.createElement("td", {
    className: "px-4 py-3 text-slate-400"
  }, "⭐".repeat(c.w)), /*#__PURE__*/React.createElement("td", {
    className: "px-4 py-3 text-slate-300"
  }, c.detail), /*#__PURE__*/React.createElement("td", {
    className: "px-4 py-3"
  }, c.pass ? /*#__PURE__*/React.createElement(Badge, {
    ok: true,
    label: __t("✓ اجتاز", "✓ Passed")
  }) : /*#__PURE__*/React.createElement(Badge, {
    label: __t("✗ لم يجتز", "✗ Did not pass")
  })))))))), tab === "postupdate" && planReady && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.postupdate), workflow === "planned" && /*#__PURE__*/React.createElement("div", {
    className: "bg-amber-950/30 border border-amber-700 rounded-xl p-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-sm font-semibold text-amber-300 mb-2"
  }, __t("⚠️ الخطة لم تُؤكد بعد", "⚠️ The plan has not been confirmed yet")), /*#__PURE__*/React.createElement("button", {
    onClick: handleConfirmPlan,
    className: "bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-xl text-sm font-bold"
  }, __t("✅ تأكيد وتحديث", "✅ Confirm and update"))), confirmed && /*#__PURE__*/React.createElement("div", {
    className: "bg-emerald-950/30 border border-emerald-700 rounded-xl p-3 text-xs text-emerald-300 flex gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\u2705"), /*#__PURE__*/React.createElement("span", null, planningProfile.hasBOM ? __t("تم تحديث المخزون وFGI وساعات الآلة بنجاح", "Inventory, FGI and machine hours were updated successfully") : [planningProfile.hasFGI && "FGI", planningProfile.hasMaintenance && __t("ساعات الآلة", "machine hours")].filter(Boolean).join(__t(" و", " and ")) ? __tf("تم تحديث {0} بنجاح", "{0} updated successfully", [[planningProfile.hasFGI && "FGI", planningProfile.hasMaintenance && __t("ساعات الآلة", "machine hours")].filter(Boolean).join(__t(" و", " and "))]) : __t("تم تأكيد الخطة بنجاح", "The plan was confirmed successfully"))), !planningProfile.hasBOM && /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 border border-dashed border-slate-700 rounded-xl p-6 text-center text-slate-500 text-xs"
  }, __t("📦 لا يوجد جدول مخزون/توصيات شراء هنا لأن تخطيطكم لا يتتبّع مواد خام (حسب إجابتكم بالاستبيان الأولي — قابل للتغيير من تبويب \"عن النظام\").", "📦 There is no inventory table/purchase recommendations here because your planning does not track raw materials (according to your answer in the initial questionnaire — changeable from the \"About the system\" tab).")), planningProfile.hasBOM && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-400"
  }, __t("📦 المخزون قبل وبعد الخطة", "📦 Inventory before and after the plan")), /*#__PURE__*/React.createElement("table", {
    className: "w-full text-xs"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "bg-slate-800/50 text-slate-400"
  }, [__t("المادة", "Material"), __t("قبل", "Before"), __t("الاستهلاك", "Consumption"), __t("الطلبيات", "Orders"), __t("بعد", "After"), __t("سعة قصوى", "Max capacity"), __t("حالة", "Status")].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    className: "px-3 py-2 text-right"
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, postPlan.map((item, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    className: "border-t border-slate-800"
  }, /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-medium text-slate-200"
  }, item.name), /*#__PURE__*/React.createElement("td", {
    className: `px-3 py-2 font-mono ${item.available < 0 ? "text-red-400 font-bold" : ""}`
  }, item.available.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-red-400"
  }, "-", item.totalConsumed.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-emerald-400"
  }, "+", item.totalOrdered.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: `px-3 py-2 font-mono font-bold ${item.endingStock < 0 ? "text-red-400" : "text-blue-400"}`
  }, item.endingStock.toLocaleString(), item.endingStock < 0 && /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-normal mr-1"
  }, __t("(عجز)", "(shortfall)"))), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-mono text-slate-500"
  }, item.maxCapacity.toLocaleString()), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2"
  }, item.endingStock < item.safety ? /*#__PURE__*/React.createElement(Badge, {
    label: __t("دون الأمان", "Below safety")
  }) : item.anyCapacityConstrained ? /*#__PURE__*/React.createElement(Badge, {
    warn: true,
    label: __t("🔒 تأثر بالسعة", "🔒 Affected by capacity")
  }) : /*#__PURE__*/React.createElement(Badge, {
    ok: true,
    label: __t("✓ آمن", "✓ Safe")
  }))))))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-400"
  }, __t("📋 توصيات الشهر القادم (تحترم سعة التخزين)", "📋 Next-month recommendations (respecting storage capacity)")), /*#__PURE__*/React.createElement("div", {
    className: "px-4 py-2 text-xs text-slate-500 bg-slate-800/40 border-b border-slate-800"
  }, __t("💡 عمود \"يُوصى بطلب\" هو", "💡 The \"Recommended order\" column is"), " ", /*#__PURE__*/React.createElement("b", {
    className: "text-emerald-400"
  }, "Planned Order"), " ", __t("— اقتراح حسابي فقط، غير مُلزم بعد. بمجرد الضغط على \"تأكيد الشراء\" يتحوّل لالتزام حقيقي (", "— a computed suggestion only, not yet binding. Once you click \"Confirm purchase\" it becomes a real commitment ("), /*#__PURE__*/React.createElement("b", {
    className: "text-sky-400"
  }, "Scheduled Receipt / SR"), __t(") بتاريخ وصول ثابت، ويُسجَّل في تبويب \"طلبات الشراء (SR)\". أي SR سبق تأكيده وتاريخ وصوله", ") with a fixed arrival date, and is recorded in the \"Purchase orders (SR)\" tab. Any SR already confirmed whose arrival date falls"), " ", /*#__PURE__*/React.createElement("b", null, __t("ضمن", "within")), " ", __t("أفق هذه الخطة محسوبٌ بالفعل داخل عمود \"المخزون\" أعلاه — فلا يُعتبر مكرراً مع توصية جديدة هنا.", "the horizon of this plan is already counted in the \"Stock\" column above — so it is not considered a duplicate of a new recommendation here.")), /*#__PURE__*/React.createElement("table", {
    className: "w-full text-xs"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "bg-slate-800/50 text-slate-400"
  }, [__t("المادة", "Material"), __t("استهلاك/W", "Consumption/W"), __t("المخزون", "Inventory"), __t("يكفي(W)", "Lasts(W)"), __t("يُوصى بطلب", "Recommended order"), __t("الأولوية", "Priority"), ""].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    className: "px-3 py-2 text-right"
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, nextMonthRec.map((r, i) => {
    // "قيد الانتظار فعلاً" = طلب شراء وصوله بعد نهاية أفق هذه الخطة (لم يُحتسب بعد ضمن endingStock).
    // أي SR بتاريخ وصول ضمن أفق الخطة الحالي أصلاً مُحتسب داخل endingStock أعلاه (عبر srForWeek
    // في calcMRP)، فاحتسابه مرة ثانية هنا كـ"مغطٍّ" للتوصية الجديدة يكون مضللاً — التوصية أصلاً
    // صافية بعده. راجع تبويب "طلبات الشراء (SR)" لكل السجل الكامل (معلّق/مستلم).
    const futurePending = poLog.filter(p => p.materialId === r.id && p.status === "pending" && p.arrivalDate > planHorizonEnd);
    const alreadyPending = futurePending.length > 0;
    const futureQty = futurePending.reduce((s, p) => s + Number(p.qty || 0), 0);
    return /*#__PURE__*/React.createElement("tr", {
      key: i,
      className: `border-t border-slate-800 ${r.needsOrder ? "bg-amber-950/10" : ""}`
    }, /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2 font-medium text-slate-200"
    }, r.name), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2 font-mono"
    }, r.weeklyConsumption.toLocaleString()), /*#__PURE__*/React.createElement("td", {
      className: `px-3 py-2 font-mono ${r.endingStock < 0 ? "text-red-400 font-bold" : ""}`
    }, r.endingStock.toLocaleString()), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2"
    }, /*#__PURE__*/React.createElement("span", {
      className: r.weeksLeft < r.leadTime ? "text-red-400 font-bold" : "text-emerald-400"
    }, r.weeksLeft, "W")), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2 font-mono text-emerald-400 font-bold"
    }, r.needsOrder ? r.recommendedQty.toLocaleString() : "—", r.capacityConstrained && /*#__PURE__*/React.createElement("span", {
      className: "text-orange-400"
    }, " \uD83D\uDD12")), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2"
    }, r.urgency), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2"
    }, r.needsOrder && !alreadyPending && /*#__PURE__*/React.createElement("button", {
      onClick: () => confirmPurchase(r.id, r.name, r.recommendedQty, r.leadTime),
      className: "bg-sky-700 hover:bg-sky-600 px-2 py-1 rounded text-[10px] font-bold whitespace-nowrap"
    }, __t("📦 تأكيد الشراء", "📦 Confirm purchase")), alreadyPending && /*#__PURE__*/React.createElement("span", {
      className: "text-sky-400 text-[10px]",
      title: __tf("طلب/طلبات قائمة بكمية إجمالية {0} تصل بعد {1} (بعد نهاية أفق هذه الخطة)", "existing order(s) with a total quantity of {0} arriving {1} (after the end of this plan's horizon)", [futureQty.toLocaleString(), planHorizonEnd])
    }, __t("✓ طلب مستقبلي قائم (", "✓ Existing future order ("), futureQty.toLocaleString(), ")")));
  })))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 px-4 py-3 text-xs text-slate-400 flex items-center justify-between"
  }, /*#__PURE__*/React.createElement("span", null, __t("🚚 طلبات الشراء المعلّقة حالياً:", "🚚 Currently pending purchase orders:"), " ", /*#__PURE__*/React.createElement("b", {
    className: "text-sky-400"
  }, poLog.filter(p => p.status === "pending").length), " ", __t("— يمكن إدارتها وإضافة طلبات جديدة يدوياً من تبويب \"طلبات الشراء (SR)\".", "— they can be managed and new orders added manually from the \"Purchase orders (SR)\" tab.")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setTab("polog"),
    className: "bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg font-bold whitespace-nowrap"
  }, __t("فتح 🚚", "Open 🚚"))))), tab === "reports" && planReady && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.reports), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-5"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-base font-bold text-slate-200 mb-1"
  }, __t("تقرير تخطيط الإنتاج الشامل", "Comprehensive production planning report")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-2 mb-4 text-xs mt-3"
  }, [[__t("الطلب", "Demand"), totalDemand.toLocaleString() + __t(" وحدة", " units")], [__t("الاستخدام", "Utilization"), avgUtil + "%"], [__t("أفق الخطة", "Plan horizon"), planWeeks + __t(" أسبوع", " weeks")], [__t("تنبيهات", "Alerts"), overloaded + stockoutAll.length], [__t("تحليل AI", "AI analysis"), agentOutputs.a4 ? "✓" : __t("✗ لم يُشغَّل", "✗ Not run")], [__t("سعة مقيّدة", "Capped capacity"), anyCapacityConstrained ? __t("نعم ⚠️", "Yes ⚠️") : __t("لا", "No")]].map(([l, v], i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "bg-slate-800 rounded-lg p-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-slate-400"
  }, l, ": "), /*#__PURE__*/React.createElement("span", {
    className: "text-slate-200 font-medium"
  }, v)))), /*#__PURE__*/React.createElement("button", {
    onClick: () => generatePDF(mps, mrp, postPlan, nextMonthRec, agentOutputs, {
      ...engineResult,
      ...engineMaint
    }, {
      ...fgiConfig,
      endOfPlan: fgiEnd
    }, planWeeks, feasibility, costAnalysis, orgLabel.productName, orgLabel.fgUnit),
    className: "w-full bg-blue-600 hover:bg-blue-500 py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDDA8\uFE0F"), " ", __t("إنشاء تقرير PDF شامل", "Generate a comprehensive PDF report"))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-5"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold text-slate-200 mb-3"
  }, __t("📧 إرسال ملخص الخطة عبر البريد", "📧 Send the plan summary by email")), /*#__PURE__*/React.createElement(TextField, {
    label: __t("البريد الإلكتروني للمستلم", "Recipient's email"),
    value: emailTo,
    onChange: setEmailTo,
    placeholder: "planning@company.com",
    mono: false
  }), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500 mt-2 mb-3"
  }, __t("سيُفتح تطبيق البريد الافتراضي على جهازك مع ملخص جاهز. لإرفاق تقرير PDF الكامل، صدّره أولاً من الأعلى ثم أرفقه يدوياً في الرسالة.", "Your device's default mail app will open with a ready summary. To attach the full PDF report, export it first from above and then attach it manually to the message.")), /*#__PURE__*/React.createElement("button", {
    onClick: handleSendPlanEmail,
    disabled: !emailTo,
    className: "w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCE7"), " ", __t("فتح في تطبيق البريد", "Open in mail app")))), tab === "allplans" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, __t("📊 متابعة كل الخطط", "📊 Overview of all plans")), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500 bg-slate-800/60 rounded-lg p-3"
  }, __t("الأرقام هنا هي آخر لقطة محسوبة وقت آخر تشغيل/تأكيد لكل خطة — مو حساباً حياً لحظياً. افتح أي خطة وشغّلها من جديد لتحديث رقمها هنا.", "The numbers here are the last snapshot calculated at the time of each plan's last run/confirmation — not a live real-time calculation. Open any plan and run it again to update its figure here.")), capacityOverlaps.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "bg-red-950/30 border border-red-700 rounded-xl p-4 space-y-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-sm font-bold text-red-300"
  }, __t("🔗⚠️ تقاطع طاقة بين خطط مرتبطة", "🔗⚠️ Capacity overlap between linked plans")), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-red-200/80"
  }, __t("هذي أسابيع تقويمية متداخلة فعلياً بين خطتين شاركتا مادة خام — ومجموع ساعات حملهما يتجاوز رياضياً أقصى طاقة ممكنة لأضعفهما إعداداً، أي لا يوجد أي ترتيب ورديات يحقق الاثنتين معاً بذاك الأسبوع. هذا تنبيه فقط — النظام لا يحاول حل التعارض تلقائياً (جدولة طاقة محدودة عبر منتجات متعددة مسألة معقّدة تحتاج قراراً بشرياً: أيّ منتج له الأولوية).", "These are overlapping calendar weeks between two plans that share a raw material — and the sum of their load hours mathematically exceeds the maximum possible capacity of the weaker-configured one, meaning there is no shift arrangement that achieves both in that week. This is an alert only — the system does not try to resolve the conflict automatically (scheduling limited capacity across multiple products is a complex problem that needs a human decision: which product has priority).")), /*#__PURE__*/React.createElement("div", {
    className: "space-y-1.5 mt-2"
  }, capacityOverlaps.map((o, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "bg-slate-900 border border-red-800/50 rounded-lg p-2.5 text-xs flex items-center justify-between flex-wrap gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-slate-200"
  }, /*#__PURE__*/React.createElement("b", null, o.planAName), " \xD7 ", /*#__PURE__*/React.createElement("b", null, o.planBName), " ", __t("— الأسبوع", "— week"), " ", o.weekStart, " \u2192 ", o.weekEnd), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-red-300"
  }, o.combinedLoadH, __t("h مطلوبة مقابل", "h required vs."), " ", o.ceiling, __t("h أقصى طاقة متاحة", "h maximum available capacity")))))), plans.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 border border-dashed border-slate-700 rounded-xl p-8 text-center text-slate-500 text-xs"
  }, __t("لا توجد خطط بعد.", "There are no plans yet.")) : /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 overflow-x-auto"
  }, /*#__PURE__*/React.createElement("table", {
    className: "w-full text-xs min-w-max"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    className: "bg-slate-800 text-slate-400"
  }, [__t("الخطة", "Plan"), __t("الحالة", "Status"), __t("الاستخدام", "Utilization"), __t("الجدوى", "Feasibility"), __t("التكلفة الإجمالية", "Total cost"), __t("إجمالي الطلب", "Total demand"), __t("آخر تحديث", "Last update"), ""].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    className: "px-3 py-2 text-right"
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, plans.map(p => {
    const s = p.lastSummary;
    const isActive = p.id === activePlanId;
    const wfLabel = {
      idle: __t("⏸ لم تُشغَّل بعد", "⏸ Not run yet"),
      syncing: __t("🔄 قيد المعالجة", "🔄 Processing"),
      planned: __t("📋 جاهزة — بانتظار التأكيد", "📋 Ready — awaiting confirmation"),
      confirmed: __t("✅ مؤكدة", "✅ Confirmed")
    }[s?.workflow] || __t("⏸ لم تُشغَّل بعد", "⏸ Not run yet");
    const hasOverlap = capacityOverlaps.some(o => o.planAId === p.id || o.planBId === p.id);
    return /*#__PURE__*/React.createElement("tr", {
      key: p.id,
      className: `border-t border-slate-800 ${isActive ? "bg-blue-950/30" : ""}`
    }, /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2 font-medium text-slate-200"
    }, p.productName || __t("بدون اسم", "Unnamed"), isActive && /*#__PURE__*/React.createElement("span", {
      className: "text-blue-400 text-[10px] mr-1"
    }, __t("(الحالية)", "(current)")), hasOverlap && /*#__PURE__*/React.createElement("span", {
      className: "text-red-400 text-[10px] mr-1",
      title: __t("تقاطع طاقة مع خطة مرتبطة — راجع التنبيه أعلاه", "Capacity overlap with a linked plan — see the alert above")
    }, "\u26A0\uFE0F")), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2"
    }, wfLabel), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2 font-mono"
    }, s ? /*#__PURE__*/React.createElement("span", {
      className: s.avgUtil > 100 ? "text-red-400" : s.avgUtil > 85 ? "text-amber-400" : "text-emerald-400"
    }, s.avgUtil, "%") : "—"), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2 font-mono"
    }, s ? /*#__PURE__*/React.createElement("span", {
      style: {
        color: s.feasibilityScore >= 80 ? "#10B981" : s.feasibilityScore >= 60 ? "#F59E0B" : "#EF4444"
      }
    }, s.feasibilityScore, "/100") : "—"), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2 font-mono"
    }, s ? s.totalCost.toLocaleString() : "—"), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2 font-mono"
    }, s ? s.totalDemand.toLocaleString() : "—"), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2 font-mono text-slate-500"
    }, s?.updatedAt || "—"), /*#__PURE__*/React.createElement("td", {
      className: "px-3 py-2"
    }, !isActive && /*#__PURE__*/React.createElement("button", {
      onClick: () => switchPlan(p.id),
      className: "bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded text-[10px] font-bold whitespace-nowrap"
    }, __t("فتح", "Open"))));
  })))), plans.length >= 2 && /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4 space-y-3"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-semibold text-slate-300"
  }, __t("🔗 ربط خطط لفحص تقاطع الطاقة (بدون الحاجة لمشاركة أي مادة خام)", "🔗 Link plans to check capacity overlap (without needing to share any raw material)")), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-500"
  }, __t("اربط أي خطتين تستخدمان فعلياً نفس خط الإنتاج أو نفس العمالة — حتى لو ما تشتركان بأي مادة — ليشملهما تنبيه التقاطع أعلاه تلقائياً من الآن فصاعداً.", "Link any two plans that actually use the same production line or the same workforce — even if they share no material — so they are automatically included in the overlap alert above from now on.")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 flex-wrap"
  }, /*#__PURE__*/React.createElement("select", {
    value: linkPickA,
    onChange: e => setLinkPickA(e.target.value),
    className: "bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, __t("اختر خطة...", "Choose a plan...")), plans.map(p => /*#__PURE__*/React.createElement("option", {
    key: p.id,
    value: p.id
  }, p.productName || __t("بدون اسم", "Unnamed")))), /*#__PURE__*/React.createElement("span", {
    className: "text-slate-500 text-xs"
  }, "\uD83D\uDD17"), /*#__PURE__*/React.createElement("select", {
    value: linkPickB,
    onChange: e => setLinkPickB(e.target.value),
    className: "bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, __t("بخطة...", "with a plan...")), plans.filter(p => p.id !== linkPickA).map(p => /*#__PURE__*/React.createElement("option", {
    key: p.id,
    value: p.id
  }, p.productName || __t("بدون اسم", "Unnamed")))), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      linkPlansForCapacity(linkPickA, linkPickB);
      setLinkPickA("");
      setLinkPickB("");
    },
    disabled: !linkPickA || !linkPickB || linkPickA === linkPickB,
    className: "bg-sky-700 hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg text-xs font-bold"
  }, __t("ربط", "Link"))), linkedPairs.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "space-y-1 pt-1"
  }, linkedPairs.map(([a, b]) => /*#__PURE__*/React.createElement("div", {
    key: a.id + b.id,
    className: "flex items-center justify-between bg-slate-800/60 rounded-lg px-3 py-1.5 text-xs"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-slate-300"
  }, a.productName || __t("بدون اسم", "Unnamed"), " \uD83D\uDD17 ", b.productName || __t("بدون اسم", "Unnamed")), /*#__PURE__*/React.createElement("button", {
    onClick: () => unlinkPlans(a.id, b.id),
    className: "text-red-400 hover:text-red-300 text-[10px] font-bold"
  }, __t("✕ فك الربط", "✕ Unlink")))))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowNewPlan(true),
    className: "w-full border border-dashed border-slate-600 hover:border-blue-500 hover:text-blue-400 text-slate-400 rounded-xl py-3 text-sm transition-colors"
  }, __t("+ خطة جديدة", "+ New plan"))), tab === "about" && /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement(SH, null, T.about), /*#__PURE__*/React.createElement("div", {
    className: "bg-cyan-950/20 border border-cyan-800/50 rounded-xl p-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold text-cyan-300 mb-2"
  }, __t("🧭 ملف تخطيط الشركة الحالي", "🧭 The company's current planning profile")), /*#__PURE__*/React.createElement("div", {
    className: "space-y-1 text-xs text-cyan-100 mb-3"
  }, /*#__PURE__*/React.createElement("div", null, __t("• تتبّع مواد خام (BOM):", "• Raw-material tracking (BOM):"), " ", /*#__PURE__*/React.createElement("b", null, planningProfile.hasBOM ? __t("نعم", "Yes") : __t("لا", "No"))), /*#__PURE__*/React.createElement("div", null, __t("• مخزون أمان للمنتج النهائي (FGI):", "• Finished-product safety stock (FGI):"), " ", /*#__PURE__*/React.createElement("b", null, planningProfile.hasFGI ? __t("نعم", "Yes") : __t("لا", "No"))), /*#__PURE__*/React.createElement("div", null, __t("• صيانة دورية بالساعات:", "• Periodic maintenance by hours:"), " ", /*#__PURE__*/React.createElement("b", null, planningProfile.hasMaintenance ? __t("نعم", "Yes") : __t("لا", "No")))), /*#__PURE__*/React.createElement("div", {
    className: "text-xs text-slate-400 mb-2"
  }, __t("تغيير أي إجابة يُظهر أو يُخفي التبويبات المرتبطة بها فوراً — بياناتكم المُدخَلة مسبقاً (BOM، FGI، الصيانة) تبقى محفوظة كما هي حتى لو أعدتم تفعيلها لاحقاً.", "Changing any answer instantly shows or hides the tabs related to it — your previously entered data (BOM, FGI, maintenance) stays saved as it is even if you re-enable them later.")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setPlanningProfile(mkPlanningProfile()),
    className: "text-xs bg-cyan-800/60 hover:bg-cyan-800 border border-cyan-700 text-cyan-200 px-3 py-1.5 rounded-lg font-bold"
  }, __t("🔄 إعادة الإجابة على أسئلة نوع التخطيط", "🔄 Re-answer the planning-type questions"))), /*#__PURE__*/React.createElement("div", {
    className: "bg-emerald-950/30 border border-emerald-700 rounded-xl p-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold text-emerald-300 mb-2"
  }, __t("✅ نظام مستقل بالكامل", "✅ A fully independent system")), /*#__PURE__*/React.createElement("div", {
    className: "space-y-1 text-xs text-emerald-200"
  }, /*#__PURE__*/React.createElement("div", null, __t("• ملف HTML واحد يعمل من أي متصفح — بدون خادم، بدون تثبيت", "• A single HTML file that works from any browser — no server, no installation")), /*#__PURE__*/React.createElement("div", null, __t("• الوكلاء الذكية عبر Gemini API مباشرة (مجاني) — بدون وسيط", "• Smart agents via the Gemini API directly (free) — no intermediary")), /*#__PURE__*/React.createElement("div", null, __t("• البيانات تُحفظ في متصفحك محلياً (localStorage)", "• Data is saved locally in your browser (localStorage)")), /*#__PURE__*/React.createElement("div", null, __t("• استيراد البيانات: Excel أو Google Sheets مباشرة", "• Data import: Excel or Google Sheets directly")))), /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-900 rounded-xl border border-slate-700 p-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold text-slate-200 mb-3"
  }, __t("🏗️ منطق النظام", "🏗️ System logic")), /*#__PURE__*/React.createElement("div", {
    className: "space-y-2 text-xs text-slate-300"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", {
    className: "text-blue-400"
  }, "MPS:"), " ", __t("Lot-for-Lot مع مراعاة FGI (Push/Pull/Hybrid)", "Lot-for-Lot with FGI consideration (Push/Pull/Hybrid)")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", {
    className: "text-blue-400"
  }, "MRP:"), " ", __t("جدولة خلفية (Backward Scheduling) + قيود سعة التخزين", "Backward Scheduling + storage-capacity constraints")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", {
    className: "text-blue-400"
  }, "CRP:"), " ", __t("ورديات ديناميكية (1-3) + يوم جمعة اختياري (OT)", "Dynamic shifts (1-3) + optional Friday (OT)")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", {
    className: "text-blue-400"
  }, __t("الصيانة:", "Maintenance:")), " ", __t("قائمة فقط على ساعات التشغيل التراكمية — لا صيانة دورية أخرى", "based only on cumulative operating hours — no other periodic maintenance")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", {
    className: "text-blue-400"
  }, __t("ماذا لو:", "What-if:")), " ", __t("صدمة طلب، توقف آلة جزئي، تأخر مورد، وعطل مفاجئ (Run to Failure)", "demand shock, partial machine stoppage, supplier delay, and sudden breakdown (Run to Failure)")))), /*#__PURE__*/React.createElement("div", {
    className: "bg-blue-950/30 border border-blue-700 rounded-xl p-4 text-xs text-blue-200"
  }, /*#__PURE__*/React.createElement("div", {
    className: "font-semibold text-blue-300 mb-2"
  }, __t("🎓 مشروع تخرج — هندسة صناعية", "🎓 Graduation project — Industrial Engineering")), /*#__PURE__*/React.createElement("div", null, __t("Cognitive Digital Twin لتخطيط الإنتاج والتحكم —", "Cognitive Digital Twin for production planning & control —"), " ", orgLabel.productName)))))));
}

// ═══════════════════════════════════════════════════════════════════
//  ERROR BOUNDARY — يعرض أي خطأ تشغيل بشكل مرئي بدلاً من شاشة تحميل صامتة
// ═══════════════════════════════════════════════════════════════════
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      info: null
    };
  }
  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      error
    };
  }
  componentDidCatch(error, info) {
    this.setState({
      info
    });
    console.error("CDT-PPC render error:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return /*#__PURE__*/React.createElement("div", {
        dir: "rtl",
        style: {
          minHeight: "100vh",
          background: "#020617",
          color: "#e2e8f0",
          padding: "24px",
          fontFamily: "sans-serif"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          maxWidth: "700px",
          margin: "40px auto",
          background: "#7f1d1d33",
          border: "1px solid #b91c1c",
          borderRadius: "12px",
          padding: "24px"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: "20px",
          fontWeight: "bold",
          color: "#fca5a5",
          marginBottom: "8px"
        }
      }, __t("⚠️ حدث خطأ أثناء تشغيل التطبيق", "⚠️ An error occurred while running the application")), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: "13px",
          color: "#fecaca",
          marginBottom: "12px"
        }
      }, __t("هذا يمنع الموقع من العمل. التفاصيل التقنية أدناه — أرسلها للمساعدة في الإصلاح:", "This is preventing the site from working. The technical details are below — send them to get help with the fix:")), /*#__PURE__*/React.createElement("pre", {
        style: {
          background: "#0f172a",
          padding: "12px",
          borderRadius: "8px",
          fontSize: "11px",
          color: "#fca5a5",
          overflow: "auto",
          whiteSpace: "pre-wrap",
          direction: "ltr",
          textAlign: "left"
        }
      }, String(this.state.error?.stack || this.state.error?.message || this.state.error)), /*#__PURE__*/React.createElement("button", {
        onClick: () => window.location.reload(),
        style: {
          marginTop: "16px",
          background: "#2563eb",
          color: "white",
          border: "none",
          borderRadius: "8px",
          padding: "8px 16px",
          fontSize: "13px",
          cursor: "pointer"
        }
      }, __t("🔄 إعادة تحميل الصفحة", "🔄 Reload the page"))));
    }
    return this.props.children;
  }
}
try {
  const rootEl = document.getElementById('root');
  const root = ReactDOM.createRoot(rootEl);
  root.render( /*#__PURE__*/React.createElement(ErrorBoundary, null, /*#__PURE__*/React.createElement(Root, null)));
  document.getElementById('loading').style.display = 'none';
} catch (err) {
  console.error("CDT-PPC bootstrap error:", err);
  document.getElementById('loading').innerHTML = '<div style="max-width:600px"><div style="font-size:32px">⚠️</div>' + '<div style="color:#fca5a5;font-weight:bold;margin:8px 0">فشل تشغيل التطبيق</div>' + '<pre style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;font-size:11px;color:#fca5a5;white-space:pre-wrap;text-align:left;direction:ltr">' + String(err.stack || err.message || err) + '</pre>' + '<button onclick="if(confirm(\'مسح كل البيانات المحفوظة؟\')){Object.keys(localStorage).filter(k=>k.startsWith(\'cdt:\')).forEach(k=>localStorage.removeItem(k));location.reload();}" style="margin-top:10px;background:#b91c1c;color:white;border:none;border-radius:8px;padding:8px 16px;font-size:12px;cursor:pointer">🗑️ مسح البيانات المحفوظة وإعادة المحاولة</button></div>';
}
