import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  databaseEnvironment,
  objectFilename,
  encryptFile,
  decryptFile,
} from "./encrypted-backup-lib.mjs";
let working;
let phase = "配置检查";
async function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (part) => {
      output += part;
      if (output.length > 8 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", () => {});
    child.on("error", () => reject(new Error("备份工具启动失败")));
    child.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error("备份工具执行失败，请核对连接、权限及空间")),
    );
  });
}
try {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const pg = databaseEnvironment(process.env.SUPABASE_BACKUP_DB_URL, ref);
  const password = process.env.BACKUP_ENCRYPTION_PASSPHRASE;
  if (!password || password.length < 24)
    throw new Error("备份加密密码至少24个字符");
  const base = new URL(process.env.VITE_SUPABASE_URL);
  if (
    base.hostname !== ref + ".supabase.co" ||
    base.protocol !== "https:" ||
    base.username ||
    base.password
  )
    throw new Error("目标项目不一致");
  const output = path.resolve(
    process.env.BACKUP_OUTPUT_DIR ||
      path.join(process.env.RUNNER_TEMP || tmpdir(), "ezshop-backup-output"),
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  working = await mkdtemp(
    path.join(process.env.RUNNER_TEMP || tmpdir(), "ezshop-private-backup-"),
  );
  await mkdir(path.join(working, "objects"), { mode: 0o700 });
  const env = { ...process.env, ...pg };
  for (const key of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ])
    delete env[key];
  const docker = [
    "--host=unix:///var/run/docker.sock",
    "run",
    "--rm",
    "--network=host",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--mount",
    `type=bind,src=${working},dst=/backup`,
    "--mount",
    "type=bind,src=/etc/ssl/certs/ca-certificates.crt,dst=/trust/ca.crt,readonly",
    ...Object.keys(pg).flatMap((name) => ["--env", name]),
    "postgres:18",
  ];
  const pgRun = (args) => run("docker", [...docker, ...args], { env });
  const listSQL =
    "select coalesce(jsonb_agg(jsonb_build_object('name',o.name,'id',o.id,'updated_at',o.updated_at) order by o.name),'[]'::jsonb) from storage.objects o join storage.buckets b on b.id=o.bucket_id where o.bucket_id='ezshop-media' and b.public=true";
  const bucketSQL =
    "select count(*) from storage.buckets where id='ezshop-media' and public=true";
  if ((await pgRun(["psql", "-X", "-A", "-t", "-c", bucketSQL])).trim() !== "1")
    throw new Error("EZShop图片bucket不存在或不是公开bucket，停止备份");
  const tablesSQL = "select count(*) from information_schema.tables where table_schema='ezshop' and table_name in ('merchants','products','orders','order_items')";
  if ((await pgRun(["psql", "-X", "-A", "-t", "-c", tablesSQL])).trim() !== "4") throw new Error("目标不是完整的EZShop数据库");
  const started = new Date().toISOString();
  phase = "读取图片清单";
  const before = (
    await pgRun(["psql", "-X", "-A", "-t", "-c", listSQL])
  ).trim();
  const objects = JSON.parse(before);
  const limit = 512 * 1024 * 1024;
  let total = 0;
  phase = "只读数据库导出";
  await pgRun([
    "pg_dump",
    "--format=custom",
    "--no-owner",
    "--schema=ezshop",
    "--schema=public",
    "--schema=auth",
    "--schema=storage",
    "--file=/backup/database.dump",
  ]);
  phase = "数据库归档可读性检查";
  await pgRun(["pg_restore", "--list", "/backup/database.dump"]);
  total = (await stat(path.join(working, "database.dump"))).size;
  if (total > limit) throw new Error("备份超过512MB安全上限");
  const manifest = {
    version: 1,
    project_ref: ref,
    started_at: started,
    schemas: ["ezshop", "public", "auth", "storage"],
    bucket: "ezshop-media",
    restore_verified: false,
    other_storage_buckets_included: false,
    objects: [],
  };
  phase = "下载公开图片";
  for (const item of objects) {
    if (
      typeof item.name !== "string" ||
      item.name.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error("图片路径无效");
    const filename = objectFilename("ezshop-media/" + item.name);
    const objectURL = new URL(
      "/storage/v1/object/public/ezshop-media/" +
        item.name.split("/").map(encodeURIComponent).join("/"),
      base,
    );
    const response = await fetch(objectURL, {
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (
      !response.ok ||
      Number(response.headers.get("content-length") || 0) > 10 * 1024 * 1024
    )
      throw new Error("图片文件读取失败或超过大小上限，停止备份");
    const parts = [];
    let bytes = 0;
    for await (const part of response.body) {
      bytes += part.length;
      if (bytes > 10 * 1024 * 1024 || total + bytes > limit)
        throw new Error("图片或总备份超过大小上限");
      parts.push(part);
    }
    const data = Buffer.concat(parts);
    total += bytes;
    await writeFile(path.join(working, "objects", filename), data, {
      flag: "wx",
      mode: 0o600,
    });
    manifest.objects.push({
      ...item,
      file: "objects/" + filename,
      bytes,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  phase = "图片一致性检查";
  const after = (await pgRun(["psql", "-X", "-A", "-t", "-c", listSQL])).trim();
  if (before !== after)
    throw new Error("备份期间图片发生变化，请在低流量时段重试");
  manifest.completed_at = new Date().toISOString();
  const hash = async (file) => {
    const digest = createHash("sha256");
    for await (const part of createReadStream(file)) digest.update(part);
    return digest.digest("hex");
  };
  manifest.database_sha256 = await hash(path.join(working, "database.dump"));
  await writeFile(
    path.join(working, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  );
  phase = "打包并加密";
  const archive = path.join(working, "backup.tar.gz");
  await run("tar", [
    "-czf",
    archive,
    "-C",
    working,
    "database.dump",
    "manifest.json",
    "objects",
  ]);
  const destination = path.join(
    output,
    "ezshop-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      "-" +
      randomUUID().slice(0, 8) +
      ".ezbackup",
  );
  await encryptFile(archive, destination, password);
  phase = "解密回读验证";
  const verification = path.join(working, "verified.tar.gz");
  await decryptFile(destination, verification, password);
  if ((await hash(archive)) !== (await hash(verification))) {
    await rm(destination);
    throw new Error("加密备份回读校验失败");
  }
  console.log(
    `加密备份已生成并完成解密回读及校验：数据库资料与${objects.length}张EZShop图片。没有执行数据库或图片恢复。`,
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    await writeFile(
      process.env.GITHUB_STEP_SUMMARY,
      "加密备份已生成，数据库归档可读取、加密文件回读校验通过。请下载 Artifact 并另行妥善保存加密密码。文件仅保留7天，过期自动删除。\n\n范围：ezshop/public/auth/storage 四个 schema 和 ezshop-media 图片文件；不含其他 Storage bucket、Edge Secrets、项目设置和外部图片链接。未执行实际恢复演练。\n",
      { flag: "a" },
    );
} catch {
  console.error(
    `加密备份未完成（${phase}）。请核对同项目Session pooler连接串、数据库密码、至少24字符的加密密码、TLS证书及存储空间；不会输出连接串或资料。没有执行数据库写入或恢复。`,
  );
  process.exitCode = 1;
} finally {
  if (working) await rm(working, { recursive: true, force: true });
}
