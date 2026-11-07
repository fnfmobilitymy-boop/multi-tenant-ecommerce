# ezshop.lifestyle 域名切换

更新：用户已在 GitHub Pages 绑定主域名，DNS 主域名检查通过。正式发布配置现已固定 `ezshop.lifestyle` 与根路径，并提供 `public/CNAME`；仓库变量不再作为本项目切换路径的开关。下文旧的变量步骤仅作为历史流程说明。

顾客首页不展示某个指定商家或店铺目录；商家分享自己的 `/shop/店铺标识` 链接。后台保持 `/merchant`、`/platform`。

## 先完成 DNS 与域名归属验证

Spaceship → Domain Manager → ezshop.lifestyle → DNS／Advanced DNS：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | fnfmobilitymy-boop.github.io |

先核对原有网站 A／AAAA／CNAME 或停放记录，避免冲突；不要删除邮件 MX／TXT。使用其他 DNS 名称服务器时，在实际 DNS 托管平台设置。

GitHub 账户 Settings → Pages → Add a domain，按 GitHub 显示的名称和值在 Spaceship 添加 TXT 归属验证记录；验证完成后保留记录。不要使用通配符 DNS。

## 登录回跳

发布流程会在网站版本和脚本样式加载检查通过后，使用现有 Supabase 管理令牌自动追加以下新域名回跳地址、保留原白名单和旧默认地址，并把默认 Site URL 更新到新商家入口；随后回读验证。只修改 `site_url`、`uri_allow_list`，不会修改密码、SMTP、登录方式或发送邮件。管理权限不足（HTTP401/403）时，该步骤明确报告认证回跳“待手动确认”，不会将其标记为已验证；网站发布结果单独保留。可按下列内容手动设置并确认。

Supabase Authentication → URL Configuration：

- 切换后 Site URL：`https://ezshop.lifestyle/merchant`。
- Redirect URLs 添加 `https://ezshop.lifestyle/merchant`、`https://ezshop.lifestyle/reset-password`、`https://ezshop.lifestyle/platform/reset-password`、`https://ezshop.lifestyle/shop/**`。
- 保留原网站根地址、`https://fnfmobilitymy-boop.github.io/multi-tenant-ecommerce/merchant`、`https://fnfmobilitymy-boop.github.io/multi-tenant-ecommerce/shop/**`，用于过渡及旧邮件。
- 当前商家注册、团队注册、重发及找回密码邮件会使用当前站点的 `/merchant` 回跳。找回密码仍由恢复处理器跳到重设密码页。
- 已登录会话、购物车和私有订单凭证属于原域名浏览器存储，不会自动迁移到新域名；顾客可登录购买记录或使用原有凭证查询订单。

## DNS 就绪后启用

1. 仓库 Settings → Secrets and variables → Actions → Variables 添加 `EZSHOP_CUSTOM_DOMAIN`，值 `ezshop.lifestyle`。
2. 仓库 Settings → Pages → Custom domain 填写 `ezshop.lifestyle`，保存并确认 DNS 检查通过。
3. 运行“一次更新网站与后端”，确认项 `DEPLOY`。构建会改用根路径 `/`，并写入 `dist/CNAME`。域名变量为空时保留旧 GitHub Pages 项目路径，不提前切换。
4. 等待 GitHub HTTPS 证书签发，启用 Enforce HTTPS。验证根首页、深链接、图标、登录、邮件回跳和实际店铺。

新地址：

- `https://ezshop.lifestyle`
- `https://ezshop.lifestyle/merchant`
- `https://ezshop.lifestyle/platform`

DNS、GitHub Pages 域名绑定必须由具备对应账号权限的人保存；Supabase 回跳优先通过已授权的发布流程配置，权限不足时由项目管理员在控制台设置。仅发布源码或创建 CNAME 文件不代表域名已成功绑定。

## 正式环境观察

GitHub只读诊断确认主域名绑定匹配、HTTPS证书状态approved、新域名HTTPS返回200、根路径资源正确。2026-11-08的发布已通过网站版本与资源检查；随后认证配置管理接口返回HTTP403，自动登录回跳未验证，须项目管理员在Supabase控制台保存。此状态不得作为实际验证邮件投递或回跳已通过的证据。

平台登录新增“忘记密码？”入口：`/platform/forgot-password`；平台邮件回跳使用`/platform/reset-password`并保留平台独立会话、图标和中英语言，完成及失效后均返回平台端。Supabase Redirect URLs 需包含`https://ezshop.lifestyle/platform/reset-password`；现有管理权限不足时由项目管理员追加该条，保留旧记录。
