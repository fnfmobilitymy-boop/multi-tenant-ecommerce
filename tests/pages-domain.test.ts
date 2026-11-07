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
