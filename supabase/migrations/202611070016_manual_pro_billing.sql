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
