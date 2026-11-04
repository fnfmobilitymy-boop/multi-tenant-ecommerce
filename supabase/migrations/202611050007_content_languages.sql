-- 已应用 001–006 的项目仅执行本新增迁移；不重复运行旧迁移。
do $$begin
 if to_regprocedure('public.ezshop_delivery_api(text,jsonb)') is null or to_regclass('ezshop.merchant_payments') is null then raise exception '请先按顺序应用缺少的 005、006 迁移，不要重复已应用的迁移';end if;
end$$;
-- 公开商店内容的六语版本及成交快照。保留原字段，兼容旧客户端。
alter table ezshop.products add column if not exists content_translations jsonb not null default '{}'::jsonb;
alter table ezshop.merchants add column if not exists content_translations jsonb not null default '{}'::jsonb;
alter table ezshop.order_items add column if not exists content_translations jsonb not null default '{}'::jsonb;
alter table ezshop.orders add column if not exists locale text not null default 'zh' check(locale in ('zh','en','ms','th','km','vi'));
create or replace function ezshop.validate_content(value jsonb,kind text) returns void language plpgsql set search_path=pg_catalog as $$
declare entry record;field record;maximum int;
begin
 if jsonb_typeof(value) is distinct from 'object' or length(value::text)>50000 then raise exception '多语言内容格式无效';end if;
 for entry in select * from jsonb_each(value) loop
  if entry.key not in ('zh','en','ms','th','km','vi') or jsonb_typeof(entry.value) is distinct from 'object' then raise exception '多语言内容格式无效';end if;
  for field in select * from jsonb_each(entry.value) loop
   maximum:=case when field.key='name' then case when kind='store' then 80 else 120 end when field.key='description' then case when kind='store' then 500 else 2000 end when kind='product' and field.key='category' then 80 when kind='product' and field.key='variant' then 100 else null end;
   if maximum is null or jsonb_typeof(field.value) is distinct from 'string' or length(field.value#>>'{}')>maximum then raise exception '多语言内容格式无效';end if;
  end loop;
 end loop;
end;
$$;
revoke all on function ezshop.validate_content(jsonb,text) from public,anon,authenticated,service_role;
do $$begin
 if to_regprocedure('public.ezshop_specs_api(text,jsonb)') is null then alter function public.ezshop_api(text,jsonb) rename to ezshop_specs_api;end if;
end$$;
revoke all on function public.ezshop_specs_api(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ezshop_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
#variable_conflict use_column
declare result jsonb;mid bigint;pid bigint;oid bigint;existed boolean:=false;items jsonb;
begin
 if route in ('products','products/update','settings') and payload?'content_translations' then perform ezshop.validate_content(payload->'content_translations',case when route='settings' then 'store' else 'product' end);end if;
 if route='checkout' then
  if coalesce(payload->>'locale','zh') not in ('zh','en','ms','th','km','vi') then raise exception '语言无效';end if;
  select id into mid from ezshop.merchants where slug=payload->>'slug';
  if mid is not null then perform pg_advisory_xact_lock(mid);end if;
  existed:=exists(select 1 from ezshop.orders where merchant_id=mid and checkout_key=payload->>'checkout_key');
 end if;
 result:=public.ezshop_specs_api(route,payload);
 if route in ('products','products/update') and payload?'content_translations' then
  pid:=case when route='products' then currval(pg_get_serial_sequence('ezshop.products','id')) else (payload->>'id')::bigint end;
  update ezshop.products set content_translations=payload->'content_translations' where id=pid;
 end if;
 if route='settings' and payload?'content_translations' then update ezshop.merchants set content_translations=payload->'content_translations' where owner=auth.uid();end if;
 if route='store' then
  select coalesce(jsonb_agg(v.value||jsonb_build_object('content_translations',p.content_translations) order by v.ordinality),'[]'::jsonb) into items from jsonb_array_elements(result->'products') with ordinality v(value,ordinality) join ezshop.products p on p.id=(v.value->>'id')::bigint;
  result:=jsonb_set(result,'{products}',items);
  select id into mid from ezshop.merchants where slug=payload->>'slug';
  result:=jsonb_set(result,'{store,content_translations}',(select content_translations from ezshop.merchants where id=mid));
 end if;
 if route='checkout' and not existed then
  select id into oid from ezshop.orders where reference=result->>'reference';
  update ezshop.orders set locale=coalesce(payload->>'locale','zh') where id=oid;
  update ezshop.order_items i set content_translations=(select jsonb_object_agg(lang,jsonb_build_object('name',coalesce(nullif(trim(p.content_translations->lang->>'name'),''),p.name),'variant',coalesce(nullif(trim(p.content_translations->lang->>'variant'),''),p.variant))) from unnest(array['zh','en','ms','th','km','vi']) lang) from ezshop.products p where i.order_id=oid and p.id=i.product_id and p.content_translations<>'{}'::jsonb;
 end if;
 if route in ('order-result','orders/detail') then
  -- 内层已经验证订单凭证/商家权限；之后只返回公开内容快照。
  select id into oid from ezshop.orders where reference=result->'order'->>'reference';
  select coalesce(jsonb_agg(jsonb_build_object('name',name,'price',price,'quantity',quantity)||case when content_translations='{}'::jsonb then '{}'::jsonb else jsonb_build_object('content_translations',content_translations) end order by id),'[]'::jsonb) into items from ezshop.order_items where order_id=oid;
  result:=jsonb_set(result,'{items}',items);
 end if;
 return result;
end;
$$;
revoke all on function public.ezshop_api(text,jsonb) from public;
grant execute on function public.ezshop_api(text,jsonb) to anon,authenticated,service_role;
-- 只有所属商家获准的角色可以调用外部翻译；并发请求共享日用量上限。
create table if not exists ezshop.translation_usage(merchant_id bigint not null references ezshop.merchants(id),day date not null,requests int not null,characters int not null,primary key(merchant_id,day));
alter table ezshop.translation_usage enable row level security;
revoke all on ezshop.translation_usage from public,anon,authenticated,service_role;
create or replace function public.ezshop_translation_access(kind text,characters int) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare mid bigint;role_name text:='owner';used int;
begin
 if auth.uid() is null or kind not in ('store','product') or characters is null or characters not between 1 and 5000 then raise exception '需要有效的商家账号及翻译内容';end if;
 select id into mid from ezshop.merchants where owner=auth.uid() and status='active';
 if mid is null then
  select t.id,m.role into mid,role_name from ezshop.memberships m join ezshop.merchants t on t.id=m.merchant_id where m.user_id=auth.uid() and t.status='active';
 end if;
 if mid is null or role_name not in ('owner','manager','inventory') or (kind='store' and role_name<>'owner') then raise exception '当前角色没有此操作权限';end if;
 insert into ezshop.translation_usage values(mid,(now() at time zone 'UTC')::date,1,characters) on conflict(merchant_id,day) do update set requests=translation_usage.requests+1,characters=translation_usage.characters+excluded.characters where translation_usage.requests<200 and translation_usage.characters+excluded.characters<=60000 returning requests into used;
 if used is null then raise exception '今日翻译用量已达上限';end if;
 return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.ezshop_translation_access(text,int) from public;
grant execute on function public.ezshop_translation_access(text,int) to authenticated;
