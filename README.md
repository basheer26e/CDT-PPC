# CDT-PPC — التوأم الرقمي المعرفي لتخطيط ومراقبة الإنتاج

**🔗 جرّب النظام:** https://basheer26e.github.io/CDT-PPC/

مشروع تخرج في الهندسة الصناعية ونظم التصنيع، مطبّق على حالة دراسية لمصنع سمن.

## ماذا يفعل؟

يحوّل الطلب الأسبوعي إلى خطة إنتاج رئيسية (MPS) ثم احتياج مواد (MRP)، ويساعد المخطط على:

- معرفة الأسابيع التي تكون فيها مدة التوريد أطول من الوقت المتبقي، أي «فات أوان الطلب».
- مراعاة الطاقة الإنتاجية وساعات الورديات والصيانة والتكاليف.
- تجربة سيناريوهات «ماذا لو؟» مثل تعطل آلة أو تأخر مورد قبل أن تحدث.
- الحصول على شرح للخطة من وكلاء ذكاء اصطناعي، وتصدير تقرير PDF.

الواجهة بالعربية والإنجليزية.

## كيف تبدأ؟

1. افتح الرابط أعلاه في المتصفح.
2. اضغط «المتابعة محلياً بدون تسجيل دخول».
3. أدخل بياناتك أو جرّب البيانات التجريبية.

البيانات تُحفظ في متصفحك فقط ولا تُرسل إلى أي خادم.

## الحالة

نموذج أولي قيد التطوير: يعمل كاملاً في المتصفح، وربطه بقاعدة بيانات لعدة مصانع قيد العمل.

## ملاحظاتك

إن كنت مخطط إنتاج أو مهندس مصنع، فملاحظتك عن أي نقطة لا تشبه الواقع تفيدني كثيراً. افتح [Issue](../../issues) أو راسلني على LinkedIn.

---

**EN:** CDT-PPC is a Cognitive Digital Twin for Production Planning & Control, a graduation project in Industrial & Manufacturing Systems Engineering applied to a ghee factory case study. It turns weekly demand into an MPS/MRP plan, flags material orders that are already too late, runs what-if scenarios, and explains the plan with AI agents. Try it: https://basheer26e.github.io/CDT-PPC/ (choose "continue locally without login"; data stays in your browser). Prototype — feedback from planners and plant engineers is very welcome.

Developer guide: [docs/DEVELOPER.md](docs/DEVELOPER.md)
