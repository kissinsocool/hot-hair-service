# 「按分类查找」图片接口（店铺动态）

`GET /api/salons/category-posts?category=color&sort=latest&page=1&limit=30`，按距离时 `sort=distance&latitude=..&longitude=..`（公开，沿用 publicRead 限流）。实现在 `src/services/category-posts.js`。

小程序「按分类查找」的图片改为店铺发布的动态，点击图片进入动态详情。此前用的是推广套餐的图片、点击进入店铺（`/api/salons/promoted-services`）。

## 规则

- 一条动态属于哪个分类，由商家发布作品时选的**推广分类**决定（`SalonPost.promotionCategoryId`），不再看关联套餐的标签。分类 ID：`women-cut` 女士精剪、`men-cut` 男士精剪、`color` 染发、`curly` 卷发、`straight` 直发、`care` 护理（小程序显示为「发质改善」），定义在 `src/services/promotion-categories.js`。
- 只出：在线店铺、已审核通过、至少有一张图片的动态。是否关联套餐、关联的套餐是否还在售都不影响。`promotionCategoryId` 为空字符串的动态不属于任何分类，不出现。
- 每条动态只出第一张图。
- `sort=latest`（默认）按动态发布时间从新到旧；`sort=distance` 按店铺距离由近到远，同店按发布时间。
- 分类不存在返回 400；`sort=distance` 缺坐标返回 400。
- 查询从 `salonposts` 出发（索引 `{ promotionCategoryId, reviewStatus, createdAt, _id }`），用 `$lookup` 按 `salonId` 关联 `salons` 只留在线店铺。

## 推广分类字段（2026-11）

- 商家端 `POST /api/merchant/salon-posts` 新增 `promotionCategoryId`。新版商家端必选；服务端对**不带这个字段**（`undefined` / `null`）的旧版商家端保持兼容：按关联套餐的标签推算（规则同字段上线前，`recommended-services.js` 的 `servicePromotionCategory`，一个套餐属于多个分类时按 染发 > 卷发 > 直发 > 护理 > 女士精剪 > 男士精剪 取一个），没有关联套餐记为 `''`。带了但不是有效分类（包括空字符串）返回 400「请选择推广分类」。
- 商家端、后台的动态列表响应（`postPayload`）新增 `promotionCategoryId`，旧动态为 `''`。小程序不读取这个字段。
- 字段上线前的动态：`npm run migrate:post-promotion-categories` 按关联套餐的标签补一次，只处理还没有这个字段的动态，可重复运行。与字段上线前的区别：以前一条动态可以同时出现在多个分类（套餐有多个标签），补完后只在一个分类里；关联的套餐已下架的动态以前不出现，补完后也是 `''`。

## 发布顺序

1. 发布后端（新增字段、索引在启动时创建，接口兼容旧版商家端）。
2. 立即运行 `npm run migrate:post-promotion-categories`。在它跑完之前，老动态没有分类，「按分类查找」里暂时看不到它们。
3. 发布商家端（发布作品时必选推广分类）。
4. 小程序不需要发版：分类 ID 和接口都没变。
5. 回滚：后端回到上一版即恢复按套餐标签归类；`promotionCategoryId` 字段留在数据里不影响旧代码。确认线上没有旧版商家端后，可以把服务端的「不带字段时按套餐推算」改成必填。

### 三端调用方核对（2026-11-29）

- 字段生产者：商家端 `merchant_salon_repository.dart` 的 `createSalonPost`；后端 `routes/merchant.js` 创建作品、`migrate-post-promotion-categories.js` 回填旧作品。当前已提交的旧商家端请求不带分类，新请求仅增加可选字段。
- 字段消费者：后端 `category-posts.js` 查询和 `salon-posts.js` 序列化；商家端 `merchant_salon_screen.dart`、后台 `admin_salon_posts_page.dart` 展示分类。共用序列化的商家/后台作品列表、公开作品详情/列表、收藏和首页推荐均只增加响应字段，原字段保留。
- 小程序 `utils/promotionCategories.js` 的六个分类 ID 与后端、商家端一致；`pages/style-gallery/style-gallery.js` 仍按原请求和 `{ id, salonId, postId, imageUrl }` 响应读取，不依赖新增字段。旧 `/salons/promoted-services` 保留原逻辑。
- 部署时先备份历史作品，在旧进程运行期间先回填，再重启新版并立即补跑回填，覆盖旧进程在首次扫描后新增的作品。新版创建操作直接保存分类，补跑只更新字段缺失的数据；重复运行应为零修改。这样重启后历史作品即可按分类查询，避免先重启再迁移的空列表窗口。回滚目标为发布前提交 `9e10c76`，不删除新增字段或索引，不覆盖回填后商家新发布的数据。

## 响应

数组，每项 `{ id, salonId, postId, imageUrl }`，`id` 等于 `postId`。分页信息在响应头（`X-Total-Count`、`X-Page`、`X-Page-Size`），与原接口一致。小程序用 `salonId` + `postId` 打开动态详情（`/api/salons/:id/posts/:postId`）。

`Cache-Control: public, max-age=15, stale-while-revalidate=30`。按发布时间排序的页在服务端按「分类 + 页码 + 每页条数」缓存 1 分钟（`ttl-cache.js` 的 `categoryPosts`）；按距离排序的结果随坐标变化，不缓存。没有写操作会清这份缓存，新审核通过的动态最迟 1 分钟后出现。

## 兼容与发布（2026-10 第一版）

- `/api/salons/promoted-services` 原样保留：已发布的小程序仍在调用它（推广套餐图片、点击进店铺），仍按套餐标签归类。线上不再有旧版本后再删除。
- 消费者：仅小程序 `pages/style-gallery/style-gallery.js`。merchant_app 和后台不读取本接口。
