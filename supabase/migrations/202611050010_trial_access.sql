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
