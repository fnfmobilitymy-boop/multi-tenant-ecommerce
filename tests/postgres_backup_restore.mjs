// Isolated fixture only. No Supabase connection string is used or accepted.
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { encryptFile, decryptFile } from "../scripts/encrypted-backup-lib.mjs";
const name = "ezshop-restore-fixture-" + randomUUID().slice(0, 8),
  dir = await mkdtemp(path.join(tmpdir(), "ezshop-restore-fixture-"));
const env = { ...process.env };
for (const key of [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
])
  delete env[key];
async function run(program, args, input) {
  return new Promise((resolve, reject) => {
    const c = spawn(program, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (b) => (out += b));
    let diagnostic = "";
    c.stderr.on("data", (b) => (diagnostic += b));
    c.on("error", reject);
    c.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(
            new Error(
              "Isolated backup fixture command failed: " +
                program +
                "; " +
                diagnostic.slice(-1500),
            ),
          ),
    );
    c.stdin.end(input);
  });
}
const docker = (args, input) =>
  run("docker", ["--host=unix:///var/run/docker.sock", ...args], input);
const sql = (db, query) =>
  docker(
    [
      "exec",
      "-i",
      name,
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    query,
  );
let created = false;
try {
  await docker([
    "run",
    "--name",
    name,
    "--network=none",
    "-e",
    "POSTGRES_PASSWORD=fixture-only-password",
    "-d",
    "postgres:18",
  ]);
  created = true;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      // The image's temporary initialization server only opens a Unix socket.
      // TCP readiness waits for the final server after initialization completes.
      await docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert.ok(ready, "Fixture PostgreSQL did not start");
  await sql("postgres", "create database backup_fixture;");
  await sql("postgres", "create database restore_fixture;");
  await sql("restore_fixture", "drop schema public cascade;");
  const setup = await readFile(
    "tests/fixtures/postgres-backup-init.sql",
    "utf8",
  );
  await sql("backup_fixture", setup);
  for (const file of (await readdir("supabase/migrations"))
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await sql(
      "backup_fixture",
      await readFile("supabase/migrations/" + file, "utf8"),
    );
  await sql(
    "backup_fixture",
    `insert into auth.users(id,email) values('11111111-1111-4111-8111-111111111111','fixture@example.test');insert into ezshop.merchants(owner,name,slug,email) values('11111111-1111-4111-8111-111111111111','Fixture','fixture','fixture@example.test');insert into ezshop.products(merchant_id,name,price,stock,unit_cost) select id,'Fixture Product',1000,8,400 from ezshop.merchants;insert into storage.objects(bucket_id,name) values('ezshop-media','fixture/image.png');`,
  );
  await docker([
    "exec",
    name,
    "pg_dump",
    "-U",
    "postgres",
    "-d",
    "backup_fixture",
    "--format=custom",
    "--no-owner",
    "--schema=ezshop",
    "--schema=public",
    "--schema=auth",
    "--schema=storage",
    "--file=/tmp/fixture.dump",
  ]);
  await docker([
    "cp",
    name + ":/tmp/fixture.dump",
    path.join(dir, "database.dump"),
  ]);
  await mkdir(path.join(dir, "objects"));
  const image = await readFile("tests/fixtures/shop-image.png");
  await writeFile(path.join(dir, "objects", "fixture.png"), image);
  await run("tar", [
    "-czf",
    path.join(dir, "plain.tar.gz"),
    "-C",
    dir,
    "database.dump",
    "objects",
  ]);
  const password = "fixture-only-backup-password-0123456789";
  await encryptFile(
    path.join(dir, "plain.tar.gz"),
    path.join(dir, "cipher.ezbackup"),
    password,
  );
  await decryptFile(
    path.join(dir, "cipher.ezbackup"),
    path.join(dir, "verified.tar.gz"),
    password,
  );
  await mkdir(path.join(dir, "restored"));
  await run("tar", [
    "-xzf",
    path.join(dir, "verified.tar.gz"),
    "-C",
    path.join(dir, "restored"),
  ]);
  assert.deepEqual(
    await readFile(path.join(dir, "restored", "objects", "fixture.png")),
    image,
  );
  await docker([
    "cp",
    path.join(dir, "restored", "database.dump"),
    name + ":/tmp/restored.dump",
  ]);
  await docker([
    "exec",
    name,
    "pg_restore",
    "-U",
    "postgres",
    "-d",
    "restore_fixture",
    "--no-owner",
    "--exit-on-error",
    "/tmp/restored.dump",
  ]);
  assert.equal(
    (
      await sql(
        "restore_fixture",
        "select p.name||':'||p.stock||':'||u.email from ezshop.products p join ezshop.merchants m on m.id=p.merchant_id join auth.users u on u.id=m.owner;",
      )
    ).trim(),
    "Fixture Product:8:fixture@example.test",
  );
  assert.equal(
    (
      await sql(
        "restore_fixture",
        "select count(*) from storage.objects where name='fixture/image.png';",
      )
    ).trim(),
    "1",
  );
  assert.equal(
    (
      await sql(
        "restore_fixture",
        "select has_function_privilege('anon','public.ezshop_books_api(text,jsonb)','EXECUTE') or has_function_privilege('authenticated','public.ezshop_customer_store_api(text,jsonb)','EXECUTE');",
      )
    ).trim(),
    "f",
  );
  assert.equal(
    (
      await sql(
        "restore_fixture",
        "select relrowsecurity from pg_class where oid='ezshop.orders'::regclass;",
      )
    ).trim(),
    "t",
  );
  console.log(
    "PASS: 临时PostgreSQL导出、认证加密、解密、四个schema恢复、图片字节及跨表资料/ACL/RLS验证。未访问Supabase或恢复正式数据。",
  );
} finally {
  if (created) await docker(["rm", "-f", name]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
