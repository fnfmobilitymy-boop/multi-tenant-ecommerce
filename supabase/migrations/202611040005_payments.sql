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
