import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  encryptFile,
  decryptFile,
  databaseEnvironment,
  objectFilename,
} from "../scripts/encrypted-backup-lib.mjs";
const password = "fixture-backup-passphrase-0123456789";
it("认证加密回读、篡改与错误密码拒绝，不覆盖已有备份或目标", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ezshop-crypto-test-"));
  try {
    const input = path.join(dir, "in"),
      encrypted = path.join(dir, "encrypted"),
      restored = path.join(dir, "restored");
    const content = "private-customer-fixture".repeat(20000);
    await writeFile(input, content);
    await encryptFile(input, encrypted, password);
    expect(
      (await readFile(encrypted)).includes(
        Buffer.from("private-customer-fixture"),
      ),
    ).toBe(false);
    await decryptFile(encrypted, restored, password);
    expect(await readFile(restored, "utf8")).toBe(content);
    await expect(encryptFile(input, encrypted, password)).rejects.toThrow();
    await expect(decryptFile(encrypted, restored, password)).rejects.toThrow();
    expect(await readFile(restored, "utf8")).toBe(content);
    const wrong = path.join(dir, "wrong");
    await expect(
      decryptFile(encrypted, wrong, password + "wrong"),
    ).rejects.toThrow();
    await expect(access(wrong)).rejects.toThrow();
    const data = await readFile(encrypted);
    data[data.length - 1] ^= 1;
    await writeFile(path.join(dir, "corrupt"), data);
    await expect(
      decryptFile(
        path.join(dir, "corrupt"),
        path.join(dir, "corrupt-output"),
        password,
      ),
    ).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("只接受同项目的直连或会话连接，密码不放命令参数，图片名不会成为文件路径", () => {
  const ref = "a".repeat(20);
  const env = databaseEnvironment(
    `postgresql://postgres.${ref}:fixture-pass@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
    ref,
  );
  expect(env.PGSSLMODE).toBe("verify-full");
  expect(env.PGOPTIONS).toContain("read_only=on");
  for (const url of [
    `postgresql://postgres:pw@evil.example:5432/postgres`,
    `postgresql://postgres.${ref}:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
    `postgresql://postgres.other:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
  ])
    expect(() => databaseEnvironment(url, ref)).toThrow();
  expect(objectFilename("../../private")).toMatch(/^[a-f0-9]{64}$/);
  expect(() => databaseEnvironment("not-a-url", ref)).toThrow();
});
