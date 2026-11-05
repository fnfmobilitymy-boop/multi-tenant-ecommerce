-- 平台只读业务明细。独立 RPC，不冒充商家身份、不调用商家写入接口。
-- 仅可信数据库授予且当前 active 的 owner/is_admin 可访问；不受目标商家订阅或暂停状态限制。
create or replace function ezshop.platform_book_summary(mid bigint) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,ezshop as $$
declare summary jsonb;lo date;hi date;
begin
 with events as (
  select e.*,coalesce(o.commission,0) commission,coalesce(o.stock_returned,false) returned,
   coalesce((select sum(i.unit_cost*i.quantity) from ezshop.order_items i where i.order_id=e.order_id),0) cost,
   (not exists(select 1 from ezshop.order_items i where i.order_id=e.order_id) or exists(select 1 from ezshop.order_items i where i.order_id=e.order_id and i.unit_cost is null)) missing
  from ezshop.finance_events e left join ezshop.orders o on o.id=e.order_id where e.merchant_id=mid and (lo is null or ((e.occurred_at at time zone 'Asia/Kuala_Lumpur')::date>=lo and (e.occurred_at at time zone 'Asia/Kuala_Lumpur')::date<hi))
 ), totals as (select coalesce(sum(amount) filter(where kind='payment'),0) receipts,coalesce(sum(amount) filter(where kind='refund'),0) refunds,coalesce(sum(amount) filter(where kind='payout'),0) payouts,
  coalesce(sum(case when kind='payment' then cost when kind='refund' and returned then -cost else 0 end),0) costs,
  coalesce(sum(case when kind='payment' then commission when kind='refund' then -commission else 0 end),0) commissions,
  count(distinct order_id) filter(where missing and (kind='payment' or (kind='refund' and returned))) missing_cost_orders from events
 ), manual as (select coalesce(sum(amount) filter(where kind='income'),0) income,coalesce(sum(amount) filter(where kind='income' and category<>'capital'),0) profit_income,coalesce(sum(amount) filter(where kind='expense'),0) expenses,coalesce(sum(amount) filter(where kind='expense' and category<>'inventory'),0) profit_expenses from ezshop.finance_entries where merchant_id=mid and not voided and (lo is null or (occurred_on>=lo and occurred_on<hi)))
 select jsonb_build_object('receipts',t.receipts,'refunds',t.refunds,'payouts',t.payouts,'manual_income',x.income,'expenses',x.expenses,'goods_cost',t.costs,'commissions',t.commissions,'missing_cost_orders',t.missing_cost_orders,'net_cash',t.receipts+x.income-t.refunds-t.payouts-x.expenses,'profit',case when t.missing_cost_orders=0 then t.receipts-t.refunds-t.costs-t.commissions+x.profit_income-x.profit_expenses end,'unknown_date_events',(select count(*) from ezshop.finance_events where merchant_id=mid and occurred_at is null)) into summary from totals t cross join manual x;
 return summary;
