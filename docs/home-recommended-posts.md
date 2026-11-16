# 首页「套餐推荐」接口

新增 `GET /api/salons/recommended-posts?latitude=..&longitude=..&limit=10`（公开，无需登录，沿用 publicRead 限流）。
小程序首页在「附近店铺」上方用横向卡片展示，卡片与收藏页「套餐」是同一个组件。

## 推荐规则

- 候选店铺：离请求坐标最近的 50 家在线店铺（`publishStatus: 'online'` 且至少有一个套餐），不限半径，与店铺列表「附近不足时放宽范围」的做法一致。
- 每家店最多一条：该店最新的已审核动态（`reviewStatus: 'approved'`），且动态关联的套餐仍在该店的套餐列表里。没有关联套餐、或套餐已下架的动态不参与。
- 结果按店铺距离由近到远，`limit` 默认 10、上限 20。没有符合条件的动态时返回 `[]`，小程序整块不显示。
- 缺少或无效的坐标返回 400。

## 响应

数组，每项与 `GET /api/favorites/posts` 的条目同结构（两处共用 `services/salon-posts.js` 的 `postWithSalonPayload`），另带可选的 `distanceKm`：

动态字段（`id`、`salonId`、`content`、`serviceId`、`serviceName`、`imageUrls`、`createdAt` 等）+ `salonName`、`salonDescription`、`salonImageUrl`、`salonTags`、`relatedService`（套餐当前的名称、价格、折扣、说明等，同 `servicePayload`）。

`Cache-Control: public, max-age=15, stale-while-revalidate=30`。结果随坐标变化，服务端不做进程内缓存。

## 生产者与消费者

- 生产者：商家端发布动态、后台审核动态、商家端维护套餐，均为原有写入，字段和规则不变。
- 新消费者：仅小程序 `pages/home/homePackages.js`。收藏、取消收藏沿用原有 `/api/favorites/posts/:id`。
- `GET /api/favorites/posts` 的响应结构未变，只是改为调用共用的构造函数。
- merchant_app 和后台不读取本接口。

## 发布与回滚

- 顺序：先发布后端，再发布小程序。小程序先上线时，请求会落到 `/api/salons/:id` 并得到 404，首页不显示该模块、不提示错误，其余功能不受影响。
- 回滚：两端可各自独立回滚；后端回滚后小程序表现同上。
- 无数据迁移、无新增索引：店铺查询使用已有的 `geoLocation` 2dsphere 索引，动态查询使用已有的 `{ salonId, createdAt, _id }` 索引。
