-- 店铺和商品公开图片。客户凭证和私密文件不得放入此公开 bucket。
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('ezshop-media','ezshop-media',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;
-- 检查冲突，不能静默改变已有 bucket 的公开范围或覆盖已有文件。
do $$ begin
 if not exists(select 1 from storage.buckets where id='ezshop-media' and public=true and file_size_limit=5242880
  and allowed_mime_types @> array['image/jpeg','image/png','image/webp'] and allowed_mime_types <@ array['image/jpeg','image/png','image/webp']) then
  raise exception 'ezshop-media 已存在但配置不同，请先审查 bucket，未自动更改其配置';
 end if;
end $$;
create or replace function public.ezshop_can_upload_media()
returns boolean language sql stable security definer set search_path=pg_catalog,ezshop as $$
 select exists(select 1 from ezshop.merchants where owner=auth.uid() and status='active')
 or exists(select 1 from ezshop.memberships member join ezshop.merchants merchant on merchant.id=member.merchant_id
  where member.user_id=auth.uid() and member.role in ('inventory','manager') and merchant.status='active');
$$;
revoke all on function public.ezshop_can_upload_media() from public,anon;
grant execute on function public.ezshop_can_upload_media() to authenticated;
-- 只能新增自己 UUID 目录中的文件，不授予覆盖或删除他人图片的权限。
drop policy if exists ezshop_media_insert on storage.objects;
create policy ezshop_media_insert on storage.objects for insert to authenticated
with check(bucket_id='ezshop-media' and (storage.foldername(name))[1]=auth.uid()::text and public.ezshop_can_upload_media());
-- 读取公开 URL 由 Storage public bucket 提供；此策略仅允许登录者读取自己的对象元数据。
drop policy if exists ezshop_media_select on storage.objects;
create policy ezshop_media_select on storage.objects for select to authenticated
using(bucket_id='ezshop-media' and (storage.foldername(name))[1]=auth.uid()::text and public.ezshop_can_upload_media());
