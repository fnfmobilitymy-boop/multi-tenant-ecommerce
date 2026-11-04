-- 增量升级：佣金提现账本及已完成线下退款的登记。不会执行支付转账。
alter table ezshop.orders drop constraint if exists orders_status_check;
alter table ezshop.orders add constraint orders_status_check check(status in ('pending','paid','cancelled','refunded'));
alter table ezshop.orders add column if not exists refund_reference text not null default '';
alter table ezshop.orders add column if not exists refunded_at timestamptz;
alter table ezshop.orders add column if not exists stock_returned boolean not null default false;
create table if not exists ezshop.payouts (
 id bigint generated always as identity primary key,merchant_id bigint not null references ezshop.merchants(id),agent_id bigint not null references ezshop.agents(id),
 amount bigint not null check(amount>0),bank_details text not null,request_key text not null,status text not null default 'requested' check(status in ('requested','paid','rejected')),
 reference text not null default '',created timestamptz not null default now(),updated timestamptz not null default now(),unique(merchant_id,agent_id,request_key)
);
alter table ezshop.payouts enable row level security;
revoke all on ezshop.payouts from public,anon,authenticated;
create index if not exists payouts_agent on ezshop.payouts(merchant_id,agent_id);
create or replace function ezshop.balance(mid bigint,aid bigint) returns jsonb language sql stable security definer set search_path=pg_catalog,ezshop as $$
 with earnings as (select coalesce(sum(commission),0) earned from ezshop.orders where merchant_id=mid and agent_id=aid and status='paid'),
 payments as (select coalesce(sum(case when status='paid' then amount else 0 end),0) paid,coalesce(sum(case when status='requested' then amount else 0 end),0) reserved from ezshop.payouts where merchant_id=mid and agent_id=aid)
 select jsonb_build_object('earned',earned,'paid',paid,'reserved',reserved,'available',earned-paid-reserved) from earnings cross join payments;
$$;
revoke all on function ezshop.balance(bigint,bigint) from public,anon,authenticated;
-- 保留已验证的核心 RPC，外层仅增加财务路由，不重复建立现有业务表。
do $$ begin
 if to_regprocedure('public.ezshop_core_api(text,jsonb)') is null then
  alter function public.ezshop_api(text,jsonb) rename to ezshop_core_api;
 end if;
