# 「按分类查找」图片接口（店铺动态）

`GET /api/salons/category-posts?category=color&sort=latest&page=1&limit=30`，按距离时 `sort=distance&latitude=..&longitude=..`（公开，沿用 publicRead 限流）。实现在 `src/services/category-posts.js`。

小程序「按分类查找」的图片改为店铺发布的动态，点击图片进入动态详情。此前用的是推广套餐的图片、点击进入店铺（`/api/salons/promoted-services`）。

## 规则

- 一条动态属于哪个分类，由它关联的套餐的标签决定，分类定义与原接口相同（`services/recommended-services.js` 的 `promotionCategoryTagFilter`）。
- 只出：在线店铺、已审核通过、至少有一张图片、关联的套餐仍在该店套餐列表里的动态。没有关联套餐的动态不属于任何分类，不出现。
- 每条动态只出第一张图。
- `sort=latest`（默认）按动态发布时间从新到旧；`sort=distance` 按店铺距离由近到远，同店按发布时间。
- 分类不存在返回 400；`sort=distance` 缺坐标返回 400。

## 响应

数组，每项 `{ id, salonId, postId, imageUrl }`，`id` 等于 `postId`。分页信息在响应头（`X-Total-Count`、`X-Page`、`X-Page-Size`），与原接口一致。小程序用 `salonId` + `postId` 打开动态详情（`/api/salons/:id/posts/:postId`）。

`Cache-Control: public, max-age=15, stale-while-revalidate=30`。按发布时间排序的页在服务端按「分类 + 页码 + 每页条数」缓存 1 分钟（`ttl-cache.js` 的 `categoryPosts`）；按距离排序的结果随坐标变化，不缓存。没有写操作会清这份缓存，新审核通过的动态最迟 1 分钟后出现。

## 兼容与发布

- `/api/salons/promoted-services` 原样保留：已发布的小程序仍在调用它（推广套餐图片、点击进店铺）。线上不再有旧版本后再删除。
- 新消费者：仅小程序 `pages/style-gallery/style-gallery.js`。merchant_app 和后台不读取本接口。
- 顺序：先发布后端，再发布小程序。
- 查询从 `salons` 出发，用 `$lookup` 按 `salonId` + `serviceId` 关联 `salonposts`（使用已有的 `{ salonId, createdAt, _id }` 索引）。无数据迁移、无新增索引。
