"""备份可恢复性验证，不访问真实业务数据。"""
import sqlite3,tempfile,unittest
from pathlib import Path
from backup import snapshot,verify
class BackupTests(unittest.TestCase):
    def test_wal_snapshot_restore_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            original=Path(directory)/'source.db';backup=Path(directory)/'backup.db';restored=Path(directory)/'restored.db'
            db=sqlite3.connect(original);db.execute('pragma journal_mode=wal')
            for table in ('merchants','orders','products','order_items'):db.execute('create table '+table+'(id integer primary key,name text)')
            db.execute("insert into orders values(1,'original order')");db.commit()
            snapshot(original,backup)
            db.execute("update orders set name='later change'");db.commit()
            snapshot(backup,restored);verify(restored)
            with sqlite3.connect(restored) as recovered:self.assertEqual(recovered.execute('select name from orders').fetchone()[0],'original order')
            with self.assertRaises(FileExistsError):snapshot(original,backup)
            with self.assertRaises(ValueError):snapshot(original,original)
            db.close()
    def test_invalid_source_never_creates_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'invalid.db';dest=Path(directory)/'copy.db'
            with sqlite3.connect(source) as db:db.execute('create table unrelated(id integer)')
            with self.assertRaises(ValueError):snapshot(source,dest)
            self.assertFalse(dest.exists())
if __name__=='__main__':unittest.main()
