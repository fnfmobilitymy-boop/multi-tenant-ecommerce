-- 新项目的可选迁移。已有 Supabase 项目必须先审查结构再应用，不能盲目执行。
-- 此迁移未连接远端执行；使用隔离 schema，避免覆盖现有 public 表。
create schema if not exists ezshop;
create table if not exists ezshop.merchants (
 id bigint generated always as identity primary key, owner uuid not null unique references auth.users(id),
 name text not null check(length(name) between 1 and 80), slug text not null unique check(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 email text not null, phone text not null default '', description text not null default '', logo text not null default '', banner text not null default '', is_admin boolean not null default false, plan text not null default 'free' check(plan in ('free','pro')), status text not null default 'active' check(status in ('active','suspended'))
);
create table if not exists ezshop.products (
 id bigint generated always as identity primary key, merchant_id bigint not null references ezshop.merchants(id),
 name text not null, price bigint not null check(price between 1 and 100000000), stock int not null check(stock>=0),
 emoji text not null default '📦', description text not null default '', category text not null default '全部商品', image text not null default '',
 featured int not null default 0 check(featured in (0,1)), published int not null default 1 check(published in (0,1)), version bigint not null default 0
);
create table if not exists ezshop.agents (
 id bigint generated always as identity primary key, merchant_id bigint not null references ezshop.merchants(id),
 name text not null, code text not null unique default replace(gen_random_uuid()::text,'-',''), rate int not null check(rate between 0 and 100)
);
create table if not exists ezshop.orders (
 id bigint generated always as identity primary key, merchant_id bigint not null references ezshop.merchants(id),
 reference text unique not null, customer text not null,email text not null,phone text not null,address text not null,note text not null default '',
 total bigint not null,shipping bigint not null default 0,discount bigint not null default 0,
 status text not null default 'pending' check(status in ('pending','paid','cancelled')),
 agent_id bigint references ezshop.agents(id),commission bigint not null default 0,
 created timestamptz not null default now(),checkout_key text,access_token text not null,
 unique(merchant_id,checkout_key)
);
create table if not exists ezshop.order_items (
 id bigint generated always as identity primary key,order_id bigint not null references ezshop.orders(id),
 product_id bigint not null references ezshop.products(id),name text not null,price bigint not null,quantity int not null check(quantity between 1 and 1000)
);
create table if not exists ezshop.memberships (
 id bigint generated always as identity primary key, merchant_id bigint not null references ezshop.merchants(id), user_id uuid unique references auth.users(id),
 name text not null,email text not null unique,role text not null check(role in ('agent','manager','inventory','orders')),
 agent_id bigint references ezshop.agents(id),invite_token text unique,expires bigint not null
);
create table if not exists ezshop.audit_log (
 id bigint generated always as identity primary key,merchant_id bigint not null references ezshop.merchants(id),actor text not null,action text not null,object_id bigint,created timestamptz not null default now()
);
alter table ezshop.memberships enable row level security;
alter table ezshop.audit_log enable row level security;
create table if not exists ezshop.notification_jobs (
 id bigint generated always as identity primary key,merchant_id bigint not null references ezshop.merchants(id),order_id bigint not null references ezshop.orders(id),kind text not null,
 event_key text unique not null,status text not null default 'queued',attempts int not null default 0,provider_id text,error text,updated timestamptz not null default now()
);
alter table ezshop.notification_jobs enable row level security;
create index if not exists products_store on ezshop.products(merchant_id);
create index if not exists orders_store on ezshop.orders(merchant_id);
create index if not exists items_order on ezshop.order_items(order_id);
alter table ezshop.merchants enable row level security;
alter table ezshop.products enable row level security;
alter table ezshop.orders enable row level security;
alter table ezshop.order_items enable row level security;
alter table ezshop.agents enable row level security;
-- 没有开放表级匿名访问，所有数据仅通过下面的受控 RPC 访问。
revoke all on schema ezshop from public, anon, authenticated;
revoke all on all tables in schema ezshop from public, anon, authenticated;

create or replace function public.ezshop_api(route text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, ezshop, extensions
as $$
#variable_conflict use_column
declare
 m ezshop.merchants%rowtype; p ezshop.products%rowtype; o ezshop.orders%rowtype; a ezshop.agents%rowtype;
 line jsonb; items jsonb; result jsonb; amount bigint:=0; qty int; oid bigint; key text; token text;
 iid bigint; rate int:=0; uid uuid:=auth.uid(); metadata jsonb; member ezshop.memberships%rowtype; role_name text:='owner'; safe_merchant jsonb; agent_id bigint; invite text;
begin
 if route in ('mail/claim','mail/finish','mail/reminders') then
   if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' and coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role' is distinct from 'service_role' then raise exception '需要服务端权限'; end if;
   if route='mail/reminders' then
     insert into ezshop.notification_jobs(merchant_id,order_id,kind,event_key) select merchant_id,id,'reminder','reminder:'||id::text||':'||to_char(now() at time zone 'UTC','YYYY-MM-DD') from ezshop.orders where status='pending' and created<now()-interval '24 hours' on conflict(event_key) do nothing;
     return jsonb_build_object('ok',true);
   end if;
   if route='mail/finish' then
     if coalesce(payload->>'status','') not in ('sent','failed') then raise exception '通知状态无效'; end if;
     update ezshop.notification_jobs set status=payload->>'status',provider_id=payload->>'provider_id',error=payload->>'error',updated=now() where id=(payload->>'id')::bigint and status='sending';
     return jsonb_build_object('ok',true);
   end if;
   update ezshop.notification_jobs set status='queued' where status='sending' and updated<now()-interval '10 minutes';
   update ezshop.notification_jobs n set status='skipped',updated=now() from ezshop.orders r where n.order_id=r.id and n.status in ('queued','failed') and ((n.kind='receipt' and r.status<>'paid') or (n.kind='reminder' and r.status<>'pending'));
   with candidate as (select id from ezshop.notification_jobs where status in ('queued','failed') and attempts<3 order by id for update skip locked limit 1), claimed as (update ezshop.notification_jobs n set status='sending',attempts=n.attempts+1,updated=now() from candidate c where n.id=c.id returning n.*)
   select to_jsonb(c)||jsonb_build_object('reference',r.reference,'recipient',r.email,'total',r.total,'store_name',t.name,'items',(select jsonb_agg(jsonb_build_object('name',i.name,'quantity',i.quantity,'price',i.price)) from ezshop.order_items i where i.order_id=r.id)) into result from claimed c join ezshop.orders r on r.id=c.order_id join ezshop.merchants t on t.id=c.merchant_id;
   return result;
 end if;
 if route='health' then return jsonb_build_object('ok',true); end if;
 if route='brand' then return jsonb_build_object('logo',false); end if;
 if route='store' then
   select * into m from ezshop.merchants where slug=payload->>'slug' and status='active';
   if not found then raise exception '找不到店铺'; end if;
   select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]'::jsonb) into items from
     (select id,name,price,stock,emoji,description,category,image,featured from ezshop.products where merchant_id=m.id and published=1) x;
   return jsonb_build_object('store',to_jsonb(m)-'owner'-'email'-'is_admin'-'plan'-'status','products',items);
 end if;
 if route='order-result' then
   select r.* into o from ezshop.orders r join ezshop.merchants s on s.id=r.merchant_id
    where r.reference=payload->>'reference' and r.access_token=payload->>'token' and s.slug=payload->>'slug';
   if not found then raise exception '订单不存在或访问凭证无效'; end if;
   select * into m from ezshop.merchants where id=o.merchant_id;
   select coalesce(jsonb_agg(jsonb_build_object('name',name,'price',price,'quantity',quantity)),'[]'::jsonb) into items from ezshop.order_items where order_id=o.id;
   return jsonb_build_object('order',jsonb_build_object('reference',o.reference,'total',o.total,'status',o.status,'created',o.created,'shipping',o.shipping,'discount',o.discount),'items',items,'store',to_jsonb(m)-'owner'-'email'-'is_admin'-'plan'-'status');
 end if;
 if route='checkout' then
   select * into m from ezshop.merchants where slug=payload->>'slug' and status='active';
   if not found then raise exception '店铺不存在'; end if;
   -- 每商家事务锁确保重复请求与取消/下单库存变化有一致顺序。
   perform pg_advisory_xact_lock(m.id);
   key:=payload->>'checkout_key';
   if key is null or key !~ '^[A-Za-z0-9_-]{20,100}$' then raise exception '结账请求标识无效'; end if;
   select * into o from ezshop.orders where merchant_id=m.id and checkout_key=key;
   if found then return jsonb_build_object('reference',o.reference,'total',o.total,'status',o.status,'access_token',o.access_token); end if;
   if coalesce(payload->>'payment_method','manual')<>'manual' then raise exception '付款方式尚未开通'; end if;
   if length(trim(coalesce(payload->>'customer','')))=0 or length(payload->>'customer')>100
     or length(trim(coalesce(payload->>'phone','')))=0 or length(payload->>'phone')>40
     or length(trim(coalesce(payload->>'address','')))=0 or length(payload->>'address')>500
     or coalesce(payload->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(payload->>'email')>200
     or length(coalesce(payload->>'note',''))>1000 then raise exception '联系或收货资料无效'; end if;
   if jsonb_typeof(payload->'items') is distinct from 'array' then raise exception '请选择商品'; end if;
   if jsonb_array_length(payload->'items') not between 1 and 100 then raise exception '请选择商品'; end if;
   if (select count(*) from jsonb_array_elements(payload->'items'))<>(select count(distinct (v->>'id')::bigint) from jsonb_array_elements(payload->'items') v) then raise exception '商品重复'; end if;
   for line in select value from jsonb_array_elements(payload->'items') order by (value->>'id')::bigint loop
     if coalesce(line->>'quantity','') !~ '^[0-9]+$' then raise exception '数量无效'; end if;
     qty:=(line->>'quantity')::int;
     select * into p from ezshop.products where id=(line->>'id')::bigint and merchant_id=m.id for update;
     if not found or p.published<>1 or qty not between 1 and 1000 or p.stock<qty then raise exception '商品不存在、未发布或库存不足'; end if;
     amount:=amount+p.price*qty;
   end loop;
   if coalesce(payload->>'agent','')<>'' then
     select * into a from ezshop.agents where merchant_id=m.id and code=payload->>'agent';
     if not found then raise exception '代理链接无效'; end if;
     rate:=a.rate;
   end if;
   token:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
   insert into ezshop.orders(merchant_id,reference,customer,email,phone,address,note,total,agent_id,commission,checkout_key,access_token)
     values(m.id,'EZ-'||upper(replace(gen_random_uuid()::text,'-','')),trim(payload->>'customer'),payload->>'email',payload->>'phone',payload->>'address',coalesce(payload->>'note',''),amount,a.id,(amount*rate+50)/100,key,token) returning * into o;
   for line in select value from jsonb_array_elements(payload->'items') loop
     qty:=(line->>'quantity')::int;
     select * into p from ezshop.products where id=(line->>'id')::bigint and merchant_id=m.id;
     insert into ezshop.order_items(order_id,product_id,name,price,quantity) values(o.id,p.id,p.name,p.price,qty);
     update ezshop.products set stock=stock-qty,version=version+1 where id=p.id;
   end loop;
   return jsonb_build_object('reference',o.reference,'total',o.total,'status',o.status,'access_token',token);
 end if;
 if uid is null then raise exception '请先登录'; end if;
 if route='join' then
   if exists(select 1 from ezshop.memberships where user_id=uid) then return jsonb_build_object('ok',true); end if;
   if exists(select 1 from ezshop.merchants where owner=uid) then raise exception '已有商家账号不能兼任其他店铺团队，请使用独立邮箱'; end if;
   select memberrow.* into member from ezshop.memberships memberrow join auth.users u on u.id=uid where memberrow.invite_token=payload->>'token' and memberrow.expires>extract(epoch from now()) and memberrow.user_id is null and lower(u.email)=memberrow.email for update;
   if not found then raise exception '邀请已过期、已使用或邮箱不匹配'; end if;
   update ezshop.memberships set user_id=uid,invite_token=null where id=member.id;
   return jsonb_build_object('ok',true);
 end if;
 select * into member from ezshop.memberships where user_id=uid;
 select * into m from ezshop.merchants where owner=uid;
 if m.id is null and member.id is not null then
   select * into m from ezshop.merchants where id=member.merchant_id;
   role_name:=member.role;
 end if;
 if m.id is null and route='dashboard' then
   select raw_user_meta_data into metadata from auth.users where id=uid;
   if length(trim(coalesce(metadata->>'name','')))=0 or length(metadata->>'name')>80
    or coalesce(metadata->>'slug','') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(metadata->>'slug')>60 then raise exception '注册资料缺少有效的店铺名称或网址标识'; end if;
   insert into ezshop.merchants(owner,name,slug,email) select uid,metadata->>'name',metadata->>'slug',email from auth.users where id=uid returning * into m;
 end if;
 if m.id is null then raise exception '找不到商家账户'; end if;
 if m.status<>'active' and not (role_name='owner' and m.is_admin) then raise exception '店铺已暂停，请联系平台管理员'; end if;
 safe_merchant:=(to_jsonb(m)-'owner')||jsonb_build_object('role',role_name,'is_admin',case when role_name='owner' then m.is_admin else false end);
 if route='dashboard' and role_name='agent' then
   select * into a from ezshop.agents where id=member.agent_id and merchant_id=m.id;
   return jsonb_build_object('merchant',safe_merchant,'products','[]'::jsonb,'agents',jsonb_build_array(to_jsonb(a)),
    'orders',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'reference',r.reference,'total',r.total,'status',r.status,'commission',r.commission,'created',r.created) order by r.id desc),'[]'::jsonb) from ezshop.orders r where merchant_id=m.id and r.agent_id=member.agent_id));
 end if;
 if route='dashboard' then
   return jsonb_build_object('merchant',safe_merchant,
   'products',case when role_name in ('owner','manager','inventory') then (select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]'::jsonb) from ezshop.products x where merchant_id=m.id) else '[]'::jsonb end,
   'orders',case when role_name in ('owner','manager','orders') then (select coalesce(jsonb_agg((to_jsonb(x)-'access_token'-'checkout_key')||jsonb_build_object('agent_name',a.name) order by x.id desc),'[]'::jsonb) from ezshop.orders x left join ezshop.agents a on a.id=x.agent_id where x.merchant_id=m.id) else '[]'::jsonb end,
   'agents',case when role_name='owner' then (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select a.*,count(o.id) orders_count,coalesce(sum(case when o.status='paid' then o.commission else 0 end),0) earned from ezshop.agents a left join ezshop.orders o on o.agent_id=a.id where a.merchant_id=m.id group by a.id) x) else '[]'::jsonb end);
 end if;
 if not (role_name='owner' or (role_name in ('manager','inventory') and route in ('products','products/update')) or (role_name in ('manager','orders') and route in ('orders/detail','orders/paid','orders/cancel'))) then raise exception '当前角色没有此操作权限'; end if;
 if route='notifications' then
   return jsonb_build_object('jobs',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select n.id,n.kind,n.status,n.attempts,n.provider_id,n.error,r.reference,r.email recipient from ezshop.notification_jobs n join ezshop.orders r on r.id=n.order_id where n.merchant_id=m.id order by n.id desc limit 100) x));
 end if;
 if route='team' then
   return jsonb_build_object('members',(select coalesce(jsonb_agg((to_jsonb(t)-'invite_token'-'user_id')||jsonb_build_object('active',case when t.user_id is null then 0 else 1 end)),'[]'::jsonb) from ezshop.memberships t where merchant_id=m.id),
   'logs',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select actor,action,object_id,created from ezshop.audit_log where merchant_id=m.id order by id desc limit 50) x));
 end if;
 if route='team/invite' then
   if coalesce(payload->>'role','') not in ('agent','orders','inventory','manager') or length(trim(coalesce(payload->>'name','')))=0 or length(payload->>'name')>80
    or length(payload->>'email')>200 or coalesce(payload->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception '邀请资料无效'; end if;
   if exists(select 1 from ezshop.merchants where lower(email)=lower(payload->>'email')) then raise exception '此邮箱已有商家账号，请使用独立邮箱'; end if;
   if payload->>'role'='agent' then
     if coalesce(payload->>'rate','') !~ '^[0-9]+$' or (payload->>'rate')::int not between 0 and 100 then raise exception '佣金比例无效'; end if;
     insert into ezshop.agents(merchant_id,name,rate) values(m.id,payload->>'name',(payload->>'rate')::int) returning id into agent_id;
   end if;
   invite:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
   insert into ezshop.memberships(merchant_id,name,email,role,agent_id,invite_token,expires) values(m.id,payload->>'name',lower(payload->>'email'),payload->>'role',agent_id,invite,extract(epoch from now())::bigint+604800);
   insert into ezshop.audit_log(merchant_id,actor,action) values(m.id,uid::text,'team.invite');
   return jsonb_build_object('invite_token',invite);
 end if;
 if route='team/revoke' then
   delete from ezshop.memberships where id=(payload->>'id')::bigint and merchant_id=m.id;
   if not found then raise exception '找不到团队成员'; end if;
   insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(m.id,uid::text,'team.revoke',(payload->>'id')::bigint);
   return jsonb_build_object('ok',true);
 end if;
 if route in ('platform','platform/update') then
   if not m.is_admin then raise exception '需要平台管理员权限'; end if;
   if route='platform' then
     return jsonb_build_object('merchants',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select t.id,t.name,t.email,t.slug,t.plan,t.status,count(r.id) orders_count,coalesce(sum(case when r.status='paid' then r.total else 0 end),0) sales from ezshop.merchants t left join ezshop.orders r on r.merchant_id=t.id group by t.id) x));
   end if;
   if coalesce(payload->>'plan','') not in ('free','pro') or coalesce(payload->>'status','') not in ('active','suspended') then raise exception '方案或状态无效'; end if;
   if (payload->>'id')::bigint=m.id and payload->>'status'='suspended' then raise exception '不能暂停自己的管理账号'; end if;
   update ezshop.merchants set plan=payload->>'plan',status=payload->>'status' where id=(payload->>'id')::bigint;
   if not found then raise exception '找不到商家'; end if;
   insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(m.id,uid::text,'merchant.update',(payload->>'id')::bigint);
   return jsonb_build_object('ok',true);
 end if;
 if route in ('products','products/update') then
   if length(trim(coalesce(payload->>'name','')))=0 or length(payload->>'name')>120 or (payload->>'price')::bigint not between 1 and 100000000 or (payload->>'stock')::int not between 0 and 1000000
    or coalesce(payload->>'price','') !~ '^[0-9]+$' or coalesce(payload->>'stock','') !~ '^[0-9]+$'
    or length(coalesce(payload->>'description',''))>2000 or length(coalesce(payload->>'category',''))>80
    or length(coalesce(payload->>'image',''))>2000 or (coalesce(payload->>'image','')<>'' and payload->>'image' !~ '^https://[^/]+')
    or coalesce(payload->>'featured','0') not in ('0','1') or coalesce(payload->>'published','1') not in ('0','1') then raise exception '商品资料无效'; end if;
   if route='products' then
     insert into ezshop.products(merchant_id,name,price,stock,emoji,description,category,image,published,featured) values(m.id,payload->>'name',(payload->>'price')::bigint,(payload->>'stock')::int,coalesce(payload->>'emoji','📦'),coalesce(payload->>'description',''),coalesce(payload->>'category','全部商品'),coalesce(payload->>'image',''),coalesce((payload->>'published')::int,1),coalesce((payload->>'featured')::int,0));
   else
     update ezshop.products set name=payload->>'name',price=(payload->>'price')::bigint,stock=(payload->>'stock')::int,emoji=coalesce(payload->>'emoji','📦'),description=coalesce(payload->>'description',''),category=coalesce(payload->>'category','全部商品'),image=coalesce(payload->>'image',''),published=coalesce((payload->>'published')::int,1),featured=coalesce((payload->>'featured')::int,0),version=version+1 where id=(payload->>'id')::bigint and merchant_id=m.id and version=(payload->>'version')::bigint;
     if not found then raise exception '商品或库存已更新，请刷新后重新编辑'; end if;
   end if;
   return jsonb_build_object('ok',true);
 end if;
 if route='settings' then
   if length(trim(coalesce(payload->>'name','')))=0 or length(payload->>'name')>80 or length(coalesce(payload->>'description',''))>500
    or (coalesce(payload->>'phone','')<>'' and payload->>'phone' !~ '^\+?[0-9]{8,15}$') then raise exception '店铺资料无效'; end if;
   if length(coalesce(payload->>'logo',''))>2000 or length(coalesce(payload->>'banner',''))>2000
    or (coalesce(payload->>'logo','')<>'' and payload->>'logo' !~ '^https://[^/]+') or (coalesce(payload->>'banner','')<>'' and payload->>'banner' !~ '^https://[^/]+') then raise exception '店铺图片必须使用 HTTPS 网址'; end if;
   update ezshop.merchants set name=payload->>'name',phone=coalesce(payload->>'phone',''),description=coalesce(payload->>'description',''),logo=coalesce(payload->>'logo',m.logo),banner=coalesce(payload->>'banner',m.banner) where id=m.id;
   return jsonb_build_object('ok',true);
 end if;
 if route='agents' then
   if length(trim(coalesce(payload->>'name','')))=0 or length(payload->>'name')>80 or coalesce(payload->>'rate','') !~ '^[0-9]+$' or (payload->>'rate')::int not between 0 and 100 then raise exception '代理资料无效'; end if;
   insert into ezshop.agents(merchant_id,name,rate) values(m.id,payload->>'name',(payload->>'rate')::int);
   return jsonb_build_object('ok',true);
 end if;
 if route in ('orders/detail','orders/paid','orders/cancel') then
   perform pg_advisory_xact_lock(m.id);
   select * into o from ezshop.orders where id=(payload->>'id')::bigint and merchant_id=m.id for update;
   if not found then raise exception '找不到订单'; end if;
   if route='orders/detail' then
     select coalesce(jsonb_agg(jsonb_build_object('name',name,'price',price,'quantity',quantity)),'[]'::jsonb) into items from ezshop.order_items where order_id=o.id;
     return jsonb_build_object('order',to_jsonb(o)-'access_token'-'checkout_key','items',items);
   end if;
   if (route='orders/paid' and o.status='paid') or (route='orders/cancel' and o.status='cancelled') then return jsonb_build_object('ok',true); end if;
   if o.status<>'pending' then raise exception '只能操作待付款订单'; end if;
   if route='orders/cancel' then
     update ezshop.products p set stock=p.stock+i.quantity,version=p.version+1 from ezshop.order_items i where i.order_id=o.id and p.id=i.product_id and p.merchant_id=m.id;
   end if;
   update ezshop.orders set status=case when route='orders/paid' then 'paid' else 'cancelled' end where id=o.id;
   if route='orders/paid' then
     insert into ezshop.notification_jobs(merchant_id,order_id,kind,event_key) values(m.id,o.id,'receipt','receipt:'||o.id::text) on conflict(event_key) do nothing;
   end if;
   insert into ezshop.audit_log(merchant_id,actor,action,object_id) values(m.id,uid::text,route,o.id);
   return jsonb_build_object('ok',true);
 end if;
 raise exception '不支持此操作';
end;
$$;
revoke all on function public.ezshop_api(text,jsonb) from public;
grant execute on function public.ezshop_api(text,jsonb) to anon,authenticated,service_role;
