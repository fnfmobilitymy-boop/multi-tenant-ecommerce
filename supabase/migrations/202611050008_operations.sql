-- 只读部署检查。只公开结构能力，不公开商家/顾客资料或服务密钥。
create or replace function public.ezshop_release_status() returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare features jsonb;secured boolean;inner_locked boolean;
begin
 features:=jsonb_build_object(
  'storefront',to_regprocedure('public.ezshop_api(text,jsonb)') is not null,
  'payments',to_regprocedure('public.ezshop_payment_api(text,jsonb)') is not null,
  'shipping',exists(select 1 from information_schema.columns where table_schema='ezshop' and table_name='orders' and column_name='fulfillment_status'),
  'product_specs',exists(select 1 from information_schema.columns where table_schema='ezshop' and table_name='products' and column_name='variant'),
  'content_languages',exists(select 1 from information_schema.columns where table_schema='ezshop' and table_name='products' and column_name='content_translations') and to_regprocedure('public.ezshop_translation_access(text,integer)') is not null,
  'media',exists(select 1 from storage.buckets where id='ezshop-media' and public and file_size_limit=5242880),
  'notifications',to_regprocedure('public.ezshop_mail_api(text,jsonb)') is not null,
  'platform_billing',to_regprocedure('public.ezshop_platform_billing_api(text,jsonb)') is not null
 );
 select coalesce(bool_and(c.relrowsecurity),false) into secured from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='ezshop' and c.relkind='r';
 secured:=secured and not has_schema_privilege('anon','ezshop','USAGE') and not has_schema_privilege('authenticated','ezshop','USAGE');
 select coalesce(bool_and(not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')),false) into inner_locked from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('ezshop_core_api','ezshop_finance_api','ezshop_delivery_api','ezshop_specs_api','ezshop_content_api','ezshop_gateway_api');
 return jsonb_build_object('manifest_version',1,'features',features,'rls_enabled',secured,'internal_rpc_locked',inner_locked,'database_ready',secured and inner_locked and not exists(select 1 from jsonb_each(features) f where f.value<>'true'::jsonb),'production_verified',false);
end;
$$;
revoke all on function public.ezshop_release_status() from public;
grant execute on function public.ezshop_release_status() to anon,authenticated,service_role;
-- 已通过服务端角色检查的通知任务，按顾客选择语言读取成交快照。
create or replace function public.ezshop_mail_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
#variable_conflict use_column
declare result jsonb;language text;mid bigint;oid bigint;items jsonb;store_name text;
begin
 if route not in ('mail/claim','mail/finish','mail/reminders') then raise exception '不支持此通知操作';end if;
 result:=public.ezshop_api(route,payload);
 if route='mail/claim' and result is not null then
  oid:=(result->>'order_id')::bigint;
  select locale,merchant_id into language,mid from ezshop.orders where id=oid;
  select coalesce(nullif(content_translations->language->>'name',''),name) into store_name from ezshop.merchants where id=mid;
  select jsonb_agg(jsonb_build_object('name',case when nullif(content_translations->language->>'name','') is not null then (content_translations->language->>'name')||case when coalesce(content_translations->language->>'variant','')<>'' then ' · '||(content_translations->language->>'variant') else '' end else name end,'price',price,'quantity',quantity) order by id) into items from ezshop.order_items where order_id=oid;
  return result||jsonb_build_object('locale',language,'store_name',store_name,'items',items);
 end if;
 return result;
end;
$$;
revoke all on function public.ezshop_mail_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.ezshop_mail_api(text,jsonb) to service_role;
