const crypto = require('crypto');
const { promisify } = require('util');

const pbkdf2 = promisify(crypto.pbkdf2);
const dummyCredentials = {
  passwordSalt: crypto.randomBytes(16).toString('hex'),
  passwordHash: crypto.randomBytes(32).toString('hex'),
};

const hashPassword = async (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt,
  hash: (await pbkdf2(String(password), salt, 120000, 32, 'sha256')).toString('hex'),
});

const timingSafeEqualHex = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ''), 'hex');
  const rightBuffer = Buffer.from(String(right || ''), 'hex');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const verifyPassword = async (password, user) => {
  const { passwordSalt, passwordHash } = user ?? dummyCredentials;
  const currentHash = (await hashPassword(password, passwordSalt)).hash;
  const matches = timingSafeEqualHex(currentHash, passwordHash);
  return Boolean(user) && matches;
};

const newPasswordRule = '密码至少 10 位，且包含英文字母和数字';
const hasPasswordLettersAndDigits = password => /[A-Za-z]/.test(password) && /[0-9]/.test(password);
const isValidNewPassword = password => password.length >= 10 && hasPasswordLettersAndDigits(password);

module.exports = { hashPassword, verifyPassword, newPasswordRule, hasPasswordLettersAndDigits, isValidNewPassword };
