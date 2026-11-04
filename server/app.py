"""EzShop local development prototype. Python 3.12+, no third-party dependencies."""
import os, json, sqlite3, secrets, hashlib, hmac, re, time, mimetypes
from pathlib import Path
from finance import handle as handle_finance, FinanceError
from delivery import cart_items, destination
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).parent
DB = Path(os.environ.get('EZSHOP_DB', str(ROOT / 'data/ezshop.db')))
DB.parent.mkdir(parents=True, exist_ok=True)
LOGO = Path(os.environ.get('EZSHOP_LOGO_PATH', str(ROOT / 'assets/logo.png')))
MEDIA_DIR = DB.parent / 'media'
DIST = Path(os.environ.get('EZSHOP_DIST', str(ROOT.parent / 'dist')))
MAX_IMAGE_BYTES=5*1024*1024

def valid_image_url(value):
    return bool((urlparse(value).scheme=='https' and urlparse(value).hostname) or re.fullmatch(r'/media/[0-9]+/[a-f0-9]{40}\.(png|jpg|webp)',value))

def connect():
    db = sqlite3.connect(DB, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db

def init():
    with connect() as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS merchants(id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, merchant_id INTEGER NOT NULL REFERENCES merchants(id), expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, merchant_id INTEGER NOT NULL REFERENCES merchants(id), name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>0), stock INTEGER NOT NULL CHECK(stock>=0), emoji TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agents(id INTEGER PRIMARY KEY, merchant_id INTEGER NOT NULL REFERENCES merchants(id), name TEXT NOT NULL, code TEXT UNIQUE NOT NULL, rate INTEGER NOT NULL CHECK(rate BETWEEN 0 AND 100));
        CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, merchant_id INTEGER NOT NULL REFERENCES merchants(id), reference TEXT UNIQUE NOT NULL, customer TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', agent_id INTEGER REFERENCES agents(id), commission INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id), name TEXT NOT NULL, price INTEGER NOT NULL, quantity INTEGER NOT NULL);
        ''')
        # Additive, repeatable migrations preserve existing merchant/order data.
        for table, column, definition in (
            ('merchants', 'shipping_fee', 'INTEGER NOT NULL DEFAULT 0'),
            ('merchants', 'courier', "TEXT NOT NULL DEFAULT ''"),
            ('orders', 'subtotal', 'INTEGER NOT NULL DEFAULT 0'),
            ('orders', 'state', "TEXT NOT NULL DEFAULT ''"),
            ('orders', 'postcode', "TEXT NOT NULL DEFAULT ''"),
            ('orders', 'city', "TEXT NOT NULL DEFAULT ''"),
            ('orders', 'fulfillment_status', "TEXT NOT NULL DEFAULT 'unfulfilled'"),
            ('orders', 'carrier', "TEXT NOT NULL DEFAULT ''"),
            ('orders', 'tracking', "TEXT NOT NULL DEFAULT ''"),
            ('orders', 'shipped_at', 'TEXT'),
            ('merchants', 'logo', "TEXT NOT NULL DEFAULT ''"),
            ('merchants', 'banner', "TEXT NOT NULL DEFAULT ''"),
            ('products', 'variant', "TEXT NOT NULL DEFAULT ''"),
            ('products', 'featured', 'INTEGER NOT NULL DEFAULT 0'),
            ('merchants', 'phone', "TEXT NOT NULL DEFAULT ''"),
            ('merchants', 'description', "TEXT NOT NULL DEFAULT ''"),
            ('merchants', 'is_admin', 'INTEGER NOT NULL DEFAULT 0'),
            ('merchants', 'plan', "TEXT NOT NULL DEFAULT 'free'"),
            ('merchants', 'status', "TEXT NOT NULL DEFAULT 'active'"),
            ('sessions', 'member_id', 'INTEGER'),
            ('products', 'version', 'INTEGER NOT NULL DEFAULT 0'),
            ('products', 'description', "TEXT NOT NULL DEFAULT ''"),
            ('products', 'category', "TEXT NOT NULL DEFAULT '全部商品'"),
            ('products', 'image', "TEXT NOT NULL DEFAULT ''"),
            ('products', 'published', 'INTEGER NOT NULL DEFAULT 1'),
            ('orders', 'refund_reference', "TEXT NOT NULL DEFAULT ''"),
            ('orders', 'refunded_at', 'TEXT'),
            ('orders', 'stock_returned', 'INTEGER NOT NULL DEFAULT 0'),
            ('orders', 'note', "TEXT NOT NULL DEFAULT ''"),
            ('orders', 'checkout_key', 'TEXT'),
            ('orders', 'access_token', 'TEXT'),
            ('orders', 'shipping', 'INTEGER NOT NULL DEFAULT 0'),
            ('orders', 'discount', 'INTEGER NOT NULL DEFAULT 0'),
        ):
            if column not in {row['name'] for row in db.execute(f'PRAGMA table_info({table})')}:
                db.execute(f'ALTER TABLE {table} ADD COLUMN {column} {definition}')

        db.execute('''CREATE TABLE IF NOT EXISTS memberships(id INTEGER PRIMARY KEY,merchant_id INTEGER NOT NULL REFERENCES merchants(id),name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT,role TEXT NOT NULL,agent_id INTEGER REFERENCES agents(id),invite_token TEXT UNIQUE,expires INTEGER NOT NULL)''')
        db.execute('''CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY,merchant_id INTEGER NOT NULL REFERENCES merchants(id),actor TEXT NOT NULL,action TEXT NOT NULL,object_id INTEGER,created TEXT NOT NULL DEFAULT (datetime('now')))''')
        db.execute('''CREATE TABLE IF NOT EXISTS notification_jobs(id INTEGER PRIMARY KEY,merchant_id INTEGER NOT NULL REFERENCES merchants(id),order_id INTEGER NOT NULL REFERENCES orders(id),kind TEXT NOT NULL,event_key TEXT UNIQUE NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,provider_id TEXT,error TEXT,updated INTEGER NOT NULL DEFAULT 0)''')
        db.execute('''CREATE TABLE IF NOT EXISTS payouts(id INTEGER PRIMARY KEY,merchant_id INTEGER NOT NULL REFERENCES merchants(id),agent_id INTEGER NOT NULL REFERENCES agents(id),amount INTEGER NOT NULL CHECK(amount>0),bank_details TEXT NOT NULL,request_key TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','paid','rejected')),reference TEXT NOT NULL DEFAULT '',created TEXT NOT NULL DEFAULT (datetime('now')),updated TEXT NOT NULL DEFAULT (datetime('now')),UNIQUE(merchant_id,agent_id,request_key))''')
        db.execute('UPDATE orders SET subtotal=total-shipping+discount WHERE subtotal=0 AND total>0')
        db.execute('CREATE UNIQUE INDEX IF NOT EXISTS order_checkout_key ON orders(merchant_id,checkout_key)')

