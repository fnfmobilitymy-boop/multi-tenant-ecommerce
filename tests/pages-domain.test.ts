import { describe, it, expect } from "vitest";
import { pagesConfiguration } from "../scripts/build-pages.mjs";
describe("Custom domain deployment paths", () => {
  it("retains project paths while the domain is not activated", () =>
    expect(pagesConfiguration("multi-tenant-ecommerce")).toEqual({
      base: "/multi-tenant-ecommerce/",
      domain: "",
    }));
  it("uses root paths only when the intended domain is activated", () =>
    expect(
      pagesConfiguration("multi-tenant-ecommerce", "ezshop.lifestyle"),
    ).toEqual({ base: "/", domain: "ezshop.lifestyle" }));
  it("rejects URLs, other domains and traversal in deployment configuration", () => {
    for (const domain of [
      "https://ezshop.lifestyle",
      "other.example",
      "ezshop.lifestyle/path",
    ])
      expect(() => pagesConfiguration("repo", domain)).toThrow();
    for (const name of ["../repo", ".", "..", "repo/other"])
      expect(() => pagesConfiguration(name)).toThrow();
  });
});

describe("Deployed domain asset checks", () => {
  it("accepts root and project deployments when scripts and styles load from the matching base", async () => {
    const { verifySiteAssets } = await import(
      "../scripts/site-release-lib.mjs"
    );
    for (const path of ["/", "/multi-tenant-ecommerce/"]) {
      const fetcher = async (url: URL) =>
        url.pathname === path
          ? new Response(
              `<script type="module" src="${path}assets/app.js"></script><link rel="stylesheet" href="${path}assets/app.css">`,
            )
          : new Response("", {
              headers: {
                "content-type": url.pathname.endsWith(".js")
                  ? "text/javascript"
                  : "text/css",
              },
            });
      expect(
        await verifySiteAssets("https://ezshop.lifestyle" + path, fetcher),
      ).toBe(true);
    }
  });
  it("rejects the old project asset path on a root domain, missing assets and HTML fallbacks", async () => {
    const { verifySiteAssets } = await import(
      "../scripts/site-release-lib.mjs"
    );
    expect(
      await verifySiteAssets(
        "https://ezshop.lifestyle",
        async () =>
          new Response(
            '<script src="/multi-tenant-ecommerce/assets/app.js"></script><link rel="stylesheet" href="/multi-tenant-ecommerce/assets/app.css">',
          ),
      ),
    ).toBe(false);
    for (const status of [200, 404]) {
      expect(
        await verifySiteAssets("https://ezshop.lifestyle", async (url: URL) =>
          url.pathname === "/"
            ? new Response(
                '<script src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">',
              )
            : new Response("<html>Not a bundle</html>", {
                status,
                headers: { "content-type": "text/html" },
              }),
        ),
      ).toBe(false);
    }
  });
});
