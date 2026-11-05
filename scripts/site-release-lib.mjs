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
