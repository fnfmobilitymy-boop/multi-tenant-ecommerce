import { expect, it } from 'vitest';
import { connectFailure } from '../supabase/functions/_shared/connect-errors';
it('识别 Connect 未开通和不支持国家，不把订阅错误误判成 Connect 开通结果',()=>{
 expect(connectFailure({type:'StripeInvalidRequestError',message:"You can only create new accounts if you've signed up for Connect"}).code).toBe('connect_not_enabled');
 expect(connectFailure({type:'StripeInvalidRequestError',message:'Your platform profile must be completed'}).code).toBe('connect_platform_setup');
 expect(connectFailure({type:'StripeInvalidRequestError',message:'This country is not supported for this platform'}).code).toBe('connect_country_unavailable');
 expect(connectFailure({type:'UnknownError',message:'connect not enabled'}).code).toBe('connect_request_failed');
});
it('浏览器和日志字段不包含原始错误、凭据、客户信息或非法诊断编号',()=>{
 const secret='sk_test_private_fixture';const email='private@example.test';
 const safe=connectFailure({type:'StripeInvalidRequestError',message:secret+' '+email,requestId:secret,raw:{secret,email}});
 expect(JSON.stringify(safe)).not.toContain(secret);expect(JSON.stringify(safe)).not.toContain(email);expect(safe).not.toHaveProperty('request_id');
 expect(connectFailure({requestId:'req_fixture123'}).request_id).toBe('req_fixture123');
});
