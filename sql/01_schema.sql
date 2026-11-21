-- ═══════════════════════════════════════════════════════════════════
--  CDT-PPC — بناء قاعدة البيانات من الصفر (Multi-Tenant, RLS)
-- ═══════════════════════════════════════════════════════════════════
--  ⚠️ نسخة محدَّثة (انظري docs/TEST_REPORT.md): organizations وprofiles قراءة فقط للمستخدمين، والدور admin/member مُفعَّل فعلياً
--     بسياسات RLS، ولا يمكن ربط صف بمنتج/مادة من مصنع آخر، وقيود التفرّد تحمي صفوف product_id = NULL.
--  هذا الملف يبني الأساس الكامل: 6 جداول + عزل أمني صارم بين المصانع
--  (RLS) + قالب لإضافة مصنع جديد يدوياً. اقرئي التعليقات — كل قرار أمني
--  مذكور صراحة ليش اتّخذته، لأنه ما فيه قاعدة بيانات حقيقية اختبرته عليها.
--
--  طريقة التشغيل: Supabase Dashboard (مشروعك) → SQL Editor → الصقي
--  المحتوى كاملاً → Run. يُشغَّل مرة واحدة على مشروع فاضٍ تماماً.
-- ═══════════════════════════════════════════════════════════════════


-- ═══ 1) الجداول ═══════════════════════════════════════════════════

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- تربط حساب تسجيل الدخول (auth.users من Supabase Auth) بمصنع ودور —
-- id هنا نفسه معرّف المستخدم بـauth.users (علاقة 1:1، هذا النمط القياسي بـSupabase)
create table profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  organization_id  uuid not null references organizations(id) on delete cascade,
  full_name        text,
  role             text not null default 'member' check (role in ('admin', 'member')),
  created_at       timestamptz not null default now()
);

create table products (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  name             text not null,
  created_at       timestamptz not null default now()
);

create table bom_components (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  product_id        uuid references products(id) on delete cascade,
  material_key      text not null,          -- المعرّف المحلي بالتطبيق (mat_xxxxx) — يُستخدم للمطابقة عند المزامنة
  material_name     text not null,
  qty_per_unit      numeric not null default 0,
  unit              text not null default 'kg',
  available         numeric not null default 0,
  safety_stock      numeric not null default 0,
  lead_time_weeks   numeric not null default 3,
  max_capacity      numeric,
  updated_at        timestamptz not null default now(),
  unique nulls not distinct (organization_id, product_id, material_key)   -- يلزم لـupsert المزامنة؛ nulls not distinct (PG15+) كي لا تتكرر صفوف product_id = NULL
);

create table production_lines (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  product_id        uuid references products(id) on delete cascade,
  units_per_hour    numeric not null default 0,
  shift_hours       numeric not null default 8,
  updated_at        timestamptz not null default now(),
  unique nulls not distinct (organization_id, product_id)   -- سطر واحد بالطاقة لكل منتج حالياً
);

create table scheduled_receipts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  product_id       uuid references products(id) on delete cascade,
  material_id      uuid references bom_components(id) on delete cascade,
  qty              numeric not null default 0,
  confirmed_on     date,
  arrival_date     date,
  status           text not null default 'pending' check (status in ('pending', 'received', 'cancelled')),
  created_at       timestamptz not null default now()
);
-- ملاحظة: هذا الجدول موجود بالمخطط لكن التطبيق لا يكتب له سحابياً بعد
-- (طلبات الشراء SR محلية فقط حالياً — القراءة فقط جاهزة، الكتابة الراجعة لسا لأ، بقرار متعمّد)

create index idx_bom_components_product_id     on bom_components(product_id);
create index idx_production_lines_product_id   on production_lines(product_id);
create index idx_scheduled_receipts_product_id on scheduled_receipts(product_id);
create index idx_products_org_id               on products(organization_id);


-- ═══ 2) دالة مساعدة: "شنو مصنعي أنا؟" ═══════════════════════════════
-- security definer عمداً: تتجاوز RLS بجدول profiles نفسه وقت قراءتها لمنظمة
-- المستخدم — لو ما فعلنا هذا، أي policy على profiles تستخدم هذي الدالة تدخل
-- بحلقة دائرية (تحتاج تقرأ profiles لتعرف الصلاحية، والصلاحية تحتاج نفس القراءة).
-- هذا النمط موثّق رسمياً من Supabase نفسها لبالضبط هذي الحالة.
-- set search_path صراحة: حماية قياسية موصى بها لأي دالة security definer
-- (يمنع هجوم استبدال دالة عبر التلاعب بمسار البحث).
create or replace function get_my_organization_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select organization_id from profiles where id = auth.uid()
$$;

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


