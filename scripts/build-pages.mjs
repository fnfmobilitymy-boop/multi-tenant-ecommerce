import { spawnSync } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function pagesConfiguration(repository, domain = "") {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(repository || "") ||
    repository === "." ||
    repository === ".."
  )
    throw new Error("Invalid repository name");
  const host = domain.trim().toLowerCase();
  if (host && host !== "ezshop.lifestyle")
    throw new Error("Custom domain must be ezshop.lifestyle");
  return { base: host ? "/" : `/${repository}/`, domain: host };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = pagesConfiguration(
    process.env.REPOSITORY_NAME,
    process.env.EZSHOP_CUSTOM_DOMAIN,
  );
  const result = spawnSync(
    "npm",
    ["run", "build", "--", "--base=" + config.base],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status || 1);
  copyFileSync("dist/index.html", "dist/404.html");
  if (config.domain) writeFileSync("dist/CNAME", config.domain + "\n");
}
