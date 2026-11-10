const assert = require('node:assert/strict');
const test = require('node:test');
const { readAdminConfig } = require('./create-admin');

test('admin creation requires explicit strong credentials', () => {
  assert.throws(() => readAdminConfig({}), /ADMIN_USERNAME/);
  assert.throws(() => readAdminConfig({ ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'short' }), /12 to 128/);
  assert.throws(() => readAdminConfig({ ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'letters-but-no-digits' }), /letters and digits/);
  assert.deepEqual(
    readAdminConfig({ ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'correct horse battery 7' }),
    { username: 'owner', password: 'correct horse battery 7', displayName: '平台管理员' },
  );
});
