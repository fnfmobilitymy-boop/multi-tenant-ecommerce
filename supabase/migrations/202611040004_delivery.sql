-- 商家自行设置每单固定邮费和快递公司；仅记录人工寄件，不调用快递服务。
alter table ezshop.merchants add column if not exists shipping_fee bigint not null default 0 check(shipping_fee between 0 and 1000000);
alter table ezshop.merchants add column if not exists courier text not null default '';
alter table ezshop.orders add column if not exists subtotal bigint not null default 0;
alter table ezshop.orders add column if not exists state text not null default '';
alter table ezshop.orders add column if not exists postcode text not null default '';
alter table ezshop.orders add column if not exists city text not null default '';
alter table ezshop.orders add column if not exists fulfillment_status text not null default 'unfulfilled' check(fulfillment_status in ('unfulfilled','shipped'));
alter table ezshop.orders add column if not exists carrier text not null default '';
alter table ezshop.orders add column if not exists tracking text not null default '';
alter table ezshop.orders add column if not exists shipped_at timestamptz;
update ezshop.orders set subtotal=total-shipping+discount where subtotal=0 and total>0;
create or replace function ezshop.delivery_quote(mid bigint,items jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare item jsonb;p ezshop.products%rowtype;subtotal bigint:=0;fee bigint;qty int;
begin
 if jsonb_typeof(items) is distinct from 'array' then raise exception '请选择商品'; end if;
 if jsonb_array_length(items) not between 1 and 100 then raise exception '请选择商品'; end if;
 if (select count(*) from jsonb_array_elements(items))<>(select count(distinct v->>'id') from jsonb_array_elements(items) v) then raise exception '商品重复'; end if;
 for item in select value from jsonb_array_elements(items) loop
  if coalesce(item->>'id','') !~ '^[0-9]+$' or coalesce(item->>'quantity','') !~ '^[0-9]+$' then raise exception '商品或数量无效'; end if;
  qty:=(item->>'quantity')::int;
  select * into p from ezshop.products where id=(item->>'id')::bigint and merchant_id=mid and published=1;
  if not found or qty not between 1 and 1000 or p.stock<qty then raise exception '商品不存在或库存不足'; end if;
  subtotal:=subtotal+p.price*qty;
 end loop;
 select shipping_fee into fee from ezshop.merchants where id=mid and status='active';
 if not found then raise exception '店铺不存在'; end if;
 return jsonb_build_object('subtotal',subtotal,'shipping',fee,'discount',0,'total',subtotal+fee);
end;
$$;
revoke all on function ezshop.delivery_quote(bigint,jsonb) from public,anon,authenticated,service_role;
do $$ begin
 if to_regprocedure('public.ezshop_finance_api(text,jsonb)') is null then
  alter function public.ezshop_api(text,jsonb) rename to ezshop_finance_api;
 end if;
end $$;
revoke all on function public.ezshop_finance_api(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ezshop_api(route text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,ezshop as $$
#variable_conflict use_column
declare result jsonb;m ezshop.merchants%rowtype;o ezshop.orders%rowtype;fee bigint;v_courier text;v_state text;v_postcode text;v_city text;v_carrier text;v_tracking text;
begin
 if route='shipping-quote' then
  select * into m from ezshop.merchants where slug=payload->>'slug' and status='active';
  if not found then raise exception '店铺不存在'; end if;
  return ezshop.delivery_quote(m.id,payload->'items');
 end if;
 if route='checkout' then
  select * into m from ezshop.merchants where slug=payload->>'slug' and status='active' for share;
  if not found then raise exception '店铺不存在'; end if;
  -- 核心流程锁库存并核算商品金额；邮费不计入代理佣金。
  result:=public.ezshop_finance_api(route,payload);
  select * into o from ezshop.orders where reference=result->>'reference' and merchant_id=m.id for update;
  if o.subtotal>0 then return result; end if; -- 相同请求必须返回原订单，不能重算新邮费。
  v_state:=coalesce(payload->>'state','');v_postcode:=coalesce(payload->>'postcode','');v_city:=trim(coalesce(payload->>'city',''));
  if m.shipping_fee>0 or v_state<>'' or v_postcode<>'' or v_city<>'' then
   if v_state not in ('Johor','Kedah','Kelantan','Kuala Lumpur','Labuan','Melaka','Negeri Sembilan','Pahang','Penang','Perak','Perlis','Putrajaya','Sabah','Sarawak','Selangor','Terengganu') then raise exception '请选择马来西亚配送州属'; end if;
   if v_postcode !~ '^[0-9]{5}$' or length(v_city) not between 1 and 100 or coalesce(payload->>'country','MY')<>'MY' then raise exception '请填写有效的城市、5 位邮编及马来西亚收货地址'; end if;
  end if;
  update ezshop.orders set subtotal=o.total,shipping=m.shipping_fee,total=o.total+m.shipping_fee,state=v_state,postcode=v_postcode,city=v_city where id=o.id;
  return result||jsonb_build_object('subtotal',o.total,'shipping',m.shipping_fee,'total',o.total+m.shipping_fee);
 end if;
 if route='settings' then
  result:=public.ezshop_finance_api(route,payload); -- 复用所有者权限验证和现有资料校验。
  select * into m from ezshop.merchants where owner=auth.uid();
  if payload ? 'shipping_fee' and (jsonb_typeof(payload->'shipping_fee') is distinct from 'number' or coalesce(payload->>'shipping_fee','') !~ '^[0-9]+$') then raise exception '邮费须为整数 sen'; end if;
  fee:=coalesce((payload->>'shipping_fee')::bigint,m.shipping_fee);v_courier:=trim(coalesce(payload->>'courier',m.courier));
  if fee not between 0 and 1000000 or length(v_courier)>100 then raise exception '邮费或快递公司无效'; end if;
  update ezshop.merchants set shipping_fee=fee,courier=v_courier where id=m.id;
  return result;
 end if;
 if route='orders/ship' then
  result:=public.ezshop_finance_api('orders/detail',payload); -- 仅所有者/经理/订单客服，且锁定订单。
  select * into o from ezshop.orders where id=(payload->>'id')::bigint;
  v_carrier:=trim(coalesce(payload->>'carrier',''));v_tracking:=trim(coalesce(payload->>'tracking',''));
  if length(v_carrier) not between 1 and 100 or length(v_tracking) not between 1 and 100 then raise exception '请填写快递公司及实际运单号'; end if;
  if o.status<>'paid' then raise exception '仅已付款订单可以登记发货'; end if;
  if o.fulfillment_status='shipped' then
   if o.carrier=v_carrier and o.tracking=v_tracking then return jsonb_build_object('ok',true); end if;
   raise exception '此订单已登记发货，请核实原运单记录';
  end if;
  update ezshop.orders set fulfillment_status='shipped',carrier=v_carrier,tracking=v_tracking,shipped_at=now() where id=o.id;
  insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(o.merchant_id,auth.uid()::text,'order.ship',o.id);
  return jsonb_build_object('ok',true);
 end if;
 result:=public.ezshop_finance_api(route,payload);
 if route='order-result' then
  select * into o from ezshop.orders where reference=result->'order'->>'reference';
  return result||jsonb_build_object('order',(result->'order')||jsonb_build_object('subtotal',o.subtotal,'fulfillment_status',o.fulfillment_status,'carrier',o.carrier,'tracking',o.tracking,'shipped_at',o.shipped_at));
 end if;
 if route='mail/claim' and result is not null then
  select * into o from ezshop.orders where id=(result->>'order_id')::bigint;
  return result||jsonb_build_object('shipping',o.shipping,'subtotal',o.subtotal);
 end if;
 return result;
end;
$$;
revoke all on function public.ezshop_api(text,jsonb) from public;
grant execute on function public.ezshop_api(text,jsonb) to anon,authenticated,service_role;
