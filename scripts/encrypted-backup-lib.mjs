import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  createHash,
} from "node:crypto";
import { open, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
const magic = Buffer.from("EZBKP001");
const headerSize = 36,
  tagSize = 16;
function keyFor(password, salt) {
  if (typeof password !== "string" || password.length < 24)
    throw new Error("备份加密密码至少24个字符");
  return scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}
export function databaseEnvironment(value, ref) {
  if (!/^[a-z]{20}$/.test(ref || "")) throw new Error("项目编号无效");
  const url = new URL(value);
  const username = decodeURIComponent(url.username),
    password = decodeURIComponent(url.password),
    database = decodeURIComponent(url.pathname.slice(1));
  const direct =
    url.hostname === `db.${ref}.supabase.co` && username === "postgres";
  const pooler =
    /^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(url.hostname) &&
    username === `postgres.${ref}`;
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    (!direct && !pooler) ||
    (url.port && url.port !== "5432") ||
    !password ||
    database !== "postgres" ||
    url.hash
  )
    throw new Error("请使用同一项目的数据库直连或Session pooler连接串（5432）");
  return {
    PGHOST: url.hostname,
    PGPORT: "5432",
    PGCONNECT_TIMEOUT: "20",
    PGAPPNAME: "ezshop-encrypted-backup",
    PGUSER: username,
    PGPASSWORD: password,
    PGDATABASE: database,
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: "/trust/ca.crt",
    PGOPTIONS:
      "-c default_transaction_read_only=on -c statement_timeout=300000",
  };
}
export const objectFilename = (name) =>
  createHash("sha256").update(name).digest("hex");
async function writeAll(file, data) {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await file.write(
      data,
      offset,
      data.length - offset,
    );
    if (!bytesWritten) throw new Error("备份写入失败");
    offset += bytesWritten;
  }
}
export async function encryptFile(source, destination, password) {
  const salt = randomBytes(16),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", keyFor(password, salt), iv);
  const header = Buffer.concat([magic, salt, iv]);
  cipher.setAAD(header);
  const output = await open(destination, "wx", 0o600);
  try {
    await writeAll(output, header);
    for await (const part of createReadStream(source))
      await writeAll(output, cipher.update(part));
    await writeAll(output, cipher.final());
    await writeAll(output, cipher.getAuthTag());
  } catch (e) {
    await output.close();
    await unlink(destination).catch(() => {});
    throw e;
  }
  await output.close();
}
export async function decryptFile(source, destination, password) {
  const size = (await stat(source)).size;
  if (size < headerSize + tagSize) throw new Error("备份文件不完整");
  const input = await open(source, "r"),
    header = Buffer.alloc(headerSize),
    tag = Buffer.alloc(tagSize);
  try {
    await input.read(header, 0, headerSize, 0);
    await input.read(tag, 0, tagSize, size - tagSize);
  } finally {
    await input.close();
  }
  if (!header.subarray(0, 8).equals(magic)) throw new Error("备份格式无效");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFor(password, header.subarray(8, 24)),
    header.subarray(24, 36),
  );
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const output = await open(destination, "wx", 0o600);
  try {
    if (size > headerSize + tagSize)
      for await (const part of createReadStream(source, {
        start: headerSize,
        end: size - tagSize - 1,
      }))
        await writeAll(output, decipher.update(part));
    await writeAll(output, decipher.final());
  } catch (e) {
    await output.close();
    await unlink(destination).catch(() => {});
    throw e;
  }
  await output.close();
}
