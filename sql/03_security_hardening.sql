-- ═══════════════════════════════════════════════════════════════════
--  ترقية صلاحيات قاعدة موجودة أصلاً إلى النسخة المحصَّنة (شغّله مرة واحدة من SQL Editor)
--  قاعدة جديدة من 01_schema.sql لا تحتاجه — مُطبَّق فيها أصلاً. آمن لإعادة التشغيل (idempotent).
-- ═══════════════════════════════════════════════════════════════════
--  ما يغلقه (أُثبتت الثغرات الأولى باختبار فعلي على Postgres قبل الإغلاق):
--   1) profiles كانت "for all": المستخدم يعدّل organization_id بنفسه فينضم لمصنع آخر ويقرأ بياناته، أو يرفع role إلى admin.
--   2) organizations كانت "for all": أي عضو يحذف مصنعه، والـcascade يحذف كل بياناته.
--   3) الدور (admin/member) كان مخزَّناً بلا أثر: الآن admin = كتابة وحذف كاملان؛ member = إضافة/تعديل بيانات تشغيلية فقط.
--   4) كان ممكناً ربط صف بمنتج/مادة من مصنع آخر عبر product_id/material_id؛ الآن يُرفض.
--  إنشاء/تعديل المصانع والبروفايلات يتم من SQL Editor فقط (دور postgres يتجاوز RLS).

-- هل المستخدم الحالي admin بمصنعه؟ (security definer لنفس سبب الدالة السابقة: قراءة profiles من داخل سياسة)
create or replace function is_org_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select role = 'admin' from profiles where id = auth.uid()), false)
$$;

drop policy if exists "own_profile_only" on profiles;
drop policy if exists "own_profile_read" on profiles;
drop policy if exists "org_isolation" on organizations;
drop policy if exists "org_read" on organizations;
drop policy if exists "org_isolation" on products;
drop policy if exists "products_select" on products;
drop policy if exists "products_insert" on products;
drop policy if exists "products_update" on products;
drop policy if exists "products_delete" on products;
drop policy if exists "org_isolation" on bom_components;
drop policy if exists "bom_select" on bom_components;
drop policy if exists "bom_insert" on bom_components;
drop policy if exists "bom_update" on bom_components;
drop policy if exists "bom_delete" on bom_components;
drop policy if exists "org_isolation" on production_lines;
drop policy if exists "lines_select" on production_lines;
drop policy if exists "lines_insert" on production_lines;
drop policy if exists "lines_update" on production_lines;
drop policy if exists "lines_delete" on production_lines;
drop policy if exists "org_isolation" on scheduled_receipts;
drop policy if exists "receipts_select" on scheduled_receipts;
drop policy if exists "receipts_insert" on scheduled_receipts;
drop policy if exists "receipts_update" on scheduled_receipts;
drop policy if exists "receipts_delete" on scheduled_receipts;

create policy "own_profile_read" on profiles
  for select using (id = auth.uid());
create policy "org_read" on organizations
  for select using (id = get_my_organization_id());

-- ── الجداول التشغيلية: صلاحيات حسب الدور (تُفرَض هنا بقاعدة البيانات لا بالواجهة) ──
--   القراءة: كل أعضاء المصنع.
--   admin  : كتابة وحذف كاملان.
--   member : إضافة وتعديل البيانات التشغيلية (BOM، المخزون، خط الإنتاج، الواردات) فقط — لا حذف، ولا إنشاء/تعديل/حذف المنتجات.
--   with check يمنع أيضاً ربط صف بمنتج/مادة من مصنع آخر (exists يُقيَّم تحت RLS فلا يرى إلا منتجات مصنعه).

create policy "products_select" on products for select using (organization_id = get_my_organization_id());
create policy "products_insert" on products for insert with check (organization_id = get_my_organization_id() and is_org_admin());
create policy "products_update" on products for update using (organization_id = get_my_organization_id() and is_org_admin())
                                                       with check (organization_id = get_my_organization_id() and is_org_admin());
create policy "products_delete" on products for delete using (organization_id = get_my_organization_id() and is_org_admin());

create policy "bom_select" on bom_components for select using (organization_id = get_my_organization_id());
create policy "bom_insert" on bom_components for insert with check (organization_id = get_my_organization_id()
  and (product_id is null or exists (select 1 from products p where p.id = product_id)));
create policy "bom_update" on bom_components for update using (organization_id = get_my_organization_id())
  with check (organization_id = get_my_organization_id() and (product_id is null or exists (select 1 from products p where p.id = product_id)));
create policy "bom_delete" on bom_components for delete using (organization_id = get_my_organization_id() and is_org_admin());

create policy "lines_select" on production_lines for select using (organization_id = get_my_organization_id());
create policy "lines_insert" on production_lines for insert with check (organization_id = get_my_organization_id()
  and (product_id is null or exists (select 1 from products p where p.id = product_id)));
create policy "lines_update" on production_lines for update using (organization_id = get_my_organization_id())
  with check (organization_id = get_my_organization_id() and (product_id is null or exists (select 1 from products p where p.id = product_id)));
create policy "lines_delete" on production_lines for delete using (organization_id = get_my_organization_id() and is_org_admin());

create policy "receipts_select" on scheduled_receipts for select using (organization_id = get_my_organization_id());
create policy "receipts_insert" on scheduled_receipts for insert with check (organization_id = get_my_organization_id()
  and (product_id is null or exists (select 1 from products p where p.id = product_id))
  and (material_id is null or exists (select 1 from bom_components b where b.id = material_id)));
create policy "receipts_update" on scheduled_receipts for update using (organization_id = get_my_organization_id())
  with check (organization_id = get_my_organization_id()
  and (product_id is null or exists (select 1 from products p where p.id = product_id))
  and (material_id is null or exists (select 1 from bom_components b where b.id = material_id)));
create policy "receipts_delete" on scheduled_receipts for delete using (organization_id = get_my_organization_id() and is_org_admin());

-- (اختياري) منع تكرار صفوف product_id = NULL بقاعدة قديمة: يتطلب PostgreSQL 15+ وخلوّ البيانات من تكرارات.
-- راجع أسماء القيود الحالية أولاً:  select conname from pg_constraint where conrelid = 'bom_components'::regclass and contype = 'u';
--   alter table bom_components drop constraint <اسم_القيد_القديم>;
--   alter table bom_components add constraint bom_components_org_product_material_key unique nulls not distinct (organization_id, product_id, material_key);
--   (وبالمثل production_lines على (organization_id, product_id))
