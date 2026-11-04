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
