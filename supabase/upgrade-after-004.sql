-- 由 npm run build:upgrade 生成。已有 001–004 的项目使用；先审查并备份。
-- 已存在的 RPC 链不会重命名或覆盖，整个升级在单一事务内执行。
begin;
select pg_advisory_xact_lock(73911428511630);
do $preflight$ begin
 if to_regprocedure('public.ezshop_finance_api(text,jsonb)') is null or not exists(select 1 from information_schema.columns where table_schema='ezshop' and table_name='orders' and column_name='fulfillment_status') then raise exception '需要先完成 001–004；本文件不会盲目初始化或替换旧表';end if;
 if to_regprocedure('public.ezshop_specs_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_delivery_api(text,jsonb)') is null then raise exception 'RPC 链不完整，请先人工审查';end if;
end $preflight$;

-- 202611040005_payments.sql · sha256 23b5c5a9d7eab9c0a42969cd83119497d8fbfd09a9f8fcb33726e3e7cb99504c
do $upgrade_005$ begin
 if not (to_regprocedure('public.ezshop_payment_api(text,jsonb)') is not null) then
  execute $ezshop_migration_005$
-- 可选 Stripe Connect 商品收款 + 平台订阅。密钥只在 Edge Function 中，不写入表或前端。
create table if not exists ezshop.merchant_payments (
 merchant_id bigint primary key references ezshop.merchants(id),account_id text unique not null,
 charges_enabled boolean not null default false,payouts_enabled boolean not null default false,details_submitted boolean not null default false,updated timestamptz not null default now()
);
create table if not exists ezshop.payment_sessions (
 id bigint generated always as identity primary key,merchant_id bigint not null references ezshop.merchants(id),order_id bigint not null references ezshop.orders(id),
 attempt int not null,account_id text not null,amount bigint not null check(amount>0),currency text not null default 'myr',session_id text unique,payment_intent text,
 status text not null default 'creating' check(status in ('creating','open','complete','expired')),created timestamptz not null default now(),unique(order_id,attempt)
);
create table if not exists ezshop.billing_accounts (
 merchant_id bigint primary key references ezshop.merchants(id),customer_id text unique not null,subscription_id text unique,
 status text not null default 'none',price_id text,paid_through timestamptz,invoice_paid boolean not null default false,last_event_created bigint not null default 0,updated timestamptz not null default now()
);
create table if not exists ezshop.billing_checkouts (
 id bigint generated always as identity primary key,merchant_id bigint not null references ezshop.merchants(id),attempt int not null,price_id text not null,
 session_id text unique,status text not null default 'creating' check(status in ('creating','open','complete','expired')),created timestamptz not null default now(),unique(merchant_id,attempt)
);
create table if not exists ezshop.webhook_events (
 id text primary key,kind text not null,outcome text not null default 'accepted',created timestamptz not null default now()
);
create table if not exists ezshop.payment_reviews (
 id bigint generated always as identity primary key,merchant_id bigint not null references ezshop.merchants(id),order_id bigint references ezshop.orders(id),event_id text unique not null,
 reason text not null,resolution text not null default '',created timestamptz not null default now(),resolved boolean not null default false
);
alter table ezshop.merchant_payments enable row level security;
alter table ezshop.payment_sessions enable row level security;
alter table ezshop.billing_accounts enable row level security;
alter table ezshop.billing_checkouts enable row level security;
alter table ezshop.webhook_events enable row level security;
alter table ezshop.payment_reviews enable row level security;
revoke all on ezshop.merchant_payments,ezshop.payment_sessions,ezshop.billing_accounts,ezshop.billing_checkouts,ezshop.webhook_events,ezshop.payment_reviews from public,anon,authenticated;
create index if not exists payment_sessions_order on ezshop.payment_sessions(order_id);
create index if not exists payment_reviews_store on ezshop.payment_reviews(merchant_id);
create or replace function public.ezshop_payment_api(route text,payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
#variable_conflict use_column
declare m ezshop.merchants%rowtype;o ezshop.orders%rowtype;p ezshop.merchant_payments%rowtype;s ezshop.payment_sessions%rowtype;b ezshop.billing_accounts%rowtype;c ezshop.billing_checkouts%rowtype;
 service boolean:=current_setting('request.jwt.claim.role',true)='service_role' or coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'='service_role';
 next_attempt int;event_id text;reason text;state text;period_end bigint;paid boolean;mid bigint;inserted text;
begin
 if route='store-options' then
  select * into m from ezshop.merchants where slug=payload->>'slug' and status='active';
  if not found then raise exception '店铺不存在'; end if;
  return jsonb_build_object('online_enabled',exists(select 1 from ezshop.merchant_payments where merchant_id=m.id and charges_enabled and details_submitted));
 end if;
 if route='order-summary' then
  select r.* into o from ezshop.orders r join ezshop.merchants t on t.id=r.merchant_id where r.reference=payload->>'reference' and r.access_token=payload->>'token' and t.slug=payload->>'slug';
  if not found then raise exception '订单不存在或访问凭证无效'; end if;
  return jsonb_build_object('online_enabled',exists(select 1 from ezshop.merchant_payments where merchant_id=o.merchant_id and charges_enabled and details_submitted),
   'requires_review',exists(select 1 from ezshop.payment_reviews where order_id=o.id and not resolved),'order_status',o.status);
 end if;
 if route='owner-status' then
  select * into m from ezshop.merchants where owner=auth.uid() and status='active';if not found then raise exception '需要商家所有者权限'; end if;
  select * into p from ezshop.merchant_payments where merchant_id=m.id;
  select * into b from ezshop.billing_accounts where merchant_id=m.id;
  return jsonb_build_object('merchant_id',m.id,'email',m.email,'name',m.name,'plan',m.plan,'account_id',p.account_id,'charges_enabled',coalesce(p.charges_enabled,false),'payouts_enabled',coalesce(p.payouts_enabled,false),
   'billing',case when b.merchant_id is null then '{}'::jsonb else to_jsonb(b) end,
   'reviews',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select r.id,r.order_id,o.reference,r.reason,r.created,r.resolved from ezshop.payment_reviews r left join ezshop.orders o on o.id=r.order_id where r.merchant_id=m.id or m.is_admin order by r.id desc limit 100) x));
 end if;
 if route='resolve-review' then
  select * into m from ezshop.merchants where owner=auth.uid() and status='active';if not found then raise exception '需要商家所有者权限'; end if;
  reason:=trim(coalesce(payload->>'resolution',''));if length(reason) not between 1 and 500 then raise exception '请填写外部处理结果及参考号'; end if;
  update ezshop.payment_reviews set resolved=true,resolution=reason where id=(payload->>'id')::bigint and (merchant_id=m.id or m.is_admin);
  if not found then raise exception '找不到待处理记录'; end if;
  insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(m.id,auth.uid()::text,'payment.review_resolved',(payload->>'id')::bigint);
  return jsonb_build_object('ok',true);
 end if;
 -- service 标记仅来自 Supabase 验证过的 JWT，不能由客户端 payload 自行指定。
 if service is distinct from true then raise exception '需要服务端权限'; end if;
 if route='service/bind-account' then
  mid:=(payload->>'merchant_id')::bigint;
  insert into ezshop.merchant_payments(merchant_id,account_id) values(mid,payload->>'account_id') on conflict(merchant_id) do nothing;
  select * into p from ezshop.merchant_payments where merchant_id=mid;
  if p.account_id<>payload->>'account_id' then raise exception '此商家已绑定其他收款账户'; end if;
  return jsonb_build_object('ok',true);
 end if;
 if route='service/account-status' then
  update ezshop.merchant_payments set charges_enabled=coalesce((payload->>'charges_enabled')::boolean,false),payouts_enabled=coalesce((payload->>'payouts_enabled')::boolean,false),details_submitted=coalesce((payload->>'details_submitted')::boolean,false),updated=now() where account_id=payload->>'account_id';
  return jsonb_build_object('ok',true);
 end if;
 if route='service/order-claim' then
  select r.* into o from ezshop.orders r join ezshop.merchants t on t.id=r.merchant_id where r.reference=payload->>'reference' and r.access_token=payload->>'token' and t.status='active';
  if not found then raise exception '订单不存在或访问凭证无效'; end if;
  perform pg_advisory_xact_lock(o.merchant_id);
  select * into o from ezshop.orders where id=o.id for update;
  if o.status<>'pending' then raise exception '此订单不能继续付款'; end if;
  if exists(select 1 from ezshop.payment_reviews where order_id=o.id and not resolved) then raise exception '付款需要商家核查，请勿重复付款'; end if;
  select * into p from ezshop.merchant_payments where merchant_id=o.merchant_id and charges_enabled and details_submitted;
  if not found then raise exception '商家尚未开通线上收款'; end if;
  select * into m from ezshop.merchants where id=o.merchant_id;
  select * into s from ezshop.payment_sessions where order_id=o.id order by attempt desc limit 1 for update;
  if s.id is null or s.status='expired' then
   next_attempt:=coalesce(s.attempt,0)+1;
   insert into ezshop.payment_sessions(merchant_id,order_id,attempt,account_id,amount) values(o.merchant_id,o.id,next_attempt,p.account_id,o.total) returning * into s;
  end if;
  if s.session_id is null and s.created<now()-interval '23 hours' then raise exception '付款请求需人工核实，请联系商家'; end if;
  if s.status='complete' or s.account_id<>p.account_id then raise exception '付款正在核实，请勿重复付款'; end if;
  return to_jsonb(s)||jsonb_build_object('reference',o.reference,'email',o.email,'slug',m.slug,'store_name',m.name);
 end if;
 if route='service/save-order-session' then
  update ezshop.payment_sessions set session_id=payload->>'session_id',status='open' where id=(payload->>'attempt_id')::bigint and (session_id is null or session_id=payload->>'session_id') and status in ('creating','open');
  if not found then raise exception '支付请求已变更，请重新核实'; end if;
  return jsonb_build_object('ok',true);
 end if;
 if route='service/expire-order-session' then
  update ezshop.payment_sessions set status='expired' where session_id=payload->>'session_id' and account_id=payload->>'account_id' and status in ('creating','open');
  return jsonb_build_object('ok',true);
 end if;
 if route='service/payment-completed' then
  event_id:=payload->>'event_id';if event_id is null or length(event_id)>200 then raise exception '事件标识无效'; end if;
  select * into s from ezshop.payment_sessions where session_id=payload->>'session_id';if not found then raise exception '找不到待核实的支付请求'; end if;
  perform pg_advisory_xact_lock(s.merchant_id);
  insert into ezshop.webhook_events(id,kind) values(event_id,'order.payment') on conflict(id) do nothing returning id into inserted;
  if inserted is null then return jsonb_build_object('ok',true,'duplicate',true); end if;
  select * into s from ezshop.payment_sessions where id=s.id for update;
  select * into o from ezshop.orders where id=s.order_id for update;
  reason:=case when s.account_id is distinct from payload->>'account_id' then 'account_mismatch'
   when lower(coalesce(payload->>'currency',''))<>s.currency or (payload->>'amount')::bigint is distinct from s.amount or o.total<>s.amount then 'amount_mismatch'
   when s.status='complete' then null
   when o.status<>'pending' then 'order_state_changed' else null end;
  if reason is not null then
   insert into ezshop.payment_reviews(merchant_id,order_id,event_id,reason) values(s.merchant_id,o.id,event_id,reason);
   update ezshop.webhook_events set outcome='requires_review' where id=event_id;
   return jsonb_build_object('ok',true,'requires_review',true);
  end if;
  if s.status='complete' then return jsonb_build_object('ok',true,'duplicate',true); end if;
  update ezshop.orders set status='paid' where id=o.id;
  update ezshop.payment_sessions set status='complete',payment_intent=payload->>'payment_intent' where id=s.id;
  insert into ezshop.notification_jobs(merchant_id,order_id,kind,event_key) values(s.merchant_id,o.id,'receipt','receipt:'||o.id::text) on conflict(event_key) do nothing;
  insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(s.merchant_id,'stripe','payment.verified',o.id);
  return jsonb_build_object('ok',true);
 end if;
 if route='service/charge-adjustment' then
  event_id:=payload->>'event_id';if coalesce(event_id,'')='' or length(event_id)>200 then raise exception '事件标识无效'; end if;
  select * into s from ezshop.payment_sessions where payment_intent=payload->>'payment_intent' and account_id=payload->>'account_id' and status='complete';
  if not found then
   if exists(select 1 from ezshop.orders r join ezshop.payment_sessions x on x.order_id=r.id where r.reference=payload->>'reference' and x.account_id=payload->>'account_id') then raise exception '付款记录尚未完成，请重试事件'; end if;
   return jsonb_build_object('ok',true,'ignored',true);
  end if;
  perform pg_advisory_xact_lock(s.merchant_id);
  insert into ezshop.webhook_events(id,kind) values(event_id,'order.adjustment') on conflict(id) do nothing returning id into inserted;
  if inserted is null then return jsonb_build_object('ok',true,'duplicate',true); end if;
  select * into o from ezshop.orders where id=s.order_id for update;
  if payload->>'kind'='refund' and lower(coalesce(payload->>'currency',''))=s.currency and (payload->>'amount')::bigint=s.amount and (payload->>'refunded')::bigint=s.amount then
   if o.status='paid' then
    update ezshop.orders set status='refunded',refund_reference=payload->>'charge_id',stock_returned=false,refunded_at=now() where id=o.id;
    if o.agent_id is not null then update ezshop.payouts set status='rejected',reference='关联订单退款，请重新申请',updated=now() where merchant_id=s.merchant_id and agent_id=o.agent_id and status='requested'; end if;
    insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(s.merchant_id,'stripe','refund.verified',o.id);
   elsif o.status<>'refunded' then
    insert into ezshop.payment_reviews(merchant_id,order_id,event_id,reason) values(s.merchant_id,o.id,event_id,'refund_state_changed');
   end if;
  else
   insert into ezshop.payment_reviews(merchant_id,order_id,event_id,reason) values(s.merchant_id,o.id,event_id,case when payload->>'kind'='dispute' then 'payment_disputed' else 'partial_refund_or_mismatch' end);
   update ezshop.webhook_events set outcome='requires_review' where id=event_id;
  end if;
  return jsonb_build_object('ok',true);
 end if;
 if route='service/bind-customer' then
  mid:=(payload->>'merchant_id')::bigint;
  insert into ezshop.billing_accounts(merchant_id,customer_id) values(mid,payload->>'customer_id') on conflict(merchant_id) do nothing;
  select * into b from ezshop.billing_accounts where merchant_id=mid;
  if b.customer_id<>payload->>'customer_id' then raise exception '此商家已绑定其他订阅账户'; end if;
  return jsonb_build_object('ok',true);
 end if;
 if route='service/billing-claim' then
  mid:=(payload->>'merchant_id')::bigint;perform pg_advisory_xact_lock(mid);
  select * into b from ezshop.billing_accounts where merchant_id=mid for update;
  if not found then raise exception '订阅客户尚未建立'; end if;
  if b.subscription_id is not null and b.status not in ('canceled','incomplete_expired','none') then raise exception '已有订阅，请使用订阅管理入口'; end if;
  select * into c from ezshop.billing_checkouts where merchant_id=mid order by attempt desc limit 1 for update;
  if c.id is null or c.status='expired' or (c.status='complete' and b.status in ('canceled','incomplete_expired')) then
   next_attempt:=coalesce(c.attempt,0)+1;
   insert into ezshop.billing_checkouts(merchant_id,attempt,price_id) values(mid,next_attempt,payload->>'price_id') returning * into c;
  end if;
  if c.session_id is null and c.created<now()-interval '23 hours' then raise exception '订阅请求需人工核实，请联系平台'; end if;
  if c.status='complete' then raise exception '订阅正在核实，请勿重复开通'; end if;
  return to_jsonb(c)||jsonb_build_object('customer_id',b.customer_id);
 end if;
 if route='service/save-billing-session' then
  update ezshop.billing_checkouts set session_id=payload->>'session_id',status='open' where id=(payload->>'attempt_id')::bigint and (session_id is null or session_id=payload->>'session_id') and status in ('creating','open');
  if not found then raise exception '订阅请求已变更'; end if;return jsonb_build_object('ok',true);
 end if;
 if route='service/expire-billing-session' then
  update ezshop.billing_checkouts set status='expired' where session_id=payload->>'session_id' and status in ('creating','open');return jsonb_build_object('ok',true);
 end if;
 if route='service/subscription-sync' then
  mid:=(payload->>'merchant_id')::bigint;perform pg_advisory_xact_lock(mid);
  select * into b from ezshop.billing_accounts where merchant_id=mid for update;
  if not found or b.customer_id is distinct from payload->>'customer_id' then raise exception '订阅客户不匹配'; end if;
  event_id:=payload->>'event_id';if event_id is null or length(event_id)>200 then raise exception '事件标识无效'; end if;
  insert into ezshop.webhook_events(id,kind) values(event_id,'billing.subscription') on conflict(id) do nothing returning id into inserted;
  if inserted is null then return jsonb_build_object('ok',true,'duplicate',true); end if;
  if coalesce((payload->>'event_created')::bigint,0)<b.last_event_created then
   update ezshop.webhook_events set outcome='outdated' where id=event_id;return jsonb_build_object('ok',true,'outdated',true);
  end if;
  if b.subscription_id=payload->>'subscription_id' and b.status in ('canceled','incomplete_expired') and payload->>'status' in ('active','trialing') then
   update ezshop.webhook_events set outcome='outdated' where id=event_id;return jsonb_build_object('ok',true,'outdated',true);
  end if;
  if not exists(select 1 from ezshop.billing_checkouts where merchant_id=mid and price_id=payload->>'price_id') then
   insert into ezshop.payment_reviews(merchant_id,event_id,reason) values(mid,event_id,'subscription_price_mismatch');
   return jsonb_build_object('ok',true,'requires_review',true);
  end if;
  if b.subscription_id is not null and b.subscription_id<>payload->>'subscription_id' and b.status not in ('none','canceled','incomplete_expired') then
   insert into ezshop.payment_reviews(merchant_id,event_id,reason) values(mid,event_id,'multiple_subscriptions');
   return jsonb_build_object('ok',true,'requires_review',true);
  end if;
  state:=payload->>'status';period_end:=coalesce((payload->>'period_end')::bigint,0);paid:=coalesce((payload->>'invoice_paid')::boolean,false);
  if state not in ('active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused') then raise exception '订阅状态无效'; end if;
  update ezshop.billing_accounts set subscription_id=payload->>'subscription_id',status=state,price_id=payload->>'price_id',paid_through=case when period_end>0 then to_timestamp(period_end) else null end,invoice_paid=paid,last_event_created=coalesce((payload->>'event_created')::bigint,0),updated=now() where merchant_id=mid;
  update ezshop.billing_checkouts set status='complete' where merchant_id=mid and status in ('creating','open');
  update ezshop.merchants set plan=case when period_end>extract(epoch from now()) and ((state='active' and paid) or state='trialing') then 'pro' else 'free' end where id=mid;
  insert into ezshop.audit_log(merchant_id,actor,action) values(mid,'stripe','subscription.'||state);
  return jsonb_build_object('ok',true);
 end if;
 raise exception '不支持此支付操作';
