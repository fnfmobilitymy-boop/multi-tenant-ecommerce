import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./api";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const formats: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
export function validateImage(file: File): string {
  if (!formats[file.type]) throw new Error("请选择 JPG、PNG 或 WebP 图片。");
  if (file.size === 0) throw new Error("图片文件为空，请重新选择。");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("图片不能超过 5 MB。");
  return formats[file.type];
}
export async function uploadImage(
  file: File,
  client: SupabaseClient | null = supabase,
): Promise<string> {
  const extension = validateImage(file);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("无法读取这张图片，请选择有效的 JPG、PNG 或 WebP 文件。");
  }
  const pixels = bitmap.width * bitmap.height;
  bitmap.close();
  if (pixels > 40000000) throw new Error("图片尺寸过大，请选择较小的图片。");
  if (client) {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) throw new Error("请先登录，再上传图片。");
    const path = data.user.id + "/" + crypto.randomUUID() + "." + extension;
    const { error: uploadError } = await client.storage
      .from("ezshop-media")
      .upload(path, file, { contentType: file.type, upsert: false });
    if (uploadError) {
      if (/bucket.*not found/i.test(uploadError.message))
        throw new Error("图片存储尚未初始化，请先完成图片上传配置。");
      throw new Error("图片上传失败，请检查登录状态及图片存储权限后重试。");
    }
    return client.storage.from("ezshop-media").getPublicUrl(path).data
      .publicUrl;
  }
  const response = await fetch("/api/media", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": file.type },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "图片上传失败，请重试。");
  return result.url;
}
