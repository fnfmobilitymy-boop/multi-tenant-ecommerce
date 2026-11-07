import {paymentReadiness} from "../_shared/payment-readiness.ts";
import {connectFailure} from "../_shared/connect-errors.ts";
import Stripe from 'npm:stripe@23.1.0';
import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import {appUrl,stripeRedirect} from '../_shared/payment-security.ts';
Deno.serve(async(req:Request)=>{
 let root:URL;try{root=appUrl(Deno.env.get('APP_URL'))}catch{return new Response(JSON.stringify({error:'支付服务尚未配置，当前不会发起付款或订阅。'}),{status:503,headers:{'Content-Type':'application/json'}})}
 const origin=req.headers.get('Origin');const headers={'Content-Type':'application/json','Access-Control-Allow-Origin':root.origin,'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS','Vary':'Origin'};
 const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
 if(origin&&origin!==root.origin)return reply({error:'Origin not allowed'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply({error:'POST required'},405);
 let body:any;try{body=await req.json()}catch{return reply({error:'Invalid JSON'},400)}
 if(['connect-onboarding','connect-refresh','order-checkout'].includes(body?.action))return reply({error:'商家商品收款不使用Stripe，请使用商家本地收款方式。'},409);
 if(body?.action==='subscription-checkout')return reply({error:'平台Pro采用人工审核，请提交付款申请并等待平台确认到账。'},409);
 if(body?.action==='readiness')return reply(paymentReadiness(name=>Deno.env.get(name)));
 const key=Deno.env.get('STRIPE_SECRET_KEY');if(!key)return reply({error:'支付服务尚未配置，当前不会发起付款或订阅。'},503);
 const stripe=new Stripe(key,{httpClient:Stripe.createFetchHttpClient()});
 const service=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
 const rpc=async(route:string,payload:unknown={})=>{const {data,error}=await service.rpc('ezshop_payment_api',{route,payload});if(error)throw error;return data};
 let operation="";
 try{
  const action=body?.action;
  if(["connect-onboarding","connect-refresh"].includes(action))operation=action;
  if(action==='order-checkout'){
   if(typeof body.reference!=='string'||typeof body.token!=='string'||body.reference.length>100||body.token.length>200)return reply({error:'订单访问凭证无效'},400);
   let order=await rpc('service/order-claim',{reference:body.reference,token:body.token});
   const account=await stripe.accounts.retrieve(order.account_id);
   if(!account.charges_enabled||!account.details_submitted)return reply({error:'商家收款账户尚未完成开通。'},409);
   if(order.session_id){
    const existing=await stripe.checkout.sessions.retrieve(order.session_id,{},{stripeAccount:order.account_id});
    if(existing.status==='open'&&existing.url)return reply({url:stripeRedirect(existing.url,'checkout')});
    if(existing.status!=='expired')return reply({error:'付款正在核实，请勿重复付款。'},409);
    await rpc('service/expire-order-session',{session_id:existing.id,account_id:order.account_id});order=await rpc('service/order-claim',{reference:body.reference,token:body.token});
   }
   const result=new URL('shop/'+encodeURIComponent(order.slug)+'/order-result',root);result.searchParams.set('ref',order.reference);
   const session=await stripe.checkout.sessions.create({mode:'payment',payment_intent_data:{metadata:{ezshop_order_reference:order.reference,ezshop_merchant_id:String(order.merchant_id)}},customer_email:order.email,client_reference_id:order.reference,allowed_payment_method_types:account.country==='MY'&&order.currency==='myr'&&account.capabilities?.fpx_payments==='active'?['card','fpx']:['card'],line_items:[{price_data:{currency:order.currency,unit_amount:order.amount,product_data:{name:order.store_name+' · '+order.reference}},quantity:1}],metadata:{ezshop_order_reference:order.reference,ezshop_merchant_id:String(order.merchant_id)},success_url:result.toString()+'&payment_return=1',cancel_url:result.toString()+'&payment_return=cancelled'}, {stripeAccount:order.account_id,idempotencyKey:'ezshop-order-'+order.id});
   await rpc('service/save-order-session',{attempt_id:order.id,session_id:session.id});return reply({url:stripeRedirect(session.url,'checkout')});
  }
  const authorization=req.headers.get('Authorization');if(!authorization)return reply({error:'请先登录'},401);
  const scoped=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:authorization}},auth:{persistSession:false}});
  const {data:user,error:userError}=await scoped.auth.getUser();if(userError||!user.user)return reply({error:'请先登录'},401);
  const {data:owner,error:ownerError}=await scoped.rpc('ezshop_payment_api',{route:'owner-status',payload:{}});if(ownerError)return reply({error:'需要商家所有者权限，或支付模块尚未启用。'},403);
  if(['connect-onboarding','connect-refresh'].includes(action)&&owner.subscription_access===false)return reply({error:'Pro试用或订阅已到期，请先续费。'},403);
  if(action==='connect-onboarding'){
   if(!['MY','SG','TH'].includes(owner.country_code||'MY'))return reply({error:'此地区暂未接入Stripe Connect，请使用商家自填收款方式。'},409);
   let accountId=owner.account_id;
   if(!accountId){
    const account=await stripe.accounts.create({type:'express',country:owner.country_code||'MY',email:owner.email,capabilities:{card_payments:{requested:true},transfers:{requested:true}},metadata:{ezshop_merchant_id:String(owner.merchant_id)}},{idempotencyKey:'ezshop-connect-'+owner.merchant_id});accountId=account.id;await rpc('service/bind-account',{merchant_id:owner.merchant_id,account_id:accountId});
   }
   const link=await stripe.accountLinks.create({account:accountId,type:'account_onboarding',refresh_url:root.toString()+'?connect=refresh',return_url:root.toString()+'?connect=return'});return reply({url:stripeRedirect(link.url,'connect')});
  }
  if(action==='connect-refresh'){
   if(!owner.account_id)return reply({error:'请先开通收款账户。'},409);
   const account=await stripe.accounts.retrieve(owner.account_id);await rpc('service/account-status',{account_id:account.id,charges_enabled:account.charges_enabled,payouts_enabled:account.payouts_enabled,details_submitted:account.details_submitted});return reply({ok:true});
  }
  if(action==='billing-portal'){
   if(!owner.billing?.customer_id)return reply({error:'尚未建立订阅账户。'},409);
   const session=await stripe.billingPortal.sessions.create({customer:owner.billing.customer_id,return_url:root.toString()});return reply({url:stripeRedirect(session.url,'billing')});
  }
  return reply({error:'不支持此操作'},404);
 }catch(error){
  if(operation){const failure=connectFailure(error);console.warn('connect_failure',JSON.stringify({operation,code:failure.code,request_id:failure.request_id}));return reply(failure,502)}
  return reply({error:'支付服务暂时无法完成请求。请勿重复付款，请重试或联系平台管理员。'},502)
 }
});
