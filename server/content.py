"""公开商品内容的多语言版本；不翻译顾客姓名、电话或地址。"""
import json
LANGUAGES=('zh','en','ms','th','km','vi')
LIMITS={'product':{'name':120,'description':2000,'category':80,'variant':100},'store':{'name':80,'description':500}}
def translations(value,kind):
    if not isinstance(value,dict) or len(value)>6:raise ValueError('多语言内容格式无效')
    for language,fields in value.items():
        if language not in LANGUAGES or not isinstance(fields,dict):raise ValueError('多语言内容格式无效')
        for key,text in fields.items():
            if key not in LIMITS[kind] or not isinstance(text,str) or len(text)>LIMITS[kind][key]:raise ValueError('多语言内容格式无效')
    return value
def public_content(value):
    if isinstance(value,list):return [public_content(v) for v in value]
    if isinstance(value,dict):return {k:json.loads(v) if k=='content_translations' and isinstance(v,str) else public_content(v) for k,v in value.items() if not (k=='content_translations' and v in ('{}',{}) and 'quantity' in value)}
    return value
def snapshot(product):
    versions=json.loads(product['content_translations'])
    if not versions:return {}
    return {language:{field:versions.get(language,{}).get(field,'').strip() or product[field] for field in ('name','variant')} for language in LANGUAGES}
