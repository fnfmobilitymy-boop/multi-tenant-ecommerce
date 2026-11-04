"""仅本地 SQLite：在线一致性备份、验证、恢复到新文件；不操作 Supabase。"""
import argparse,os,sqlite3
from contextlib import closing
from pathlib import Path

def verify(path):
    source=Path(path).resolve(strict=True)
    with closing(sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)) as db:
        if db.execute('pragma quick_check').fetchall()!=[('ok',)]:raise ValueError('数据库完整性检查失败')
        names={row[0] for row in db.execute("select name from sqlite_master where type='table'")}
        if not {'merchants','orders','products','order_items'}<=names:raise ValueError('不是 EZShop 本地数据库')
        if db.execute('pragma foreign_key_check').fetchone():raise ValueError('数据库关联检查失败')
    return source

def snapshot(source,destination):
    source=verify(source);destination=Path(destination).absolute()
    if destination==source:raise ValueError('目标必须是新文件')
    # O_EXCL prevents overwriting an existing business database or following a symlink.
    fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.close(fd)
    try:
        with closing(sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)) as src,closing(sqlite3.connect(destination)) as dst:
            src.backup(dst)
        verify(destination)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    return destination

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['backup','verify','restore'])
    parser.add_argument('source');parser.add_argument('--to',dest='destination');args=parser.parse_args()
    try:
        if args.command=='verify':verify(args.source);print('数据库完整性与关联检查通过。')
        else:
            if not args.destination:parser.error('备份或恢复必须指定 --to 新文件路径')
            snapshot(args.source,args.destination)
            print('已创建并验证新数据库文件。原数据库保持不变；图片目录需另行备份。')
    except (OSError,sqlite3.Error,ValueError) as error:parser.exit(1,'操作失败：'+str(error)+'\n')
if __name__=='__main__':main()
