-- 顾客身份使用 Auth；独立前端会话，不凭邮箱/电话公开查询订单。
alter table ezshop.orders add column if not exists customer_id uuid references auth.users(id);
create index if not exists orders_customer on ezshop.orders(customer_id,created desc);
create or replace function public.ezshop_customer_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare uid uuid:=auth.uid();email_address text;verified boolean;order_row ezshop.orders%rowtype;items jsonb;
begin
 if uid is null then raise exception '请先登录顾客账号。';end if;
 select lower(u.email),(to_jsonb(u)->>'email_confirmed_at') is not null into email_address,verified from auth.users u where u.id=uid;
 if not coalesce(verified,false) then raise exception '请先验证邮箱，再查看购买记录。';end if;
 if route='claim' then
  select o.* into order_row from ezshop.orders o join ezshop.merchants m on m.id=o.merchant_id where o.reference=payload->>'reference' and o.access_token=payload->>'token' and m.slug=payload->>'slug' for update of o;
  if not found then raise exception '订单无法关联，请核对凭证及账号邮箱。';end if;
  if order_row.customer_id=uid then return jsonb_build_object('ok',true);end if;
  if order_row.customer_id is not null or lower(order_row.email) is distinct from email_address then raise exception '订单无法关联，请核对凭证及账号邮箱。';end if;
  update ezshop.orders set customer_id=uid where id=order_row.id;
  return jsonb_build_object('ok',true);
 end if;
 if route<>'history' then raise exception '不支持此操作';end if;
 -- 统计覆盖全部本人订单；列表最多200笔，不能拿分页列表代替总数。
 select coalesce(jsonb_agg(x.body order by x.id desc),'[]'::jsonb) into items from (select o.id,jsonb_build_object('reference',o.reference,'status',o.status,'total',o.total,'created',o.created,'access_token',o.access_token,'store_name',m.name,'slug',m.slug,'quantity',(select coalesce(sum(i.quantity),0) from ezshop.order_items i where i.order_id=o.id)) body from ezshop.orders o join ezshop.merchants m on m.id=o.merchant_id where o.customer_id=uid and (coalesce(payload->>'slug','')='' or m.slug=payload->>'slug') order by o.id desc limit 200) x;
 return jsonb_build_object('orders',items,'summary',(select jsonb_build_object('order_count',count(*),'paid_total',coalesce(sum(o.total) filter(where o.status='paid'),0),'refunded_total',coalesce(sum(o.total) filter(where o.status='refunded'),0),'purchased_quantity',coalesce(sum((select sum(i.quantity) from ezshop.order_items i where i.order_id=o.id)) filter(where o.status='paid'),0),'pending_count',count(*) filter(where o.status='pending')) from ezshop.orders o join ezshop.merchants m on m.id=o.merchant_id where o.customer_id=uid and (coalesce(payload->>'slug','')='' or m.slug=payload->>'slug')));
end;
$$;
revoke all on function public.ezshop_customer_api(text,jsonb) from public,anon;
grant execute on function public.ezshop_customer_api(text,jsonb) to authenticated;
do $$begin if to_regprocedure('public.ezshop_receiving_api(text,jsonb)') is null then alter function public.ezshop_api(text,jsonb) rename to ezshop_receiving_api;end if;end$$;
revoke all on function public.ezshop_receiving_api(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ezshop_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare result jsonb;mid bigint;previous bigint;
begin
 if route='checkout' and auth.uid() is not null then
  select id into mid from ezshop.merchants where slug=payload->>'slug';
  if mid is not null then
   perform pg_advisory_xact_lock(mid);
   select id into previous from ezshop.orders where merchant_id=mid and checkout_key=payload->>'checkout_key';
  end if;
 end if;
 result:=public.ezshop_receiving_api(route,payload);
 if route='checkout' and auth.uid() is not null and previous is null and exists(select 1 from auth.users u where u.id=auth.uid() and to_jsonb(u)->>'email_confirmed_at' is not null) then
  update ezshop.orders set customer_id=auth.uid() where reference=result->>'reference' and access_token=result->>'access_token' and customer_id is null;
 end if;
 return result;
end;
$$;
revoke all on function public.ezshop_api(text,jsonb) from public;
grant execute on function public.ezshop_api(text,jsonb) to anon,authenticated,service_role;
