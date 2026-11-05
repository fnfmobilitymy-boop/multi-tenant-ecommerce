import {stripeAutomationEnabled} from "./features";
import type {SupabaseClient} from '@supabase/supabase-js';
export async function paymentsApi<T>(client:SupabaseClient,path:string,data?:unknown):Promise<T>{
 const payload=(data||{}) as Record<string,unknown>;
 if(['status','store-options','order-summary','resolve-review'].includes(path)){
  const {data:result,error}=await client.rpc('ezshop_payment_api',{route:path==='status'?'owner-status':path,payload});
  if(error)throw new Error('支付模块尚未启用，或当前账号没有操作权限。');return result as T;
 }
 const actions:Record<string,string>={connect:'connect-onboarding',refresh:'connect-refresh',subscribe:'subscription-checkout',portal:'billing-portal',checkout:'order-checkout'};
 if(actions[path]&&!stripeAutomationEnabled)throw new Error('自动线上付款暂未开放，请联系商家安排付款。');
 if(!actions[path])throw new Error('不支持此支付操作。');
 const {data:result,error}=await client.functions.invoke('payments',{body:{...payload,action:actions[path]}});
 if(error){let message='支付服务暂时不可用，请联系平台管理员。';try{const response=(error as {context?:Response}).context;if(response instanceof Response){const body=await response.json();if(typeof body.error==='string')message=body.error}}catch{}throw new Error(message)}
 return result as T;
}