-- ═══ 3) تفعيل RLS + سياسة عزل واحدة موحّدة لكل جدول ═══════════════
-- المبدأ: "تقدرين تشوفين/تعدّلين فقط صفوفاً تخص organization_id تبعك"، والكتابة مقيَّدة بالدور (انظري تعليق الجداول التشغيلية أدناه).

alter table organizations       enable row level security;
alter table profiles            enable row level security;
alter table products            enable row level security;
alter table bom_components      enable row level security;
alter table production_lines    enable row level security;
alter table scheduled_receipts  enable row level security;

-- 🔒 قراءة فقط: لو سمحنا بالكتابة، أي عضو يقدر يحذف مصنعه كاملاً (cascade يحذف كل بياناته) أو يعدّل اسمه.
-- إنشاء/تعديل المصانع يتم فقط من SQL Editor (دور postgres يتجاوز RLS) — وهذا مقصود بهذه المرحلة.
create policy "org_read" on organizations
  for select using (id = get_my_organization_id());

-- profiles حالة خاصة: كل مستخدم يشوف "بروفايله هو" فقط (التطبيق ما يحتاج غير هذا حالياً —
-- fetchOrgData يقرأ .eq("id", userId) فقط، ما يحتاج يشوف بروفايلات زملاء بنفس المصنع)
-- 🔒 قراءة فقط: لو سمحنا بالتعديل، أي مستخدم يقدر يغيّر organization_id بنفسه (ينضم لمصنع آخر ويقرأ بياناته)
-- أو يرفع نفسه إلى admin — لأن with check (id = auth.uid()) لا يقيّد الأعمدة. (اختُبر فعلياً قبل الإغلاق)
create policy "own_profile_read" on profiles
  for select using (id = auth.uid());

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


-- ═══════════════════════════════════════════════════════════════════
--  4) قالب: إضافة مصنع جديد يدوياً (تشغّلينه أنتِ بنفسك لكل عميل/مصنع جديد
--  — ليس تسجيلاً ذاتياً عاماً بعد، هذا مقصود بهذي المرحلة)
-- ═══════════════════════════════════════════════════════════════════
--  الخطوات:
--  أ) أنشئي حساب المستخدم أولاً من: Authentication → Users → Add User
--     (بريد إلكتروني + كلمة مرور) وانسخي الـUser UID الظاهر بعد إنشائه.
--  ب) عدّلي القيم بالأسطر الثلاثة أدناه (اسم المصنع، الـUser UID، الاسم الكامل)
--  ج) شغّلي الكتلة كاملة

-- do $$
-- declare
--   new_org_id uuid;
--   the_user_id uuid := 'ألصقي-User-UID-من-خطوة-أ-هنا';
--   org_name text := 'اسم المصنع هنا';
--   admin_name text := 'الاسم الكامل للمسؤول';
-- begin
--   insert into organizations (name) values (org_name) returning id into new_org_id;
--   insert into profiles (id, organization_id, full_name, role)
--     values (the_user_id, new_org_id, admin_name, 'admin');
--   raise notice 'تم إنشاء المصنع % بمعرّف %', org_name, new_org_id;
-- end $$;


-- ═══════════════════════════════════════════════════════════════════
--  5) خطوات تحقّق أنصحك تسوّينها بنفسك قبل أي استخدام حقيقي (لا بديل عنها)
-- ═══════════════════════════════════════════════════════════════════
--  1. أنشئي مصنعين وهميين بالقالب أعلاه (مصنع أ ومصنع ب، كل واحد بمستخدم مختلف)
--  2. أضيفي بالتطبيق نفسه BOM لمصنع أ وشغّلي مزامنة — تأكدي يظهر بجدول bom_components
--  3. سجّلي خروج، وادخلي بحساب مصنع ب — تأكدي ما تشوفين أي بيانات لمصنع أ إطلاقاً
--     (لا بالتطبيق، ولا حتى لو جرّبتِ استعلام مباشر بـSQL Editor وأنتِ "متنكّرة"
--      بدور anon key — استخدمي RLS testing بلوحة Supabase للتأكد الحقيقي)
--  4. جرّبي بـSQL Editor: select * from bom_components; وأنتِ مسجّلة كـpostgres admin
--     (هذا يتجاوز RLS ويوريكِ كل البيانات — طبيعي، هذا وضع المشرف، مو ثغرة)