end;
$$;
revoke all on function ezshop.platform_book_summary(bigint) from public,anon,authenticated,service_role;
create or replace function ezshop.platform_order_view(o ezshop.orders) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('id',o.id,'reference',o.reference,'customer',o.customer,'email',o.email,'phone',o.phone,'address',o.address,'state',o.state,'city',o.city,'postcode',o.postcode,'note',o.note,'total',o.total,'subtotal',o.subtotal,'shipping',o.shipping,'discount',o.discount,'status',o.status,'commission',o.commission,'agent_id',o.agent_id,'created',o.created,'fulfillment_status',o.fulfillment_status,'carrier',o.carrier,'tracking',o.tracking,'shipped_at',o.shipped_at,'refund_reference',o.refund_reference,'refunded_at',o.refunded_at,'stock_returned',o.stock_returned,'locale',o.locale,'payment_instructions',o.payment_instructions);
$$;
revoke all on function ezshop.platform_order_view(ezshop.orders) from public,anon,authenticated,service_role;
create or replace function public.ezshop_platform_read_api(route text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,ezshop as $$
#variable_conflict use_column
declare mid bigint;page_no int;skip_rows int;row_count bigint;rows jsonb;profile jsonb;order_row ezshop.orders%rowtype;
begin
 if not exists(select 1 from ezshop.merchants where owner=auth.uid() and is_admin and status='active') then raise exception '需要平台管理员权限';end if;
 if coalesce(payload->>'merchant_id','')!~'^[0-9]{1,18}$' then raise exception '商家编号无效';end if;
 mid:=(payload->>'merchant_id')::bigint;
 select jsonb_build_object('id',m.id,'name',m.name,'email',m.email,'slug',m.slug,'status',m.status,'plan',m.plan,'phone',m.phone,'description',m.description,'logo',m.logo,'banner',m.banner,'shipping_fee',m.shipping_fee,'courier',m.courier,'trial_ends_at',m.trial_ends_at,'content_translations',m.content_translations) into profile from ezshop.merchants m where id=mid;
 if profile is null then raise exception '找不到商家';end if;
 if coalesce(payload->>'page','1')!~'^[0-9]{1,7}$' then raise exception '页码无效';end if;
 page_no:=coalesce((payload->>'page')::int,1);
 if page_no<1 then raise exception '页码无效';end if;
 skip_rows:=(page_no-1)*50;
 if route='overview' then
  return jsonb_build_object('merchant',profile,'summary',ezshop.platform_book_summary(mid),'receiving',coalesce((select to_jsonb(r)-'version' from ezshop.merchant_receiving r where merchant_id=mid),'{}'::jsonb),'counts',jsonb_build_object('products',(select count(*) from ezshop.products where merchant_id=mid),'stock',(select coalesce(sum(stock),0) from ezshop.products where merchant_id=mid),'orders',(select count(*) from ezshop.orders where merchant_id=mid),'customers',(select count(distinct lower(email)) from ezshop.orders where merchant_id=mid)));
 elsif route='order' then
  if coalesce(payload->>'order_id','')!~'^[0-9]{1,18}$' then raise exception '订单编号无效';end if;
  select * into order_row from ezshop.orders where id=(payload->>'order_id')::bigint and merchant_id=mid;
  if not found then raise exception '找不到订单';end if;
  return jsonb_build_object('order',ezshop.platform_order_view(order_row),'items',coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from ezshop.order_items i where order_id=order_row.id),'[]'::jsonb));
 elsif route='products' then
  select count(*) into row_count from ezshop.products where merchant_id=mid;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]'::jsonb) into rows from (select * from ezshop.products where merchant_id=mid order by id desc limit 50 offset skip_rows) x;
 elsif route='orders' then
  select count(*) into row_count from ezshop.orders where merchant_id=mid;
  select coalesce(jsonb_agg(ezshop.platform_order_view(x::ezshop.orders) order by x.id desc),'[]'::jsonb) into rows from (select * from ezshop.orders where merchant_id=mid order by id desc limit 50 offset skip_rows) x;
 elsif route='customers' then
  select count(distinct lower(email)) into row_count from ezshop.orders where merchant_id=mid;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.email),'[]'::jsonb) into rows from (
   select lower(email) email,array_agg(distinct customer) names,array_agg(distinct phone) phones,array_agg(distinct address) addresses,count(*) orders_count,coalesce(sum(total) filter(where status in ('paid','refunded')),0) paid_total,coalesce(sum(total) filter(where status='refunded'),0) refunded_total,max(created) last_order
   from ezshop.orders where merchant_id=mid group by lower(email) order by lower(email) limit 50 offset skip_rows) x;
 elsif route='agents' then
  select count(*) into row_count from ezshop.agents where merchant_id=mid;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]'::jsonb) into rows from (select * from ezshop.agents where merchant_id=mid order by id desc limit 50 offset skip_rows) x;
 elsif route='team' then
  select count(*) into row_count from ezshop.memberships where merchant_id=mid;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]'::jsonb) into rows from (select id,name,email,role,agent_id,(user_id is not null) joined from ezshop.memberships where merchant_id=mid order by id desc limit 50 offset skip_rows) x;
 elsif route='payouts' then
  select count(*) into row_count from ezshop.payouts where merchant_id=mid;
  select coalesce(jsonb_agg(to_jsonb(x)-'request_key' order by x.id desc),'[]'::jsonb) into rows from (select * from ezshop.payouts where merchant_id=mid order by id desc limit 50 offset skip_rows) x;
 elsif route='journal' then
  select (select count(*) from ezshop.finance_events where merchant_id=mid)+(select count(*) from ezshop.finance_entries where merchant_id=mid) into row_count;
  select coalesce(jsonb_agg(x.body order by x.book_date desc nulls last,x.source,x.id desc),'[]'::jsonb) into rows from (
   select * from (
    select e.id,'event' source,e.occurred_at book_date,jsonb_build_object('id',e.id,'source','event','kind',e.kind,'amount',e.amount,'date',e.occurred_at,'reference',coalesce(o.reference,p.reference,''),'order_id',e.order_id,'voided',false) body from ezshop.finance_events e left join ezshop.orders o on o.id=e.order_id left join ezshop.payouts p on p.id=e.payout_id where e.merchant_id=mid
    union all select e.id,'manual',e.occurred_on::timestamp at time zone 'Asia/Kuala_Lumpur',jsonb_build_object('id',e.id,'source','manual','kind',e.kind,'amount',e.amount,'date',e.occurred_on,'category',e.category,'description',e.description,'reference',e.reference,'voided',e.voided) from ezshop.finance_entries e where e.merchant_id=mid
   ) all_rows order by book_date desc nulls last,source,id desc limit 50 offset skip_rows) x;
 elsif route='audit' then
  select count(*) into row_count from ezshop.audit_log where merchant_id=mid;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]'::jsonb) into rows from (select * from ezshop.audit_log where merchant_id=mid order by id desc limit 50 offset skip_rows) x;
 elsif route='notifications' then
  select count(*) into row_count from ezshop.notification_jobs where merchant_id=mid;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]'::jsonb) into rows from (select id,order_id,kind,status,attempts,updated from ezshop.notification_jobs where merchant_id=mid order by id desc limit 50 offset skip_rows) x;
 else raise exception '平台明细仅支持读取';
 end if;
 return jsonb_build_object('rows',rows,'total',row_count,'page',page_no,'page_size',50);
end;
$$;
revoke all on function public.ezshop_platform_read_api(text,jsonb) from public,anon,service_role;
grant execute on function public.ezshop_platform_read_api(text,jsonb) to authenticated;
-- 独立版本标记：旧商家 RPC 链不做重命名或权限变更。
create or replace function public.ezshop_platform_read_status() returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select jsonb_build_object('ready',to_regprocedure('public.ezshop_platform_read_api(text,jsonb)') is not null and not has_function_privilege('anon','public.ezshop_platform_read_api(text,jsonb)','EXECUTE') and not has_function_privilege('authenticated','ezshop.platform_book_summary(bigint)','EXECUTE') and not has_function_privilege('authenticated','ezshop.platform_order_view(ezshop.orders)','EXECUTE'));
$$;
revoke all on function public.ezshop_platform_read_status() from public;
grant execute on function public.ezshop_platform_read_status() to anon,authenticated,service_role;
