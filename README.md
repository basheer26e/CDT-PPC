# Cognitive Digital Twin for Production Planning Using AI Agents

**التوأم الرقمي المعرفي لتخطيط الإنتاج باستخدام وكلاء الذكاء الاصطناعي** (CDT-PPC)

**🔗 جرّب النظام:** https://gleeful-klepon-4bb19d.netlify.app/

مشروع تخرج في الهندسة الصناعية ونظم التصنيع، جامعة تعز 2026، مطبّق على حالة دراسية لمصنع سمن.

## الفكرة: التحول الرقمي لتخطيط الإنتاج

التحول الرقمي هنا ليس شراء برنامج، بل نقل قرارات التخطيط من تقدير المخطط إلى نموذج رقمي متصل يمكن اختباره قبل التنفيذ:

- **نموذج واحد متصل:** الطلب الأسبوعي ثم الخطة الرئيسية (MPS) ثم احتياج المواد (MRP) مع الطاقة والورديات والصيانة والتكاليف.
- **استباق بدل رد الفعل:** تنبيهات «فات أوان الطلب»، وسيناريوهات «ماذا لو؟» مثل تعطل آلة أو تأخر مورد.
- **تقرير PDF** وواجهة بالعربية والإنجليزية.

## وكلاء الذكاء الاصطناعي

أربعة وكلاء متسلسلين، كل وكيل يبني على تحليل سابقه:

1. **وكيل MPS** يحلل خطة الإنتاج الرئيسية.
2. **وكيل MRP** يحلل المواد ومدد التوريد.
3. **وكيل الصيانة وFGI** يحلل الصيانة ومخزون المنتج النهائي.
4. **كبير المخططين** يقترح تحسينًا يُحاكى فعليًا ويُقارن بالخطة الأساسية.

كل وكيل يعرض بياناته وقواعده واستدلاله عبر «لماذا هذا القرار؟»، ولا يُستدعى إلا إذا كان محوره ينطبق على المصنع.

## كيف تبدأ؟

1. افتح الرابط أعلاه في المتصفح.
2. اضغط «المتابعة محلياً بدون تسجيل دخول».
3. أدخل بياناتك أو جرّب البيانات التجريبية.

البيانات تُحفظ في متصفحك فقط. ويمكنك تغيير إجابات أسئلة نوع التخطيط في أي وقت من تبويب «عن النظام» لترى أثرها على الخطة.

## فريق العمل

Basheer Hassan · Ahmed Al-Musannaf · Abduljaleel Abdullah · Safwan Fahd · Rawaa Al-Kamali

جامعة تعز — 2026 · Taiz University — 2026

## الحالة

نموذج أولي قيد التطوير: يعمل كاملاً في المتصفح، وربطه بقاعدة بيانات لعدة مصانع قيد العمل.

## ملاحظاتك

إن كنت مخطط إنتاج أو مهندس مصنع، فملاحظتك عن أي نقطة لا تشبه الواقع تفيدنا كثيراً. افتح [Issue](../../issues) أو راسلنا على LinkedIn.

---

**EN:** *Cognitive Digital Twin for Production Planning Using AI Agents* (CDT-PPC) is a graduation project in Industrial & Manufacturing Systems Engineering (Taiz University, 2026), applied to a ghee factory case study. It connects demand, MPS, MRP, capacity and maintenance in one digital model, flags material orders that are already too late, and runs what-if scenarios. Four chained AI agents (MPS, MRP, Maintenance + FGI, Chief planner) explain each decision, and the Chief planner's proposal is simulated and compared with the base plan. Try it: https://gleeful-klepon-4bb19d.netlify.app/ (choose "continue locally without login"; data stays in your browser). Team: Basheer Hassan, Ahmed Al-Musannaf, Abduljaleel Abdullah, Safwan Fahd, Rawaa Al-Kamali. Prototype — feedback from planners and plant engineers is very welcome.

Developer guide: [docs/DEVELOPER.md](docs/DEVELOPER.md)
