// يشغّل ملفات sql/ على Postgres حقيقي (PGlite) ويختبر العزل والصلاحيات والترحيل.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const SQL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const read = (f) => fs.readFileSync(path.join(SQL, f), 'utf8');
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';

const AUTH = `create schema auth; create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role authenticated nologin; create role anon nologin; grant usage on schema public, auth to authenticated, anon;`;

async function freshDb(schemaFile = '01_schema.sql') {
  const db = new PGlite();
  await db.exec(AUTH);
  await db.exec(read(schemaFile));
  await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated, anon; grant execute on all functions in schema public to authenticated, anon;`);
  await db.exec(`insert into auth.users(id,email) values ('${A}','a@a'),('${B}','b@b')`);
  const orgA = (await db.query(`insert into organizations(name) values ('A') returning id`)).rows[0].id;
  const orgB = (await db.query(`insert into organizations(name) values ('B') returning id`)).rows[0].id;
  await db.exec(`insert into profiles values ('${A}','${orgA}','A','admin'),('${B}','${orgB}','B','member')`);
  const pA = (await db.query(`insert into products(organization_id,name) values ('${orgA}','PA') returning id`)).rows[0].id;
  const pB = (await db.query(`insert into products(organization_id,name) values ('${orgB}','PB') returning id`)).rows[0].id;
  await db.exec(`insert into bom_components(organization_id,product_id,material_key,material_name) values ('${orgA}','${pA}','m1','MilkA'),('${orgB}','${pB}','m1','MilkB')`);
  return { db, orgA, orgB, pA, pB };
}
async function as(db, uid, sql) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${uid}', false);`);
  try { return await db.query(sql); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub','', false);`); }
}
const denied = async (p) => { try { const r = await p; return r.affectedRows === 0 || r.rows?.length === 0; } catch { return true; } };

test('المخطط يُنفَّذ على قاعدة فارغة', async () => { await freshDb(); });

test('عزل المصانع: كل مستخدم يرى بيانات مصنعه فقط', async () => {
  const { db, orgB, pB } = await freshDb();
  assert.deepEqual((await as(db, A, 'select material_name from bom_components')).rows.map(r => r.material_name), ['MilkA']);
  assert.equal((await as(db, A, `select * from products where id='${pB}'`)).rows.length, 0);
  assert.ok(await denied(as(db, A, `insert into products(organization_id,name) values ('${orgB}','HACK')`)), 'الإدخال بمصنع آخر مرفوض');
  assert.ok(await denied(as(db, A, `update bom_components set qty_per_unit=99 where organization_id='${orgB}'`)));
  assert.ok(await denied(as(db, A, `delete from bom_components where organization_id='${orgB}'`)));
  assert.equal((await as(db, '99999999-9999-9999-9999-999999999999', 'select * from products')).rows.length, 0, 'مستخدم بلا بروفايل لا يرى شيئاً');
  await db.exec('set role anon'); assert.equal((await db.query('select * from products')).rows.length, 0, 'anon لا يرى شيئاً'); await db.exec('reset role');
});

test('إغلاق الثغرة 1: المستخدم لا يعدّل بروفايله (لا ترقية ولا انتقال لمصنع آخر)', async () => {
  const { db, orgA } = await freshDb();
  assert.ok(await denied(as(db, B, `update profiles set role='admin' where id='${B}'`)), 'ترقية الدور مرفوضة');
  assert.ok(await denied(as(db, B, `update profiles set organization_id='${orgA}' where id='${B}'`)), 'الانتقال لمصنع آخر مرفوض');
  assert.equal((await as(db, B, 'select material_name from bom_components')).rows[0].material_name, 'MilkB', 'B ما زال يرى مصنعه');
});

test('إغلاق الثغرة 2: العضو لا يحذف المصنع (ولا cascade لبياناته)', async () => {
  const { db, orgB } = await freshDb();
  assert.ok(await denied(as(db, B, `delete from organizations where id='${orgB}'`)));
  assert.equal((await db.query(`select count(*)::int c from products where organization_id='${orgB}'`)).rows[0].c, 1);
  assert.ok(await denied(as(db, B, `update organizations set name='X' where id='${orgB}'`)));
});

test('القراءة المشروعة تعمل: بروفايلي ومصنعي', async () => {
  const { db } = await freshDb();
  assert.equal((await as(db, A, 'select * from profiles')).rows.length, 1);
  assert.equal((await as(db, A, 'select name from organizations')).rows[0].name, 'A');
});

