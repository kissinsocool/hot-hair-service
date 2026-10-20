# 商家商圈数据契约

2026-10-20：新增可选的店铺字段 `businessDistrict`，与店铺标签、行政区划独立。
后端维护的单选值：龙湖天街、天宫院、黄村、西红门、国贸、建外soho、大望路、通州万达、旧宫、大族广场、林肯公园、庞各庄、西铁营万达、槐房路万达、丰科万达、大兴凯德MALL。
空字符串表示清空；请求省略表示保留原值；其他类型和值返回 400。

## 选项接口

`GET /api/admin/business-districts` 使用现有管理员鉴权，返回字符串数组（不含表示清空的空字符串），并设置 `Cache-Control: no-store`。`src/services/business-districts.js` 是选项、写入校验和 Mongoose 枚举的共同来源。

后台 `AdminRepository.fetchBusinessDistricts` 每次打开新增／编辑弹窗时请求列表，不再内置选项，不跨弹窗缓存。已有选中值保留以便回填；空字符串继续由界面作为“未设置”提供。加载失败时提示重试，不打开不完整表单、不写入数据；重新点击可再次加载。

该接口为新增接口，旧接口和字段语义不变，无数据迁移。首次改造先部署提供接口的后端，再发布后台；如需回滚，先回滚后台再回滚后端。此次之后只新增商圈时，只需更新后端列表并部署后端，后台下次打开弹窗即可读取；小程序显示后端返回名称，无需改动。

## 已核对的生产者和消费者

- `merchant_app/lib/features/admin/presentation/pages/admin_merchants_page.dart` 新增／编辑弹窗产生选值；`data/admin_repository.dart` 经 POST `/admin/merchants`、PATCH `/admin/merchants/:id` 写入。
- `hot_hair_service/src/routes/admin.js` 新增选项接口供后台读取，并校验写入 Salon；`src/models.js` 持久化枚举；`index.js` 的 `buildAdminMerchantPayload` 返回 `salon.businessDistrict`，后台卡片和编辑回填消费。
- `hot_hair_service/index.js` 的 `getNearbySalons`、`buildSalonDetail`、`buildMerchantSalonPayload`，以及 `src/routes/public.js` 的 `/salons`、`/salons/suggestions`、`/salons/:id` 返回该可选字段。距离／评分排序查询不剔除该字段。
- `hot_hair_mp/pages/home/home.js` 的 normalizeSalon、renderSalons 消费字段，home.wxml 在距离后展示；历史数据不显示空占位，无定位时独立显示商圈。
- 小程序 `pages/detail/detail.js`、`pages/booking/booking.js`、`pages/salon-reviews/salon-reviews.js` 消费店铺详情，忽略未知字段；商家端 `merchant_salon_repository.dart`、`merchant_salon_screen.dart` 通过 `/merchant/salon` 读写，后端显式选取允许编辑的字段，不覆盖后台商圈。收藏等店铺数据通过现有详情构造返回，旧界面不读取新增字段。

## 兼容、部署与回滚

历史店铺无需回填，缺失值视作未设置；标签、地址及其他字段语义不变。旧客户端的完整请求继续接受，省略字段不会清空数据。后端新增兼容后，再发布后台和小程序；旧后端会忽略新字段，因此后台不可先发布。没有删除兼容阶段。

回滚优先恢复前端，保留兼容后端和数据库字段。必须回滚后端时保留数据库中的商圈，不执行删除迁移；后续恢复兼容后端即可继续读取。

## 验证

后端 `src/routes/admin-business-district.test.js` 使用真实 Mongoose 文档覆盖当前旧客户端请求结构、所有选项、清空、非法值及仅修改商圈时保留标签；`index.test.js` 覆盖小程序当前列表请求返回商圈。
后台 `test/admin_business_district_test.dart` 验证新增、编辑、展示、回填、清空和取消。小程序 `tests/home-business-district.test.js` 验证字段到首页卡片的数据链路、距离及缺失字段兼容。

验证结果：Flutter 全量测试 80 项、后端 Node 测试 155 项、小程序 Node 测试 68 项通过；Flutter analyze 无问题。微信开发者工具自带 wcc / wcsc 已离线编译首页 WXML / WXSS，home.js 语法检查通过。未进行线上写入、线上端到端或真机验证。

选项接口回归：后端验证返回值与写入枚举一致、禁止缓存；后台验证服务端新增选项无需发版即可选用、保留已有回填值、加载失败可重试。
