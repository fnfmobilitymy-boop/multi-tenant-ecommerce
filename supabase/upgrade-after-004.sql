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

notify pgrst,'reload schema';
commit;
select public.ezshop_release_status();
