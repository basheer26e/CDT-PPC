-- ⚠️ للقواعد القديمة فقط (قبل تعدد الخطط). قاعدة جديدة تُنشأ من 01_schema.sql ولا تحتاج هذا الملف.
-- 🛠️ أُصلح: min(id) لا تعمل على نوع uuid (كانت تفشل بالضبط عند وجود بيانات قديمة) فاستُبدلت بـ(array_agg(id))[1].
-- ═══════════════════════════════════════════════════════════════════
--  ترقية قاعدة البيانات لدعم "تعدد الخطط" (Multi-Plan) — CDT-PPC
-- ═══════════════════════════════════════════════════════════════════
--  المشكلة التي يحلّها هذا الملف:
--  الجداول bom_components و production_lines و scheduled_receipts كانت
--  مرتبطة بـ organization_id فقط — يعني "مجموعة واحدة مشتركة لكل المنظمة"،
--  بينما النظام محلياً الآن يدعم عدة خطط/منتجات لكل منظمة (كل خطة = منتج
--  مستقل بـBOM ومخزون وطاقة خاصة به). بدون هذا التعديل، أي كتابة راجعة
--  (write-back) للسحابة كانت راح "تخلط" بيانات كل الخطط ببعض بلا تمييز.
--
--  هذا الملف إضافي بالكامل (لا يحذف ولا يُعدّل أي بيانات موجودة فعلياً) —
--  آمن للتشغيل على قاعدة بيانات فيها بيانات حقيقية بالفعل. يُشغَّل مرة واحدة.
--
--  طريقة التشغيل: Supabase Dashboard → SQL Editor → الصقي المحتوى كاملاً → Run
-- ═══════════════════════════════════════════════════════════════════

-- 1) أضيفي عمود product_id لكل جدول كان "مشتركاً على مستوى المنظمة" فقط
--    (NULL مسموح مبدئياً حتى بعد خطوة الترحيل بالأسفل، ليست القيد صارماً بعد
--    لتفادي كسر أي كتابة قديمة لم تُحدَّث بعد لإرسال product_id)
ALTER TABLE bom_components      ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE production_lines    ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE scheduled_receipts  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE CASCADE;

-- 2) فهارس لتسريع أي استعلام يُصفّي بـ product_id (كل قراءة/كتابة راجعة ستفعل هذا دائماً)
CREATE INDEX IF NOT EXISTS idx_bom_components_product_id     ON bom_components(product_id);
CREATE INDEX IF NOT EXISTS idx_production_lines_product_id   ON production_lines(product_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_receipts_product_id ON scheduled_receipts(product_id);

-- ═══════════════════════════════════════════════════════════════════
--  3) ترحيل تلقائي للبيانات الموجودة فعلياً (لو عندك بيانات حقيقية مسبقاً)
--  يُصلح فقط الحالة الواضحة: منظمة عندها منتج واحد بالضبط فعلياً — يربط
--  كل صفوفها القديمة (product_id = NULL) بذاك المنتج الوحيد تلقائياً.
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE
  org RECORD;
  single_product_id uuid;
  product_count int;
BEGIN
  FOR org IN SELECT DISTINCT organization_id FROM bom_components WHERE product_id IS NULL
  LOOP
    SELECT count(*), (array_agg(id))[1] INTO product_count, single_product_id
      FROM products WHERE organization_id = org.organization_id;

    IF product_count = 1 THEN
      UPDATE bom_components     SET product_id = single_product_id WHERE organization_id = org.organization_id AND product_id IS NULL;
      UPDATE production_lines   SET product_id = single_product_id WHERE organization_id = org.organization_id AND product_id IS NULL;
      UPDATE scheduled_receipts SET product_id = single_product_id WHERE organization_id = org.organization_id AND product_id IS NULL;
      RAISE NOTICE 'رُحِّلت بيانات المنظمة % تلقائياً (منتج واحد فقط: %)', org.organization_id, single_product_id;
    ELSE
      RAISE NOTICE '⚠️ المنظمة % عندها % منتج/منتجات — لم تُرحَّل تلقائياً، تحتاج تحديد يدوي (شوفي الاستعلام بالأسفل)', org.organization_id, product_count;
    END IF;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════
--  4) استعلام تحقّق: شغّليه بعد الترحيل — يوريكِ أي صفوف بقيت بلا product_id
--  (يعني منظمات عندها أكثر من منتج ولازم تحديد يدوي أي صف يخص أي منتج)
-- ═══════════════════════════════════════════════════════════════════
-- SELECT organization_id, count(*) AS unmigrated_rows
-- FROM bom_components WHERE product_id IS NULL GROUP BY organization_id;

-- ═══════════════════════════════════════════════════════════════════
--  5) (اختياري — نفّذيه لاحقاً بعد التأكد أن كل الصفوف رُحِّلت بنجاح)
--  فرض القيد NOT NULL نهائياً، لمنع أي كتابة مستقبلية بلا product_id
-- ═══════════════════════════════════════════════════════════════════
-- ALTER TABLE bom_components      ALTER COLUMN product_id SET NOT NULL;
-- ALTER TABLE production_lines    ALTER COLUMN product_id SET NOT NULL;
-- ALTER TABLE scheduled_receipts  ALTER COLUMN product_id SET NOT NULL;

-- ═══════════════════════════════════════════════════════════════════
--  6) قيود تفرّد (Unique Constraints) — مطلوبة لعمليات upsert بكود الكتابة
--  الراجعة (كل مادة خام تُطابَق بمنتجها + مفتاحها المنطقي، لا بمعرّف الصف وحده)
-- ═══════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_bom_components_org_product_material') THEN
    ALTER TABLE bom_components ADD CONSTRAINT uq_bom_components_org_product_material UNIQUE (organization_id, product_id, material_key);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_production_lines_org_product') THEN
    ALTER TABLE production_lines ADD CONSTRAINT uq_production_lines_org_product UNIQUE (organization_id, product_id);
  END IF;
END $$;

-- ملاحظة أمان: سياسات RLS الحالية (المبنية على organization_id) تبقى تعمل كما هي
-- بلا أي تغيير — product_id يضيف تقسيماً داخل نفس حدود الأمان الموجودة، لا يغيّرها.

-- ═══════════════════════════════════════════════════════════════════
--  7) نطاق النسخة الأولى من الكتابة الراجعة (write-back) من التطبيق:
--  تشمل فقط: bom_components و production_lines (بيانات "أساسية" بلا دورة حياة معقّدة).
--  scheduled_receipts (طلبات الشراء SR) لم تُدرَج بعد بالكتابة الراجعة عمداً —
--  دورة حياتها (معلّق ← مؤكَّد/مُلغى) تحتاج تصميم مطابقة معرّفات أدق (id السحابة
--  مقابل id المحلي) لتفادي فقدان سجل أو تكراره، ولم أرد استعجال هذا الجزء بلا
--  قاعدة بيانات فعلية أتحقق عليها. تبقى طلبات الشراء محلية فقط حالياً حتى إشعار آخر.
-- ═══════════════════════════════════════════════════════════════════