end $$;
revoke all on function public.ezshop_core_api(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ezshop_api(route text,payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ezshop as $$
#variable_conflict use_column
declare m ezshop.merchants%rowtype; member ezshop.memberships%rowtype; p ezshop.payouts%rowtype; o ezshop.orders%rowtype;
 uid uuid:=auth.uid(); role_name text:='owner';aid bigint;amount bigint;key text;details text;target text;v_reference text;restock boolean;result jsonb;
begin
 if route not in ('payouts','payouts/request','payouts/update','orders/refund') then return public.ezshop_core_api(route,payload); end if;
 if uid is null then raise exception '请先登录'; end if;
 select * into m from ezshop.merchants where owner=uid;
 if m.id is null then
  select * into member from ezshop.memberships where user_id=uid;
  if member.id is null then raise exception '权限已撤销或账户不存在'; end if;
  select * into m from ezshop.merchants where id=member.merchant_id;
  role_name:=member.role;aid:=member.agent_id;
 end if;
 if m.status<>'active' then raise exception '店铺已暂停'; end if;
 if role_name not in ('owner','agent') then raise exception '当前角色不能访问佣金结算或退款'; end if;
 if route='payouts' then
  return jsonb_build_object('balances',(select coalesce(jsonb_agg(ezshop.balance(m.id,a.id)||jsonb_build_object('agent_id',a.id,'name',a.name)),'[]'::jsonb) from ezshop.agents a where a.merchant_id=m.id and (role_name='owner' or a.id=aid)),
   'payouts',(select coalesce(jsonb_agg((to_jsonb(p)-'request_key')||jsonb_build_object('agent_name',a.name) order by p.id desc),'[]'::jsonb) from ezshop.payouts p join ezshop.agents a on a.id=p.agent_id where p.merchant_id=m.id and (role_name='owner' or p.agent_id=aid)));
 end if;
 perform pg_advisory_xact_lock(m.id);
 if route='payouts/request' then
  if role_name<>'agent' then raise exception '仅代理可以提交自己的提现申请'; end if;
  if coalesce(payload->>'amount','') !~ '^[0-9]+$' then raise exception '金额须为整数 sen'; end if;
  amount:=(payload->>'amount')::bigint;key:=payload->>'request_key';details:=trim(payload->>'bank_details');
  if amount<=0 or amount>9007199254740991 or coalesce(key,'') !~ '^[A-Za-z0-9_-]{20,100}$' or length(coalesce(details,'')) not between 1 and 500 then raise exception '提现资料无效'; end if;
  select * into p from ezshop.payouts where merchant_id=m.id and agent_id=aid and request_key=key;
  if found then
   if p.amount<>amount or p.bank_details<>details then raise exception '同一请求标识不能用于不同申请'; end if;
   return jsonb_build_object('ok',true,'id',p.id);
  end if;
  if amount>(ezshop.balance(m.id,aid)->>'available')::bigint then raise exception '可提现余额不足'; end if;
  insert into ezshop.payouts(merchant_id,agent_id,amount,bank_details,request_key) values(m.id,aid,amount,details,key) returning * into p;
  insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(m.id,uid::text,'payout.request',p.id);
  return jsonb_build_object('ok',true,'id',p.id);
 end if;
 if role_name<>'owner' then raise exception '仅商家所有者可以登记结算或退款'; end if;
 v_reference:=trim(payload->>'reference');
 if length(coalesce(v_reference,'')) not between 1 and 200 then raise exception '请填写实际转账参考号或拒绝原因'; end if;
 if route='payouts/update' then
  target:=payload->>'status';if target is null or target not in ('paid','rejected') then raise exception '结算状态无效'; end if;
  select * into p from ezshop.payouts where id=(payload->>'id')::bigint and merchant_id=m.id for update;
  if not found then raise exception '找不到提现申请'; end if;
  if p.status=target and p.reference=v_reference then return jsonb_build_object('ok',true); end if;
  if p.status<>'requested' then raise exception '申请已处理'; end if;
  if target='paid' and (ezshop.balance(m.id,p.agent_id)->>'available')::bigint<0 then raise exception '佣金已变动，请先核对账本'; end if;
  update ezshop.payouts set status=target,reference=v_reference,updated=now() where id=p.id;
  insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(m.id,uid::text,'payout.'||target,p.id);
  return jsonb_build_object('ok',true);
 end if;
 if jsonb_typeof(coalesce(payload->'restock','false'::jsonb))<>'boolean' then raise exception '库存恢复选项无效'; end if;
 restock:=coalesce((payload->>'restock')::boolean,false);
 select * into o from ezshop.orders where id=(payload->>'id')::bigint and merchant_id=m.id for update;
 if not found then raise exception '找不到订单'; end if;
 if o.status='refunded' then
  if o.refund_reference=v_reference and o.stock_returned=restock then return jsonb_build_object('ok',true); end if;
  raise exception '退款已经登记，不能重复修改';
 end if;
 if o.status<>'paid' then raise exception '只能为已付款订单登记全额退款'; end if;
 if restock then
  update ezshop.products p set stock=p.stock+i.quantity,version=p.version+1 from ezshop.order_items i where i.order_id=o.id and p.id=i.product_id and p.merchant_id=m.id;
 end if;
 update ezshop.orders set status='refunded',refund_reference=v_reference,stock_returned=restock,refunded_at=now() where id=o.id;
 if o.agent_id is not null then
  update ezshop.payouts set status='rejected',reference='关联订单退款，请重新申请',updated=now() where merchant_id=m.id and agent_id=o.agent_id and status='requested';
 end if;
 insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(m.id,uid::text,'order.refund',o.id);
 return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.ezshop_api(text,jsonb) from public;
grant execute on function public.ezshop_api(text,jsonb) to anon,authenticated,service_role;
