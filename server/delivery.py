"""商家自填邮费；不调用快递报价或叫件服务。金额单位 sen。"""
import re
STATES={'Johor','Kedah','Kelantan','Kuala Lumpur','Labuan','Melaka','Negeri Sembilan','Pahang','Penang','Perak','Perlis','Putrajaya','Sabah','Sarawak','Selangor','Terengganu'}

def cart_items(db,mid,items):
    if not isinstance(items,list) or not 1<=len(items)<=100:raise ValueError('请选择商品')
    lines=[];seen=set();subtotal=0
    for item in items:
        if not isinstance(item,dict):raise ValueError('商品格式无效')
        pid=item.get('id');qty=item.get('quantity')
        if type(pid) is not int or not 0<pid<2**53 or type(qty) is not int or not 1<=qty<=1000:raise ValueError('商品或数量无效')
        if pid in seen:raise ValueError('商品重复')
        seen.add(pid)
        product=db.execute('SELECT * FROM products WHERE id=? AND merchant_id=?',(pid,mid)).fetchone()
        if not product or not product['published'] or product['stock']<qty:raise ValueError('商品不存在或库存不足')
        subtotal+=product['price']*qty;lines.append((product,qty))
    return lines,subtotal

def destination(data,required=False):
    state=data.get('state','');postcode=data.get('postcode','');city=data.get('city','')
    if data.get('country','MY')!='MY':raise ValueError('当前店铺仅提供马来西亚配送')
    if not all(isinstance(v,str) for v in (state,postcode,city)):raise ValueError('配送地址格式无效')
    if not required and not state and not postcode and not city:return '','',''
    if state not in STATES:raise ValueError('请选择马来西亚配送州属')
    if not isinstance(postcode,str) or not re.fullmatch(r'[0-9]{5}',postcode):raise ValueError('请输入 5 位邮编')
    if not isinstance(city,str) or not 1<=len(city.strip())<=100:raise ValueError('请填写城市')
    if data.get('country','MY')!='MY':raise ValueError('当前店铺仅提供马来西亚配送')
    return state,postcode,city.strip()
