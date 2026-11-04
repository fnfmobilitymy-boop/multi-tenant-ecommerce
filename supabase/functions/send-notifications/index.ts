// Supabase Edge Function. 部署与配置后才能发送；仓库推送不会执行。
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { notificationMessage } from "../_shared/mail-template.ts";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  const secret = Deno.env.get("NOTIFICATION_JOB_SECRET");
  if (!secret || req.headers.get("Authorization") !== "Bearer " + secret)
    return json({ error: "Unauthorized" }, 401);
  const apiKey = Deno.env.get("RESEND_API_KEY"),
    sender = Deno.env.get("MAIL_FROM");
  if (!apiKey || !sender) return json({ error: "邮件服务未配置，未发送" }, 503);
  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const rpc = async (route: string, payload: unknown = {}) => {
    const { data, error } = await client.rpc("ezshop_mail_api", {
      route,
      payload,
    });
    if (error) throw error;
    return data;
  };
  try {
    await rpc("mail/reminders");
    let accepted = 0,
      failed = 0;
    const deadline = Date.now() + 45000;
    for (let n = 0; n < 20 && Date.now() < deadline; n++) {
      const job = await rpc("mail/claim");
      if (!job) break;
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + apiKey,
            "Content-Type": "application/json",
            "Idempotency-Key": "ezshop-mail-" + job.id,
          },
          signal: AbortSignal.timeout(10000),
          body: JSON.stringify({
            from: sender,
            to: [job.recipient],
            ...notificationMessage(job),
          }),
        });
        const result = await response.json();
        if (!response.ok || !result.id) throw Error("HTTP " + response.status);
        await rpc("mail/finish", {
          id: job.id,
          status: "sent",
          provider_id: result.id,
        });
        accepted++;
      } catch {
        await rpc("mail/finish", {
          id: job.id,
          status: "failed",
          error: "provider request failed",
        });
        failed++;
      }
    }
    return json({
      accepted,
      failed,
      message: "accepted 表示服务商接受请求，不保证收件人已收到。",
    });
  } catch {
    return json({ error: "通知处理失败，请检查服务端配置及日志。" }, 500);
  }
});
