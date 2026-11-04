import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { appUrl } from "../_shared/payment-security.ts";
import {
  CONTENT_LANGUAGES,
  translationInput,
  translatedFields,
} from "../_shared/content-translation.ts";
Deno.serve(async (req: Request) => {
  let root: URL;
  try {
    root = appUrl(Deno.env.get("APP_URL"));
  } catch {
    return new Response("Service not configured", { status: 503 });
  }
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": root.origin,
    "Access-Control-Allow-Headers":
      "authorization,apikey,content-type,x-client-info",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    Vary: "Origin",
  };
  const reply = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers });
  if (req.headers.get("Origin") && req.headers.get("Origin") !== root.origin)
    return reply({ error: "Origin not allowed" }, 403);
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply({ error: "POST required" }, 405);
  const key = Deno.env.get("GOOGLE_TRANSLATE_API_KEY");
  if (!key) return reply({ error: "Translation service not configured" }, 503);
  const authorization = req.headers.get("Authorization");
  if (!authorization) return reply({ error: "Authentication required" }, 401);
  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    },
  );
  const { data: user, error: authError } = await client.auth.getUser();
  if (authError || !user.user)
    return reply({ error: "Authentication required" }, 401);
  let input: ReturnType<typeof translationInput>;
  try {
    const raw = await req.text();
    if (raw.length > 32000) return reply({ error: "Too large" }, 413);
    input = translationInput(JSON.parse(raw));
  } catch {
    return reply({ error: "Invalid content" }, 400);
  }
  const { error: accessError } = await client.rpc("ezshop_translation_access", {
    kind: input.kind,
    characters: input.characters,
  });
  if (accessError)
    return reply(
      { error: "Translation access denied or daily limit reached" },
      403,
    );
  try {
    const versions = await Promise.all(
      CONTENT_LANGUAGES.map(async (language) => {
        const response = await fetch(
          "https://translation.googleapis.com/language/translate/v2",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": key,
            },
            body: JSON.stringify({
              q: input.pairs.map(([, text]) => text),
              target: language === "zh" ? "zh-CN" : language,
              format: "text",
            }),
            signal: AbortSignal.timeout(20000),
          },
        );
        if (!response.ok) throw new Error("Translation provider unavailable");
        return [
          language,
          translatedFields(await response.json(), input.pairs, input.kind),
        ];
      }),
    );
    return reply({ translations: Object.fromEntries(versions) });
  } catch {
    return reply(
      { error: "Translation could not be completed. No draft was saved." },
      502,
    );
  }
});
