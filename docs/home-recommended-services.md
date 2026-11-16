# 首页推荐（「你可能喜欢」）接口

`GET /api/salons/recommended-services?latitude=..&longitude=..&limit=10&viewedSalonIds=a,b`（公开，登录可选，沿用 publicRead 限流）。
小程序首页在「附近店铺」上方用横向卡片展示。实现在 `src/services/recommended-services.js`。

数据来自**开了推广且推广已审核通过的套餐**（`promotionEnabled: true` 且 `promotionReviewStatus: 'approved'`），不再来自店铺动态。第一版（来自动态）见 `docs/home-recommended-posts.md`。

## 推荐规则

- 候选店铺：离请求坐标最近的 50 家在线店铺，且至少有一个已审核的推广套餐；不限半径。
- 每家店最多一个套餐：推广审核通过时间（`promotionReviewedAt`）最新的那个。
- 按分类推荐（需登录）：取用户最近 20 条已完成预约，从新到旧找到第一条能归到分类的套餐（订过的套餐不必开推广），分类与「按分类查找」相同（女士精剪、男士精剪、染发、卷发、直发、发质改善；一个套餐同时属于多个分类时，烫染护理优先于剪发）。此时每家店只在该分类的推广套餐里选。该分类下不足 3 个时不按分类，`categoryId` 为空。
- 推荐理由 `reasons`：`viewed`（店铺在请求的 `viewedSalonIds` 里，即小程序本机记录的最近看过的店铺，最多取前 20 个）、`visited`（用户最近 20 条已完成预约里有这家店）。
- 排序：有推荐理由的店铺在前，其余在后；两组内都按店铺距离由近到远。`limit` 默认 10、上限 20。
- 没有可推荐的套餐时 `items` 为 `[]`，小程序整块不显示。缺少或无效的坐标返回 400。登录态无效时按未登录处理。

## 响应

`{ categoryId, items }`。`categoryId` 是分类 ID（如 `color`）或空字符串。`items` 每项：

- `id`：`<店铺 ID>:<套餐 ID>`
- `salonId`、`salonName`、`salonDescription`、`salonImageUrl`（店铺封面）、`salonTags`
- `service`：套餐当前的信息，同 `servicePayload`（名称、价格、折扣、说明、图片等）
- `reasons`、可选的 `distanceKm`
- `salonAcceptsSameDayBooking`（未设置按接受）、`salonAfterSalesPolicyIds`

小程序每张卡片显示两个标签，按顺序取前两个：推荐理由、「当日可约」、售后政策、店铺标签。卡片右上角收藏的是店铺。

`Cache-Control: private, no-store`：结果因人而异。

## 服务端缓存

与用户无关的部分（附近有推广套餐的店铺，一次地理查询）按坐标缓存 1 分钟：坐标取到小数点后 3 位（约 100 米），同一格内的请求共用（`ttl-cache.js` 的 `recommendedServices`，进程内，最多 200 格）。候选店铺以这一格的中心为准，距离仍按请求的实际坐标计算。分类、推荐理由、排序每次按当前用户现算。

没有写操作会清这份缓存：推广开关和审核结果、套餐修改或下架、店铺上下线最迟 1 分钟后在推荐里生效。

## 生产者与消费者

- 生产者：商家端开关套餐推广、后台审核推广、商家端维护套餐、用户预约完成，均为原有写入，字段和规则不变。
- 消费者：仅小程序 `pages/home/homePackages.js`。收藏沿用原有店铺收藏接口。
- merchant_app 和后台不读取本接口。

## 发布与回滚

- 顺序：先发布后端，再发布小程序。小程序先上线时请求得到 404，首页不显示该模块、不提示错误。
- 无数据迁移、无新增索引：使用已有的 `geoLocation` 2dsphere 索引和预约的 `{ userId, status, createdAt }` 索引。
- 每次请求的读取：缓存未命中时 1 次店铺查询；已登录多 1 次用户、1 次预约，订过候选范围之外的店铺时再多 1 次店铺读取。
