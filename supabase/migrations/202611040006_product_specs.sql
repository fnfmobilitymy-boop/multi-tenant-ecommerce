-- 每件商品一个可售规格；每个规格分别创建商品，独立管理价格与库存。
alter table ezshop.products add column if not exists variant text not null default '';
do $$ begin
 if to_regprocedure('public.ezshop_delivery_api(text,jsonb)') is null then
  alter function public.ezshop_api(text,jsonb) rename to ezshop_delivery_api;
 end if;
end $$;
revoke all on function public.ezshop_delivery_api(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ezshop_api(route text,payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
#variable_conflict use_column
declare result jsonb;pid bigint;spec text;products jsonb;oid bigint;existed boolean:=false;
begin
 if route in ('products','products/update') and payload ? 'variant' then
  if jsonb_typeof(payload->'variant') is distinct from 'string' or length(payload->>'variant')>100 then raise exception '规格说明不能超过 100 字'; end if;
  spec:=trim(payload->>'variant');
 end if;
 if route='checkout' then
  -- 同一商家事务锁与既有结账/取消顺序保持一致；重试不能改变商品历史快照。
  select id into pid from ezshop.merchants where slug=payload->>'slug';
  if pid is not null then perform pg_advisory_xact_lock(pid); end if;
  existed:=exists(select 1 from ezshop.orders where merchant_id=pid and checkout_key=payload->>'checkout_key');
 end if;
 result:=public.ezshop_delivery_api(route,payload);
 if route in ('products','products/update') and spec is not null then
  if route='products' then pid:=currval(pg_get_serial_sequence('ezshop.products','id'));
  else pid:=(payload->>'id')::bigint;end if;
  -- 内层已完成身份、所属商家、角色及版本检查；任何失败均回滚整个事务。
  update ezshop.products set variant=spec where id=pid;
 end if;
 if route='store' then
  select coalesce(jsonb_agg(v.value||jsonb_build_object('variant',p.variant) order by v.ordinality),'[]'::jsonb) into products
   from jsonb_array_elements(result->'products') with ordinality v(value,ordinality) join ezshop.products p on p.id=(v.value->>'id')::bigint;
  result:=jsonb_set(result,'{products}',products);
 end if;
 if route='checkout' and not existed then
  select id into oid from ezshop.orders where reference=result->>'reference';
  update ezshop.order_items i set name=i.name||' · '||p.variant from ezshop.products p where i.order_id=oid and p.id=i.product_id and p.variant<>'';
 end if;
 return result;
end;
$$;
revoke all on function public.ezshop_api(text,jsonb) from public;
grant execute on function public.ezshop_api(text,jsonb) to anon,authenticated,service_role;
