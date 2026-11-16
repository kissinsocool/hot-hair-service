# 首页「套餐推荐」接口

新增 `GET /api/salons/recommended-posts?latitude=..&longitude=..&limit=10&version=2&viewedSalonIds=a,b`（公开，登录可选，沿用 publicRead 限流）。
小程序首页在「附近店铺」上方用横向卡片展示，卡片与收藏页「套餐」是同一个组件。实现在 `src/services/recommended-posts.js`。

## 推荐规则

- 候选店铺：离请求坐标最近的 50 家在线店铺（`publishStatus: 'online'` 且至少有一个套餐），不限半径，与店铺列表「附近不足时放宽范围」的做法一致。
- 每家店最多一条：该店最新的已审核动态（`reviewStatus: 'approved'`），且动态关联的套餐仍在该店的套餐列表里。没有关联套餐、或套餐已下架的动态不参与。
- 按分类推荐（需登录）：取用户最近 20 条已完成预约，从新到旧找到第一条能归到分类的套餐，分类与「按分类查找」相同（女士精剪、男士精剪、染发、卷发、直发、发质改善；一个套餐同时属于多个分类时，烫染护理优先于剪发）。此时每家店只在该分类的套餐里取最新动态。该分类下不足 3 条时不按分类，`categoryId` 为空。
- 推荐理由 `reasons`：`viewed`（店铺在请求的 `viewedSalonIds` 里，即小程序本机记录的最近看过的店铺）、`visited`（用户最近 20 条已完成预约里有这家店）。
- 排序：有推荐理由的店铺在前，其余在后；两组内都按店铺距离由近到远。`limit` 默认 10、上限 20。
- 没有符合条件的动态时 `items` 为 `[]`，小程序整块不显示。缺少或无效的坐标返回 400。登录态无效时按未登录处理。

「最近看过」用客户端传参而不是埋点表：`AnalyticsEvent` 按设计只保留漏斗统计用的索引，没有按用户查询的索引。`viewedSalonIds` 最多取前 20 个 ID。

## 响应

传 `version=2` 时返回 `{ categoryId, items }`。旧请求继续返回按距离排序的数组，不包含 `reasons`。`categoryId` 是分类 ID（如 `color`）或空字符串。

`items` 每项与 `GET /api/favorites/posts` 的条目同结构（两处共用 `services/salon-posts.js` 的 `postWithSalonPayload`），另带 `reasons` 和可选的 `distanceKm`：

动态字段（`id`、`salonId`、`content`、`serviceId`、`serviceName`、`imageUrls`、`createdAt` 等）+ `salonName`、`salonDescription`、`salonImageUrl`、`salonTags`、`relatedService`（套餐当前的名称、价格、折扣、说明等，同 `servicePayload`）。

`Cache-Control: private, no-store`：结果因人而异。

## 服务端缓存

与用户无关的部分（候选店铺和它们各套餐的最新动态，即两次较重的查询）按坐标缓存 1 分钟：坐标取到小数点后 3 位（约 100 米），同一格内的请求共用（`ttl-cache.js` 的 `recommendedPosts`，进程内，最多 200 格）。候选店铺以这一格的中心为准，距离仍按请求的实际坐标计算。

分类、推荐理由、排序每次按当前用户现算，不进缓存。

没有写操作会清这份缓存：新审核通过的动态、套餐修改或下架、店铺上下线最迟 1 分钟后在推荐里生效。套餐刚下架的这 1 分钟内卡片仍可能出现，点进预约页时以预约页读到的最新套餐为准。

## 生产者与消费者

- 生产者：商家端发布动态、后台审核动态、商家端维护套餐、用户预约完成，均为原有写入，字段和规则不变。
- 新消费者：仅小程序 `pages/home/homePackages.js`。收藏、取消收藏沿用原有 `/api/favorites/posts/:id`。
- `GET /api/favorites/posts` 的响应结构未变，只是改为调用共用的构造函数。
- `/api/salons/promoted-services` 的分类定义移到 `services/recommended-posts.js` 供两处共用，行为未变。
- merchant_app 和后台不读取本接口。

## 发布与回滚

- 顺序：先发布后端，再发布小程序。新版小程序接受旧后端的数组响应，旧版小程序继续使用数组响应。
- 回滚：两端可各自独立回滚；后端回滚至上一版时，新版小程序继续展示按距离排序的推荐。
- 无数据迁移、无新增索引：店铺查询使用已有的 `geoLocation` 2dsphere 索引，动态查询使用 `{ salonId, createdAt, _id }`，预约查询使用 `{ userId, status, createdAt }`。
- 每次请求的读取：缓存未命中时候选店铺 1 次、动态聚合 1 次，命中时这两次都省掉；已登录多 1 次用户、1 次预约，订过候选范围之外的店铺时再多 1 次店铺读取。
