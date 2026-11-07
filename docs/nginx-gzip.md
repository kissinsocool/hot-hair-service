# Nginx gzip

`ops/nginx/gzip.conf` 在 Nginx `http` 上下文启用原生 gzip，压缩超过 1024 字节的 JSON 和文本响应。HTML 由 Nginx 默认包含。压缩级别为 4，不压缩 JPEG、PNG、WebP、视频等已经压缩的格式。客户端需发送 `Accept-Encoding: gzip`；不支持的客户端仍收到原始内容，`Vary: Accept-Encoding` 区分缓存版本。接口字段和业务进程不变，无数据迁移。

## 部署

先确认 `/opt/hot-hair-service` 当前分支、提交及工作树干净，仅通过 Git 获取并快进到已验证的指定提交。所有服务器连接遵守 AGENTS.md 中物理网卡绑定要求。

首次部署前确认 `/etc/nginx/conf.d/hot-hair-gzip.conf` 不存在，再创建软链接：

```sh
ln -s /opt/hot-hair-service/ops/nginx/gzip.conf /etc/nginx/conf.d/hot-hair-gzip.conf
nginx -t && systemctl reload nginx
```

若语法检查失败，立即移除该新建软链接，不重载。配置变更后均先 `nginx -t`，再平滑重载，无需重启 Node 服务。检查 Nginx 状态、`/health`、`/ready` 和公开店铺接口；分别请求 identity/gzip，验证状态、响应头、解压后内容一致及传输体积。不超过阈值的响应无需压缩。

## 回滚

确认该路径仍指向上述文件后，移除 `/etc/nginx/conf.d/hot-hair-gzip.conf`，运行 `nginx -t && systemctl reload nginx`。保留 Git 配置文件以便审计；不修改证书、业务代码或数据库。

参考：[Nginx gzip 模块](https://nginx.org/en/docs/http/ngx_http_gzip_module.html)。
