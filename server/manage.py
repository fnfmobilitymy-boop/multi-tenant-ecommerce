"""本地开发数据库管理。此命令不是公开 API，不会创建默认管理员。"""
import argparse
from app import init,connect
p=argparse.ArgumentParser();p.add_argument('command',choices=['grant-admin','revoke-admin']);p.add_argument('email');args=p.parse_args()
init()
with connect() as db:
    cursor=db.execute('UPDATE merchants SET is_admin=? WHERE email=?',(1 if args.command=='grant-admin' else 0,args.email.lower()))
    if cursor.rowcount!=1:raise SystemExit('找不到指定商家邮箱；请先通过界面注册。')
print('本地管理员权限已更新。Supabase 模式须由项目管理员在数据库侧授权。')
