-- 订单成本快照与经营账本。未知历史收款时间/成本保留未知，不伪造利润。
alter table ezshop.products add column if not exists unit_cost bigint check(unit_cost between 0 and 100000000);
alter table ezshop.order_items add column if not exists unit_cost bigint check(unit_cost between 0 and 100000000);
alter table ezshop.orders add column if not exists cost_snapshot_taken boolean not null default false;
alter table ezshop.orders add column if not exists cost_revision bigint not null default 0;
update ezshop.orders set cost_snapshot_taken=true;
create table if not exists ezshop.finance_events(id bigint generated always as identity primary key,merchant_id bigint not null references ezshop.merchants(id),order_id bigint references ezshop.orders(id),payout_id bigint references ezshop.payouts(id),kind text not null check(kind in ('payment','refund','payout')),amount bigint not null check(amount>=0),occurred_at timestamptz,unique(order_id,kind),unique(payout_id));
create table if not exists ezshop.finance_entries(id bigint generated always as identity primary key,merchant_id bigint not null references ezshop.merchants(id),kind text not null check(kind in ('income','expense')),category text not null,amount bigint not null check(amount between 1 and 100000000000),occurred_on date not null,description text not null,reference text not null default '',request_key text not null,voided boolean not null default false,created timestamptz not null default now(),unique(merchant_id,request_key));
alter table ezshop.finance_events enable row level security;alter table ezshop.finance_entries enable row level security;
revoke all on ezshop.finance_events,ezshop.finance_entries from public,anon,authenticated,service_role;
create index if not exists finance_events_store on ezshop.finance_events(merchant_id,occurred_at);
create index if not exists finance_entries_store on ezshop.finance_entries(merchant_id,occurred_on);
create or replace function ezshop.record_finance_event() returns trigger language plpgsql security definer set search_path=pg_catalog,ezshop as $$
begin
 if tg_table_name='orders' then
  if new.status='paid' and old.status='pending' then insert into ezshop.finance_events(merchant_id,order_id,kind,amount,occurred_at) values(new.merchant_id,new.id,'payment',new.total,now()) on conflict do nothing;end if;
  if new.status='refunded' and old.status='paid' then insert into ezshop.finance_events(merchant_id,order_id,kind,amount,occurred_at) values(new.merchant_id,new.id,'refund',new.total,coalesce(new.refunded_at,now())) on conflict do nothing;end if;
 else
  if new.status='paid' and old.status='requested' then insert into ezshop.finance_events(merchant_id,payout_id,kind,amount,occurred_at) values(new.merchant_id,new.id,'payout',new.amount,now()) on conflict do nothing;end if;
 end if;
 return new;
