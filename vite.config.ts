import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
let commit = process.env.GITHUB_SHA || "local";
if (process.env.GITHUB_SHA && !/^[a-f0-9]{40}$/i.test(commit)) throw new Error("Invalid build commit");
if (commit === "local") {
  try {
    const head = readFileSync(".git/HEAD", "utf8").trim();
    const ref = head.startsWith("ref: ") ? head.slice(5) : "";
    const value = ref.startsWith("refs/") && !ref.split("/").includes("..") ? readFileSync(resolve(".git", ref), "utf8").trim() : head;
    if (/^[a-f0-9]{40}$/i.test(value)) commit = value;
  } catch { /* Source archives can still build without Git metadata. */ }
}
const releaseMetadata = {
  name: "ezshop-release-metadata",
  generateBundle(this: { emitFile: (asset: { type: "asset"; fileName: string; source: string }) => unknown }) {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ commit, built_at: new Date().toISOString(), features: { customer_accounts: true, bookkeeping: true, merchant_receiving: true } }) });
  },
};
export default defineConfig({
  plugins: [react(), tailwindcss(), releaseMetadata],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/brand": "http://127.0.0.1:3000",
      "/media": "http://127.0.0.1:3000",
    },
  },
});
