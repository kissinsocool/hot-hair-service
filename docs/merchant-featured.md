# 店铺精选数据契约

2026-10-21：新增店铺布尔字段 `isFeatured`，默认 false；历史缺失值也视为 false，无需数据迁移。精选属于店铺，只由管理员管理，不参与商家内容审核，也不改变上架状态、排序或预约规则。

## 已核对的生产者与消费者

- `merchant_app/lib/features/admin/presentation/pages/admin_merchants_page.dart` 商家卡片开关，经 `AdminRepository.updateMerchantFeatured` 调用新增 `PATCH /api/admin/merchants/:id/featured`，请求 `{ "isFeatured": true | false }`。保存期间禁用该店开关，失败保留原状态。
- `hot_hair_service/src/routes/admin.js` 使用现有 `/api/admin` 管理员鉴权，严格校验布尔值，通过商家关联的 salonId 修改 Salon；成功保存后清理详情缓存。`src/models.js` 持久化字段。
- `hot_hair_service/index.js` 的 `buildAdminMerchantPayload` 经 `salon.isFeatured` 回传后台；`buildSalonDetail`、`buildMerchantSalonPayload`、附近店铺及收藏的现有公共店铺序列化返回新增字段。
- `hot_hair_mp/pages/detail/detail.js` 原样保留详情字段，`detail.wxml` 仅在 `salon.isFeatured === true` 时于顶部图片下、店名上展示黑底白字圆角“靓丝  精选”。缺失值不展示，不留空白。
- 其他读取端：后台 overview / service promotions 页读取商家列表；商家端 `merchant_salon_repository.dart` / `merchant_salon_screen.dart` 读取和提交店铺；小程序 home（列表及推荐套餐详情）、booking（店铺详情）、favorites（收藏店铺）消费现有店铺返回值，忽略新增字段，行为不变。salon-reviews / salon-posts / style-gallery 的独立评价、动态及套餐接口不消费精选状态。
- 商家写入仍由 `buildContentDraft`、`applyDirectSalonContent`、`applyPendingContent` 的字段白名单和 `pendingContentSchema` 管理，不加入 isFeatured，防止商家自行设置或旧草稿覆盖精选。

## 兼容、发布和回滚

旧后台新增、编辑商家的请求结构保持不变，省略该字段不会清除精选；旧商家端即使回传新增字段也不会覆盖它。新增独立接口不改变既有接口的必填规则。旧小程序忽略新增响应字段，新小程序连接旧后端时不展示标签。

先发布兼容后端，再发布管理后台和小程序。无需删除旧兼容，无索引或回填任务。回滚优先恢复客户端，数据库字段保留；紧急撤下标签可关闭开关。必须回滚后端时不删除已保存字段，恢复新版即可重新读取。新后台不得先于支持新接口的后端发布。

## 验证范围

验证真实 Mongoose 文档的默认值、开关持久化、非法请求及不存在的商家/店铺、缓存清理、旧后台/商家请求保留状态、公开详情和后台回传；后台验证开关保存、恢复和失败处理；小程序验证详情加载、旧响应兼容、条件和标签位置。构建管理后台、商家端，并离线编译小程序详情模板和样式。线上发布及真机检查另行记录。

本地结果：后端 Node 全量 178 项、Flutter 全量 106 项、小程序 Node 全量 89 项通过；Flutter analyze 无问题。按项目命令构建 admin-web 和 merchant-web 成功，base href 分别为 `/admin-app/` 和 `/merchant-app/`；微信开发者工具 wcc / wcsc 离线编译详情页 WXML / WXSS 成功。公开详情契约使用现有 `/api/salons/:id` 请求路径并调用真实详情构造与缓存；数据库读写在测试中替换，未连接线上数据库。尚未发布线上或进行微信真机验收。
