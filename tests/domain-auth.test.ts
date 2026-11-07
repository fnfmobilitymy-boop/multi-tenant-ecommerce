import { describe, it, expect } from "vitest";
import {
  domainAuthSettings,
  configureDomainAuth,
} from "../scripts/configure-domain-auth.mjs";
const ref = "abcdefghijklmnopqrst";
const env = {
  EZSHOP_CUSTOM_DOMAIN: "ezshop.lifestyle",
  VITE_SUPABASE_URL: `https://${ref}.supabase.co`,
  SUPABASE_PROJECT_REF: ref,
  SUPABASE_ACCESS_TOKEN: "fixture-not-a-real-token",
};
describe("Domain auth migration", () => {
  it("keeps the old default and all redirects, adds the new addresses, and is idempotent", () => {
    const current = {
      site_url: "https://old.example/merchant",
      uri_allow_list:
        "https://old.example/shop/**,https://other.example/callback",
      smtp_pass: "never-return-this",
    };
    const desired = domainAuthSettings(current, "ezshop.lifestyle");
    expect(desired.site_url).toBe("https://ezshop.lifestyle/merchant");
    for (const value of [
      "https://old.example/merchant",
      "https://old.example/shop/**",
      "https://other.example/callback",
      "https://ezshop.lifestyle/shop/**",
      "https://ezshop.lifestyle/reset-password",
    ])
      expect(desired.uri_allow_list).toContain(value);
    expect(Object.keys(desired).sort()).toEqual(["site_url", "uri_allow_list"]);
    expect(domainAuthSettings(desired, "ezshop.lifestyle")).toEqual(desired);
  });
  it("patches only website callbacks and verifies the saved configuration", async () => {
    let state = {
      site_url: "https://old.example/",
      uri_allow_list: "",
      smtp_pass: "private-fixture",
    };
    const methods: string[] = [];
    const result = await configureDomainAuth(
      env,
      async (url: string, options: RequestInit) => {
        expect(url).toBe(
          `https://api.supabase.com/v1/projects/${ref}/config/auth`,
        );
        methods.push(String(options.method));
        if (options.method === "PATCH") {
          const patch = JSON.parse(String(options.body));
          expect(Object.keys(patch).sort()).toEqual([
            "site_url",
            "uri_allow_list",
          ]);
          state = { ...state, ...patch };
        }
        return Response.json(state);
      },
    );
    expect(result).toEqual({ enabled: true, changed: true });
    expect(methods).toEqual(["GET", "PATCH", "GET"]);
    expect(state.smtp_pass).toBe("private-fixture");
  });
  it("does not contact another project and never returns service error bodies", async () => {
    let calls = 0;
    const denied = async () => {
      calls++;
      return new Response("secret-provider-response", { status: 403 });
    };
    await expect(
      configureDomainAuth(
        { ...env, SUPABASE_PROJECT_REF: "zzzzzzzzzzzzzzzzzzzz" },
        denied,
      ),
    ).rejects.toThrow("inconsistent");
    expect(calls).toBe(0);
    await expect(configureDomainAuth(env, denied)).rejects.toThrow("HTTP 403");
    expect(calls).toBe(1);
    expect(
      await configureDomainAuth({ ...env, EZSHOP_CUSTOM_DOMAIN: "" }, denied),
    ).toEqual({ enabled: false, changed: false });
    expect(calls).toBe(1);
  });
});