end;
$$;
revoke all on function public.ezshop_payment_api(text,jsonb) from public;
grant execute on function public.ezshop_payment_api(text,jsonb) to anon,authenticated,service_role;

$ezshop_migration_005$;
 end if;
end $upgrade_005$;

-- 202611040006_product_specs.sql · sha256 d2f3e19f60fe5535d03c86430ade46c541cb4f55351fb53c6a2308a5d573e156
do $upgrade_006$ begin
 if not (to_regprocedure('public.ezshop_delivery_api(text,jsonb)') is not null) then
  execute $ezshop_migration_006$
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

$ezshop_migration_006$;
 end if;
end $upgrade_006$;

-- 202611050007_content_languages.sql · sha256 a307380d8f8d2765fb522c353e97b6591dbd7b93497b683c544983c2dc55150f
do $upgrade_007$ begin
 if not (to_regprocedure('public.ezshop_specs_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_translation_access(text,integer)') is not null) then
  execute $ezshop_migration_007$
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

$ezshop_migration_007$;
 end if;
end $upgrade_007$;

-- 202611050008_operations.sql · sha256 c8bfafd20f375ce4809b2e13bd44204471bcb3d6de8414a4094f2ba968f4e04c
do $upgrade_008$ begin
 if not (to_regprocedure('public.ezshop_release_status()') is not null and to_regprocedure('public.ezshop_mail_api(text,jsonb)') is not null) then
  execute $ezshop_migration_008$
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

$ezshop_migration_008$;
 end if;
end $upgrade_008$;

-- 202611050009_platform_billing.sql · sha256 70862c2f8b91b9bfd5798628c0448f8d4ebfdaf2d3e410ee10b1f5184cc92c1a
do $upgrade_009$ begin
 if not (to_regprocedure('public.ezshop_content_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_platform_billing_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_gateway_api(text,jsonb)') is not null) then
  execute $ezshop_migration_009$
create or replace function ezshop.valid_tron_address(address text) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare alphabet text:='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';value numeric:=0;digit int;hex text:='';raw bytea;
begin
 if address is null or address!~'^T[1-9A-HJ-NP-Za-km-z]{33}$' then return false;end if;
 for i in 1..length(address) loop digit:=strpos(alphabet,substr(address,i,1))-1;if digit<0 then return false;end if;value:=value*58+digit;end loop;
 while value>0 loop hex:=lpad(to_hex(mod(value,256)::int),2,'0')||hex;value:=div(value,256);end loop;
 if length(hex)<>50 then return false;end if;raw:=decode(hex,'hex');
 return get_byte(raw,0)=65 and substring(raw from 22 for 4)=substring(sha256(sha256(substring(raw from 1 for 21))) from 1 for 4);
end;
$$;
revoke all on function ezshop.valid_tron_address(text) from public,anon,authenticated,service_role;
-- 平台服务费独立于商家的商品订单。自填金额只用于申请，必须人工核实后授权期限。
create table if not exists ezshop.platform_receiving(id boolean primary key default true check(id),version bigint not null default 0,
 bank_enabled boolean not null default false,bank_holder text not null default '',bank_account text not null default '',
 tng_enabled boolean not null default false,tng_holder text not null default '',tng_identifier text not null default '',tng_qr text not null default '',
 usdt_enabled boolean not null default false,usdt_address text not null default '',stripe_enabled boolean not null default false,stripe_currency text not null default 'MYR' check(stripe_currency in ('MYR','USD')),stripe_link text not null default '');
create table if not exists ezshop.plan_requests(id bigint generated always as identity primary key,merchant_id bigint not null references ezshop.merchants(id),method text not null check(method in ('bank_transfer','tng','usdt_trc20','stripe_link')),
 amount numeric(20,6) not null check(amount>0),currency text not null check(currency in ('MYR','USDT')),instructions jsonb not null,config_version bigint not null,
 status text not null default 'draft' check(status in ('draft','submitted','approved','rejected','cancelled')),reference text not null default '',actual_reference text not null default '',actual_amount numeric(20,6),days int,note text not null default '',approved_until timestamptz,created timestamptz not null default now(),updated timestamptz not null default now());
