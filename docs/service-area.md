# 小程序首页开放区域

`GET /api/service-area` 以 Express 的 `req.ip` 查询 IP 归属地，返回
`{"status":"open"}`（北京市）、`{"status":"closed"}`（其他可识别地区）
或 `{"status":"unknown"}`（IP 或数据源不可用）。响应禁止缓存。
小程序首页在确认开放前隐藏店铺、搜索和分类入口。已有店铺接口契约和订单入口保持兼容。

## 部署

1. 从 [ip2region 数据目录](https://github.com/lionsoul2014/ip2region/tree/200f4cc7a6452843ef515a889c72d295281e8da3/data)
   获取 IPv4、IPv6 的 XDB 文件，将绝对路径分别配置为 `IP_REGION_V4_XDB` 和
   `IP_REGION_V6_XDB`。服务进程需要读取权限。更新数据文件后重启服务。
2. 核对生产代理覆盖客户端提交的转发头，且 `TRUST_PROXY_HOPS` 对应实际代理链。
   用北京和非北京的真实网络出口验证接口，确认有 IPv4 和 IPv6 覆盖。
3. 先部署后端并验证区域接口，再发布小程序。没有数据库迁移。回滚时先回滚小程序，
   或保留区域接口直至依赖它的小程序版本退出使用。

查询使用本地数据，不向外部查询服务转发用户 IP。IP 归属地反映网络出口。