test('upsert المزامنة يعمل بمفاتيح التفرّد', async () => {
  const { db, orgA, pA } = await freshDb();
  const r = await as(db, A, `insert into bom_components(organization_id,product_id,material_key,material_name,qty_per_unit) values ('${orgA}','${pA}','m1','MilkA2',3) on conflict (organization_id,product_id,material_key) do update set qty_per_unit=excluded.qty_per_unit returning qty_per_unit`);
  assert.equal(Number(r.rows[0].qty_per_unit), 3);
  const l = await as(db, A, `insert into production_lines(organization_id,product_id,units_per_hour) values ('${orgA}','${pA}',120) on conflict (organization_id,product_id) do update set units_per_hour=excluded.units_per_hour returning id`);
  assert.equal(l.rows.length, 1);
});

test('قالب «إضافة مصنع جديد» يعمل ويُنشئ admin', async () => {
  const { db } = await freshDb();
  const lines = read('01_schema.sql').split('\n');
  const a = lines.findIndex(l => l.startsWith('-- do $$')), b = lines.findIndex((l, i) => i > a && l.startsWith('-- end $$;'));
  const C = '33333333-3333-3333-3333-333333333333';
  await db.exec(`insert into auth.users(id,email) values ('${C}','c@c')`);
  await db.exec(lines.slice(a, b + 1).map(l => l.replace(/^-- ?/, '')).join('\n')
    .replace("'ألصق-User-UID-من-خطوة-أ-هنا'", `'${C}'`).replace("'اسم المصنع هنا'", "'Factory C'").replace("'الاسم الكامل للمسؤول'", "'C Admin'"));
  const r = (await db.query(`select p.role, o.name from profiles p join organizations o on o.id=p.organization_id where p.id='${C}'`)).rows[0];
  assert.deepEqual({ ...r }, { role: 'admin', name: 'Factory C' });
});

async function legacyDb() {
  const db = new PGlite();
  await db.exec(AUTH.split('create role')[0]);
  await db.exec(`
    create table organizations(id uuid primary key default gen_random_uuid(), name text not null);
    create table products(id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id), name text not null);
    create table bom_components(id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id), material_key text, material_name text, qty_per_unit numeric default 0);
    create table production_lines(id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id), units_per_hour numeric default 0, shift_hours numeric default 8);
    create table scheduled_receipts(id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id), qty numeric default 0);
    insert into organizations(id,name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Org1'),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Org2');
    insert into products(organization_id,name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','P1'),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','P2a'),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','P2b');
    insert into bom_components(organization_id,material_key,material_name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','m1','Milk'),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','m1','Milk2');
    insert into production_lines(organization_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');`);
  return db;
}
test('الترحيل يعمل على قاعدة قديمة ببيانات (كان يفشل بـmin(uuid))', async () => {
  const db = await legacyDb();
  await db.exec(read('02_migration_multiplan.sql'));
  const c = async (q) => (await db.query(q)).rows[0].c;
  assert.equal(await c(`select count(*)::int c from bom_components where organization_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and product_id is not null`), 1, 'منظمة بمنتج واحد رُحّلت');
  assert.equal(await c(`select count(*)::int c from bom_components where organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and product_id is null`), 1, 'منظمة بمنتجين تُترك للترحيل اليدوي');
  await db.exec(read('02_migration_multiplan.sql')); // إعادة التشغيل آمنة
});

const OLD_POLICIES = `
  drop policy if exists "own_profile_read" on profiles; drop policy if exists "org_read" on organizations;
  drop policy if exists "products_select" on products; drop policy if exists "products_insert" on products; drop policy if exists "products_update" on products; drop policy if exists "products_delete" on products;
  drop policy if exists "bom_select" on bom_components; drop policy if exists "bom_insert" on bom_components; drop policy if exists "bom_update" on bom_components; drop policy if exists "bom_delete" on bom_components;
  drop policy if exists "lines_select" on production_lines; drop policy if exists "lines_insert" on production_lines; drop policy if exists "lines_update" on production_lines; drop policy if exists "lines_delete" on production_lines;
  drop policy if exists "receipts_select" on scheduled_receipts; drop policy if exists "receipts_insert" on scheduled_receipts; drop policy if exists "receipts_update" on scheduled_receipts; drop policy if exists "receipts_delete" on scheduled_receipts;
  create policy "own_profile_only" on profiles for all using (id = auth.uid()) with check (id = auth.uid());
  create policy "org_isolation" on organizations for all using (id = get_my_organization_id()) with check (id = get_my_organization_id());
  create policy "org_isolation" on products for all using (organization_id = get_my_organization_id()) with check (organization_id = get_my_organization_id());
  create policy "org_isolation" on bom_components for all using (organization_id = get_my_organization_id()) with check (organization_id = get_my_organization_id());
  create policy "org_isolation" on production_lines for all using (organization_id = get_my_organization_id()) with check (organization_id = get_my_organization_id());
  create policy "org_isolation" on scheduled_receipts for all using (organization_id = get_my_organization_id()) with check (organization_id = get_my_organization_id());`;

