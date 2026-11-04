import Stripe from 'npm:stripe@23.1.0';
import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import {paymentEvent,idOf,subscriptionSnapshot} from '../_shared/payment-security.ts';
Deno.serve(async(req:Request)=>{
 const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
 if(req.method!=='POST')return reply({error:'POST required'},405);
 const key=Deno.env.get('STRIPE_SECRET_KEY'),signature=req.headers.get('stripe-signature');
 const secrets=[Deno.env.get('STRIPE_WEBHOOK_SECRET'),Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET')].filter(Boolean) as string[];
 if(!key||!secrets.length)return reply({error:'Webhook not configured'},503);if(!signature)return reply({error:'Missing signature'},400);
 const raw=await req.text();if(raw.length>1000000)return reply({error:'Payload too large'},413);
 const stripe=new Stripe(key,{httpClient:Stripe.createFetchHttpClient()});let event:Stripe.Event|undefined;
 for(const secret of secrets){try{event=await stripe.webhooks.constructEventAsync(raw,signature,secret,300,Stripe.createSubtleCryptoProvider());break}catch{}}
 if(!event||event.livemode!==key.startsWith('sk_live_'))return reply({error:'Invalid signature or mode'},400);
 const service=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
 const rpc=async(route:string,payload:unknown)=>{const {data,error}=await service.rpc('ezshop_payment_api',{route,payload});if(error)throw error;return data};
 try{
  const payment=paymentEvent(event);if(payment)return reply(await rpc('service/payment-completed',payment));
  const object=event.data.object as any;
  if(['checkout.session.expired','checkout.session.async_payment_failed'].includes(event.type)){
   if(object.mode==='payment'&&object.metadata?.ezshop_order_reference&&event.account)await rpc('service/expire-order-session',{session_id:object.id,account_id:event.account});
   if(object.mode==='subscription'&&object.metadata?.ezshop_merchant_id)await rpc('service/expire-billing-session',{session_id:object.id});
   return reply({ok:true});
  }
  if(event.type==='account.updated'&&object.id){const account=await stripe.accounts.retrieve(object.id);await rpc('service/account-status',{account_id:account.id,charges_enabled:account.charges_enabled,payouts_enabled:account.payouts_enabled,details_submitted:account.details_submitted});return reply({ok:true})}
  if(event.account&&['charge.refunded','charge.dispute.created'].includes(event.type)){
   const chargeId=event.type==='charge.refunded'?object.id:idOf(object.charge);
   if(!chargeId)throw new Error('Missing charge');
   const charge=await stripe.charges.retrieve(chargeId,{},{stripeAccount:event.account});
   return reply(await rpc('service/charge-adjustment',{event_id:event.id,account_id:event.account,payment_intent:idOf(charge.payment_intent),kind:event.type==='charge.refunded'?'refund':'dispute',charge_id:charge.id,reference:charge.metadata?.ezshop_order_reference,currency:charge.currency,amount:charge.amount,refunded:charge.amount_refunded}));
  }
  let subscriptionId:string|null=null;
  if(event.type==='checkout.session.completed'&&object.mode==='subscription')subscriptionId=idOf(object.subscription);
  if(['invoice.paid','invoice.payment_failed'].includes(event.type))subscriptionId=idOf(object.subscription)||idOf(object.parent?.subscription_details?.subscription);
  if(['customer.subscription.updated','customer.subscription.deleted'].includes(event.type))subscriptionId=object.id;
  if(subscriptionId){
   const sub=await stripe.subscriptions.retrieve(subscriptionId,{expand:['latest_invoice']});
   if(!sub.metadata?.ezshop_merchant_id)return reply({ok:true,ignored:true});
   return reply(await rpc('service/subscription-sync',{...subscriptionSnapshot(sub),event_id:event.id,event_created:event.created}));
  }
  return reply({ok:true,ignored:true});
 }catch{return reply({error:'Event not yet applied; retry required'},500)}
});
