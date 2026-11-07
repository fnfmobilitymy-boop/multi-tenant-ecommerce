-- Merchant-defined domestic zones; prices remain in the store currency.
-- Existing stores retain their default fee. Existing orders are never repriced.
alter table ezshop.merchants add column shipping_rules jsonb not null default '[]'::jsonb check(jsonb_typeof(shipping_rules)='array');
create function ezshop.validate_shipping_rules(rules jsonb,country text) returns void language plpgsql immutable set search_path=pg_catalog as $$
declare r jsonb;keys text[]:='{}';key text;
begin
 if jsonb_typeof(rules) is distinct from 'array' or jsonb_array_length(rules)>50 then raise exception '运费规则无效';end if;
 for r in select value from jsonb_array_elements(rules) loop
  if jsonb_typeof(r) is distinct from 'object' or jsonb_typeof(r->'fee') is distinct from 'number' or (r->>'fee')!~'^[0-9]+$' or (r->>'fee')::numeric>1000000 then raise exception '运费规则金额无效';end if;
  if jsonb_typeof(r->'state') is distinct from 'string' or jsonb_typeof(r->'city') is distinct from 'string' or jsonb_typeof(r->'postcode_prefix') is distinct from 'string' or length(r->>'state')>100 or length(r->>'city')>100 or coalesce(r->>'postcode_prefix','')!~'^[0-9]{0,6}$' then raise exception '运费规则地区无效';end if;
  if country='MY' and trim(r->>'state')<>'' and trim(r->>'state') not in ('Johor','Kedah','Kelantan','Kuala Lumpur','Labuan','Melaka','Negeri Sembilan','Pahang','Penang','Perak','Perlis','Putrajaya','Sabah','Sarawak','Selangor','Terengganu') then raise exception '请选择马来西亚配送州属';end if;
  key:=jsonb_build_array(lower(trim(r->>'state')),lower(trim(r->>'city')),r->>'postcode_prefix')::text;
  if key=any(keys) then raise exception '运费规则地区重复';end if;keys:=array_append(keys,key);
 end loop;
end;
$$;
revoke all on function ezshop.validate_shipping_rules(jsonb,text) from public,anon,authenticated,service_role;
create function ezshop.zone_shipping_fee(mid bigint,p jsonb) returns bigint language plpgsql stable security definer set search_path=pg_catalog,ezshop as $$
declare m ezshop.merchants%rowtype;r jsonb;fee bigint;rank int;best int:=-1;
begin
 select * into m from ezshop.merchants where id=mid;
 if coalesce(p->>'country',m.country_code)<>m.country_code then raise exception '请填写商家所在国家的配送地址';end if;
 fee:=m.shipping_fee;
 for r in select value from jsonb_array_elements(m.shipping_rules) loop
  if (trim(r->>'state')='' or lower(trim(r->>'state'))=lower(trim(coalesce(p->>'state','')))) and
     (trim(r->>'city')='' or lower(trim(r->>'city'))=lower(trim(coalesce(p->>'city','')))) and
     (r->>'postcode_prefix'='' or left(coalesce(p->>'postcode',''),length(r->>'postcode_prefix'))=r->>'postcode_prefix') then
    rank:=(case when r->>'postcode_prefix'<>'' then 100+length(r->>'postcode_prefix') else 0 end)+(case when trim(r->>'city')<>'' then 10 else 0 end)+(case when trim(r->>'state')<>'' then 1 else 0 end);
    if rank>best then best:=rank;fee:=(r->>'fee')::bigint;end if;
  end if;
 end loop;
 return fee;