create unique index if not exists plan_reference_once on ezshop.plan_requests(method,reference) where reference<>'';
create unique index if not exists plan_actual_reference_once on ezshop.plan_requests(method,actual_reference) where status='approved' and actual_reference<>'';
create unique index if not exists plan_request_active on ezshop.plan_requests(merchant_id) where status in ('draft','submitted');
create table if not exists ezshop.manual_plan_grants(merchant_id bigint primary key references ezshop.merchants(id),paid_until timestamptz not null,request_id bigint not null references ezshop.plan_requests(id));
alter table ezshop.platform_receiving enable row level security;alter table ezshop.plan_requests enable row level security;alter table ezshop.manual_plan_grants enable row level security;
revoke all on ezshop.platform_receiving,ezshop.plan_requests,ezshop.manual_plan_grants from public,anon,authenticated,service_role;
create or replace function ezshop.configure_platform_receiving(p jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
begin
 if jsonb_typeof(p->'bank_enabled') is distinct from 'boolean' or jsonb_typeof(p->'tng_enabled') is distinct from 'boolean' or jsonb_typeof(p->'usdt_enabled') is distinct from 'boolean' or jsonb_typeof(p->'stripe_enabled') is distinct from 'boolean' then raise exception '收款资料无效';end if;
 if length(coalesce(p->>'bank_holder',''))>100 or length(coalesce(p->>'bank_account',''))>20 or length(coalesce(p->>'tng_holder',''))>100 or length(coalesce(p->>'tng_identifier',''))>20 or length(coalesce(p->>'tng_qr',''))>2000 or length(coalesce(p->>'usdt_address',''))>34 or length(coalesce(p->>'stripe_link',''))>500 then raise exception '收款资料无效';end if;
 if (p->>'bank_enabled')::boolean and (length(trim(coalesce(p->>'bank_holder','')))=0 or coalesce(p->>'bank_account','')!~'^[0-9]{8,20}$') then raise exception '请填写有效的银行收款人及账号';end if;
 if coalesce(p->>'tng_qr','')<>'' and (p->>'tng_qr')!~'^https://[^/]+/' then raise exception 'TNG 二维码必须使用 HTTPS 图片';end if;
 if (p->>'tng_enabled')::boolean and (length(trim(coalesce(p->>'tng_holder','')))=0 or (coalesce(p->>'tng_qr','')!~'^https://[^/]+/' and coalesce(p->>'tng_identifier','')!~'^[0-9]{8,20}$')) then raise exception '请填写 TNG 收款人及有效钱包号码或二维码';end if;
 if (p->>'usdt_enabled')::boolean and not ezshop.valid_tron_address(p->>'usdt_address') then raise exception 'TRC20 收款地址校验失败';end if;
 if coalesce(p->>'stripe_currency','MYR') not in ('MYR','USD') then raise exception 'Stripe 币种无效';end if;
 if (p->>'stripe_enabled')::boolean and coalesce(p->>'stripe_link','')!~'^https://buy\.stripe\.com/[A-Za-z0-9]+/?$' then raise exception '请填写有效的 Stripe 收款链接';end if;
 insert into ezshop.platform_receiving(id) values(true) on conflict do nothing;
 update ezshop.platform_receiving set version=version+1,bank_enabled=(p->>'bank_enabled')::boolean,bank_holder=coalesce(p->>'bank_holder',''),bank_account=coalesce(p->>'bank_account',''),tng_enabled=(p->>'tng_enabled')::boolean,tng_holder=coalesce(p->>'tng_holder',''),tng_identifier=coalesce(p->>'tng_identifier',''),tng_qr=coalesce(p->>'tng_qr',''),usdt_enabled=(p->>'usdt_enabled')::boolean,usdt_address=coalesce(p->>'usdt_address',''),stripe_enabled=(p->>'stripe_enabled')::boolean,stripe_currency=coalesce(p->>'stripe_currency','MYR'),stripe_link=coalesce(p->>'stripe_link','') where id and (bank_enabled,bank_holder,bank_account,tng_enabled,tng_holder,tng_identifier,tng_qr,usdt_enabled,usdt_address,stripe_enabled,stripe_currency,stripe_link) is distinct from ((p->>'bank_enabled')::boolean,coalesce(p->>'bank_holder',''),coalesce(p->>'bank_account',''),(p->>'tng_enabled')::boolean,coalesce(p->>'tng_holder',''),coalesce(p->>'tng_identifier',''),coalesce(p->>'tng_qr',''),(p->>'usdt_enabled')::boolean,coalesce(p->>'usdt_address',''),(p->>'stripe_enabled')::boolean,coalesce(p->>'stripe_currency','MYR'),coalesce(p->>'stripe_link',''));
 return jsonb_build_object('ok',true);
end;
$$;
revoke all on function ezshop.configure_platform_receiving(jsonb) from public,anon,authenticated,service_role;
create or replace function ezshop.apply_plan_expiry(uid uuid) returns void language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare mid bigint;active_stripe boolean;
begin
 select id into mid from ezshop.merchants where owner=uid;
 if mid is null then select merchant_id into mid from ezshop.memberships where user_id=uid;end if;
 if mid is null then return;end if;
 if not exists(select 1 from ezshop.manual_plan_grants where merchant_id=mid and paid_until<=now()) then return;end if;
 perform pg_advisory_xact_lock(mid);
 if exists(select 1 from ezshop.manual_plan_grants where merchant_id=mid and paid_until<=now()) then
  if not exists(select 1 from ezshop.manual_plan_grants where merchant_id=mid and paid_until<=now()) then return;end if;
  select exists(select 1 from ezshop.billing_accounts where merchant_id=mid and paid_through>now() and ((status='active' and invoice_paid) or status='trialing')) into active_stripe;
  if not active_stripe then update ezshop.merchants set plan='free' where id=mid;end if;
 end if;
end;
$$;
revoke all on function ezshop.apply_plan_expiry(uuid) from public,anon,authenticated,service_role;
create or replace function public.ezshop_platform_billing_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
#variable_conflict use_column
declare m ezshop.merchants%rowtype;c ezshop.platform_receiving%rowtype;r ezshop.plan_requests%rowtype;method text;amount numeric;info jsonb;ref text;period int;until_time timestamptz;actual numeric;target_mid bigint;
begin
 select * into m from ezshop.merchants where owner=auth.uid() and status='active';if not found then raise exception '需要商家所有者权限';end if;
 if route in ('view','create','submit','cancel') then perform ezshop.apply_plan_expiry(auth.uid());end if;
 if route in ('settings','save','queue','review') and not m.is_admin then raise exception '需要平台管理员权限';end if;
 if route='save' then perform ezshop.configure_platform_receiving(payload);insert into ezshop.audit_log(merchant_id,actor,action) values(m.id,auth.uid()::text,'platform.receiving');end if;
 select * into c from ezshop.platform_receiving where id;
 if route in ('settings','save') then return jsonb_build_object('settings',case when c.id is null then '{}'::jsonb else to_jsonb(c) end);end if;
 if route='queue' then return jsonb_build_object('requests',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select p.*,s.name merchant_name,s.email merchant_email from ezshop.plan_requests p join ezshop.merchants s on s.id=p.merchant_id order by p.id desc limit 100) x));end if;
 if route='view' then return jsonb_build_object('options',jsonb_build_object('bank_transfer',coalesce(c.bank_enabled,false),'tng',coalesce(c.tng_enabled,false),'usdt_trc20',coalesce(c.usdt_enabled,false),'stripe_link',coalesce(c.stripe_enabled,false)),
 'stripe_currency',coalesce(c.stripe_currency,'MYR'),'requests',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select p.*,coalesce(p.config_version=c.version and p.status='draft',false) as can_pay from ezshop.plan_requests p where merchant_id=m.id order by id desc limit 30) x),'paid_until',(select paid_until from ezshop.manual_plan_grants where merchant_id=m.id));end if;
 if route='create' then
  method:=payload->>'method';if coalesce(payload->>'amount','')!~'^[0-9]{1,8}(\.[0-9]{1,6})?$' then raise exception '申请金额无效';end if;amount:=(payload->>'amount')::numeric;
  if amount<=0 or (method<>'usdt_trc20' and amount*100<>trunc(amount*100)) then raise exception '申请金额无效';end if;
  perform pg_advisory_xact_lock(m.id);
  select * into r from ezshop.plan_requests where merchant_id=m.id and status in ('draft','submitted');
  if found then
   if r.method=method and r.amount=amount then return jsonb_build_object('request',to_jsonb(r));end if;
   raise exception '已有待处理申请，请先查看或联系平台';
  end if;
  if method='bank_transfer' and c.bank_enabled then info:=jsonb_build_object('bank_name','Hong Leong Bank','holder',c.bank_holder,'account',c.bank_account);
  elsif method='tng' and c.tng_enabled then info:=jsonb_build_object('holder',c.tng_holder,'identifier',c.tng_identifier,'qr',c.tng_qr);
  elsif method='usdt_trc20' and c.usdt_enabled then info:=jsonb_build_object('network','TRC20','address',c.usdt_address);
  elsif method='stripe_link' and c.stripe_enabled then info:=jsonb_build_object('url',c.stripe_link);
  else raise exception '平台尚未启用此收款方式';end if;
  insert into ezshop.plan_requests(merchant_id,method,amount,currency,instructions,config_version) values(m.id,method,amount,case when method='usdt_trc20' then 'USDT' when method='stripe_link' then c.stripe_currency else 'MYR' end,info,c.version) returning * into r;
  return jsonb_build_object('request',to_jsonb(r));
 end if;
 if route='review' then select merchant_id into target_mid from ezshop.plan_requests where id=(payload->>'id')::bigint; if target_mid is not null then perform pg_advisory_xact_lock(target_mid);end if;end if;
 select * into r from ezshop.plan_requests where id=(payload->>'id')::bigint and (merchant_id=m.id or (m.is_admin and route='review')) for update;
 if not found then raise exception '找不到订阅申请';end if;
 if route='submit' then
  ref:=trim(coalesce(payload->>'reference',''));if length(ref) not between 6 and 160 or (r.method='usdt_trc20' and ref!~'^[a-fA-F0-9]{64}$') then raise exception '付款参考号或 TRON 交易哈希无效';end if;
  if r.method='usdt_trc20' then ref:=lower(ref);end if;
  if r.status='submitted' and r.reference=ref then return jsonb_build_object('ok',true);end if;
  if r.status<>'draft' then raise exception '申请已处理，不能修改';end if;
  update ezshop.plan_requests set status='submitted',reference=ref,updated=now() where id=r.id;
 elsif route='cancel' then
  if r.status<>'draft' then raise exception '付款资料已提交，请联系平台处理';end if;
  update ezshop.plan_requests set status='cancelled',updated=now() where id=r.id;
 elsif route='review' then
  if r.status<>'submitted' then raise exception '只能核实已提交付款资料的申请';end if;
  if payload->>'status'='approved' then
   period:=(payload->>'days')::int;ref:=trim(coalesce(payload->>'actual_reference',''));
   if (payload->'verified') is distinct from 'true'::jsonb or period is null or period not between 1 and 366 or length(ref) not between 6 and 160 or coalesce(payload->>'actual_amount','')!~'^[0-9]{1,8}(\.[0-9]{1,6})?$' then raise exception '请填写实际到账金额、参考号及开通天数';end if;
   if r.method='usdt_trc20' then ref:=lower(ref);if ref!~'^[a-f0-9]{64}$' then raise exception '实际 TRON 交易哈希无效';end if;end if;
   actual:=(payload->>'actual_amount')::numeric;if actual<=0 or (r.currency<>'USDT' and actual*100<>trunc(actual*100)) then raise exception '实际到账金额无效';end if;
   perform pg_advisory_xact_lock(r.merchant_id);
   select greatest(now(),paid_until) into until_time from ezshop.manual_plan_grants where merchant_id=r.merchant_id;
   until_time:=coalesce(until_time,now())+make_interval(days=>period);
   insert into ezshop.manual_plan_grants values(r.merchant_id,until_time,r.id) on conflict(merchant_id) do update set paid_until=excluded.paid_until,request_id=excluded.request_id;
   update ezshop.plan_requests set status='approved',actual_reference=ref,actual_amount=actual,days=period,approved_until=until_time,updated=now() where id=r.id;
   update ezshop.merchants set plan='pro' where id=r.merchant_id;
  elsif payload->>'status'='rejected' then
   if length(trim(coalesce(payload->>'note',''))) not between 1 and 500 then raise exception '请填写拒绝原因';end if;
   update ezshop.plan_requests set status='rejected',note=payload->>'note',updated=now() where id=r.id;
  else raise exception '审核状态无效';end if;
  insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(m.id,auth.uid()::text,'subscription.manual_review',r.id);
 else raise exception '不支持此订阅操作';end if;
 return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.ezshop_platform_billing_api(text,jsonb) from public;
