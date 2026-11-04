/** Accept the project URL or the REST endpoint copied from Supabase's console. */
export function normalizeSupabaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) {
    throw new Error('Supabase URL 必须使用 HTTPS；本地开发地址除外。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Supabase URL 不能包含账号、密码或查询参数。');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/rest/v1') url.pathname = '';
  else if (path !== '') throw new Error('请填写 Supabase 项目根网址，不要附加 API 路径。');
  return url.toString().replace(/\/+$/, '');
}
