# HTTPS 证书运维记录

最后完整验证：2026-08-14（Asia/Shanghai）

当前 HTTPS 证书、自动续签和自动部署链路均已实现并验证。除非出现续签失败、证书告警、DNS 变更或 OSS 自定义域名配置变更，否则直接以本文档为准，不需要重新摸排架构。

## 当前架构

| 域名 | TLS 终止位置 | Certbot 证书名 | 自动验证与部署 |
| --- | --- | --- | --- |
| `hothaircc.cn` | ECS Nginx | `hothaircc.cn` | Nginx 插件自动验证、安装 |
| `www.hothaircc.cn` | ECS Nginx | `hothaircc.cn` | 与主域名共用 SAN 证书 |
| `api.hothaircc.cn` | ECS Nginx | `hothaircc.cn` | 与主域名共用 SAN 证书 |
| `oss.hothaircc.cn` | 阿里云 OSS | `oss.hothaircc.cn` | OSS HTTP-01 验证钩子、OSS API 自动部署 |
| `media.hothaircc.cn` | 阿里云 OSS | `media.hothaircc.cn` | OSS HTTP-01 验证钩子、OSS API 自动部署 |

- 主域名、`www` 和 `api` 直接解析到 ECS `182.92.129.180`。
- `oss.hothaircc.cn` CNAME 到 `hothairapp.oss-cn-beijing.aliyuncs.com`，请求不经过 ECS 或 ESA。
- `media.hothaircc.cn` CNAME 到 `hothairmedia.oss-cn-beijing.aliyuncs.com`，只承载公开上传图片。
- ESA 不在当前 HTTPS 或请求链路中；停用或不续费 ESA 不影响上述证书。
- 应用生成的公开图片地址使用 `https://media.hothaircc.cn`；`https://oss.hothaircc.cn` 保留给商家端静态网站。

## 自动续签

服务器使用 `certbot-renew.timer` 定期执行 `certbot renew`，该 timer 已启用并处于运行状态。

主证书配置：

- 证书：`/etc/letsencrypt/live/hothaircc.cn/`
- 续签配置：`/etc/letsencrypt/renewal/hothaircc.cn.conf`
- 覆盖域名：`hothaircc.cn`、`www.hothaircc.cn`、`api.hothaircc.cn`
- 验证器和安装器：Certbot Nginx 插件

OSS 证书配置：

- 证书：`/etc/letsencrypt/live/oss.hothaircc.cn/`
- 续签配置：`/etc/letsencrypt/renewal/oss.hothaircc.cn.conf`
- 验证器：Certbot manual HTTP-01
- `manual_auth_hook`：`/opt/hot-hair-service/ops/certbot-oss-hook auth`
- `manual_cleanup_hook`：`/opt/hot-hair-service/ops/certbot-oss-hook cleanup`
- `renew_hook`：`/opt/hot-hair-service/ops/certbot-oss-hook deploy`

媒体 OSS 证书使用相同钩子，证书名为 `media.hothaircc.cn`。钩子根据证书域名选择 `hothairapp` 或 `hothairmedia` Bucket。

OSS 续签流程：

1. 验证钩子按域名把挑战内容写入对应 Bucket 的 `.well-known/acme-challenge/<token>`。
2. Let's Encrypt 从对应的 OSS 自定义域名完成 HTTP-01 验证。
3. 清理钩子删除临时对象。
4. 签发成功后，部署钩子调用 `ossutil api put-cname`，将证书和私钥部署到 OSS 自定义域名。

唯一有效的 OSS 钩子实现是 [`ops/certbot-oss-hook`](../ops/certbot-oss-hook)。它复用服务器现有的：

- `/usr/local/bin/ossutil-v2`
- `/root/.ossutilconfig`

凭据只保存在服务器上，不得写入 Git。现有 RAM 凭据不需要 AliDNS 权限。

## 已验证结果

2026-08-14 的完整验证结果：

- 两张证书的 `certbot renew --dry-run` 均成功。
- OSS 正式证书已完成一次真实签发和自动部署。
- OSS 线上证书与服务器证书序列号一致。
- OSS ACME 临时对象清理后数量为 0。
- 所有四个域名的 TLS 校验结果正常。
- 主域名、`www` 和 `api` 的 HTTP 请求会 `301` 到 HTTPS。
- API `/health` 返回正常。
- 当时主证书有效期至 2026-11-01；OSS 证书有效期至 2026-11-12。该日期仅为验证快照，后续应由自动续签更新。

## 日常检查与故障排查

仅在收到告警、续签失败或相关配置发生变化时执行：

```bash
certbot certificates
systemctl status certbot-renew.timer
certbot renew --cert-name hothaircc.cn --dry-run --no-random-sleep-on-renew
certbot renew --cert-name oss.hothaircc.cn --dry-run --no-random-sleep-on-renew
```

不要在 dry-run 中添加 `--run-deploy-hooks`，避免把测试环境证书部署到正式 OSS。

OSS 验证对象残留检查：

```bash
/usr/local/bin/ossutil-v2 ls \
  oss://hothairapp/.well-known/acme-challenge/ \
  --region cn-beijing \
  -c /root/.ossutilconfig
```

连接生产服务器和从本机请求线上域名时，仍必须遵守 `AGENTS.md` 中的物理网卡绑定要求。

## 历史文件与备份

- 旧脚本 `/usr/local/sbin/deploy-hothaircc-oss-certificate` 已不再使用，不要重新接入。
- 重复的全局部署钩子已移动到 `/root/certbot-backups/50-hothaircc-oss-certificate.duplicate-20260814131404`，避免一次续签重复部署。
- 修改前的 OSS 续签配置备份位于 `/root/certbot-backups/oss.hothaircc.cn.conf.before-http-hook-20260814131055`。
- 当前实现对应的生产 Git 提交为 `ba278149f3833cbc9c03407ad75dba1de6c03eff`。

用户已确认暂不增加 HSTS，也不要求禁止 OSS 的 HTTP 访问；这不影响当前 HTTPS 正常使用。