grant execute on function public.ezshop_platform_billing_api(text,jsonb) to authenticated;
-- 每次受保护的商家访问都会核对人工服务期限，不只依赖界面显示。
do $$begin if to_regprocedure('public.ezshop_content_api(text,jsonb)') is null then alter function public.ezshop_api(text,jsonb) rename to ezshop_content_api;end if;end$$;
revoke all on function public.ezshop_content_api(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ezshop_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
begin
 if auth.uid() is not null then perform ezshop.apply_plan_expiry(auth.uid());end if;
 return public.ezshop_content_api(route,payload);
end;
$$;
revoke all on function public.ezshop_api(text,jsonb) from public;
grant execute on function public.ezshop_api(text,jsonb) to anon,authenticated,service_role;
-- Stripe 的真实订阅状态与有效人工授权可以并存；取消其中一个不会抹掉另一个。
do $$begin if to_regprocedure('public.ezshop_gateway_api(text,jsonb)') is null then alter function public.ezshop_payment_api(text,jsonb) rename to ezshop_gateway_api;end if;end$$;
revoke all on function public.ezshop_gateway_api(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ezshop_payment_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare result jsonb;
begin
 if route='owner-status' and auth.uid() is not null then perform ezshop.apply_plan_expiry(auth.uid());end if;
 result:=public.ezshop_gateway_api(route,payload);
 if route='service/subscription-sync' and exists(select 1 from ezshop.manual_plan_grants where merchant_id=(payload->>'merchant_id')::bigint and paid_until>now()) then update ezshop.merchants set plan='pro' where id=(payload->>'merchant_id')::bigint;end if;
 if route='owner-status' then return result||jsonb_build_object('manual_billing_enabled',exists(select 1 from ezshop.platform_receiving where bank_enabled or tng_enabled or usdt_enabled or stripe_enabled));end if;
 return result;
end;
$$;
revoke all on function public.ezshop_payment_api(text,jsonb) from public;
grant execute on function public.ezshop_payment_api(text,jsonb) to anon,authenticated,service_role;

$ezshop_migration_009$;
 end if;
end $upgrade_009$;

-- 202611050010_trial_access.sql · sha256 51c01b9208278639770bed85abe7e9b1eea7c013c58122f2048a280fe3b23e0d
do $upgrade_010$ begin
 if not (to_regprocedure('public.ezshop_subscription_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_subscription_payment_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_base_release_status()') is not null) then
  execute $ezshop_migration_010$
-- 新商家从建立店铺起试用七天；已有商家从本迁移开始获得七天过渡期。
-- 固定到期时间不可由浏览器重设。不删除到期店铺或已有订单。
alter table ezshop.merchants add column if not exists trial_ends_at timestamptz not null default (now()+interval '7 days');
create or replace function ezshop.subscription_access(mid bigint) returns boolean language sql stable security definer set search_path=pg_catalog,ezshop as $$
 select exists(select 1 from ezshop.merchants m where m.id=mid and m.status='active' and
 (m.is_admin or m.trial_ends_at>now()
 or exists(select 1 from ezshop.manual_plan_grants g where g.merchant_id=m.id and g.paid_until>now())
 or exists(select 1 from ezshop.billing_accounts b where b.merchant_id=m.id and b.paid_through>now() and ((b.status='active' and b.invoice_paid) or b.status='trialing'))));
$$;
revoke all on function ezshop.subscription_access(bigint) from public,anon,authenticated,service_role;
do $$begin if to_regprocedure('public.ezshop_subscription_api(text,jsonb)') is null then alter function public.ezshop_api(text,jsonb) rename to ezshop_subscription_api;end if;end$$;
revoke all on function public.ezshop_subscription_api(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ezshop_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare m ezshop.merchants%rowtype;member ezshop.memberships%rowtype;result jsonb;role_name text:='owner';allowed boolean;
begin
 if route in ('health','brand','order-result','join') or route like 'mail/%' then return public.ezshop_subscription_api(route,payload);end if;
 if route in ('store','checkout','shipping-quote') then
  select * into m from ezshop.merchants where slug=payload->>'slug' and status='active';
  if m.id is not null and not ezshop.subscription_access(m.id) then
   if route='store' then return jsonb_build_object('store',(to_jsonb(m)-'owner'-'email'-'is_admin'-'plan'-'status'-'trial_ends_at')||jsonb_build_object('subscription_access',false),'products','[]'::jsonb);end if;
   raise exception '店铺暂停接收新订单，请联系商家。';
  end if;
  result:=public.ezshop_subscription_api(route,payload);
  if route='store' then result:=jsonb_set(result,'{store}',((result->'store')-'trial_ends_at')||jsonb_build_object('subscription_access',true));end if;
  return result;
 end if;
 if auth.uid() is not null then
  select * into m from ezshop.merchants where owner=auth.uid();
  if m.id is null then
   select * into member from ezshop.memberships where user_id=auth.uid();
   if member.id is not null then select * into m from ezshop.merchants where id=member.merchant_id;role_name:=member.role;end if;
  end if;
  if m.id is not null and not ezshop.subscription_access(m.id) then
   if m.status<>'active' then raise exception '店铺已暂停，请联系平台管理员';end if;
   if route='dashboard' then return jsonb_build_object('merchant',(to_jsonb(m)-'owner')||jsonb_build_object('role',role_name,'is_admin',false,'subscription_access',false),'products','[]'::jsonb,'orders','[]'::jsonb,'agents','[]'::jsonb);end if;
   raise exception 'Pro试用或订阅已到期，请先续费。';
  end if;
 end if;
 result:=public.ezshop_subscription_api(route,payload);
 if route='dashboard' then
  select * into m from ezshop.merchants where id=(result->'merchant'->>'id')::bigint;
  result:=jsonb_set(result,'{merchant}',(result->'merchant')||jsonb_build_object('subscription_access',ezshop.subscription_access(m.id),'trial_ends_at',m.trial_ends_at));
 end if;
 return result;
end;
$$;
revoke all on function public.ezshop_api(text,jsonb) from public;
grant execute on function public.ezshop_api(text,jsonb) to anon,authenticated,service_role;
-- 续费入口始终保留；已有订单付款和签名事件继续处理，不能因商家到期丢单。
do $$begin if to_regprocedure('public.ezshop_subscription_payment_api(text,jsonb)') is null then alter function public.ezshop_payment_api(text,jsonb) rename to ezshop_subscription_payment_api;end if;end$$;
revoke all on function public.ezshop_subscription_payment_api(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ezshop_payment_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare result jsonb;ending timestamptz;
begin
 result:=public.ezshop_subscription_payment_api(route,payload);
 if route='owner-status' then
  select trial_ends_at into ending from ezshop.merchants where id=(result->>'merchant_id')::bigint;
  return result||jsonb_build_object('trial_ends_at',ending,'subscription_access',ezshop.subscription_access((result->>'merchant_id')::bigint));
 end if;
 return result;
end;
$$;
revoke all on function public.ezshop_payment_api(text,jsonb) from public;
grant execute on function public.ezshop_payment_api(text,jsonb) to anon,authenticated,service_role;
-- Storage 也校验订阅状态，不能绕过已到期的商家页面上传。
create or replace function public.ezshop_can_upload_media() returns boolean language sql stable security definer set search_path=pg_catalog,ezshop as $$
 select exists(select 1 from ezshop.merchants m where m.owner=auth.uid() and ezshop.subscription_access(m.id))
 or exists(select 1 from ezshop.memberships t where t.user_id=auth.uid() and t.role in ('inventory','manager') and ezshop.subscription_access(t.merchant_id));
$$;
revoke all on function public.ezshop_can_upload_media() from public,anon;
grant execute on function public.ezshop_can_upload_media() to authenticated;
do $$begin if to_regprocedure('public.ezshop_base_release_status()') is null then alter function public.ezshop_release_status() rename to ezshop_base_release_status;end if;end$$;
revoke all on function public.ezshop_base_release_status() from public,anon,authenticated,service_role;
create or replace function public.ezshop_release_status() returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;locked boolean;
begin
 result:=public.ezshop_base_release_status();
 select bool_and(not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')) into locked from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('ezshop_subscription_api','ezshop_subscription_payment_api','ezshop_base_release_status');
 return result||jsonb_build_object('features',(result->'features')||jsonb_build_object('trial_access',true),'internal_rpc_locked',coalesce(locked,false) and (result->>'internal_rpc_locked')::boolean,'database_ready',coalesce(locked,false) and (result->>'database_ready')::boolean);
end;
$$;
revoke all on function public.ezshop_release_status() from public;
grant execute on function public.ezshop_release_status() to anon,authenticated,service_role;

$ezshop_migration_010$;
 end if;
end $upgrade_010$;

-- 202611050011_merchant_receiving.sql · sha256 ef6c0c4207f7bf661dcf780704d0c66858e81b0466d081cb7e2409c0ce79d37a
do $upgrade_011$ begin
 if not (to_regprocedure('public.ezshop_trial_api(text,jsonb)') is not null and to_regclass('ezshop.merchant_receiving') is not null) then
  execute $ezshop_migration_011$
-- 商家顾客商品款账户与平台订阅费账户完全分开。只在受凭证保护的订单结果中提供付款资料。
create table if not exists ezshop.merchant_receiving(
 merchant_id bigint primary key references ezshop.merchants(id),bank_enabled boolean not null default false,
 bank_name text not null default '',holder text not null default '',account text not null default '',instructions text not null default '',
 wallet_enabled boolean not null default false,wallet_name text not null default '',wallet_identifier text not null default '',wallet_qr text not null default '',
 usdt_enabled boolean not null default false,usdt_network text not null default '',usdt_address text not null default '',
 link_enabled boolean not null default false,payment_link text not null default '',version bigint not null default 0
);
create or replace function ezshop.receiving_https_url(value text) returns boolean language sql immutable set search_path=pg_catalog as $$
 select value ~* '^https://[a-z0-9][a-z0-9.-]*\.[a-z]{2,63}(:[0-9]{1,5})?([/?#][^[:space:]]*)?$';
$$;
revoke all on function ezshop.receiving_https_url(text) from public,anon,authenticated,service_role;
alter table ezshop.merchant_receiving enable row level security;
revoke all on ezshop.merchant_receiving from public,anon,authenticated,service_role;
alter table ezshop.orders add column if not exists payment_instructions jsonb;
-- 不给历史订单追加新的收款账户，以免误导已安排付款的顾客。
update ezshop.orders set payment_instructions='{}'::jsonb where payment_instructions is null;
do $$begin if to_regprocedure('public.ezshop_trial_api(text,jsonb)') is null then alter function public.ezshop_api(text,jsonb) rename to ezshop_trial_api;end if;end$$;
revoke all on function public.ezshop_trial_api(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ezshop_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare m ezshop.merchants%rowtype;c ezshop.merchant_receiving%rowtype;result jsonb;info jsonb;flag text;
begin
 if route in ('receiving','receiving/save') then
  select * into m from ezshop.merchants where owner=auth.uid() and status='active';
  if not found then raise exception '需要商家所有者权限';end if;
  if route='receiving/save' then
   if not ezshop.subscription_access(m.id) then raise exception 'Pro试用或订阅已到期，请先续费。';end if;
   foreach flag in array array['bank_enabled','wallet_enabled','usdt_enabled','link_enabled'] loop
    if jsonb_typeof(payload->flag) is distinct from 'boolean' then raise exception '商家收款资料无效，请检查银行、户名和账号。';end if;
   end loop;
   if coalesce(payload->>'version','')!~'^[0-9]+$' or length(coalesce(payload->>'bank_name',''))>120 or length(coalesce(payload->>'holder',''))>120 or length(coalesce(payload->>'account',''))>64
    or length(coalesce(payload->>'instructions',''))>500 or length(coalesce(payload->>'wallet_name',''))>60 or length(coalesce(payload->>'wallet_identifier',''))>120
    or length(coalesce(payload->>'wallet_qr',''))>2000 or length(coalesce(payload->>'payment_link',''))>2000 or length(coalesce(payload->>'usdt_address',''))>128 or length(coalesce(payload->>'usdt_network',''))>20 then raise exception '商家收款资料无效，请检查银行、户名和账号。';end if;
   if (payload->>'bank_enabled')::boolean and (length(trim(coalesce(payload->>'bank_name','')))=0 or length(trim(coalesce(payload->>'holder','')))=0 or coalesce(payload->>'account','')!~'^[A-Za-z0-9 -]{5,64}$') then raise exception '商家收款资料无效，请检查银行、户名和账号。';end if;
   if (coalesce(payload->>'wallet_qr','')<>'' and not ezshop.receiving_https_url(payload->>'wallet_qr')) or (coalesce(payload->>'payment_link','')<>'' and not ezshop.receiving_https_url(payload->>'payment_link')) then raise exception '收款链接及二维码必须使用有效的HTTPS网址。';end if;
   if (payload->>'wallet_enabled')::boolean and (length(trim(coalesce(payload->>'wallet_name','')))=0 or (length(trim(coalesce(payload->>'wallet_identifier','')))=0 and coalesce(payload->>'wallet_qr','')='')) then raise exception '请填写电子钱包名称及账号，或上传真实收款二维码。';end if;
   if (payload->>'usdt_enabled')::boolean and not coalesce(((payload->>'usdt_network'='TRC20' and ezshop.valid_tron_address(payload->>'usdt_address')) or (payload->>'usdt_network' in ('ERC20','BEP20') and coalesce(payload->>'usdt_address','')~'^0x[0-9A-Fa-f]{40}$')),false) then raise exception 'USDT网络或收款地址无效，请核对后保存。';end if;
   if (payload->>'link_enabled')::boolean and not coalesce(ezshop.receiving_https_url(payload->>'payment_link'),false) then raise exception '收款链接及二维码必须使用有效的HTTPS网址。';end if;
   perform pg_advisory_xact_lock(m.id);
   insert into ezshop.merchant_receiving(merchant_id) values(m.id) on conflict do nothing;
   update ezshop.merchant_receiving set bank_enabled=(payload->>'bank_enabled')::boolean,wallet_enabled=(payload->>'wallet_enabled')::boolean,usdt_enabled=(payload->>'usdt_enabled')::boolean,link_enabled=(payload->>'link_enabled')::boolean,
    bank_name=trim(coalesce(payload->>'bank_name','')),holder=trim(coalesce(payload->>'holder','')),account=trim(coalesce(payload->>'account','')),instructions=trim(coalesce(payload->>'instructions','')),
    wallet_name=trim(coalesce(payload->>'wallet_name','')),wallet_identifier=trim(coalesce(payload->>'wallet_identifier','')),wallet_qr=coalesce(payload->>'wallet_qr',''),
    usdt_network=coalesce(payload->>'usdt_network',''),usdt_address=trim(coalesce(payload->>'usdt_address','')),payment_link=coalesce(payload->>'payment_link',''),version=version+1
    where merchant_id=m.id and version=(payload->>'version')::bigint returning * into c;
   if not found then raise exception '收款资料已更新，请刷新后重新编辑。';end if;
   insert into ezshop.audit_log(merchant_id,actor,action) values(m.id,auth.uid()::text,'receiving.update');
  else
   select * into c from ezshop.merchant_receiving where merchant_id=m.id;
  end if;
  return jsonb_build_object('receiving',case when c.merchant_id is null then jsonb_build_object('bank_enabled',false,'wallet_enabled',false,'usdt_enabled',false,'link_enabled',false,'bank_name','','holder','','account','','instructions','','wallet_name','','wallet_identifier','','wallet_qr','','usdt_network','','usdt_address','','payment_link','','version',0) else to_jsonb(c)-'merchant_id' end);
 end if;
 result:=public.ezshop_trial_api(route,payload);
 if route='checkout' then
  update ezshop.orders r set payment_instructions=coalesce((select jsonb_strip_nulls(jsonb_build_object(
   'bank',case when config.bank_enabled then jsonb_build_object('bank_name',config.bank_name,'holder',config.holder,'account',config.account) end,
   'wallet',case when config.wallet_enabled then jsonb_build_object('name',config.wallet_name,'identifier',config.wallet_identifier,'qr',config.wallet_qr) end,
   'usdt',case when config.usdt_enabled then jsonb_build_object('network',config.usdt_network,'address',config.usdt_address) end,
   'link',case when config.link_enabled then config.payment_link end,'instructions',config.instructions))
   from ezshop.merchant_receiving config where config.merchant_id=r.merchant_id and (config.bank_enabled or config.wallet_enabled or config.usdt_enabled or config.link_enabled)),'{}'::jsonb)
   where r.reference=result->>'reference' and r.access_token=result->>'access_token' and r.payment_instructions is null;
 end if;
 if route='order-result' then
  select payment_instructions into info from ezshop.orders where reference=result->'order'->>'reference';
  return result||jsonb_build_object('payment_instructions',coalesce(info,'{}'::jsonb));
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
 select bool_and(not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')) into locked from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('ezshop_subscription_api','ezshop_subscription_payment_api','ezshop_base_release_status','ezshop_trial_api');
 ready:=to_regclass('ezshop.merchant_receiving') is not null and exists(select 1 from information_schema.columns where table_schema='ezshop' and table_name='orders' and column_name='payment_instructions');
 return result||jsonb_build_object('features',(result->'features')||jsonb_build_object('trial_access',true,'merchant_receiving',ready),'internal_rpc_locked',coalesce(locked,false) and (result->>'internal_rpc_locked')::boolean,'database_ready',ready and coalesce(locked,false) and (result->>'database_ready')::boolean);
end;
$$;
revoke all on function public.ezshop_release_status() from public;
grant execute on function public.ezshop_release_status() to anon,authenticated,service_role;

$ezshop_migration_011$;
 end if;
end $upgrade_011$;

-- 202611050012_customer_accounts.sql · sha256 8b1ec82141499f09da631203cdb0de7ebc74bedf5ababfe3c56599df44f64500
do $upgrade_012$ begin
 if not (to_regprocedure('public.ezshop_customer_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_receiving_api(text,jsonb)') is not null) then
  execute $ezshop_migration_012$
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

$ezshop_migration_012$;
 end if;
end $upgrade_012$;

-- 202611050013_bookkeeping.sql · sha256 f7c406045f63827909276037cc89770b2b22ddafbe3de2e5a02cd7fc5f61bed4
do $upgrade_013$ begin
 if not (to_regprocedure('public.ezshop_customer_store_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_books_api(text,jsonb)') is not null) then
  execute $ezshop_migration_013$
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

$ezshop_migration_013$;
 end if;
end $upgrade_013$;

-- 202611050014_platform_read.sql · sha256 3b484cb73a5e5eb18d17b10cbf58fb777d8da45db0659ea07d72f143e9ba853d
do $upgrade_014$ begin
 if not (to_regprocedure('public.ezshop_platform_read_api(text,jsonb)') is not null and to_regprocedure('public.ezshop_platform_read_status()') is not null) then
  execute $ezshop_migration_014$
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

$ezshop_migration_014$;
 end if;
end $upgrade_014$;

-- 202611050015_regional_currency.sql · sha256 13c62af3d0b2aced7b6f64552a3746661fe849878aa27240bf01042f2e10e5d3
do $upgrade_015$ begin
 if not (to_regprocedure('public.ezshop_region_status()') is not null) then
  execute $ezshop_migration_015$
-- 商家国家/币种及不可变交易快照。旧数据保持MYR，不自动换汇。
alter table ezshop.merchants add column if not exists country_code text not null default 'MY' check(country_code in ('MY','SG','TH','KH','VN'));
alter table ezshop.merchants add column if not exists currency text not null default 'MYR' check(currency in ('MYR','SGD','THB','KHR','USD','VND'));
alter table ezshop.merchants add constraint merchant_region_currency check((country_code='MY' and currency='MYR') or (country_code='SG' and currency='SGD') or (country_code='TH' and currency='THB') or (country_code='KH' and currency in ('KHR','USD')) or (country_code='VN' and currency='VND'));
alter table ezshop.orders add column if not exists currency text not null default 'MYR' check(currency in ('MYR','SGD','THB','KHR','USD','VND'));
alter table ezshop.orders add column if not exists country_code text not null default 'MY' check(country_code in ('MY','SG','TH','KH','VN'));
alter table ezshop.finance_events add column if not exists currency text not null default 'MYR';
alter table ezshop.finance_entries add column if not exists currency text not null default 'MYR';
alter table ezshop.payouts add column if not exists currency text not null default 'MYR';
create or replace function ezshop.shop_timezone(mid bigint) returns text language sql stable security definer set search_path=pg_catalog,ezshop as $$
 select case country_code when 'SG' then 'Asia/Singapore' when 'TH' then 'Asia/Bangkok' when 'KH' then 'Asia/Phnom_Penh' when 'VN' then 'Asia/Ho_Chi_Minh' else 'Asia/Kuala_Lumpur' end from ezshop.merchants where id=mid;
$$;
revoke all on function ezshop.shop_timezone(bigint) from public,anon,authenticated,service_role;
create or replace function ezshop.currency_locked(mid bigint) returns boolean language sql stable security definer set search_path=pg_catalog,ezshop as $$
 select exists(select 1 from ezshop.products where merchant_id=mid) or exists(select 1 from ezshop.orders where merchant_id=mid) or exists(select 1 from ezshop.finance_events where merchant_id=mid) or exists(select 1 from ezshop.finance_entries where merchant_id=mid) or exists(select 1 from ezshop.payouts where merchant_id=mid) or exists(select 1 from ezshop.merchant_payments where merchant_id=mid);
$$;
revoke all on function ezshop.currency_locked(bigint) from public,anon,authenticated,service_role;
create or replace function ezshop.currency_snapshot() returns trigger language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare store ezshop.merchants%rowtype;
begin
 if tg_op='UPDATE' then
  if new.currency is distinct from old.currency then raise exception '交易币种不能修改';end if;
  if tg_table_name='orders' and to_jsonb(new)->>'country_code' is distinct from to_jsonb(old)->>'country_code' then raise exception '订单国家不能修改';end if;
 else
  select * into store from ezshop.merchants where id=new.merchant_id;
  if not found then raise exception '找不到商家';end if;
  new.currency:=store.currency;
  if tg_table_name='orders' then new.country_code:=store.country_code;end if;
 end if;
 return new;
end;
$$;
revoke all on function ezshop.currency_snapshot() from public,anon,authenticated,service_role;
create trigger ezshop_order_currency before insert or update on ezshop.orders for each row execute function ezshop.currency_snapshot();
create trigger ezshop_event_currency before insert or update on ezshop.finance_events for each row execute function ezshop.currency_snapshot();
create trigger ezshop_entry_currency before insert or update on ezshop.finance_entries for each row execute function ezshop.currency_snapshot();
create trigger ezshop_payout_currency before insert or update on ezshop.payouts for each row execute function ezshop.currency_snapshot();
create or replace function ezshop.regional_destination(country_code text,p jsonb,fee bigint) returns void language plpgsql immutable set search_path=pg_catalog as $$
declare state text:=coalesce(p->>'state','');postcode text:=coalesce(p->>'postcode','');city text:=trim(coalesce(p->>'city',''));
begin
 if coalesce(p->>'country',country_code)<>country_code then raise exception '请填写商家所在国家的配送地址';end if;
 if country_code='MY' then
  if fee>0 or state<>'' or postcode<>'' or city<>'' then
   if state not in ('Johor','Kedah','Kelantan','Kuala Lumpur','Labuan','Melaka','Negeri Sembilan','Pahang','Penang','Perak','Perlis','Putrajaya','Sabah','Sarawak','Selangor','Terengganu') then raise exception '请选择马来西亚配送州属';end if;
   if postcode!~'^[0-9]{5}$' or length(city) not between 1 and 100 then raise exception '请填写有效的城市、5 位邮编及马来西亚收货地址';end if;
  end if;
 else
  if length(city) not between 1 and 100 or length(state)>100 or (country_code<>'SG' and length(trim(state))=0) or not ((country_code='SG' and postcode~'^[0-9]{6}$') or (country_code in ('TH','VN') and postcode~'^[0-9]{5}$') or (country_code='KH' and postcode~'^[0-9]{5,6}$')) then raise exception '请填写有效的当地城市、地区及邮编';end if;
 end if;
end;
$$;
revoke all on function ezshop.regional_destination(text,jsonb,bigint) from public,anon,authenticated,service_role;
create or replace function public.ezshop_delivery_api(route text,payload jsonb default '{}'::jsonb) returns jsonb
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
  perform ezshop.regional_destination(m.country_code,payload,m.shipping_fee);
  update ezshop.orders set subtotal=o.total,shipping=m.shipping_fee,total=o.total+m.shipping_fee,state=v_state,postcode=v_postcode,city=v_city where id=o.id;
  return result||jsonb_build_object('subtotal',o.total,'shipping',m.shipping_fee,'total',o.total+m.shipping_fee);
 end if;
 if route='settings' then
  result:=public.ezshop_finance_api(route,payload); -- 复用所有者权限验证和现有资料校验。
  select * into m from ezshop.merchants where owner=auth.uid();
  if payload ? 'shipping_fee' and (jsonb_typeof(payload->'shipping_fee') is distinct from 'number' or coalesce(payload->>'shipping_fee','') !~ '^[0-9]+$') then raise exception '邮费须为币种最小单位整数'; end if;
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
create or replace function public.ezshop_gateway_api(route text,payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
#variable_conflict use_column
declare m ezshop.merchants%rowtype;o ezshop.orders%rowtype;p ezshop.merchant_payments%rowtype;s ezshop.payment_sessions%rowtype;b ezshop.billing_accounts%rowtype;c ezshop.billing_checkouts%rowtype;
 service boolean:=current_setting('request.jwt.claim.role',true)='service_role' or coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'='service_role';
 next_attempt int;event_id text;reason text;state text;period_end bigint;paid boolean;mid bigint;inserted text;
begin
 if route='store-options' then
  select * into m from ezshop.merchants where slug=payload->>'slug' and status='active';
  if not found then raise exception '店铺不存在'; end if;
  return jsonb_build_object('online_enabled',exists(select 1 from ezshop.merchant_payments where merchant_id=m.id and charges_enabled and details_submitted));
 end if;
 if route='order-summary' then
  select r.* into o from ezshop.orders r join ezshop.merchants t on t.id=r.merchant_id where r.reference=payload->>'reference' and r.access_token=payload->>'token' and t.slug=payload->>'slug';
  if not found then raise exception '订单不存在或访问凭证无效'; end if;
  return jsonb_build_object('online_enabled',exists(select 1 from ezshop.merchant_payments where merchant_id=o.merchant_id and charges_enabled and details_submitted),
   'requires_review',exists(select 1 from ezshop.payment_reviews where order_id=o.id and not resolved),'order_status',o.status);
 end if;
 if route='owner-status' then
  select * into m from ezshop.merchants where owner=auth.uid() and status='active';if not found then raise exception '需要商家所有者权限'; end if;
  select * into p from ezshop.merchant_payments where merchant_id=m.id;
  select * into b from ezshop.billing_accounts where merchant_id=m.id;
  return jsonb_build_object('merchant_id',m.id,'country_code',m.country_code,'currency',m.currency,'email',m.email,'name',m.name,'plan',m.plan,'account_id',p.account_id,'charges_enabled',coalesce(p.charges_enabled,false),'payouts_enabled',coalesce(p.payouts_enabled,false),
   'billing',case when b.merchant_id is null then '{}'::jsonb else to_jsonb(b) end,
   'reviews',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select r.id,r.order_id,o.reference,r.reason,r.created,r.resolved from ezshop.payment_reviews r left join ezshop.orders o on o.id=r.order_id where r.merchant_id=m.id or m.is_admin order by r.id desc limit 100) x));
 end if;
 if route='resolve-review' then
  select * into m from ezshop.merchants where owner=auth.uid() and status='active';if not found then raise exception '需要商家所有者权限'; end if;
  reason:=trim(coalesce(payload->>'resolution',''));if length(reason) not between 1 and 500 then raise exception '请填写外部处理结果及参考号'; end if;
  update ezshop.payment_reviews set resolved=true,resolution=reason where id=(payload->>'id')::bigint and (merchant_id=m.id or m.is_admin);
  if not found then raise exception '找不到待处理记录'; end if;
  insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(m.id,auth.uid()::text,'payment.review_resolved',(payload->>'id')::bigint);
  return jsonb_build_object('ok',true);
 end if;
 -- service 标记仅来自 Supabase 验证过的 JWT，不能由客户端 payload 自行指定。
 if service is distinct from true then raise exception '需要服务端权限'; end if;
 if route='service/bind-account' then
  mid:=(payload->>'merchant_id')::bigint;
  insert into ezshop.merchant_payments(merchant_id,account_id) values(mid,payload->>'account_id') on conflict(merchant_id) do nothing;
  select * into p from ezshop.merchant_payments where merchant_id=mid;
  if p.account_id<>payload->>'account_id' then raise exception '此商家已绑定其他收款账户'; end if;
  return jsonb_build_object('ok',true);
 end if;
 if route='service/account-status' then
  update ezshop.merchant_payments set charges_enabled=coalesce((payload->>'charges_enabled')::boolean,false),payouts_enabled=coalesce((payload->>'payouts_enabled')::boolean,false),details_submitted=coalesce((payload->>'details_submitted')::boolean,false),updated=now() where account_id=payload->>'account_id';
  return jsonb_build_object('ok',true);
 end if;
 if route='service/order-claim' then
  select r.* into o from ezshop.orders r join ezshop.merchants t on t.id=r.merchant_id where r.reference=payload->>'reference' and r.access_token=payload->>'token' and t.status='active';
  if not found then raise exception '订单不存在或访问凭证无效'; end if;
  perform pg_advisory_xact_lock(o.merchant_id);
  select * into o from ezshop.orders where id=o.id for update;
  if o.status<>'pending' then raise exception '此订单不能继续付款'; end if;
  if exists(select 1 from ezshop.payment_reviews where order_id=o.id and not resolved) then raise exception '付款需要商家核查，请勿重复付款'; end if;
  select * into p from ezshop.merchant_payments where merchant_id=o.merchant_id and charges_enabled and details_submitted;
  if not found then raise exception '商家尚未开通线上收款'; end if;
  select * into m from ezshop.merchants where id=o.merchant_id;
  select * into s from ezshop.payment_sessions where order_id=o.id order by attempt desc limit 1 for update;
  if s.id is null or s.status='expired' then
   next_attempt:=coalesce(s.attempt,0)+1;
   insert into ezshop.payment_sessions(merchant_id,order_id,attempt,account_id,amount,currency) values(o.merchant_id,o.id,next_attempt,p.account_id,o.total,lower(o.currency)) returning * into s;
  end if;
  if s.session_id is null and s.created<now()-interval '23 hours' then raise exception '付款请求需人工核实，请联系商家'; end if;
  if s.status='complete' or s.account_id<>p.account_id then raise exception '付款正在核实，请勿重复付款'; end if;
  return to_jsonb(s)||jsonb_build_object('reference',o.reference,'email',o.email,'slug',m.slug,'store_name',m.name);
 end if;
 if route='service/save-order-session' then
  update ezshop.payment_sessions set session_id=payload->>'session_id',status='open' where id=(payload->>'attempt_id')::bigint and (session_id is null or session_id=payload->>'session_id') and status in ('creating','open');
  if not found then raise exception '支付请求已变更，请重新核实'; end if;
  return jsonb_build_object('ok',true);
 end if;
 if route='service/expire-order-session' then
  update ezshop.payment_sessions set status='expired' where session_id=payload->>'session_id' and account_id=payload->>'account_id' and status in ('creating','open');
  return jsonb_build_object('ok',true);
 end if;
 if route='service/payment-completed' then
  event_id:=payload->>'event_id';if event_id is null or length(event_id)>200 then raise exception '事件标识无效'; end if;
  select * into s from ezshop.payment_sessions where session_id=payload->>'session_id';if not found then raise exception '找不到待核实的支付请求'; end if;
  perform pg_advisory_xact_lock(s.merchant_id);
  insert into ezshop.webhook_events(id,kind) values(event_id,'order.payment') on conflict(id) do nothing returning id into inserted;
  if inserted is null then return jsonb_build_object('ok',true,'duplicate',true); end if;
  select * into s from ezshop.payment_sessions where id=s.id for update;
  select * into o from ezshop.orders where id=s.order_id for update;
  reason:=case when s.account_id is distinct from payload->>'account_id' then 'account_mismatch'
   when lower(coalesce(payload->>'currency',''))<>s.currency or (payload->>'amount')::bigint is distinct from s.amount or o.total<>s.amount then 'amount_mismatch'
   when s.status='complete' then null
   when o.status<>'pending' then 'order_state_changed' else null end;
  if reason is not null then
   insert into ezshop.payment_reviews(merchant_id,order_id,event_id,reason) values(s.merchant_id,o.id,event_id,reason);
   update ezshop.webhook_events set outcome='requires_review' where id=event_id;
   return jsonb_build_object('ok',true,'requires_review',true);
  end if;
  if s.status='complete' then return jsonb_build_object('ok',true,'duplicate',true); end if;
  update ezshop.orders set status='paid' where id=o.id;
  update ezshop.payment_sessions set status='complete',payment_intent=payload->>'payment_intent' where id=s.id;
  insert into ezshop.notification_jobs(merchant_id,order_id,kind,event_key) values(s.merchant_id,o.id,'receipt','receipt:'||o.id::text) on conflict(event_key) do nothing;
  insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(s.merchant_id,'stripe','payment.verified',o.id);
  return jsonb_build_object('ok',true);
 end if;
 if route='service/charge-adjustment' then
  event_id:=payload->>'event_id';if coalesce(event_id,'')='' or length(event_id)>200 then raise exception '事件标识无效'; end if;
  select * into s from ezshop.payment_sessions where payment_intent=payload->>'payment_intent' and account_id=payload->>'account_id' and status='complete';
  if not found then
   if exists(select 1 from ezshop.orders r join ezshop.payment_sessions x on x.order_id=r.id where r.reference=payload->>'reference' and x.account_id=payload->>'account_id') then raise exception '付款记录尚未完成，请重试事件'; end if;
   return jsonb_build_object('ok',true,'ignored',true);
  end if;
  perform pg_advisory_xact_lock(s.merchant_id);
  insert into ezshop.webhook_events(id,kind) values(event_id,'order.adjustment') on conflict(id) do nothing returning id into inserted;
  if inserted is null then return jsonb_build_object('ok',true,'duplicate',true); end if;
  select * into o from ezshop.orders where id=s.order_id for update;
  if payload->>'kind'='refund' and lower(coalesce(payload->>'currency',''))=s.currency and (payload->>'amount')::bigint=s.amount and (payload->>'refunded')::bigint=s.amount then
   if o.status='paid' then
    update ezshop.orders set status='refunded',refund_reference=payload->>'charge_id',stock_returned=false,refunded_at=now() where id=o.id;
    if o.agent_id is not null then update ezshop.payouts set status='rejected',reference='关联订单退款，请重新申请',updated=now() where merchant_id=s.merchant_id and agent_id=o.agent_id and status='requested'; end if;
    insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(s.merchant_id,'stripe','refund.verified',o.id);
   elsif o.status<>'refunded' then
    insert into ezshop.payment_reviews(merchant_id,order_id,event_id,reason) values(s.merchant_id,o.id,event_id,'refund_state_changed');
   end if;
  else
   insert into ezshop.payment_reviews(merchant_id,order_id,event_id,reason) values(s.merchant_id,o.id,event_id,case when payload->>'kind'='dispute' then 'payment_disputed' else 'partial_refund_or_mismatch' end);
   update ezshop.webhook_events set outcome='requires_review' where id=event_id;
  end if;
  return jsonb_build_object('ok',true);
 end if;
 if route='service/bind-customer' then
  mid:=(payload->>'merchant_id')::bigint;
  insert into ezshop.billing_accounts(merchant_id,customer_id) values(mid,payload->>'customer_id') on conflict(merchant_id) do nothing;
  select * into b from ezshop.billing_accounts where merchant_id=mid;
  if b.customer_id<>payload->>'customer_id' then raise exception '此商家已绑定其他订阅账户'; end if;
  return jsonb_build_object('ok',true);
 end if;
 if route='service/billing-claim' then
  mid:=(payload->>'merchant_id')::bigint;perform pg_advisory_xact_lock(mid);
  select * into b from ezshop.billing_accounts where merchant_id=mid for update;
  if not found then raise exception '订阅客户尚未建立'; end if;
  if b.subscription_id is not null and b.status not in ('canceled','incomplete_expired','none') then raise exception '已有订阅，请使用订阅管理入口'; end if;
  select * into c from ezshop.billing_checkouts where merchant_id=mid order by attempt desc limit 1 for update;
  if c.id is null or c.status='expired' or (c.status='complete' and b.status in ('canceled','incomplete_expired')) then
   next_attempt:=coalesce(c.attempt,0)+1;
   insert into ezshop.billing_checkouts(merchant_id,attempt,price_id) values(mid,next_attempt,payload->>'price_id') returning * into c;
  end if;
  if c.session_id is null and c.created<now()-interval '23 hours' then raise exception '订阅请求需人工核实，请联系平台'; end if;
  if c.status='complete' then raise exception '订阅正在核实，请勿重复开通'; end if;
  return to_jsonb(c)||jsonb_build_object('customer_id',b.customer_id);
 end if;
 if route='service/save-billing-session' then
  update ezshop.billing_checkouts set session_id=payload->>'session_id',status='open' where id=(payload->>'attempt_id')::bigint and (session_id is null or session_id=payload->>'session_id') and status in ('creating','open');
  if not found then raise exception '订阅请求已变更'; end if;return jsonb_build_object('ok',true);
 end if;
 if route='service/expire-billing-session' then
  update ezshop.billing_checkouts set status='expired' where session_id=payload->>'session_id' and status in ('creating','open');return jsonb_build_object('ok',true);
 end if;
 if route='service/subscription-sync' then
  mid:=(payload->>'merchant_id')::bigint;perform pg_advisory_xact_lock(mid);
  select * into b from ezshop.billing_accounts where merchant_id=mid for update;
  if not found or b.customer_id is distinct from payload->>'customer_id' then raise exception '订阅客户不匹配'; end if;
  event_id:=payload->>'event_id';if event_id is null or length(event_id)>200 then raise exception '事件标识无效'; end if;
  insert into ezshop.webhook_events(id,kind) values(event_id,'billing.subscription') on conflict(id) do nothing returning id into inserted;
  if inserted is null then return jsonb_build_object('ok',true,'duplicate',true); end if;
  if coalesce((payload->>'event_created')::bigint,0)<b.last_event_created then
   update ezshop.webhook_events set outcome='outdated' where id=event_id;return jsonb_build_object('ok',true,'outdated',true);
  end if;
  if b.subscription_id=payload->>'subscription_id' and b.status in ('canceled','incomplete_expired') and payload->>'status' in ('active','trialing') then
   update ezshop.webhook_events set outcome='outdated' where id=event_id;return jsonb_build_object('ok',true,'outdated',true);
  end if;
  if not exists(select 1 from ezshop.billing_checkouts where merchant_id=mid and price_id=payload->>'price_id') then
   insert into ezshop.payment_reviews(merchant_id,event_id,reason) values(mid,event_id,'subscription_price_mismatch');
   return jsonb_build_object('ok',true,'requires_review',true);
  end if;
  if b.subscription_id is not null and b.subscription_id<>payload->>'subscription_id' and b.status not in ('none','canceled','incomplete_expired') then
   insert into ezshop.payment_reviews(merchant_id,event_id,reason) values(mid,event_id,'multiple_subscriptions');
   return jsonb_build_object('ok',true,'requires_review',true);
  end if;
  state:=payload->>'status';period_end:=coalesce((payload->>'period_end')::bigint,0);paid:=coalesce((payload->>'invoice_paid')::boolean,false);
  if state not in ('active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused') then raise exception '订阅状态无效'; end if;
  update ezshop.billing_accounts set subscription_id=payload->>'subscription_id',status=state,price_id=payload->>'price_id',paid_through=case when period_end>0 then to_timestamp(period_end) else null end,invoice_paid=paid,last_event_created=coalesce((payload->>'event_created')::bigint,0),updated=now() where merchant_id=mid;
  update ezshop.billing_checkouts set status='complete' where merchant_id=mid and status in ('creating','open');
  update ezshop.merchants set plan=case when period_end>extract(epoch from now()) and ((state='active' and paid) or state='trialing') then 'pro' else 'free' end where id=mid;
  insert into ezshop.audit_log(merchant_id,actor,action) values(mid,'stripe','subscription.'||state);
  return jsonb_build_object('ok',true);
 end if;
 raise exception '不支持此支付操作';
end;
$$;
do $$begin if to_regprocedure('public.ezshop_pre_region_api(text,jsonb)') is null then alter function public.ezshop_api(text,jsonb) rename to ezshop_pre_region_api;end if;end$$;
revoke all on function public.ezshop_pre_region_api(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ezshop_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
#variable_conflict use_column
declare result jsonb;m ezshop.merchants%rowtype;member ezshop.memberships%rowtype;new_store boolean:=false;metadata jsonb;country text;cur text;o ezshop.orders%rowtype;
begin
 if auth.uid() is not null then
  select * into m from ezshop.merchants where owner=auth.uid();
  if not found then select * into member from ezshop.memberships where user_id=auth.uid();if found then select * into m from ezshop.merchants where id=member.merchant_id;elsif route='dashboard' then new_store:=true;end if;end if;
 end if;
 if route='checkout' then select * into m from ezshop.merchants where slug=payload->>'slug';end if;
 if m.id is not null and route in ('checkout','settings','products','products/update','payouts/request') then perform pg_advisory_xact_lock(m.id);select * into m from ezshop.merchants where id=m.id for update;end if;
 if m.id is not null and route in ('products','products/update','payouts/request','checkout') and coalesce(payload->>'currency','MYR') is distinct from m.currency then raise exception '币种已变化，请刷新后重新填写金额';end if;
 if route='settings' and (payload?'country_code' or payload?'currency') then
  if m.owner is distinct from auth.uid() then raise exception '需要商家所有者权限';end if;
  country:=coalesce(payload->>'country_code',m.country_code);cur:=coalesce(payload->>'currency',m.currency);
  if (country,cur) is distinct from (m.country_code,m.currency) then
   if ezshop.currency_locked(m.id) or m.shipping_fee<>0 then raise exception '店铺已有商品、交易或邮费，请勿直接转换币种';end if;
   update ezshop.merchants set country_code=country,currency=cur where id=m.id;
   insert into ezshop.audit_log(merchant_id,actor,action) values(m.id,auth.uid()::text,'store.region:'||country||':'||cur);
  end if;
 end if;
 result:=public.ezshop_pre_region_api(route,payload);
 if route='dashboard' then
  select * into m from ezshop.merchants where id=(result->'merchant'->>'id')::bigint;
  if new_store then
   select raw_user_meta_data into metadata from auth.users where id=auth.uid();
   country:=coalesce(metadata->>'country_code','MY');cur:=coalesce(metadata->>'currency',case country when 'SG' then 'SGD' when 'TH' then 'THB' when 'KH' then 'KHR' when 'VN' then 'VND' else 'MYR' end);
   update ezshop.merchants set country_code=country,currency=cur where id=m.id returning * into m;
  end if;
  result:=jsonb_set(result,'{merchant}',(result->'merchant')||jsonb_build_object('country_code',m.country_code,'currency',m.currency,'regional_enabled',true,'currency_locked',ezshop.currency_locked(m.id) or m.shipping_fee<>0));
  result:=jsonb_set(result,'{orders}',coalesce((select jsonb_agg(v||jsonb_build_object('currency',o.currency,'country_code',o.country_code)) from jsonb_array_elements(result->'orders') v join ezshop.orders o on o.id=(v->>'id')::bigint),'[]'::jsonb));
 elsif route='store' then
  select * into m from ezshop.merchants where slug=payload->>'slug';
  result:=jsonb_set(result,'{store}',(result->'store')||jsonb_build_object('country_code',m.country_code,'currency',m.currency));
 elsif route in ('checkout','order-result','orders/detail','mail/claim') and result is not null then
  select * into o from ezshop.orders where reference=coalesce(result->>'reference',result->'order'->>'reference') or (route='mail/claim' and id=(result->>'order_id')::bigint);
  if found then
   if route in ('order-result','orders/detail') then result:=jsonb_set(result,'{order}',(result->'order')||jsonb_build_object('currency',o.currency,'country_code',o.country_code));
   else result:=result||jsonb_build_object('currency',o.currency,'country_code',o.country_code);end if;
  end if;
 elsif route='payouts' then
  result:=result||jsonb_build_object('currency',m.currency);
 elsif route='platform' then
  result:=jsonb_set(result,'{merchants}',coalesce((select jsonb_agg(v||jsonb_build_object('currency',m.currency,'country_code',m.country_code)) from jsonb_array_elements(result->'merchants') v join ezshop.merchants m on m.id=(v->>'id')::bigint),'[]'::jsonb));
 end if;
 return result;
end;
$$;
revoke all on function public.ezshop_api(text,jsonb) from public;
grant execute on function public.ezshop_api(text,jsonb) to anon,authenticated,service_role;
create or replace function public.ezshop_customer_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare uid uuid:=auth.uid();email_address text;verified boolean;order_row ezshop.orders%rowtype;items jsonb;groups jsonb;result jsonb;cur text;
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
 select coalesce(jsonb_agg(x.body order by x.id desc),'[]'::jsonb) into items from (select o.id,jsonb_build_object('reference',o.reference,'currency',o.currency,'status',o.status,'total',o.total,'created',o.created,'access_token',o.access_token,'store_name',m.name,'slug',m.slug,'quantity',(select coalesce(sum(i.quantity),0) from ezshop.order_items i where i.order_id=o.id)) body from ezshop.orders o join ezshop.merchants m on m.id=o.merchant_id where o.customer_id=uid and (coalesce(payload->>'slug','')='' or m.slug=payload->>'slug') order by o.id desc limit 200) x;
 result:=jsonb_build_object('orders',items,'summary',(select jsonb_build_object('order_count',count(*),'paid_total',coalesce(sum(o.total) filter(where o.status='paid'),0),'refunded_total',coalesce(sum(o.total) filter(where o.status='refunded'),0),'purchased_quantity',coalesce(sum((select sum(i.quantity) from ezshop.order_items i where i.order_id=o.id)) filter(where o.status='paid'),0),'pending_count',count(*) filter(where o.status='pending')) from ezshop.orders o join ezshop.merchants m on m.id=o.merchant_id where o.customer_id=uid and (coalesce(payload->>'slug','')='' or m.slug=payload->>'slug')));
 select coalesce(jsonb_agg(jsonb_build_object('currency',x.currency,'paid_total',x.paid_total,'refunded_total',x.refunded_total) order by x.currency),'[]'::jsonb) into groups from (select o.currency,coalesce(sum(o.total) filter(where o.status='paid'),0) paid_total,coalesce(sum(o.total) filter(where o.status='refunded'),0) refunded_total from ezshop.orders o join ezshop.merchants m on m.id=o.merchant_id where o.customer_id=uid and (coalesce(payload->>'slug','')='' or m.slug=payload->>'slug') group by o.currency) x;
 if jsonb_array_length(groups)>1 then result:=jsonb_set(result,'{summary}',(result->'summary')||jsonb_build_object('paid_total',null,'refunded_total',null,'currency',null));
 else
  select currency into cur from ezshop.merchants where slug=payload->>'slug';
  result:=jsonb_set(result,'{summary}',(result->'summary')||jsonb_build_object('currency',coalesce(groups->0->>'currency',cur,'MYR')));
 end if;
 return result||jsonb_build_object('currency_totals',groups);

end;
$$;
create or replace function public.ezshop_platform_read_api(route text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,ezshop as $$
#variable_conflict use_column
declare mid bigint;page_no int;skip_rows int;row_count bigint;rows jsonb;profile jsonb;order_row ezshop.orders%rowtype;
begin
 if not exists(select 1 from ezshop.merchants where owner=auth.uid() and is_admin and status='active') then raise exception '需要平台管理员权限';end if;
 if coalesce(payload->>'merchant_id','')!~'^[0-9]{1,18}$' then raise exception '商家编号无效';end if;
 mid:=(payload->>'merchant_id')::bigint;
 select jsonb_build_object('id',m.id,'name',m.name,'email',m.email,'slug',m.slug,'status',m.status,'plan',m.plan,'phone',m.phone,'description',m.description,'logo',m.logo,'banner',m.banner,'shipping_fee',m.shipping_fee,'courier',m.courier,'currency',m.currency,'country_code',m.country_code,'trial_ends_at',m.trial_ends_at,'content_translations',m.content_translations) into profile from ezshop.merchants m where id=mid;
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
    select e.id,'event' source,e.occurred_at book_date,jsonb_build_object('id',e.id,'source','event','currency',e.currency,'kind',e.kind,'amount',e.amount,'date',e.occurred_at,'reference',coalesce(o.reference,p.reference,''),'order_id',e.order_id,'voided',false) body from ezshop.finance_events e left join ezshop.orders o on o.id=e.order_id left join ezshop.payouts p on p.id=e.payout_id where e.merchant_id=mid
    union all select e.id,'manual',e.occurred_on::timestamp at time zone ezshop.shop_timezone(mid),jsonb_build_object('id',e.id,'source','manual','currency',e.currency,'kind',e.kind,'amount',e.amount,'date',e.occurred_on,'category',e.category,'description',e.description,'reference',e.reference,'voided',e.voided) from ezshop.finance_entries e where e.merchant_id=mid
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
create or replace function ezshop.platform_order_view(o ezshop.orders) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('id',o.id,'currency',o.currency,'country_code',o.country_code,'reference',o.reference,'customer',o.customer,'email',o.email,'phone',o.phone,'address',o.address,'state',o.state,'city',o.city,'postcode',o.postcode,'note',o.note,'total',o.total,'subtotal',o.subtotal,'shipping',o.shipping,'discount',o.discount,'status',o.status,'commission',o.commission,'agent_id',o.agent_id,'created',o.created,'fulfillment_status',o.fulfillment_status,'carrier',o.carrier,'tracking',o.tracking,'shipped_at',o.shipped_at,'refund_reference',o.refund_reference,'refunded_at',o.refunded_at,'stock_returned',o.stock_returned,'locale',o.locale,'payment_instructions',o.payment_instructions);
$$;
create or replace function public.ezshop_region_status() returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 select jsonb_build_object('ready',to_regprocedure('public.ezshop_pre_region_api(text,jsonb)') is not null and not has_function_privilege('anon','public.ezshop_pre_region_api(text,jsonb)','EXECUTE') and not has_function_privilege('authenticated','public.ezshop_pre_region_api(text,jsonb)','EXECUTE') and to_regprocedure('public.ezshop_pre_region_books_api(text,jsonb)') is not null and not has_function_privilege('authenticated','public.ezshop_pre_region_books_api(text,jsonb)','EXECUTE'));
$$;
revoke all on function public.ezshop_region_status() from public;
grant execute on function public.ezshop_region_status() to anon,authenticated,service_role;

do $$begin if to_regprocedure('public.ezshop_pre_region_books_api(text,jsonb)') is null then alter function public.ezshop_books_api(text,jsonb) rename to ezshop_pre_region_books_api;end if;end$$;
revoke all on function public.ezshop_pre_region_books_api(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ezshop_books_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare result jsonb;cur text;
begin
 result:=public.ezshop_pre_region_books_api(route,payload);
 select currency into cur from ezshop.merchants where owner=auth.uid();
 if route in ('entry/add','order-costs') and coalesce(payload->>'currency','MYR') is distinct from cur then raise exception '币种已变化，请刷新后重新填写金额';end if;
 return result||jsonb_build_object('currency',cur);
end;
$$;
revoke all on function public.ezshop_books_api(text,jsonb) from public,anon;
grant execute on function public.ezshop_books_api(text,jsonb) to authenticated;

create or replace function public.ezshop_pre_region_books_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
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
  if book_date is null or book_date<'2000-01-01'::date or book_date>(now() at time zone ezshop.shop_timezone(m.id))::date then raise exception '收支日期必须是已发生的日期。';end if;
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
    if book_date<'2000-01-01'::date or book_date>(now() at time zone ezshop.shop_timezone(m.id))::date then raise exception '收支日期必须是已发生的日期。';end if;
    update ezshop.finance_events set occurred_at=book_date::timestamp at time zone ezshop.shop_timezone(m.id) where order_id=order_row.id and kind='payment' and occurred_at is null;
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
  from ezshop.finance_events e left join ezshop.orders o on o.id=e.order_id where e.merchant_id=m.id and (lo is null or ((e.occurred_at at time zone ezshop.shop_timezone(m.id))::date>=lo and (e.occurred_at at time zone ezshop.shop_timezone(m.id))::date<hi))
 ), totals as (select coalesce(sum(amount) filter(where kind='payment'),0) receipts,coalesce(sum(amount) filter(where kind='refund'),0) refunds,coalesce(sum(amount) filter(where kind='payout'),0) payouts,
  coalesce(sum(case when kind='payment' then cost when kind='refund' and returned then -cost else 0 end),0) costs,
  coalesce(sum(case when kind='payment' then commission when kind='refund' then -commission else 0 end),0) commissions,
  count(distinct order_id) filter(where missing and (kind='payment' or (kind='refund' and returned))) missing_cost_orders from events
 ), manual as (select coalesce(sum(amount) filter(where kind='income'),0) income,coalesce(sum(amount) filter(where kind='income' and category<>'capital'),0) profit_income,coalesce(sum(amount) filter(where kind='expense'),0) expenses,coalesce(sum(amount) filter(where kind='expense' and category<>'inventory'),0) profit_expenses from ezshop.finance_entries where merchant_id=m.id and not voided and (lo is null or (occurred_on>=lo and occurred_on<hi)))
 select jsonb_build_object('receipts',t.receipts,'refunds',t.refunds,'payouts',t.payouts,'manual_income',x.income,'expenses',x.expenses,'goods_cost',t.costs,'commissions',t.commissions,'missing_cost_orders',t.missing_cost_orders,'net_cash',t.receipts+x.income-t.refunds-t.payouts-x.expenses,'profit',case when t.missing_cost_orders=0 then t.receipts-t.refunds-t.costs-t.commissions+x.profit_income-x.profit_expenses end,'unknown_date_events',(select count(*) from ezshop.finance_events where merchant_id=m.id and occurred_at is null)) into summary from totals t cross join manual x;
 select coalesce(jsonb_agg(x.body order by x.book_date desc nulls last,x.id desc),'[]'::jsonb) into rows from (
  select * from (select e.id,e.occurred_at book_date,jsonb_build_object('id',e.id,'source','order','kind',e.kind,'amount',e.amount,'date',e.occurred_at,'reference',coalesce(o.reference,p.reference,''),'order_id',e.order_id,'voided',false) body from ezshop.finance_events e left join ezshop.orders o on o.id=e.order_id left join ezshop.payouts p on p.id=e.payout_id where e.merchant_id=m.id and (lo is null or ((e.occurred_at at time zone ezshop.shop_timezone(m.id))::date>=lo and (e.occurred_at at time zone ezshop.shop_timezone(m.id))::date<hi))
  union all select e.id,e.occurred_on::timestamp at time zone ezshop.shop_timezone(m.id),jsonb_build_object('id',e.id,'source','manual','currency',e.currency,'kind',e.kind,'amount',e.amount,'date',e.occurred_on,'category',e.category,'description',e.description,'reference',e.reference,'voided',e.voided) from ezshop.finance_entries e where e.merchant_id=m.id and (lo is null or (e.occurred_on>=lo and e.occurred_on<hi))) all_rows order by book_date desc nulls last,id desc limit 200
 ) x;
 return jsonb_build_object('summary',summary,'rows',rows);
end;
$$;
create or replace function ezshop.platform_book_summary(mid bigint) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,ezshop as $$
declare summary jsonb;lo date;hi date;
begin
 with events as (
  select e.*,coalesce(o.commission,0) commission,coalesce(o.stock_returned,false) returned,
   coalesce((select sum(i.unit_cost*i.quantity) from ezshop.order_items i where i.order_id=e.order_id),0) cost,
   (not exists(select 1 from ezshop.order_items i where i.order_id=e.order_id) or exists(select 1 from ezshop.order_items i where i.order_id=e.order_id and i.unit_cost is null)) missing
  from ezshop.finance_events e left join ezshop.orders o on o.id=e.order_id where e.merchant_id=mid and (lo is null or ((e.occurred_at at time zone ezshop.shop_timezone(mid))::date>=lo and (e.occurred_at at time zone ezshop.shop_timezone(mid))::date<hi))
 ), totals as (select coalesce(sum(amount) filter(where kind='payment'),0) receipts,coalesce(sum(amount) filter(where kind='refund'),0) refunds,coalesce(sum(amount) filter(where kind='payout'),0) payouts,
  coalesce(sum(case when kind='payment' then cost when kind='refund' and returned then -cost else 0 end),0) costs,
  coalesce(sum(case when kind='payment' then commission when kind='refund' then -commission else 0 end),0) commissions,
  count(distinct order_id) filter(where missing and (kind='payment' or (kind='refund' and returned))) missing_cost_orders from events
 ), manual as (select coalesce(sum(amount) filter(where kind='income'),0) income,coalesce(sum(amount) filter(where kind='income' and category<>'capital'),0) profit_income,coalesce(sum(amount) filter(where kind='expense'),0) expenses,coalesce(sum(amount) filter(where kind='expense' and category<>'inventory'),0) profit_expenses from ezshop.finance_entries where merchant_id=mid and not voided and (lo is null or (occurred_on>=lo and occurred_on<hi)))
 select jsonb_build_object('receipts',t.receipts,'refunds',t.refunds,'payouts',t.payouts,'manual_income',x.income,'expenses',x.expenses,'goods_cost',t.costs,'commissions',t.commissions,'missing_cost_orders',t.missing_cost_orders,'net_cash',t.receipts+x.income-t.refunds-t.payouts-x.expenses,'profit',case when t.missing_cost_orders=0 then t.receipts-t.refunds-t.costs-t.commissions+x.profit_income-x.profit_expenses end,'unknown_date_events',(select count(*) from ezshop.finance_events where merchant_id=mid and occurred_at is null)) into summary from totals t cross join manual x;
 return summary;
end;
$$;

$ezshop_migration_015$;
 end if;
end $upgrade_015$;

-- 202611070016_manual_pro_billing.sql · sha256 dc145dbd1c214c294a44b0d30ec0c6b968e73cbd6b379463c727f4653d9ae621
do $upgrade_016$ begin
 if not (to_regprocedure('public.ezshop_manual_billing_status()') is not null) then
  execute $ezshop_migration_016$
-- Platform Pro now requires administrator confirmation of actual receipt.
-- Existing grants and historical Stripe records are preserved. This migration
-- does not contact Stripe, cancel subscriptions, or claim charges have stopped.
alter function public.ezshop_payment_api(text,jsonb) rename to ezshop_pre_manual_payment_api;
revoke all on function public.ezshop_pre_manual_payment_api(text,jsonb) from public,anon,authenticated,service_role;
create function public.ezshop_payment_api(route text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare result jsonb;
begin
 if route in ('service/subscription-sync','service/bind-customer','service/billing-claim','service/save-billing-session') then
  if (coalesce(current_setting('request.jwt.claim.role',true),'')='service_role' or coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'='service_role') is distinct from true then raise exception '需要服务端权限';end if;
  if route='service/subscription-sync' then return jsonb_build_object('ok',true,'ignored',true,'billing_policy','manual_review');end if;
  raise exception '平台Pro采用人工审核，请提交付款申请并等待平台确认到账。';
 end if;
 result:=public.ezshop_pre_manual_payment_api(route,payload);
 if route='owner-status' then return result||jsonb_build_object('billing_policy','manual_review','automatic_pro_enabled',false);end if;
 return result;
end;
$$;
revoke all on function public.ezshop_payment_api(text,jsonb) from public;
grant execute on function public.ezshop_payment_api(text,jsonb) to anon,authenticated,service_role;

-- The previous public payment link was recurring. Stop offering it to new
-- applicants; submitted payments remain available for administrator review.
update ezshop.platform_receiving set stripe_enabled=false,version=version+1 where stripe_enabled;
alter function public.ezshop_platform_billing_api(text,jsonb) rename to ezshop_pre_manual_platform_billing_api;
revoke all on function public.ezshop_pre_manual_platform_billing_api(text,jsonb) from public,anon,authenticated,service_role;
create function public.ezshop_platform_billing_api(route text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare result jsonb;
begin
 if route='save' then payload:=payload||jsonb_build_object('stripe_enabled',false);end if;
 if route='create' and payload->>'method'='stripe_link' then raise exception '平台Pro采用人工审核，请选择银行、电子钱包或USDT付款。';end if;
 result:=public.ezshop_pre_manual_platform_billing_api(route,payload);
 if route='view' then result:=jsonb_set(result,'{options,stripe_link}','false'::jsonb);end if;
 return result||jsonb_build_object('billing_policy','manual_review');
end;
$$;
revoke all on function public.ezshop_platform_billing_api(text,jsonb) from public,anon,service_role;
grant execute on function public.ezshop_platform_billing_api(text,jsonb) to authenticated;
create function public.ezshop_manual_billing_status() returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 select jsonb_build_object('ready',
  not has_function_privilege('anon','public.ezshop_pre_manual_payment_api(text,jsonb)','EXECUTE') and
  not has_function_privilege('authenticated','public.ezshop_pre_manual_payment_api(text,jsonb)','EXECUTE') and
  not has_function_privilege('service_role','public.ezshop_pre_manual_payment_api(text,jsonb)','EXECUTE') and
  not has_function_privilege('anon','public.ezshop_pre_manual_platform_billing_api(text,jsonb)','EXECUTE') and
  not has_function_privilege('authenticated','public.ezshop_pre_manual_platform_billing_api(text,jsonb)','EXECUTE'),
  'billing_policy','manual_review','automatic_pro_enabled',false);
$$;
revoke all on function public.ezshop_manual_billing_status() from public;
grant execute on function public.ezshop_manual_billing_status() to anon,authenticated,service_role;

$ezshop_migration_016$;
 end if;
end $upgrade_016$;

notify pgrst,'reload schema';
commit;
select public.ezshop_release_status();
