const crypto = require('node:crypto');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const rateLimitToken = crypto.randomBytes(32).toString('hex');
process.env.LOAD_TEST_BYPASS_ENABLED = 'true';
process.env.LOAD_TEST_BYPASS_TOKEN = rateLimitToken;
const mongoose = require('mongoose');
const models = require('../src/models');
const { CouponCampaign, UserCoupon, Salon, ClientUser, Booking } = models;
const { defaultCampaign, CAMPAIGN_KEY, couponStatus } = require('../src/coupons');
const { createSession } = require('../src/services/auth');
const { sync } = require('./sync-signup-coupon-rules');
const { expirePendingBookings } = require('../src/services/auto-complete-bookings');
const { server } = require('../index');
const uri = String(process.env.TEST_MONGODB_URI || '').trim();
const describeWithMongo = uri ? describe : describe.skip;

describeWithMongo('signup coupon rule synchronization against an isolated replica-set database', () => {
  const databaseName = `hot_hair_coupon_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const now = new Date();
  const past = new Date('2020-01-01');
  const future = new Date('2035-01-01');
  const session = createSession();
  let baseUrl;
  let campaign;
  beforeAll(async () => {
    const localUri = new URL(uri);
    if (!['127.0.0.1', 'localhost'].includes(localUri.hostname)) throw new Error('Only local test MongoDB is allowed');
    await mongoose.connect(uri, { dbName: databaseName, serverSelectionTimeoutMS: 10000 });
    await Promise.all(Object.values(models).map(Model => Model.init()));
    await ClientUser.create({ id: 'sync-client', account: 'sync-client', authProvider: 'wechat',
      sessionTokenHash: session.tokenHash, sessionExpiresAt: session.expiresAt });
    await models.StaffProfile.create({ id: 'sync-staff', name: 'Sync stylist', roleId: 'designer', extraServiceFeeFen: 0 });
    await Salon.create({ id: 'sync-salon', name: 'Sync salon', publishStatus: 'online', staffIds: ['sync-staff'], openingHours: '09:00-20:00',
      services: [{ id: 'cut', name: 'Cut', tagIds: ['wash_cut_blow'], priceFen: 8000, durationMinutes: 60 }] });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    campaign = { ...defaultCampaign(), registrationStartAt: past, registrationEndAt: future };
    campaign.coupons[0] = { key: '99-20', minimumSpendFen: 7000, discountFen: 1500, title: '满70减15', description: '新门槛' };
    await CouponCampaign.create(campaign);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([CouponCampaign.deleteMany({}), UserCoupon.deleteMany({}), Booking.deleteMany({}),
      models.SlotOccupancy.deleteMany({}), models.BookingMessage.deleteMany({}), models.UserPolicy.deleteMany({})]);
  });
  afterAll(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      const databases = await mongoose.connection.getClient().db('admin').admin().listDatabases({ nameOnly: true });
      expect(databases.databases.map(db => db.name)).not.toContain(databaseName);
      await mongoose.disconnect();
    }
  });
  async function coupon(id, overrides = {}) {
    return UserCoupon.create({ id, userId: id, campaignKey: CAMPAIGN_KEY, couponType: '99-20',
      minimumSpendFen: 5000, discountFen: 1000, title: '旧规则', description: '旧说明',
      grantedAt: past, claimedAt: past, validFrom: past, validUntil: future, ...overrides });
  }
  const read = () => UserCoupon.find().sort({ id: 1 }).lean();
  const rules = template => Object.fromEntries(['minimumSpendFen', 'discountFen', 'title', 'description'].map(field => [field, template[field]]));
  async function request(route, body, method = 'POST') {
    const res = await fetch(`${baseUrl}/api${route}`, { method,
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', 'x-load-test-token': rateLimitToken },
      body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  const bookingInput = { staffId: '__no_preference__', salonId: 'sync-salon', serviceId: 'cut', startTime: '2030-06-01T10:00:00+08:00' };

  test('dry run, legacy empty values, every status, exact expiry, unchanged validity, and idempotence', async () => {
    for (const [i, redeemedAt] of [undefined, null, ''].entries()) {
      for (const [j, reservedBookingId] of [undefined, null, ''].entries()) {
        const id = `blank-${i}-${j}`;
        await coupon(id);
        const $set = {}; const $unset = {};
        for (const [key, value] of Object.entries({ redeemedAt, reservedBookingId })) {
          if (value === undefined) $unset[key] = ''; else $set[key] = value;
        }
        // Raw storage preserves legacy '' in a Date field; all reads and writes below use real Mongoose queries.
        await UserCoupon.collection.updateOne({ id }, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) });
      }
    }
    await coupon('unclaimed', { claimedAt: undefined });
    await coupon('unclaimed-null', { claimedAt: null });
    await coupon('unclaimed-blank');
    await UserCoupon.collection.updateOne({ id: 'unclaimed-blank' }, { $set: { claimedAt: '' } });
    await coupon('pending', { validFrom: future });
    await coupon('second-type', { couponType: '199-30' });
    await coupon('reserved', { reservedBookingId: 'locked-booking' });
    await coupon('redeemed', { redeemedAt: past, reservedBookingId: 'locked-booking' });
    await coupon('expired', { validUntil: past });
    await coupon('expires-now', { validUntil: now });
    await coupon('already-new', rules(campaign.coupons[0]));
    await coupon('foreign', { campaignKey: 'other' });
    await coupon('unknown-type', { couponType: 'other' });
    const before = await read();
    const eligible = before.filter(c => c.campaignKey === CAMPAIGN_KEY && ['99-20', '199-30'].includes(c.couponType)
      && ['available', 'unclaimed', 'pending'].includes(couponStatus(c, now)) && c.id !== 'already-new');
    expect(eligible).toHaveLength(14);
    const dry = await sync({ now });
    expect(await read()).toEqual(before);
    expect(dry.report).toMatchObject([
      { toUpdate: 13, toUpdateAlreadyClaimed: 10, skippedReserved: 1, skippedRedeemed: 1 }, { toUpdate: 1 },
    ]);
    const applied = await sync({ apply: true, now });
    expect(applied.report.map(r => [r.toUpdate, r.modified])).toEqual([[13, 13], [1, 1]]);
    for (const after of await read()) {
      const old = before.find(c => c.id === after.id);
      if (eligible.some(c => c.id === after.id)) {
        expect(after).toMatchObject(rules(campaign.coupons.find(t => t.key === after.couponType)));
        const { updatedAt: afterUpdatedAt, ...rest } = after;
        const { updatedAt: beforeUpdatedAt, ...oldFields } = old;
        expect(rest).toEqual({ ...oldFields, ...rules(campaign.coupons.find(t => t.key === after.couponType)) });
      } else expect(after).toEqual(old);
    }
    const second = await sync({ apply: true, now });
    expect(second.report.map(r => [r.toUpdate, r.modified])).toEqual([[0, 0], [0, 0]]);
  });

  test('invalid second template or missing configuration fails before changing any coupon', async () => {
    await coupon('validation');
    const before = await read();
    for (const coupons of [campaign.coupons.slice(0, 1), [campaign.coupons[0], campaign.coupons[0]],
      [campaign.coupons[0], { ...campaign.coupons[1], discountFen: -1 }]]) {
      await CouponCampaign.collection.updateOne({ key: CAMPAIGN_KEY }, { $set: { coupons } });
      await expect(sync({ apply: true, now })).rejects.toThrow('活动配置无效');
      expect(await read()).toEqual(before);
    }
    await CouponCampaign.deleteMany({});
    await expect(sync({ apply: true, now })).rejects.toThrow('未找到活动配置');
    expect(await read()).toEqual(before);
  });

  test('each individual outdated field and a missing description are detected', async () => {
    const current = rules(campaign.coupons[0]);
    for (const [field, value] of Object.entries({ minimumSpendFen: 5000, discountFen: 1000, title: '旧标题', description: '旧说明' })) {
      await coupon(`only-${field}`, { ...current, [field]: value });
    }
    await coupon('missing-description', current);
    await UserCoupon.collection.updateOne({ id: 'missing-description' }, { $unset: { description: '' } });
    expect((await sync({ now })).report[0].toUpdate).toBe(5);
    expect((await sync({ apply: true, now })).report[0].modified).toBe(5);
    for (const updated of await read()) expect(updated).toMatchObject(current);
  });

  test('CLI defaults to dry run and --apply writes only the isolated test database', async () => {
    await coupon('cli');
    const testUri = new URL(uri); testUri.pathname = `/${databaseName}`;
    const run = async args => JSON.parse((await promisify(execFile)(process.execPath,
      [path.join(__dirname, 'sync-signup-coupon-rules.js'), ...args],
      { env: { ...process.env, MONGODB_URI: testUri.href } })).stdout.split('\n以上为预览')[0]);
    const before = await read();
    expect((await run([])).apply).toBe(false);
    expect(await read()).toEqual(before);
    expect((await run(['--apply'])).report[0]).toMatchObject({ toUpdate: 1, modified: 1 });
    expect((await run(['--apply'])).report[0]).toMatchObject({ toUpdate: 0, modified: 0 });
    await CouponCampaign.collection.updateOne({ key: CAMPAIGN_KEY }, { $set: { 'coupons.1.discountFen': -1 } });
    const beforeInvalid = await read();
    await expect(run(['--apply'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('活动配置无效') });
    expect(await read()).toEqual(beforeInvalid);
  }, 15000);

  test('new threshold rejects the old qualifying amount, then books with the new discount', async () => {
    await coupon('booking', { userId: 'sync-client' });
    await sync({ apply: true, now });
    await Salon.updateOne({ id: 'sync-salon' }, { $set: { 'services.0.priceFen': 6000 } });
    try {
      const rejected = await request('/bookings', { ...bookingInput, couponId: 'booking' });
      expect(rejected.status).toBe(409);
      expect(rejected.body.message).toContain('未满70元');
      expect((await UserCoupon.findOne({ id: 'booking' }).lean()).reservedBookingId).toBe('');
      expect(await Booking.countDocuments()).toBe(0);
    } finally { await Salon.updateOne({ id: 'sync-salon' }, { $set: { 'services.0.priceFen': 8000 } }); }
    const accepted = await request('/bookings', { ...bookingInput, couponId: 'booking', expectedOriginalAmountFen: 8000, expectedPayableAmountFen: 6500 });
    expect(accepted.status).toBe(201);
    expect(accepted.body.booking).toMatchObject({ couponDiscountFen: 1500, payableAmountFen: 6500, couponTitle: '满70减15' });
  });

  test('reservation after counting but before update preserves the old order; cancellation and rerun update the released coupon', async () => {
    await coupon('race-reserve', { userId: 'sync-client' });
    const original = UserCoupon.updateMany;
    let order;
    jest.spyOn(UserCoupon, 'updateMany').mockImplementationOnce(async function (...args) {
      order = await request('/bookings', { ...bookingInput, couponId: 'race-reserve' });
      expect(order.status).toBe(201);
      return original.apply(this, args);
    });
    const result = await sync({ apply: true, now });
    expect(result.report[0]).toMatchObject({ toUpdate: 1, modified: 0 });
    expect(order.body.booking).toMatchObject({ couponDiscountFen: 1000, payableAmountFen: 7000 });
    expect((await UserCoupon.findOne({ id: 'race-reserve' }).lean()).discountFen).toBe(1000);
    expect((await request(`/bookings/${order.body.booking.id}/cancel`, {}, 'PATCH')).status).toBe(200);
    expect((await sync({ apply: true, now })).report[0].modified).toBe(1);
  });

  test('synchronization after a transaction snapshot but before reservation forces retry and new pricing', async () => {
    await coupon('race-sync', { userId: 'sync-client' });
    const original = UserCoupon.findOneAndUpdate;
    const reserve = jest.spyOn(UserCoupon, 'findOneAndUpdate').mockImplementationOnce(async function (...args) {
      expect((await sync({ apply: true, now })).report[0].modified).toBe(1);
      return original.apply(this, args);
    });
    const order = await request('/bookings', { ...bookingInput, couponId: 'race-sync' });
    expect(order.status).toBe(201);
    expect(reserve.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(order.body.booking).toMatchObject({ couponDiscountFen: 1500, payableAmountFen: 6500 });
    expect((await UserCoupon.findOne({ id: 'race-sync' }).lean()).discountFen).toBe(1500);
  });

  test('pending timeout releases an old-rule coupon for the next synchronization', async () => {
    await coupon('timeout', { userId: 'sync-client' });
    const order = await request('/bookings', { ...bookingInput, couponId: 'timeout' });
    expect(order.status).toBe(201);
    expect((await sync({ apply: true, now })).report[0].modified).toBe(0);
    await Booking.updateOne({ id: order.body.booking.id }, { $set: { createdAt: past } });
    expect(await expirePendingBookings({ mongoose, ...models, broadcastBookingEvent: () => {} }, now, { timeoutMs: 60000 })).toBe(1);
    const released = await UserCoupon.findOne({ id: 'timeout' }).lean();
    expect(released).not.toHaveProperty('reservedBookingId');
    expect(released.discountFen).toBe(1000);
    expect((await sync({ apply: true, now })).report[0].modified).toBe(1);
  });

  test('an uncommitted reservation blocks sync until commit, then the atomic filter skips it', async () => {
    await coupon('uncommitted');
    const transaction = await mongoose.startSession();
    transaction.startTransaction();
    let writing;
    const entered = new Promise(resolve => { writing = resolve; });
    const original = UserCoupon.updateMany;
    jest.spyOn(UserCoupon, 'updateMany').mockImplementationOnce(function (...args) {
      const query = original.apply(this, args);
      const result = query.exec();
      writing();
      return result;
    });
    let running;
    try {
      await UserCoupon.findOneAndUpdate({ id: 'uncommitted' }, { $set: { reservedBookingId: 'transaction-booking' } }, { session: transaction });
      running = sync({ apply: true, now });
      await entered;
      await transaction.commitTransaction();
      expect((await running).report[0]).toMatchObject({ toUpdate: 1, modified: 0 });
      expect((await UserCoupon.findOne({ id: 'uncommitted' }).lean()).discountFen).toBe(1000);
    } finally {
      if (transaction.inTransaction()) await transaction.abortTransaction();
      await transaction.endSession();
      if (running) await running;
    }
  });

  test('an aborted reservation lets the waiting synchronization update the coupon', async () => {
    await coupon('aborted');
    const transaction = await mongoose.startSession();
    transaction.startTransaction();
    let writing;
    const entered = new Promise(resolve => { writing = resolve; });
    const original = UserCoupon.updateMany;
    jest.spyOn(UserCoupon, 'updateMany').mockImplementationOnce(function (...args) {
      const result = original.apply(this, args).exec();
      writing();
      return result;
    });
    let running;
    try {
      await UserCoupon.findOneAndUpdate({ id: 'aborted' }, { $set: { reservedBookingId: 'aborted-booking' } }, { session: transaction });
      running = sync({ apply: true, now });
      await entered;
      await transaction.abortTransaction();
      expect((await running).report[0]).toMatchObject({ toUpdate: 1, modified: 1 });
      expect((await UserCoupon.findOne({ id: 'aborted' }).lean()).discountFen).toBe(1500);
    } finally {
      if (transaction.inTransaction()) await transaction.abortTransaction();
      await transaction.endSession();
      if (running) await running;
    }
  });
});
