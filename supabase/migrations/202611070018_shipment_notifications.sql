-- Registering an actual shipment queues one notice in the same transaction.
-- Queueing does not claim a message has been sent or delivered.
create function ezshop.queue_shipment_notice() returns trigger language plpgsql security definer set search_path=pg_catalog,ezshop as $$
begin
 if new.status='paid' and new.fulfillment_status='shipped' and old.fulfillment_status is distinct from 'shipped' then
  insert into ezshop.notification_jobs(merchant_id,order_id,kind,event_key) values(new.merchant_id,new.id,'shipment','shipment:'||new.id::text) on conflict(event_key) do nothing;
 end if;
 return new;
end;
$$;
revoke all on function ezshop.queue_shipment_notice() from public,anon,authenticated,service_role;
create trigger ezshop_shipment_notice after update of fulfillment_status on ezshop.orders for each row execute function ezshop.queue_shipment_notice();
alter function public.ezshop_mail_api(text,jsonb) rename to ezshop_pre_ship_mail_api;
revoke all on function public.ezshop_pre_ship_mail_api(text,jsonb) from public,anon,authenticated,service_role;
create function public.ezshop_mail_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
declare result jsonb;o ezshop.orders%rowtype;
begin
 if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' and coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role' is distinct from 'service_role' then raise exception '需要服务端权限';end if;
 if route='mail/claim' then
  update ezshop.notification_jobs n set status='skipped',updated=now() from ezshop.orders r where n.order_id=r.id and n.kind='shipment' and (n.status in ('queued','failed') or (n.status='sending' and n.updated<now()-interval '10 minutes')) and (r.status<>'paid' or r.fulfillment_status<>'shipped');
 end if;
 result:=public.ezshop_pre_ship_mail_api(route,payload);
 if route='mail/claim' and result is not null then
  select * into o from ezshop.orders where id=(result->>'order_id')::bigint;
  return result||jsonb_build_object('carrier',o.carrier,'tracking',o.tracking,'shipping',o.shipping,'currency',o.currency);
 end if;
 return result;
end;
$$;
revoke all on function public.ezshop_mail_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.ezshop_mail_api(text,jsonb) to service_role;
create function public.ezshop_shipment_notice_status() returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 select jsonb_build_object('ready',
  exists(select 1 from pg_trigger where tgrelid='ezshop.orders'::regclass and tgname='ezshop_shipment_notice' and tgenabled in ('O','A')) and
  not has_function_privilege('anon','public.ezshop_pre_ship_mail_api(text,jsonb)','EXECUTE') and
  not has_function_privilege('authenticated','public.ezshop_pre_ship_mail_api(text,jsonb)','EXECUTE') and
  not has_function_privilege('service_role','public.ezshop_pre_ship_mail_api(text,jsonb)','EXECUTE'));
$$;
revoke all on function public.ezshop_shipment_notice_status() from public;
grant execute on function public.ezshop_shipment_notice_status() to anon,authenticated,service_role;
