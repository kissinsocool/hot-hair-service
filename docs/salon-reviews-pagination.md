# 公开评价分页契约

新增 `GET /api/salons/:id/reviews?filter=latest&page=1&limit=10`。
`filter` 支持 `latest`（默认，全部）、`negative`（1 ≤ 星级 < 3）、`neutral`（3 ≤ 星级 < 4）、`photos`（公开评价的 imageUrls 至少有一张图片）。四种筛选均按评价创建时间倒序。
每页默认 10 条，上限 50 条；沿用现有分页参数规范化。

返回 `{ items, page, limit, total, hasMore, counts: { all, negative, neutral, photos }, reviewTags: [{ name, count }] }`。
`reviewTags` 复用旧详情接口的全店已审核评价标签统计和固定标签顺序，不受分页或分类影响；小程序只在“全部”tab 下、评价列表上方展示。
`total` 为当前筛选的总条数；`counts` 为该店全部公开评价的分类总数，与页码和当前筛选无关。
列表及总数来自同一聚合，只包含审核通过、评分在 1–5 范围内的评价。
按评价创建时间倒序、数据库 `_id` 倒序稳定排序；旧评价没有创建时间时用评价日期，再用订单更新时间。
沿用店铺详情的 `staffIds` 归属范围和公共评价序列化，隐藏待审修改、待审回复与订单用户标识。
页码分页期间如有新增或删除，列表位置可能移动；客户端按评价 ID 去重，下拉刷新重新从第一页获取。

## 三端生产者与消费者（实施前检索）

- 后端生产者：`src/routes/client-bookings.js` 提交、编辑、删除评价；`src/routes/admin.js` 审核评价及修改；`src/routes/merchant.js` 回复评价。继续写入原有 Booking.review，不变更字段或审核规则。
- 后端旧公开读取：`src/routes/public.js` 店铺详情、理发师详情；`index.js` 的 `buildSalonDetail`、`getApprovedReviewsByStaffIds`。保持原响应和原上限。
- 小程序新消费者：`pages/salon-reviews/salon-reviews.js` 改用新增接口；页面筛选、滚动加载及数量均取后端结果。
- 四 tab 扩展：后端 `src/services/salon-reviews.js` 为 `photos` 列表和 `counts.photos` 的唯一生产者；小程序评价页为唯一消费者。图片继续由原客户端提交、后台审核发布到 Booking.review.imageUrls；待审 pendingEdit 图片不参与筛选和统计。三端检索确认商家端/后台不读取本分页接口，其他公开消费者无需修改。
- 标签扩展：`getApprovedReviewTagCountsByStaffIds` 从 `index.js` 移到 `src/services/salon-reviews.js`，旧详情接口及新分页接口复用同一实现。标签生产者仍为客户端评价提交/编辑及后台审核；商家端无 reviewTags 消费者，小程序详情页继续消费原字段，评价页消费分页响应新增的同名字段。
- 小程序旧详情消费者：`pages/detail/detail.js`、`pages/booking/booking.js`、`pages/home/home.js`；理发师消费者为 `pages/staff/staff.js`。原请求结构和响应字段保持兼容。
- 商家/后台端：`merchant_app/lib/features/merchant/data/merchant_salon_repository.dart` 使用 `/merchant/salon`；`lib/features/booking/data/order_repository.dart` 使用商家订单和评价回复；`lib/features/merchant/presentation/merchant_orders_screen.dart` 展示订单评价，后台执行原有审核。检索 lib、test 确认无公开 `/salons/:id/reviews` 消费者，不需要改动 Flutter 端。

## 发布与回滚

无数据迁移、无必填字段变更。`photos`、`counts.photos` 和分页响应 `reviewTags` 为兼容新增，保留 `latest` 的全部语义及其他原有字段。先发布后端接口并验证，再发布小程序。
旧小程序继续调用 `/salons/:id`，不删除旧兼容。回滚先回退小程序，后端新增接口可保留；如需回退后端，应在小程序回退后执行。
本地测试不代表已发布；线上确认新增接口可用之前不得先发布依赖它的小程序。

## 验证记录

- 后端 `npm test`：156 项通过。
- 小程序 `node --test tests/*.test.js`：73 项通过，覆盖分页追加、分类数量、空列表、失败重试、切换筛选与页面卸载后的过期请求，以及分页后的图片预览。
- 本地隔离 MongoDB 测试库：`TEST_MONGODB_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0' npm run test:integration`，2 套测试、10 项通过。用 165 条公开评价验证超出原 150 条上限的分页读取、同时间稳定顺序、评分边界、待审内容隐藏、分类总数、分页参数上限、空店铺和未上线店铺。按旧客户端实际结构 `GET /salons/:id` 验证原响应仍有 150 条预览及全量 reviewCount。
- 本次不修改 Flutter 端代码或其消费的契约，未重复执行商家端和后台构建。
- 尚未部署线上，尚未进行微信真机交互验收。
