import Stripe from 'stripe';import {describe,it,expect} from 'vitest';
import {appUrl,stripeRedirect,paymentEvent,subscriptionSnapshot} from '../supabase/functions/_shared/payment-security';
describe('支付安全边界',()=>{
 it('只使用配置的网站根 URL，禁止外部查询参数和凭证',()=>{
  expect(appUrl('https://example.test/shop').toString()).toBe('https://example.test/shop/');expect(()=>appUrl(undefined)).toThrow();expect(()=>appUrl('https://user:pass@example.test/')).toThrow();expect(()=>appUrl('https://example.test/?return=https://evil.test')).toThrow();
 });
 it('收款页面只接受 Stripe 的准确 HTTPS 域名',()=>{
  expect(stripeRedirect('https://checkout.stripe.com/c/pay/test','checkout')).toContain('checkout.stripe.com');expect(()=>stripeRedirect('https://checkout.stripe.com.evil.test/','checkout')).toThrow();expect(()=>stripeRedirect('http://checkout.stripe.com/','checkout')).toThrow();
 });
 it('待处理付款不能冒充已收款，Connected Account 不得缺失',()=>{
  const event={id:'evt_fixture',type:'checkout.session.completed',account:'acct_fixture',data:{object:{id:'cs_fixture',mode:'payment',payment_status:'unpaid',amount_total:1000,currency:'myr',metadata:{ezshop_order_reference:'EZ-FIXTURE'}}}};
  expect(paymentEvent(event)).toBeNull();event.data.object.payment_status='paid';expect(paymentEvent(event)?.amount).toBe(1000);expect(()=>paymentEvent({...event,account:undefined})).toThrow();
 });
 it('官方 SDK 拒绝篡改签名和过期的 Webhook',()=>{
  const stripe=new Stripe('sk_test_fixture');const payload=JSON.stringify({id:'evt_test',type:'checkout.session.completed'}),secret='whsec_test_fixture';
  const signature=stripe.webhooks.generateTestHeaderString({payload,secret});expect(stripe.webhooks.constructEvent(payload,signature,secret).id).toBe('evt_test');expect(()=>stripe.webhooks.constructEvent(payload+' ',signature,secret)).toThrow();
  const stale=stripe.webhooks.generateTestHeaderString({payload,secret,timestamp:Math.floor(Date.now()/1000)-1000});expect(()=>stripe.webhooks.constructEvent(payload,stale,secret,300)).toThrow();
 });
 it('订阅必须匹配商家、单一 MYR 价格和真实已付账单',()=>{
  const sub={id:'sub_fixture',customer:'cus_fixture',status:'active',metadata:{ezshop_merchant_id:'1'},items:{data:[{quantity:1,current_period_end:2000000000,price:{id:'price_fixture',currency:'myr'}}]},latest_invoice:{status:'open'}};
  expect(subscriptionSnapshot(sub).invoice_paid).toBe(false);sub.latest_invoice.status='paid';expect(subscriptionSnapshot(sub).invoice_paid).toBe(true);expect(()=>subscriptionSnapshot({...sub,metadata:{}})).toThrow();expect(()=>subscriptionSnapshot({...sub,items:{data:[]}})).toThrow();
 });
});
