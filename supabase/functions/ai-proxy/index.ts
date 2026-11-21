// ═══════════════════════════════════════════════════════════════════
//  ai-proxy — وسيط الذكاء الاصطناعي للوضع السحابي (Supabase Edge Function)
// ═══════════════════════════════════════════════════════════════════
//  التطبيق (index.html) يستدعيه هكذا:  supabase.functions.invoke("ai-proxy", { body: { prompt } })
//  ويتوقع الرد:  { text: "..." }  أو  { error: "..." }
//
//  ⚠️ لم يُختبر على مشروع Supabase حقيقي (لا يوجد وصول لمشروعك من بيئة الاختبار).
//     اختبريه بعد النشر بالخطوات في README (قسم «الوضع السحابي»).
//
//  الفائدة: مفتاح Gemini يبقى سرّاً على الخادم، والمستخدم لا يدخل أي مفتاح.
//  الحماية: verify_jwt مُفعَّل افتراضياً — لا يصل للدالة إلا مستخدم مسجّل دخوله بمشروعك.
//
//  النشر (من الطرفية، بعد تثبيت Supabase CLI):
//    supabase login
//    supabase link --project-ref <مشروعك>
//    supabase secrets set GEMINI_API_KEY=<مفتاحك>
//    supabase secrets set GEMINI_MODEL=<اسم نموذج متاح بحسابك>     # اختياري، الافتراضي أدناه
//    supabase functions deploy ai-proxy
// ═══════════════════════════════════════════════════════════════════

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_PROMPT_CHARS = 30000; // حد أعلى كي لا يستنزف مستخدم واحد حصة المفتاح بطلب ضخم
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ error: "الخادم غير مهيّأ: GEMINI_API_KEY غير مضبوط (supabase secrets set)" });

  let prompt = "";
  try { ({ prompt } = await req.json()); } catch { return json({ error: "جسم الطلب ليس JSON صالحاً" }, 400); }
  if (typeof prompt !== "string" || !prompt.trim()) return json({ error: "prompt فارغ" }, 400);
  if (prompt.length > MAX_PROMPT_CHARS) return json({ error: `الطلب أطول من الحد المسموح (${MAX_PROMPT_CHARS} حرف)` }, 400);

  const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.0-flash";
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!r.ok) return json({ error: `خطأ من Gemini (${r.status}) — تأكدي من GEMINI_MODEL والمفتاح` });
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? json({ text }) : json({ error: "Gemini لم يُرجع نصاً" });
  } catch (e) {
    return json({ error: `تعذّر الاتصال بـGemini: ${(e as Error).message}` });
  }
});
