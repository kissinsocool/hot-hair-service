# 后台图片直传

广告图和新客活动推广图复用现有公开图片 POST Policy，上传目标仍为媒体 Bucket。新增 `POST /api/admin/uploads/sign`，位于管理员鉴权之后并使用现有上传限流。请求 `files` 中包含 `fileName/contentType/size`，响应 `uploads` 与商家直传相同；只签公开图片，按管理员身份隔离对象路径，沿用五分钟有效期、5 MiB 和图片 MIME 类型限制。

调用链：`merchant_app` 的 `AdminAdPage` → `AdminRepository.saveAd`、`AdminCouponCampaignPage` → `AdminRepository.saveCouponCampaign` → 共用 `ApiClient.uploadBase64Images` → 管理员签名 → 浏览器直传 OSS → 原 PATCH 接口提交 URL。OSS 请求使用独立 Dio，不携带后台登录凭据。上传失败不提交配置。

跨三端检索：后端 `src/routes/admin.js` 是两处配置的写入方，广告/活动模型保存 URL；`src/routes/public.js`、`src/routes/client.js` 和后台读取接口提供图片地址；小程序广告展示及 `utils/couponCampaign.js` 消费这些地址。商家上传继续使用原 `/api/merchant/uploads/sign`。小程序无后台上传调用，展示协议不变。

项目尚未上线，不保留 Base64 保存协议。原 PATCH 仅使用 `imageUrl/promotionImageUrl` 保存图片地址，已删除 Base64 转存和本地落盘函数；仅携带 Base64 而未提供 URL 的启用请求返回 400。前端本地读取图片数据用于 OSS 直传，不再发送给配置保存接口。无需 Schema 或数据迁移，历史图片不移动。先发布后端再发布后台；若需回滚到此次改造前，前后端必须恢复到匹配的接口版本。

上传成功而配置保存失败时可能留下未引用图片，与已有商家直传行为一致；此次不新增清理服务。

本地验证（2026-11-08）：后端 221 项、Flutter 134 项、小程序 119 项测试通过，管理员签名未登录返回 401 的 HTTP 检查通过；Flutter analyze、后台和商家端 Web 构建通过。直传测试使用本地 HTTP 接收实际 multipart 字节，覆盖两处上传失败不保存、无新图不上传、保存时移除 Base64 字段。未部署，未进行生产 OSS 浏览器上传验收。

部署候选在独立工作树重新运行后端 217 项测试全部通过；未包含本地另一组 JSON 请求体限制修改及其测试。