test('الأدوار: member يقرأ ويُدخل/يعدّل بيانات تشغيلية، لكن لا يحذف ولا يُنشئ منتجات', async () => {
  const { db, orgB, pB } = await freshDb();
  assert.equal((await as(db, B, 'select * from products')).rows.length, 1, 'القراءة مسموحة');
  const ins = await as(db, B, `insert into bom_components(organization_id,product_id,material_key,material_name,qty_per_unit) values ('${orgB}','${pB}','m2','Cream',1) returning id`);
  assert.equal(ins.rows.length, 1, 'member يضيف مادة');
  const up = await as(db, B, `update bom_components set qty_per_unit = 5 where organization_id='${orgB}' and material_key='m2' returning qty_per_unit`);
  assert.equal(Number(up.rows[0].qty_per_unit), 5, 'member يعدّل مادة');
  const ups = await as(db, B, `insert into production_lines(organization_id,product_id,units_per_hour) values ('${orgB}','${pB}',100) on conflict (organization_id,product_id) do update set units_per_hour=excluded.units_per_hour returning units_per_hour`);
  assert.equal(Number(ups.rows[0].units_per_hour), 100, 'member يكتب خط الإنتاج');
  assert.ok(await denied(as(db, B, `delete from bom_components where organization_id='${orgB}'`)), 'member لا يحذف مواداً');
  assert.ok(await denied(as(db, B, `delete from production_lines where organization_id='${orgB}'`)), 'member لا يحذف خطوطاً');
  assert.ok(await denied(as(db, B, `delete from products where organization_id='${orgB}'`)), 'member لا يحذف منتجات');
  assert.ok(await denied(as(db, B, `insert into products(organization_id,name) values ('${orgB}','NewByMember')`)), 'member لا يُنشئ منتجاً');
  assert.ok(await denied(as(db, B, `update products set name='X' where id='${pB}'`)), 'member لا يعدّل منتجاً');
  assert.equal((await db.query(`select count(*)::int c from bom_components where organization_id='${orgB}'`)).rows[0].c, 2, 'لا شيء حُذف');
});

test('الأدوار: admin يملك كتابة وحذفاً كاملين على مصنعه فقط', async () => {
  const { db, orgA, orgB, pA } = await freshDb();
  const np = await as(db, A, `insert into products(organization_id,name) values ('${orgA}','P-new') returning id`);
  assert.equal(np.rows.length, 1, 'admin يُنشئ منتجاً');
  assert.equal((await as(db, A, `update products set name='P-renamed' where id='${np.rows[0].id}' returning name`)).rows[0].name, 'P-renamed');
  assert.equal((await as(db, A, `delete from bom_components where organization_id='${orgA}' returning id`)).rows.length, 1, 'admin يحذف مواد مصنعه');
  assert.equal((await as(db, A, `delete from products where id='${np.rows[0].id}' returning id`)).rows.length, 1, 'admin يحذف منتجاً');
  assert.ok(await denied(as(db, A, `delete from products where organization_id='${orgB}'`)), 'admin مصنع A لا يحذف منتجات B');
  assert.ok(await denied(as(db, A, `insert into products(organization_id,name) values ('${orgB}','X')`)), 'admin A لا يُنشئ منتجاً داخل B');
});

