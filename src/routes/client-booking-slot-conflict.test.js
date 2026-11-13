const assert = require('node:assert/strict');
const test = require('node:test');
const registerClientBookingRoutes = require('./client-bookings');

// 与所选时间有关的下单拒绝都带 BOOKING_SLOT_UNAVAILABLE 和中文说明，客户端据此引导用户重新选择时间；
// 其他拒绝（店铺下架、预约数上限等）不带这个代码。请求结构与线上小程序一致。
function createRoute(overrides = {}) {
  const routes = new Map();
  const app = {
    get() {}, patch() {}, delete() {}, use() {},
    post(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const session = { async withTransaction(work) { await work(); }, async endSession() {} };
  const state = {
    salonStatus: 'online', closed: false, sameDayBlocked: false, outsideHours: false,
    conflict: false, staffUnavailable: false, duplicateOnReserve: false, duplicateOnSave: false, ...overrides,
  };
  const bookings = [];
  class Booking {
    constructor(value) { Object.assign(this, value); }
    async save() {
      if (state.duplicateOnSave) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      bookings.push(this);
    }
    static findOne({ userId, clientRequestId }) {
      const query = {
        session: () => query,
        async lean() {
          return bookings.find(booking => booking.userId === userId && booking.clientRequestId === clientRequestId);
        },
      };
      return query;
    }
    static async exists() { return false; }
    static countDocuments() { return { async session() { return 0; } }; }
  }
  registerClientBookingRoutes(app, {
    AnalyticsEvent: { async updateOne() {} },
    Booking,
    BookingMessage: { async create(...args) { return args[0]; } },
    UserCoupon: { async findOneAndUpdate() { return null; } },
    SlotOccupancy: {
      async updateOne() {
        if (state.duplicateOnReserve) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      },
    },
    Salon: { async updateOne() { return { matchedCount: 1 }; } },
    mongoose: { async startSession() { return session; } },
    crypto: { randomInt() { return 12345678; } },
    normalizeUserId: (value) => value,
    userIdAliases: (value) => [value],
    getStaffById() {
      return { async lean() { return { id: 'staff-1', name: 'Stylist', extraServiceFeeFen: 0 }; } };
    },
    getSalonByStaffId() {
      return {
        async lean() {
          return {
            id: 'salon-1', name: 'Salon', publishStatus: state.salonStatus, openingHours: '09:00-22:00',
            services: [{ id: 'service-1', name: 'Cut', tagIds: [], priceFen: 12000, durationMinutes: 60 }],
          };
        },
      };
    },
    parseOpeningHours: () => (state.outsideHours ? { start: 0, end: 0 } : { start: 0, end: 24 * 60 }),
    async findActiveBookingAtTime() { return state.conflict ? { id: 'other' } : null; },
    async isStaffUnavailable() { return state.staffUnavailable; },
    isSalonClosedOnDate: () => state.closed,
    isSameDayBookingBlocked: () => state.sameDayBlocked,
    async getUserPolicy() { return { isBlacklisted: false }; },
    couponDiscountForOrder: () => null,
    normalizeBooking: (value) => value,
    broadcastBookingEvent() {},
    INPUT_LIMITS: { note: 500 },
    rateLimits: { login: [], booking: [], merchantBooking: [], publicRead: [], upload: [] },
  });
  return routes.get('/api/bookings');
}

async function submit(route, startTime = '2030-01-01T10:00:00.000+08:00', overrides = {}, userId = 'user-1') {
  let status = 200;
  let body;
  await route(
    {
      clientUser: { id: userId, displayName: 'User' },
      body: {
        salonId: 'salon-1', staffId: 'staff-1', serviceId: 'service-1', startTime,
        expectedOriginalAmountFen: 12000, expectedPayableAmountFen: 12000, ...overrides,
      },
    },
    { status(value) { status = value; return this; }, json(value) { body = value; } },
  );
  return { status, body };
}

const slotCases = [
  ['a past time', {}, '2020-01-01T10:00:00.000+08:00'],
  ['a salon rest day', { closed: true }],
  ['a same-day booking the salon does not accept', { sameDayBlocked: true }],
  ['a time outside opening hours', { outsideHours: true }],
  ['a slot that already has a booking', { conflict: true }],
  ['a stylist unavailable at that time', { staffUnavailable: true }],
  ['a slot taken by a concurrent booking', { duplicateOnReserve: true }],
];

for (const [name, overrides, startTime] of slotCases) {
  test(`${name} is rejected with BOOKING_SLOT_UNAVAILABLE and a Chinese message`, async () => {
    const { status, body } = await submit(createRoute(overrides), startTime);
    assert.equal(status, 409);
    assert.equal(body.code, 'BOOKING_SLOT_UNAVAILABLE');
    assert.match(body.message, /[一-鿿]/);
  });
}

test('rejections unrelated to the chosen time keep their existing shape', async () => {
  const { status, body } = await submit(createRoute({ salonStatus: 'offline' }));
  assert.equal(status, 409);
  assert.equal(body.code, undefined);
  assert.match(body.message, /下架/);
});

test('an available slot is still booked', async () => {
  const { status, body } = await submit(createRoute());
  assert.equal(status, 201);
  assert.equal(body.code, undefined);
});

test('a duplicate booking ID is propagated instead of asking the user to select another time', async () => {
  await assert.rejects(submit(createRoute({ duplicateOnSave: true })), { code: 11000 });
});


test('a successful booking is replayed for its owner before rechecking availability', async () => {
  const route = createRoute();
  const data = { clientRequestId: 'confirm-1' };
  const first = await submit(route, undefined, data);
  assert.equal(first.status, 201);
  const replay = await submit(route, '2020-01-01T10:00:00+08:00', data);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.equal((await submit(route, undefined, data, 'user-2')).status, 201);
});

test('a rejected price or slot does not consume the request ID', async () => {
  const route = createRoute();
  const data = { clientRequestId: 'confirm-2' };
  assert.equal((await submit(route, undefined, { ...data, expectedPayableAmountFen: 1 })).body.code, 'BOOKING_PRICE_CHANGED');
  assert.equal((await submit(route, '2020-01-01T10:00:00+08:00', data)).body.code, 'BOOKING_SLOT_UNAVAILABLE');
  assert.equal((await submit(route, undefined, data)).status, 201);
});

test('legacy clients can omit the ID, but an invalid ID is rejected', async () => {
  const route = createRoute();
  assert.equal((await submit(route, undefined, { clientRequestId: { $ne: '' } })).status, 400);
  assert.equal((await submit(route)).status, 201);
  assert.equal((await submit(route)).status, 201);
});