def public_order(row):
    order = dict(row)
    order.pop('access_token', None)
    order.pop('checkout_key', None)
    return order

def product_extras(data):
    result = []
    for key, default, maximum in [('description', '', 2000), ('category', '全部商品', 80), ('image', '', 2000), ('variant', '', 100)]:
        value = data.get(key, default)
        if not isinstance(value, str) or len(value) > maximum:
            raise ValueError('商品资料格式无效')
        if key == 'image' and value and not valid_image_url(value):
            raise ValueError('图片必须使用 HTTPS 网址')
        result.append(value.strip())
    published = data.get('published', 1)
    if type(published) is not int or published not in (0, 1):
        raise ValueError('发布状态无效')
    featured = data.get('featured', 0)
    if type(featured) is not int or featured not in (0, 1):
        raise ValueError('热门商品状态无效')
    return (*result, published, featured)

def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1).hex()
    return salt + ':' + digest

def text_field(data, name, maximum=200):
    value = data.get(name, '')
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError('请填写有效的 ' + name)
    return value.strip()

def integer(data, name, lower, upper):
    value = data.get(name)
    if type(value) is not int or not lower <= value <= upper:
        raise ValueError(name + ' 超出允许范围')
    return value

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Never log query strings, session cookies, or request bodies.
        pass

    def reply(self, data, status=200, cookie=None):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        try:
            path = urlparse(self.path).path
            if path.startswith('/media/') and self.command=='GET':
                if not re.fullmatch(r'/media/[0-9]+/[a-f0-9]{40}\.(png|jpg|webp)',path):
                    return self.reply({'error':'Image not found'},404)
                image=MEDIA_DIR / path.removeprefix('/media/')
                if not image.is_file():
                    return self.reply({'error':'Image not found'},404)
                body=image.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type',mimetypes.guess_type(str(image))[0] or 'application/octet-stream')
                self.send_header('Content-Length',str(len(body)))
                self.send_header('X-Content-Type-Options','nosniff')
                self.send_header('Cache-Control','public,max-age=31536000,immutable')
                self.end_headers();self.wfile.write(body);return
            if path == '/brand/logo.png' and self.command == 'GET':
                if not LOGO.is_file():
                    return self.reply({'error': 'Brand logo not configured'}, 404)
                body = LOGO.read_bytes()
                if not body.startswith(b'\x89PNG\r\n\x1a\n'):
                    return self.reply({'error': 'Brand logo must be a PNG'}, 415)
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.wfile.write(body)
                return
            if not path.startswith('/api/'):

                if self.command != 'GET':
                    return self.reply({'error': 'Method not allowed'}, 405)
                if path == '/legacy':
                    file = ROOT / 'legacy.html'
                else:
                    dist = DIST
                    candidate = (dist / path.lstrip('/')).resolve()
                    if not candidate.is_relative_to(dist.resolve()):
                        return self.reply({'error': 'Not found'}, 404)
                    file = candidate if candidate.is_file() else dist / 'index.html'
                if not file.is_file():
                    return self.reply({'error': '请先执行 npm run build，或使用 Vite 开发服务'}, 503)
                body = file.read_bytes()
                self.send_response(200)
                content_type = mimetypes.guess_type(str(file))[0] or 'application/octet-stream'
                self.send_header('Content-Type', content_type + ('; charset=utf-8' if content_type.startswith('text/') else ''))
                self.send_header('Content-Length', str(len(body)))
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Referrer-Policy', 'same-origin')
                self.end_headers()
                self.wfile.write(body)
                return
            data = {}
            if self.command == 'POST':
                if self.headers.get('Sec-Fetch-Site') == 'cross-site':
                    return self.reply({'error': 'Cross-site request denied'}, 403)
                if path=='/api/media':
                    length=int(self.headers.get('Content-Length','0'))
                    if not 0<length<=MAX_IMAGE_BYTES:
                        return self.reply({'error':'图片不能为空或超过 5 MB'},413)
                    data={'_bytes':self.rfile.read(length),'_mime':self.headers.get('Content-Type','').split(';')[0]}
                    with connect() as db:
                        self.route(db,path,data)
                    return
                if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                    return self.reply({'error': 'JSON required'}, 415)
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 65536:
                    return self.reply({'error': 'Invalid request size'}, 413)
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError('Invalid JSON object')
            with connect() as db:
                self.route(db, path, data)
        except FinanceError as exc:
            self.reply({'error':str(exc)},exc.status)
        except (ValueError, json.JSONDecodeError) as exc:
            self.reply({'error': str(exc)}, 400)
        except sqlite3.IntegrityError:
            self.reply({'error': '邮箱、店铺网址或代理代码已被使用，或数据无效'}, 409)
        except Exception:
            self.reply({'error': '服务器暂时无法完成请求'}, 500)

    def route(self, db, path, data):
        method = self.command
        if path == '/api/brand' and method == 'GET':
            return self.reply({'logo': LOGO.is_file()})
        if path == '/api/health' and method == 'GET':
            db.execute('SELECT 1')
            return self.reply({'ok': True})
        if path == '/api/join' and method == 'POST':
            token = text_field(data, 'token', 100)
            password = text_field(data, 'password', 256)
            email = text_field(data, 'email', 200).lower()
            if len(password) < 10:
                raise ValueError('密码至少需要 10 个字符')
            db.execute('BEGIN IMMEDIATE')
            member = db.execute('SELECT * FROM memberships WHERE invite_token=? AND expires>? AND password IS NULL AND email=?', (token, int(time.time()), email)).fetchone()
            if not member:
                return self.reply({'error': '邀请已过期、已使用或邮箱不匹配'}, 400)
            db.execute('UPDATE memberships SET password=?,invite_token=NULL WHERE id=?', (password_hash(password), member['id']))
            db.commit()
            return self.reply({'ok': True})
        if path in ('/api/register', '/api/login') and method == 'POST':
            email = text_field(data, 'email').lower()
            if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
                raise ValueError('邮箱格式无效')
            password = text_field(data, 'password', 256)
            member_id = None
            if path == '/api/register':
                if db.execute('SELECT 1 FROM memberships WHERE email=?', (email,)).fetchone():
                    raise ValueError('此邮箱已有团队邀请或账号，请使用邀请链接或登录')
                if len(password) < 10:
                    raise ValueError('密码至少需要 10 个字符')
                name = text_field(data, 'name', 80)
                slug = text_field(data, 'slug', 60).lower()
                if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
                    raise ValueError('店铺网址只能使用小写英文字母、数字和连字符')
                mid = db.execute('INSERT INTO merchants(name,slug,email,password) VALUES(?,?,?,?)', (name, slug, email, password_hash(password))).lastrowid
            else:
                merchant = db.execute('SELECT * FROM merchants WHERE email=?', (email,)).fetchone()
                member = db.execute('SELECT * FROM memberships WHERE email=? AND password IS NOT NULL', (email,)).fetchone() if not merchant else None
                account = merchant or member
                if not account or not hmac.compare_digest(account['password'], password_hash(password, account['password'].split(':')[0])):
                    return self.reply({'error': '邮箱或密码不正确'}, 401)
                mid = merchant['id'] if merchant else member['merchant_id']
                member_id = member['id'] if member else None
            token = secrets.token_urlsafe(32)
            db.execute('INSERT INTO sessions(token,merchant_id,expires,member_id) VALUES(?,?,?,?)', (token, mid, int(time.time()) + 86400, member_id))
            db.commit()
            return self.reply({'ok': True}, cookie='ezshop_session=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400')
        if path == '/api/store' and method == 'GET':
            slug = parse_qs(urlparse(self.path).query).get('slug', [''])[0]
            merchant = db.execute("SELECT id,name,slug,phone,description,logo,banner,shipping_fee,courier FROM merchants WHERE slug=? AND status='active'", (slug,)).fetchone()
            if not merchant:
                return self.reply({'error': '找不到这家店铺'}, 404)
            products = [dict(p) for p in db.execute('SELECT id,name,price,stock,emoji,description,category,image,featured,variant FROM products WHERE merchant_id=? AND published=1 ORDER BY id DESC', (merchant['id'],))]
            return self.reply({'store': {**{k: merchant[k] for k in ('name', 'slug', 'phone', 'description','shipping_fee','courier')}, **{k:merchant[k] for k in ('logo','banner') if merchant[k]}}, 'products': products})
        if path == '/api/order-result' and method == 'POST':
            reference = text_field(data, 'reference', 50)
            token = text_field(data, 'token', 100)
            order = db.execute('SELECT * FROM orders WHERE reference=? AND access_token=?', (reference, token)).fetchone()
            if not order:
                return self.reply({'error': '订单不存在或访问凭证无效'}, 404)
            store = db.execute('SELECT id,name,slug,phone,description FROM merchants WHERE id=?', (order['merchant_id'],)).fetchone()
            if data.get('slug') != store['slug']:
                return self.reply({'error': '订单不存在或访问凭证无效'}, 404)
            items = [dict(i) for i in db.execute('SELECT name,price,quantity FROM order_items WHERE order_id=?', (order['id'],))]
            safe = {key: order[key] for key in ('reference','total','status','created','subtotal','shipping','discount','fulfillment_status','carrier','tracking','shipped_at')}
            return self.reply({'order': safe, 'items': items, 'store': dict(store)})
        if path == '/api/shipping-quote' and method == 'POST':
            slug=text_field(data,'slug',60)
            store=db.execute("SELECT id,shipping_fee FROM merchants WHERE slug=? AND status='active'",(slug,)).fetchone()
            if not store:return self.reply({'error':'找不到店铺'},404)
            _,subtotal=cart_items(db,store['id'],data.get('items'))
            return self.reply({'subtotal':subtotal,'shipping':store['shipping_fee'],'discount':0,'total':subtotal+store['shipping_fee']})
        if path == '/api/checkout' and method == 'POST':
            return self.checkout(db, data)
        cookie = self.headers.get('Cookie', '')
        token = next((p.strip().split('=', 1)[1] for p in cookie.split(';') if p.strip().startswith('ezshop_session=')), '')
        merchant = db.execute('SELECT m.id,m.name,m.slug,m.email,m.phone,m.description,m.logo,m.banner,m.shipping_fee,m.courier,m.is_admin,m.plan,m.status,s.member_id FROM merchants m JOIN sessions s ON s.merchant_id=m.id WHERE s.token=? AND s.expires>?', (token, int(time.time()))).fetchone()
        if not merchant:
            return self.reply({'error': '请先登录'}, 401)
        mid = merchant['id']
        member = db.execute('SELECT id,name,role,agent_id FROM memberships WHERE id=? AND merchant_id=? AND password IS NOT NULL', (merchant['member_id'], mid)).fetchone() if merchant['member_id'] else None
        if merchant['member_id'] and not member:
            return self.reply({'error': '团队权限已撤销'}, 401)
        role = member['role'] if member else 'owner'
        safe_merchant = dict(merchant)
        safe_merchant.update(role=role, is_admin=merchant['is_admin'] if role=='owner' else 0)
        safe_merchant.pop('member_id', None)
        if member:
            safe_merchant['member_name'] = member['name']
        if path == '/api/logout' and method == 'POST':
            db.execute('DELETE FROM sessions WHERE token=?', (token,))
            db.commit()
            return self.reply({'ok': True}, cookie='ezshop_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
        if merchant['status'] != 'active' and not (role=='owner' and merchant['is_admin']):
            return self.reply({'error': '店铺已暂停，请联系平台管理员'}, 403)
        finance = handle_finance(db,mid,role,member,path,data,method)
        if finance is not None:
            return self.reply(*finance)
        if path=='/api/media' and method=='POST':
            if role not in ('owner','manager','inventory'):
                return self.reply({'error':'当前角色不能上传店铺或商品图片'},403)
            body=data['_bytes'];mime=data['_mime']
            extension=None
            if mime=='image/png' and len(body)>=33 and body.startswith(b'\x89PNG\r\n\x1a\n'):
                import struct
                width,height=struct.unpack('>II',body[16:24])
                if width*height>40000000 or width==0 or height==0:
                    raise ValueError('图片尺寸无效或过大')
                extension='png'
            elif mime=='image/jpeg' and body.startswith(b'\xff\xd8\xff') and body.endswith(b'\xff\xd9'):
                extension='jpg'
            elif mime=='image/webp' and len(body)>=20 and body.startswith(b'RIFF') and body[8:12]==b'WEBP':
                extension='webp'
            if not extension:
                return self.reply({'error':'请选择有效的 JPG、PNG 或 WebP 图片'},415)
            folder=MEDIA_DIR/str(mid);folder.mkdir(parents=True,exist_ok=True)
            name=secrets.token_hex(20)+'.'+extension
            with (folder/name).open('xb') as file:file.write(body)
            return self.reply({'url':'/media/'+str(mid)+'/'+name},201)
        if path == '/api/dashboard' and method == 'GET':
            if role == 'agent':
                agent = db.execute('SELECT id,name,code,rate FROM agents WHERE id=? AND merchant_id=?', (member['agent_id'],mid)).fetchone()
                orders = [dict(o) for o in db.execute('SELECT id,reference,total,status,commission,created FROM orders WHERE merchant_id=? AND agent_id=? ORDER BY id DESC', (mid,member['agent_id']))]
                return self.reply({'merchant':safe_merchant,'products':[],'orders':orders,'agents':[dict(agent)] if agent else []})
            products = [dict(p) for p in db.execute('SELECT * FROM products WHERE merchant_id=? ORDER BY id DESC', (mid,))] if role in ('owner','manager','inventory') else []
            orders = [public_order(o) for o in db.execute('SELECT o.*, a.name agent_name FROM orders o LEFT JOIN agents a ON a.id=o.agent_id WHERE o.merchant_id=? ORDER BY o.id DESC', (mid,))] if role in ('owner','manager','orders') else []
            agents = [dict(a) for a in db.execute("SELECT a.*,COALESCE(SUM(CASE WHEN o.status='paid' THEN o.commission ELSE 0 END),0) earned,COUNT(o.id) orders_count FROM agents a LEFT JOIN orders o ON o.agent_id=a.id WHERE a.merchant_id=? GROUP BY a.id", (mid,))] if role=='owner' else []
            for a in agents:
                a.pop('invite_token', None)
            return self.reply({'merchant': safe_merchant, 'products': products, 'orders': orders, 'agents': agents})
        allowed = role=='owner' or (role in ('manager','inventory') and path.startswith('/api/products')) or (role in ('manager','orders') and path.startswith('/api/orders/'))
        if not allowed:
            return self.reply({'error': '当前角色没有此操作权限'}, 403)
        if path == '/api/notifications' and method == 'GET':
            jobs=[dict(j) for j in db.execute('SELECT n.id,n.kind,n.status,n.attempts,n.provider_id,n.error,o.reference,o.email recipient FROM notification_jobs n JOIN orders o ON o.id=n.order_id WHERE n.merchant_id=? ORDER BY n.id DESC LIMIT 100',(mid,))]
            return self.reply({'jobs':jobs})
        if path == '/api/team' and method == 'GET':
            members=[dict(m) for m in db.execute('SELECT id,name,email,role,agent_id,expires,password IS NOT NULL AS active FROM memberships WHERE merchant_id=? ORDER BY id DESC',(mid,))]
            logs=[dict(l) for l in db.execute('SELECT actor,action,object_id,created FROM audit_log WHERE merchant_id=? ORDER BY id DESC LIMIT 50',(mid,))]
            return self.reply({'members':members,'logs':logs})
        if path == '/api/team/invite' and method == 'POST':
            name=text_field(data,'name',80)
            email=text_field(data,'email',200).lower()
            invitation_role=text_field(data,'role',20)
            if invitation_role not in ('agent','orders','inventory','manager') or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email):
                raise ValueError('角色或邮箱无效')
            if db.execute('SELECT 1 FROM merchants WHERE email=?',(email,)).fetchone():
                raise ValueError('此邮箱已有商家账号，请为团队使用独立邮箱')
            agent_id=None
            if invitation_role=='agent':
                rate=integer(data,'rate',0,100)
                agent_id=db.execute('INSERT INTO agents(merchant_id,name,code,rate) VALUES(?,?,?,?)',(mid,name,secrets.token_urlsafe(12),rate)).lastrowid
            invite=secrets.token_urlsafe(32)
            db.execute('INSERT INTO memberships(merchant_id,name,email,role,agent_id,invite_token,expires) VALUES(?,?,?,?,?,?,?)',(mid,name,email,invitation_role,agent_id,invite,int(time.time())+7*86400))
            db.execute('INSERT INTO audit_log(merchant_id,actor,action) VALUES(?,?,?)',(mid,'owner','team.invite'))
            db.commit()
            return self.reply({'invite_token':invite},201)
        if path == '/api/team/revoke' and method == 'POST':
            member_id=integer(data,'id',1,2**53)
            if not db.execute('SELECT 1 FROM memberships WHERE id=? AND merchant_id=?',(member_id,mid)).fetchone():
                return self.reply({'error':'找不到团队成员'},404)
            db.execute('DELETE FROM sessions WHERE member_id=?',(member_id,))
            db.execute('DELETE FROM memberships WHERE id=? AND merchant_id=?',(member_id,mid))
            db.execute('INSERT INTO audit_log(merchant_id,actor,action,object_id) VALUES(?,?,?,?)',(mid,'owner','team.revoke',member_id))
            db.commit()
            return self.reply({'ok':True})
        if path.startswith('/api/platform'):
            if not merchant['is_admin']:
                return self.reply({'error':'需要平台管理员权限'},403)
            if path=='/api/platform' and method=='GET':
                merchants=[dict(m) for m in db.execute("SELECT m.id,m.name,m.email,m.slug,m.plan,m.status,COUNT(o.id) orders_count,COALESCE(SUM(CASE WHEN o.status='paid' THEN o.total ELSE 0 END),0) sales FROM merchants m LEFT JOIN orders o ON o.merchant_id=m.id GROUP BY m.id")]
                return self.reply({'merchants':merchants})
            if path=='/api/platform/update' and method=='POST':
                target=integer(data,'id',1,2**53)
                plan=text_field(data,'plan',20)
                status=text_field(data,'status',20)
                if plan not in ('free','pro') or status not in ('active','suspended'):
                    raise ValueError('方案或状态无效')
                if target==mid and status=='suspended':
                    raise ValueError('不能暂停自己的管理账号')
                cursor=db.execute('UPDATE merchants SET plan=?,status=? WHERE id=?',(plan,status,target))
                if not cursor.rowcount:
                    return self.reply({'error':'找不到商家'},404)
                db.execute('INSERT INTO audit_log(merchant_id,actor,action,object_id) VALUES(?,?,?,?)',(mid,'platform','merchant.update',target))
                db.commit()
                return self.reply({'ok':True})
        if path == '/api/products' and method == 'POST':
            name = text_field(data, 'name', 120)
            price = integer(data, 'price', 1, 100000000)
            stock = integer(data, 'stock', 0, 1000000)
            emoji = text_field(data, 'emoji', 12)
            db.execute('INSERT INTO products(merchant_id,name,price,stock,emoji,description,category,image,variant,published,featured) VALUES(?,?,?,?,?,?,?,?,?,?,?)', (mid, name, price, stock, emoji, *product_extras(data)))
            db.commit()
            return self.reply({'ok': True}, 201)
        if path == '/api/products/update' and method == 'POST':
            pid = integer(data, 'id', 1, 2**53)
            version = integer(data, 'version', 0, 2**53)
            name = text_field(data, 'name', 120)
            price = integer(data, 'price', 1, 100000000)
            stock = integer(data, 'stock', 0, 1000000)
            emoji = text_field(data, 'emoji', 12)
            db.execute('BEGIN IMMEDIATE')
            product = db.execute('SELECT version,variant FROM products WHERE id=? AND merchant_id=?', (pid, mid)).fetchone()
            if not product:
                return self.reply({'error': '找不到商品'}, 404)
            if product['version'] != version:
                return self.reply({'error': '商品或库存已更新，请关闭窗口并刷新页面后重新编辑'}, 409)
            if 'variant' not in data:data={**data,'variant':product['variant']}
            db.execute('UPDATE products SET name=?,price=?,stock=?,emoji=?,description=?,category=?,image=?,variant=?,published=?,featured=?,version=version+1 WHERE id=? AND merchant_id=? AND version=?', (name, price, stock, emoji, *product_extras(data), pid, mid, version))
            db.commit()
            return self.reply({'ok': True})
        if path == '/api/settings' and method == 'POST':
            name = text_field(data, 'name', 80)
            phone = data.get('phone', '')
            description = data.get('description', '')
            if not isinstance(description, str) or len(description) > 500:
                raise ValueError('店铺简介不能超过 500 字')
            if not isinstance(phone, str) or (phone and not re.fullmatch(r'\+?[0-9]{8,15}', phone)):
                raise ValueError('联系电话须包含国家区号，例如 +60123456789')
            assets=[]
            for key in ('logo','banner'):
                value=data.get(key,merchant[key])
                if not isinstance(value,str) or len(value)>2000 or (value and not valid_image_url(value)):
                    raise ValueError('店铺图片必须使用 HTTPS 网址')
                assets.append(value)
            shipping_fee=data.get('shipping_fee',merchant['shipping_fee'])
            courier=data.get('courier',merchant['courier'])
            if type(shipping_fee) is not int or not 0<=shipping_fee<=1000000:raise ValueError('邮费须为 0 到 RM 10,000 之间的金额')
            if not isinstance(courier,str) or len(courier)>100:raise ValueError('快递公司名称不能超过 100 字')
            db.execute('UPDATE merchants SET name=?,phone=?,description=?,logo=?,banner=?,shipping_fee=?,courier=? WHERE id=?', (name, phone, description.strip(), *assets, shipping_fee,courier.strip(),mid))
            db.commit()
            return self.reply({'ok': True})
        if path == '/api/agents' and method == 'POST':
            name = text_field(data, 'name', 80)
            rate = integer(data, 'rate', 0, 100)
            code = secrets.token_urlsafe(9)
            db.execute('INSERT INTO agents(merchant_id,name,code,rate) VALUES(?,?,?,?)', (mid, name, code, rate))
            db.commit()
            return self.reply({'ok': True}, 201)
        if path == '/api/orders/ship' and method == 'POST':
            oid=integer(data,'id',1,2**53)
            carrier=text_field(data,'carrier',100);tracking=text_field(data,'tracking',100)
            db.execute('BEGIN IMMEDIATE')
            order=db.execute('SELECT * FROM orders WHERE id=? AND merchant_id=?',(oid,mid)).fetchone()
            if not order:return self.reply({'error':'找不到订单'},404)
            if order['status']!='paid':return self.reply({'error':'仅已付款订单可以登记发货'},409)
            if order['fulfillment_status']=='shipped':
                if order['carrier']==carrier and order['tracking']==tracking:return self.reply({'ok':True})
                return self.reply({'error':'此订单已登记发货，请核实原运单记录'},409)
            db.execute("UPDATE orders SET fulfillment_status='shipped',carrier=?,tracking=?,shipped_at=datetime('now') WHERE id=?",(carrier,tracking,oid))
            db.execute('INSERT INTO audit_log(merchant_id,actor,action,object_id) VALUES(?,?,?,?)',(mid,str(member['id']) if member else 'owner','order.ship',oid))
            db.commit();return self.reply({'ok':True})
        if path == '/api/orders/detail' and method == 'GET':
            query = parse_qs(urlparse(self.path).query)
            oid = int(query.get('id', ['0'])[0])
            order = db.execute('SELECT o.*, a.name agent_name FROM orders o LEFT JOIN agents a ON a.id=o.agent_id WHERE o.id=? AND o.merchant_id=?', (oid, mid)).fetchone()
            if not order:
                return self.reply({'error': '找不到订单'}, 404)
            items = [dict(i) for i in db.execute('SELECT name,price,quantity FROM order_items WHERE order_id=? ORDER BY id', (oid,))]
            return self.reply({'order': public_order(order), 'items': items})
        if path in ('/api/orders/paid', '/api/orders/cancel') and method == 'POST':
            oid = integer(data, 'id', 1, 2**53)
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT status FROM orders WHERE id=? AND merchant_id=?', (oid, mid)).fetchone()
            if not row:
                return self.reply({'error': '找不到订单'}, 404)
            target = 'paid' if path.endswith('/paid') else 'cancelled'
            if row['status'] == target:
                return self.reply({'ok': True})
            if row['status'] != 'pending':
                return self.reply({'error': '只能操作待付款订单；已付款订单需要另行处理退款'}, 409)
            if target == 'cancelled':
                for item in db.execute('SELECT product_id,quantity FROM order_items WHERE order_id=?', (oid,)).fetchall():
                    db.execute('UPDATE products SET stock=stock+?,version=version+1 WHERE id=? AND merchant_id=?', (item['quantity'], item['product_id'], mid))
            db.execute('UPDATE orders SET status=? WHERE id=? AND merchant_id=?', (target, oid, mid))
            if target=='paid':
                db.execute("INSERT OR IGNORE INTO notification_jobs(merchant_id,order_id,kind,event_key) VALUES(?,?,'receipt',?)",(mid,oid,'receipt:'+str(oid)))
            db.execute('INSERT INTO audit_log(merchant_id,actor,action,object_id) VALUES(?,?,?,?)',(mid,str(member['id']) if member else 'owner','order.'+target,oid))
            db.commit()
            return self.reply({'ok': True})
        return self.reply({'error': 'Not found'}, 404)

    def checkout(self, db, data):
        # Write lock prevents concurrent checkouts from overselling inventory.
        db.execute('BEGIN IMMEDIATE')
        slug = text_field(data, 'slug', 60)
        store = db.execute("SELECT * FROM merchants WHERE slug=? AND status='active'", (slug,)).fetchone()
        if not store:
            raise ValueError('店铺不存在')
        mid = store['id']
        checkout_key = data.get('checkout_key')
        if checkout_key is not None:
            if not isinstance(checkout_key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{20,100}', checkout_key):
                raise ValueError('结账请求标识无效')
            previous = db.execute('SELECT reference,total,status,access_token FROM orders WHERE merchant_id=? AND checkout_key=?', (mid, checkout_key)).fetchone()
            if previous:
                return self.reply(dict(previous))
        if data.get('payment_method', 'manual') != 'manual':
            raise ValueError('该付款方式尚未开通')
        note = data.get('note', '')
        if not isinstance(note, str) or len(note) > 1000:
            raise ValueError('订单备注不能超过 1000 字')
        customer = text_field(data, 'customer', 100)
        email = text_field(data, 'email', 200)
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
            raise ValueError('邮箱格式无效')
        phone = text_field(data, 'phone', 40)
        address = text_field(data, 'address', 500)
        lines,subtotal=cart_items(db,mid,data.get('items'))
        shipping=store['shipping_fee']
        state,postcode,city=destination(data,required=shipping>0)
        total=subtotal+shipping
        code = data.get('agent', '')
        if not isinstance(code, str) or len(code) > 100:
            raise ValueError('代理代码无效')
        agent = db.execute('SELECT id,rate FROM agents WHERE code=? AND merchant_id=?', (code, mid)).fetchone() if code else None
        if code and not agent:
            raise ValueError('代理链接无效')
        commission = (subtotal * agent['rate'] + 50) // 100 if agent else 0
        reference = 'EZ-' + secrets.token_hex(5).upper()
        oid = db.execute('INSERT INTO orders(merchant_id,reference,customer,email,phone,address,total,agent_id,commission) VALUES(?,?,?,?,?,?,?,?,?)', (mid, reference, customer, email, phone, address, total, agent['id'] if agent else None, commission)).lastrowid
        token = secrets.token_urlsafe(32)
        db.execute('UPDATE orders SET note=?,checkout_key=?,access_token=?,subtotal=?,shipping=?,state=?,postcode=?,city=? WHERE id=?', (note, checkout_key, token,subtotal,shipping,state,postcode,city,oid))
        for p, qty in lines:
            db.execute('INSERT INTO order_items(order_id,product_id,name,price,quantity) VALUES(?,?,?,?,?)', (oid, p['id'], p['name']+(' · '+p['variant'] if p['variant'] else ''), p['price'], qty))
            db.execute('UPDATE products SET stock=stock-?,version=version+1 WHERE id=? AND merchant_id=?', (qty, p['id'], mid))
        db.commit()
        return self.reply({'reference': reference, 'total': total, 'status': 'pending', 'access_token': token, 'message': '订单已提交。请联系商家确认付款方式；本原型尚未接入线上支付。'}, 201)

if __name__ == '__main__':
    init()
    port = int(os.environ.get('PORT', '3000'))
    print(f'EzShop development server on port {port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