end;
$$;
revoke all on function ezshop.zone_shipping_fee(bigint,jsonb) from public,anon,authenticated,service_role;
alter function public.ezshop_api(text,jsonb) rename to ezshop_pre_zone_api;
revoke all on function public.ezshop_pre_zone_api(text,jsonb) from public,anon,authenticated,service_role;
create function public.ezshop_api(route text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
#variable_conflict use_column
declare result jsonb;m ezshop.merchants%rowtype;o ezshop.orders%rowtype;fee bigint;replay boolean:=false;ready boolean;
begin
 if route='settings' then
  select * into m from ezshop.merchants where owner=auth.uid();
  if payload?'shipping_rules' then
   if m.id is null then raise exception '需要商家所有者权限';end if;
   perform ezshop.validate_shipping_rules(payload->'shipping_rules',coalesce(payload->>'country_code',m.country_code));
  end if;
  if m.id is not null and jsonb_array_length(m.shipping_rules)>0 and ((payload?'country_code' and payload->>'country_code'<>m.country_code) or (payload?'currency' and payload->>'currency'<>m.currency)) then raise exception '请先清除分区邮费再修改国家币种';end if;
  result:=public.ezshop_pre_zone_api(route,payload);
  if payload?'shipping_rules' then update ezshop.merchants set shipping_rules=payload->'shipping_rules' where id=m.id;end if;
  return result;
 end if;
 if route in ('shipping-quote','checkout') then
  select * into m from ezshop.merchants where slug=payload->>'slug' and status='active';
  if m.id is null then raise exception '店铺不存在';end if;
  if route='checkout' then
   perform pg_advisory_xact_lock(m.id);select * into m from ezshop.merchants where id=m.id for update;
   select exists(select 1 from ezshop.orders where merchant_id=m.id and checkout_key=payload->>'checkout_key') into replay;
  end if;
  if not replay then
   ready:=coalesce(payload->>'city','')<>'' and length(coalesce(payload->>'postcode',''))>=case when m.country_code='SG' then 6 else 5 end and (m.country_code='SG' or coalesce(payload->>'state','')<>'');
   if route='shipping-quote' and jsonb_array_length(m.shipping_rules)>0 and not ready then
    result:=public.ezshop_pre_zone_api(route,payload);
    return result||jsonb_build_object('shipping',null,'total',null,'destination_required',true);
   end if;
   if jsonb_array_length(m.shipping_rules)>0 then perform ezshop.regional_destination(m.country_code,payload,1);end if;
   fee:=ezshop.zone_shipping_fee(m.id,payload);
   if route='checkout' and jsonb_array_length(m.shipping_rules)>0 and not (payload?'expected_shipping') then raise exception '分区邮费已启用，请刷新后重新结账';end if;
   if route='checkout' and payload?'expected_shipping' and ((coalesce(payload->>'expected_shipping','')!~'^[0-9]+$') or (payload->>'expected_shipping')::numeric<>fee) then raise exception '邮费已更新，请刷新金额后重新提交';end if;
  end if;
  result:=public.ezshop_pre_zone_api(route,payload);
  if replay then return result;end if;
  if route='shipping-quote' then return result||jsonb_build_object('shipping',fee,'total',(result->>'subtotal')::bigint+fee);end if;
  select * into o from ezshop.orders where merchant_id=m.id and reference=result->>'reference';
  update ezshop.orders set shipping=fee,total=subtotal+fee where id=o.id returning * into o;
  return result||jsonb_build_object('shipping',fee,'subtotal',o.subtotal,'total',o.total);
 end if;
 result:=public.ezshop_pre_zone_api(route,payload);
 if route='dashboard' then
  select * into m from ezshop.merchants where id=(result->'merchant'->>'id')::bigint;
  return jsonb_set(result,'{merchant}',(result->'merchant')||jsonb_build_object('shipping_rules',m.shipping_rules,'shipping_rules_enabled',true,'currency_locked',(result->'merchant'->>'currency_locked')::boolean or jsonb_array_length(m.shipping_rules)>0));
 elsif route='store' then
  select * into m from ezshop.merchants where slug=payload->>'slug';
  return jsonb_set(result,'{store}',(result->'store')||jsonb_build_object('shipping_zones',jsonb_array_length(m.shipping_rules)>0));
 end if;
 return result;
end;
$$;
revoke all on function public.ezshop_api(text,jsonb) from public;
grant execute on function public.ezshop_api(text,jsonb) to anon,authenticated,service_role;
create function public.ezshop_shipping_zones_status() returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 select jsonb_build_object('ready',not has_function_privilege('anon','public.ezshop_pre_zone_api(text,jsonb)','EXECUTE') and not has_function_privilege('authenticated','public.ezshop_pre_zone_api(text,jsonb)','EXECUTE') and not has_function_privilege('service_role','public.ezshop_pre_zone_api(text,jsonb)','EXECUTE'));
$$;
revoke all on function public.ezshop_shipping_zones_status() from public;
grant execute on function public.ezshop_shipping_zones_status() to anon,authenticated,service_role;
