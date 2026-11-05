import { decryptFile } from "./encrypted-backup-lib.mjs";
try {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error("missing filenames");
  await decryptFile(
    source,
    destination,
    process.env.BACKUP_ENCRYPTION_PASSPHRASE,
  );
  console.log(
    "已解密到新文件；未连接数据库、未恢复或覆盖任何业务资料。解密后的文件含敏感资料，请妥善保管。",
  );
} catch {
  console.error(
    "无法解密：请核对密码、文件完整性，并确保目标文件不存在。不会覆盖已有文件。",
  );
  process.exitCode = 1;
}
