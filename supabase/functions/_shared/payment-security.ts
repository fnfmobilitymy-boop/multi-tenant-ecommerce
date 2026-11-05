export type RecordValue=Record<string,any>;
export function appUrl(value:string|undefined):URL{
 if(!value)throw new Error('APP_URL not configured');const url=new URL(value);
 if((url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))||url.username||url.password||url.search||url.hash)throw new Error('Invalid APP_URL');
 url.pathname=url.pathname.replace(/\/+$/,'')+'/';return url;
}
export function stripeRedirect(value:unknown,kind:'checkout'|'connect'|'billing'):string{
 if(typeof value!=='string')throw new Error('Missing Stripe redirect');const url=new URL(value);
 const host={checkout:'checkout.stripe.com',connect:'connect.stripe.com',billing:'billing.stripe.com'}[kind];
 if(url.protocol!=='https:'||url.hostname!==host||url.username||url.password||url.port)throw new Error('Untrusted payment redirect');return url.toString();
}
export function idOf(value:unknown):string|null{return typeof value==='string'?value:value&&typeof value==='object'&&'id'in value&&typeof value.id==='string'?value.id:null}
export function paymentEvent(event:RecordValue):RecordValue|null{
 if(!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type))return null;
 const object=event.data?.object;
 if(object?.mode!=='payment'||!object.metadata?.ezshop_order_reference||object.payment_status!=='paid')return null;
 if(typeof event.account!=='string'||!event.account.startsWith('acct_')||typeof object.id!=='string'||!Number.isSafeInteger(object.amount_total)||object.amount_total<0)throw new Error('Invalid connected payment event');
 return {event_id:event.id,session_id:object.id,account_id:event.account,currency:String(object.currency||'').toLowerCase(),amount:object.amount_total,payment_intent:idOf(object.payment_intent)};
}
export function subscriptionSnapshot(subscription:RecordValue):RecordValue{
 const merchant=Number(subscription.metadata?.ezshop_merchant_id),items=subscription.items?.data;
 if(!Number.isSafeInteger(merchant)||merchant<1||!Array.isArray(items)||items.length!==1)throw new Error('Unknown subscription');
 const item=items[0],price=item.price;
 if(!price||price.currency!=='myr'||(item.quantity??1)!==1||!idOf(price)||!idOf(subscription.customer)||!idOf(subscription))throw new Error('Invalid subscription price or customer');
 const period=item.current_period_end??subscription.current_period_end??0;
 if(!Number.isSafeInteger(period)||period<0||(['active','trialing'].includes(subscription.status)&&period===0))throw new Error('Invalid subscription period');
 return {merchant_id:merchant,customer_id:idOf(subscription.customer),subscription_id:subscription.id,price_id:price.id,status:subscription.status,period_end:period,invoice_paid:subscription.latest_invoice?.status==='paid'||subscription.latest_invoice?.paid===true};
}

// The configured Stripe tax rate is authoritative for invoice calculation.
// Never accept an amount or tax rate from the browser.
export function validateProCheckout(price: RecordValue, tax: RecordValue): void {
 if(!price.active || price.currency!=='myr' || price.unit_amount!==9990 || price.tax_behavior==='inclusive' || !price.recurring || price.recurring.interval_count!==1 || price.recurring.interval!=='month')throw new Error('Invalid Pro price');
 if(!tax.active || tax.percentage!==6 || tax.inclusive!==false || typeof tax.id!=='string' || !tax.id.startsWith('txr_'))throw new Error('Invalid Pro tax rate');
}

export function proTrialEnd(value: unknown, now = Date.now()): number | undefined {
 const ending = typeof value === 'string' ? Date.parse(value) : NaN;
 return Number.isFinite(ending) && ending > now + 60000 ? Math.floor(ending / 1000) : undefined;
}