test('لا يمكن ربط صف بمنتج أو مادة من مصنع آخر', async () => {
  const { db, orgA, orgB, pA, pB } = await freshDb();
  // مستخدم B (member) يحاول إدخال مادة بمصنعه لكن بمنتج من مصنع A
  assert.ok(await denied(as(db, B, `insert into bom_components(organization_id,product_id,material_key,material_name) values ('${orgB}','${pA}','x','Cross')`)), 'bom → منتج مصنع آخر مرفوض');
  assert.ok(await denied(as(db, B, `insert into production_lines(organization_id,product_id,units_per_hour) values ('${orgB}','${pA}',1)`)), 'خط → منتج مصنع آخر مرفوض');
  const foreignMat = (await db.query(`select id from bom_components where organization_id='${orgA}'`)).rows[0].id;
  assert.ok(await denied(as(db, B, `insert into scheduled_receipts(organization_id,product_id,material_id,qty) values ('${orgB}','${pB}','${foreignMat}',5)`)), 'استلام → مادة مصنع آخر مرفوض');
  // وعدم نقل صف موجود لمنتج مصنع آخر بالتحديث
  assert.ok(await denied(as(db, B, `update bom_components set product_id='${pA}' where organization_id='${orgB}'`)), 'تحديث product_id لمنتج مصنع آخر مرفوض');
  // الحالة المشروعة تعمل
  const own = (await db.query(`select id from bom_components where organization_id='${orgB}'`)).rows[0].id;
  const ok = await as(db, B, `insert into scheduled_receipts(organization_id,product_id,material_id,qty) values ('${orgB}','${pB}','${own}',5) returning id`);
  assert.equal(ok.rows.length, 1, 'استلام بمادة مصنعه مقبول');
});

test('قيد التفرّد يحمي صفوف product_id = NULL من التكرار (والـupsert يعمل عليها)', async () => {
  const { db, orgA } = await freshDb();
  const q = `insert into bom_components(organization_id,product_id,material_key,material_name,qty_per_unit) values ('${orgA}',null,'x','N',%QTY%) on conflict (organization_id,product_id,material_key) do update set qty_per_unit=excluded.qty_per_unit`;
  await as(db, A, q.replace('%QTY%', '1')); await as(db, A, q.replace('%QTY%', '2'));
  const r = (await db.query(`select qty_per_unit from bom_components where organization_id='${orgA}' and material_key='x'`)).rows;
  assert.equal(r.length, 1, 'صف واحد فقط'); assert.equal(Number(r[0].qty_per_unit), 2, 'القيمة حُدِّثت');
});

test('سكربت الترقية 03: يحصّن قاعدة بالسياسات القديمة المفتوحة كلها، وآمن لإعادة التشغيل', async () => {
  const { db, orgA, orgB, pA } = await freshDb();
  await db.exec(OLD_POLICIES);
  // الحالة القديمة: كل الثغرات مفتوحة
  await as(db, B, `update profiles set role='admin' where id='${B}'`);
  assert.equal((await db.query(`select role from profiles where id='${B}'`)).rows[0].role, 'admin', 'الثغرة موجودة قبل الترقية (ترقية الدور)');
  await db.exec(`update profiles set role='member' where id='${B}'`);
  await as(db, B, `update profiles set organization_id='${orgA}' where id='${B}'`);
  assert.equal((await as(db, B, 'select material_name from bom_components')).rows[0]?.material_name, 'MilkA', 'الثغرة موجودة قبل الترقية (الانتقال لمصنع آخر)');
  await db.exec(`update profiles set organization_id='${orgB}' where id='${B}'`);
  await db.exec(read('03_security_hardening.sql')); await db.exec(read('03_security_hardening.sql'));
  assert.ok(await denied(as(db, B, `update profiles set role='admin' where id='${B}'`)), 'ترقية الدور مغلقة');
  assert.ok(await denied(as(db, B, `update profiles set organization_id='${orgA}' where id='${B}'`)), 'الانتقال لمصنع آخر مغلق');
  assert.ok(await denied(as(db, B, `delete from organizations where id='${orgB}'`)), 'حذف المصنع مغلق');
  assert.ok(await denied(as(db, B, `delete from products where organization_id='${orgB}'`)), 'member لا يحذف منتجات بعد الترقية');
  assert.ok(await denied(as(db, B, `insert into bom_components(organization_id,product_id,material_key,material_name) values ('${orgB}','${pA}','x','Cross')`)), 'الربط عبر المصانع مغلق');
  assert.equal((await as(db, A, 'select count(*)::int c from products')).rows[0].c, 1, 'admin A ما زال يقرأ');
});
