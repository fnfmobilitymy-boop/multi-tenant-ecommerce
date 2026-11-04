import {describe,it,expect} from 'vitest';
import {normalizeSupabaseUrl} from './supabase-config';
const root='https://uhqhatcygteviyonzojn.supabase.co';
describe('Supabase 项目 URL 自动修正',()=>{
 it('保留正确的项目根网址',()=>expect(normalizeSupabaseUrl(root)).toBe(root));
 it('修正复制的 REST 端点及尾部空格',()=>{
  expect(normalizeSupabaseUrl(root+'/rest/v1')).toBe(root);
  expect(normalizeSupabaseUrl(' '+root+'/rest/v1/ ')).toBe(root);
 });
 it('保留本地开发服务端口',()=>expect(normalizeSupabaseUrl('http://127.0.0.1:54321/rest/v1/')).toBe('http://127.0.0.1:54321'));
 it('拒绝含凭证和意外路径的网址',()=>{
  for(const value of ['https://name:password@example.com',root+'/rest/v1/products',root+'?key=test','http://example.com'])expect(()=>normalizeSupabaseUrl(value)).toThrow();
 });
});
