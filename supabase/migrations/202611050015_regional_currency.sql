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