end;
$$;
revoke all on function ezshop.record_finance_event() from public,anon,authenticated,service_role;
drop trigger if exists ezshop_order_finance on ezshop.orders;
create trigger ezshop_order_finance after update on ezshop.orders for each row execute function ezshop.record_finance_event();
drop trigger if exists ezshop_payout_finance on ezshop.payouts;
create trigger ezshop_payout_finance after update on ezshop.payouts for each row execute function ezshop.record_finance_event();
insert into ezshop.finance_events(merchant_id,order_id,kind,amount,occurred_at) select merchant_id,id,'payment',total,null from ezshop.orders where status in ('paid','refunded') on conflict do nothing;
insert into ezshop.finance_events(merchant_id,order_id,kind,amount,occurred_at) select merchant_id,id,'refund',total,refunded_at from ezshop.orders where status='refunded' on conflict do nothing;
insert into ezshop.finance_events(merchant_id,payout_id,kind,amount,occurred_at) select merchant_id,id,'payout',amount,updated from ezshop.payouts where status='paid' on conflict do nothing;
create or replace function public.ezshop_books_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
#variable_conflict use_column
declare m ezshop.merchants%rowtype;entry ezshop.finance_entries%rowtype;order_row ezshop.orders%rowtype;line jsonb;rows jsonb;summary jsonb;lo date;hi date;month text:=coalesce(payload->>'month','');book_date date;amount bigint;key text;items jsonb;
begin
 select * into m from ezshop.merchants where owner=auth.uid() and status='active';
 if not found then raise exception '需要商家所有者权限';end if;
 if not ezshop.subscription_access(m.id) then raise exception 'Pro试用或订阅已到期，请先续费。';end if;
 if route='entry/add' then
  if coalesce(payload->>'amount','')!~'^[0-9]+$' or (payload->>'amount')::bigint not between 1 and 100000000000 or length(trim(coalesce(payload->>'description','')))=0 or length(payload->>'description')>300 or length(coalesce(payload->>'reference',''))>120 or coalesce(payload->>'request_key','')!~'^[A-Za-z0-9_-]{20,100}$' then raise exception '收支资料无效，请核对金额、日期及说明。';end if;
  if not ((payload->>'kind'='income' and payload->>'category' in ('other_income','capital')) or (payload->>'kind'='expense' and payload->>'category' in ('operating','shipping','advertising','fees','inventory'))) then raise exception '收支资料无效，请核对金额、日期及说明。';end if;
  book_date:=(payload->>'occurred_on')::date;
  if book_date is null or book_date<'2000-01-01'::date or book_date>(now() at time zone 'Asia/Kuala_Lumpur')::date then raise exception '收支日期必须是已发生的日期。';end if;
  amount:=(payload->>'amount')::bigint;key:=payload->>'request_key';perform pg_advisory_xact_lock(m.id);
  select * into entry from ezshop.finance_entries where merchant_id=m.id and request_key=key;
  if found then
   if entry.kind is distinct from payload->>'kind' or entry.category is distinct from payload->>'category' or entry.amount<>amount or entry.occurred_on<>book_date or entry.description is distinct from trim(payload->>'description') or entry.reference is distinct from coalesce(payload->>'reference','') then raise exception '重复收支请求的资料不一致，请刷新后重试。';end if;
   return jsonb_build_object('ok',true,'duplicate',true);
  end if;
  insert into ezshop.finance_entries(merchant_id,kind,category,amount,occurred_on,description,reference,request_key) values(m.id,payload->>'kind',payload->>'category',amount,book_date,trim(payload->>'description'),coalesce(payload->>'reference',''),key);
  insert into ezshop.audit_log(merchant_id,actor,action) values(m.id,auth.uid()::text,'books.entry');return jsonb_build_object('ok',true);
 end if;
 if route='entry/void' then
  if length(trim(coalesce(payload->>'reason','')))=0 or length(payload->>'reason')>300 then raise exception '请填写作废原因。';end if;
  update ezshop.finance_entries set voided=true where id=(payload->>'id')::bigint and merchant_id=m.id and not voided returning * into entry;
  if not found then raise exception '记录不存在或已经作废。';end if;
  insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(m.id,auth.uid()::text,'books.void: '||trim(payload->>'reason'),entry.id);return jsonb_build_object('ok',true);
 end if;
 if route in ('order','order-costs') then
  select * into order_row from ezshop.orders where id=(payload->>'id')::bigint and merchant_id=m.id for update;
  if not found then raise exception '找不到订单';end if;
  if route='order-costs' then
   if coalesce(payload->>'version','')!~'^[0-9]+$' or (payload->>'version')::bigint<>order_row.cost_revision then raise exception '订单成本已更新，请刷新后重试。';end if;
   if length(trim(coalesce(payload->>'reason','')))=0 or length(payload->>'reason')>300 or jsonb_typeof(payload->'items') is distinct from 'array' then raise exception '请填写成本及更正原因。';end if;
   if jsonb_array_length(payload->'items') not between 1 and 100 then raise exception '请填写成本及更正原因。';end if;
   for line in select value from jsonb_array_elements(payload->'items') loop
    if coalesce(line->>'unit_cost','')!~'^[0-9]+$' or (line->>'unit_cost')::bigint not between 0 and 100000000 then raise exception '商品成本无效。';end if;
    update ezshop.order_items set unit_cost=(line->>'unit_cost')::bigint where id=(line->>'id')::bigint and order_id=order_row.id;
    if not found then raise exception '商品不属于此订单。';end if;
   end loop;
   if coalesce(payload->>'paid_on','')<>'' then
    book_date:=(payload->>'paid_on')::date;
    if book_date<'2000-01-01'::date or book_date>(now() at time zone 'Asia/Kuala_Lumpur')::date then raise exception '收支日期必须是已发生的日期。';end if;
    update ezshop.finance_events set occurred_at=book_date::timestamp at time zone 'Asia/Kuala_Lumpur' where order_id=order_row.id and kind='payment' and occurred_at is null;
   end if;
   update ezshop.orders set cost_revision=cost_revision+1 where id=order_row.id;
   insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(m.id,auth.uid()::text,'books.costs: '||trim(payload->>'reason'),order_row.id);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'name',i.name,'quantity',i.quantity,'unit_cost',i.unit_cost) order by i.id),'[]'::jsonb) into items from ezshop.order_items i where i.order_id=order_row.id;
  return jsonb_build_object('reference',order_row.reference,'version',order_row.cost_revision+case when route='order-costs' then 1 else 0 end,'items',items,'unknown_paid_date',exists(select 1 from ezshop.finance_events where order_id=order_row.id and kind='payment' and occurred_at is null));
 end if;
 if route<>'summary' then raise exception '不支持此操作';end if;
 if coalesce(payload->>'date','')<>'' then
  lo:=(payload->>'date')::date;hi:=lo+1;
 elsif month<>'' then
  if month!~'^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception '月份格式无效。';end if;
  lo:=(month||'-01')::date;hi:=(lo+interval '1 month')::date;
 end if;
 with events as (
  select e.*,coalesce(o.commission,0) commission,coalesce(o.stock_returned,false) returned,
   coalesce((select sum(i.unit_cost*i.quantity) from ezshop.order_items i where i.order_id=e.order_id),0) cost,
   (not exists(select 1 from ezshop.order_items i where i.order_id=e.order_id) or exists(select 1 from ezshop.order_items i where i.order_id=e.order_id and i.unit_cost is null)) missing
  from ezshop.finance_events e left join ezshop.orders o on o.id=e.order_id where e.merchant_id=m.id and (lo is null or ((e.occurred_at at time zone 'Asia/Kuala_Lumpur')::date>=lo and (e.occurred_at at time zone 'Asia/Kuala_Lumpur')::date<hi))
 ), totals as (select coalesce(sum(amount) filter(where kind='payment'),0) receipts,coalesce(sum(amount) filter(where kind='refund'),0) refunds,coalesce(sum(amount) filter(where kind='payout'),0) payouts,
  coalesce(sum(case when kind='payment' then cost when kind='refund' and returned then -cost else 0 end),0) costs,
  coalesce(sum(case when kind='payment' then commission when kind='refund' then -commission else 0 end),0) commissions,
  count(distinct order_id) filter(where missing and (kind='payment' or (kind='refund' and returned))) missing_cost_orders from events
 ), manual as (select coalesce(sum(amount) filter(where kind='income'),0) income,coalesce(sum(amount) filter(where kind='income' and category<>'capital'),0) profit_income,coalesce(sum(amount) filter(where kind='expense'),0) expenses,coalesce(sum(amount) filter(where kind='expense' and category<>'inventory'),0) profit_expenses from ezshop.finance_entries where merchant_id=m.id and not voided and (lo is null or (occurred_on>=lo and occurred_on<hi)))
 select jsonb_build_object('receipts',t.receipts,'refunds',t.refunds,'payouts',t.payouts,'manual_income',x.income,'expenses',x.expenses,'goods_cost',t.costs,'commissions',t.commissions,'missing_cost_orders',t.missing_cost_orders,'net_cash',t.receipts+x.income-t.refunds-t.payouts-x.expenses,'profit',case when t.missing_cost_orders=0 then t.receipts-t.refunds-t.costs-t.commissions+x.profit_income-x.profit_expenses end,'unknown_date_events',(select count(*) from ezshop.finance_events where merchant_id=m.id and occurred_at is null)) into summary from totals t cross join manual x;
 select coalesce(jsonb_agg(x.body order by x.book_date desc nulls last,x.id desc),'[]'::jsonb) into rows from (
  select * from (select e.id,e.occurred_at book_date,jsonb_build_object('id',e.id,'source','order','kind',e.kind,'amount',e.amount,'date',e.occurred_at,'reference',coalesce(o.reference,p.reference,''),'order_id',e.order_id,'voided',false) body from ezshop.finance_events e left join ezshop.orders o on o.id=e.order_id left join ezshop.payouts p on p.id=e.payout_id where e.merchant_id=m.id and (lo is null or ((e.occurred_at at time zone 'Asia/Kuala_Lumpur')::date>=lo and (e.occurred_at at time zone 'Asia/Kuala_Lumpur')::date<hi))
  union all select e.id,e.occurred_on::timestamp at time zone 'Asia/Kuala_Lumpur',jsonb_build_object('id',e.id,'source','manual','kind',e.kind,'amount',e.amount,'date',e.occurred_on,'category',e.category,'description',e.description,'reference',e.reference,'voided',e.voided) from ezshop.finance_entries e where e.merchant_id=m.id and (lo is null or (e.occurred_on>=lo and e.occurred_on<hi))) all_rows order by book_date desc nulls last,id desc limit 200
 ) x;
 return jsonb_build_object('summary',summary,'rows',rows);
