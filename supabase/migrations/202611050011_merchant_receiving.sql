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
