export async function verifySiteRelease(site, expectedCommit, fetcher = fetch) {
  const base = new URL(site);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !/^[a-f0-9]{40}$/i.test(expectedCommit)
  )
    throw new Error("发布网址或提交编号无效");
  base.pathname = base.pathname.replace(/\/+$/, "") + "/";
  const url = new URL("version.json", base);
  url.searchParams.set("release", expectedCommit);
  const response = await fetcher(url, {
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return false;
  const result = await response.json();
  return (
    result?.commit === expectedCommit &&
    result?.features?.bookkeeping === true &&
    result?.features?.customer_accounts === true &&
    result?.features?.merchant_receiving === true &&
    result?.features?.platform_read === true &&
    result?.features?.portal_navigation_isolated === true
  );
}

/** Verify that deployed HTML and its bundles use the actual hosting base path. */
export async function verifySiteAssets(site, fetcher = fetch) {
  const base = new URL(site);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("Invalid deployment URL");
  base.pathname = base.pathname.replace(/\/+$/, "") + "/";
  const options = () => ({
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  const page = await fetcher(base, options());
  if (!page.ok) return false;
  const html = await page.text();
  const script = html.match(/<script\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
  const stylesheet = [...html.matchAll(/<link\b[^>]*>/gi)]
    .find((match) => /\brel=["']stylesheet["']/i.test(match[0]))?.[0]
    .match(/\bhref=["']([^"']+)["']/i)?.[1];
  if (!script || !stylesheet) return false;
  const assets = [new URL(script, base), new URL(stylesheet, base)];
  const prefix = new URL("assets/", base).pathname;
  if (
    assets.some(
      (url) => url.origin !== base.origin || !url.pathname.startsWith(prefix),
    )
  )
    return false;
  const results = await Promise.all(
    assets.map((url) => fetcher(url, options())),
  );
  return results.every(
    (response, i) =>
      response.ok &&
      (i === 0
        ? /(?:application|text)\/(?:javascript|ecmascript)/i
        : /text\/css/i
      ).test(response.headers.get("content-type") || ""),
  );
}