end;
$$;
revoke all on function public.ezshop_books_api(text,jsonb) from public,anon;
grant execute on function public.ezshop_books_api(text,jsonb) to authenticated;
-- 商品成本不公开；成交快照只在创建新订单时写入一次。
do $$begin if to_regprocedure('public.ezshop_customer_store_api(text,jsonb)') is null then alter function public.ezshop_api(text,jsonb) rename to ezshop_customer_store_api;end if;end$$;
revoke all on function public.ezshop_customer_store_api(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ezshop_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare result jsonb;m ezshop.merchants%rowtype;member ezshop.memberships%rowtype;role_name text:='owner';pid bigint;oid bigint;cost bigint;
begin
 if route in ('products','products/update','dashboard') and auth.uid() is not null then
  select * into m from ezshop.merchants where owner=auth.uid();
  if m.id is null then select * into member from ezshop.memberships where user_id=auth.uid();if member.id is not null then select * into m from ezshop.merchants where id=member.merchant_id;role_name:=member.role;end if;end if;
 end if;
 if route in ('products','products/update') and payload?'unit_cost' then
  if m.id is null or role_name not in ('owner','manager') then raise exception '当前角色没有此操作权限';end if;
  if payload->>'unit_cost' is not null then
   if coalesce(payload->>'unit_cost','')!~'^[0-9]+$' or (payload->>'unit_cost')::bigint not between 0 and 100000000 then raise exception '商品成本无效。';end if;cost:=(payload->>'unit_cost')::bigint;
  end if;
  perform pg_advisory_xact_lock(m.id);
 end if;
 if route in ('products','products/update') and m.id is not null then perform pg_advisory_xact_lock(m.id);end if;
 result:=public.ezshop_customer_store_api(route,payload);
 if route in ('products','products/update') and payload?'unit_cost' then
  if route='products/update' then pid:=(payload->>'id')::bigint;else select max(id) into pid from ezshop.products where merchant_id=m.id;end if;
  update ezshop.products set unit_cost=cost where id=pid and merchant_id=m.id;
 end if;
 if route='checkout' then
  select id into oid from ezshop.orders where reference=result->>'reference' and access_token=result->>'access_token' and not cost_snapshot_taken for update;
  if oid is not null then
   update ezshop.order_items i set unit_cost=p.unit_cost from ezshop.products p,ezshop.orders o where i.order_id=oid and o.id=oid and p.id=i.product_id and p.merchant_id=o.merchant_id;
   update ezshop.orders set cost_snapshot_taken=true where id=oid;
  end if;
 end if;
 if route='dashboard' then
  result:=jsonb_set(result,'{merchant,bookkeeping_enabled}','true'::jsonb);
  if role_name not in ('owner','manager') then result:=jsonb_set(result,'{products}',coalesce((select jsonb_agg(value-'unit_cost') from jsonb_array_elements(result->'products')),'[]'::jsonb));end if;
 end if;
 return result;
end;
$$;
revoke all on function public.ezshop_api(text,jsonb) from public;
grant execute on function public.ezshop_api(text,jsonb) to anon,authenticated,service_role;
create or replace function public.ezshop_release_status() returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;locked boolean;ready boolean;
begin
 result:=public.ezshop_base_release_status();
 select bool_and(not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')) into locked from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('ezshop_subscription_api','ezshop_subscription_payment_api','ezshop_base_release_status','ezshop_trial_api','ezshop_receiving_api','ezshop_customer_store_api');
 ready:=to_regclass('ezshop.finance_events') is not null and to_regprocedure('public.ezshop_customer_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_books_api(text,jsonb)') is not null;
 return result||jsonb_build_object('features',(result->'features')||jsonb_build_object('trial_access',true,'merchant_receiving',true,'customer_accounts',ready,'bookkeeping',ready),'internal_rpc_locked',coalesce(locked,false) and (result->>'internal_rpc_locked')::boolean,'database_ready',ready and coalesce(locked,false) and (result->>'database_ready')::boolean);
end;
$$;
revoke all on function public.ezshop_release_status() from public;
grant execute on function public.ezshop_release_status() to anon,authenticated,service_role;
