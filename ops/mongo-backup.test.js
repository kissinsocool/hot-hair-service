const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const script = path.join(__dirname, 'mongo-backup');

test('mongo backup alert: check the latest scheduled window and send over TLS', () => {
  const alert = path.join(__dirname, 'mongo-backup-alert');
  const result = spawnSync('python3', ['-c', `
import datetime, json, os, pathlib, runpy, socket, sys, tempfile
from unittest.mock import patch

alert = runpy.run_path(sys.argv[1])
now = datetime.datetime(2026, 11, 11, 5, tzinfo=datetime.timezone(datetime.timedelta(hours=8)))
with tempfile.TemporaryDirectory() as root:
    marker = pathlib.Path(root) / 'last-success.json'
    assert alert['overdue'](marker, now)
    marker.touch()
    before = (now - datetime.timedelta(hours=2, seconds=1)).timestamp()
    os.utime(str(marker), (before, before))
    assert alert['overdue'](marker, now)
    assert not alert['overdue'](marker, now - datetime.timedelta(minutes=1))
    after = (now - datetime.timedelta(hours=2)).timestamp()
    os.utime(str(marker), (after, after))
    assert not alert['overdue'](marker, now)

    config = pathlib.Path(root) / 'smtp.json'
    config.write_text(json.dumps({'host': 'smtp.example.com', 'port': 587,
                                  'from': 'ops@example.com', 'to': 'ops@example.com',
                                  'password': 'dummy'}))
    config.chmod(0o600)
    with patch('smtplib.SMTP') as connect:
        connect.side_effect = [socket.timeout(), connect.return_value]
        client = connect.return_value.__enter__.return_value
        client.send_message.return_value = {}
        alert['notify'](config, 'Backup failed')
        assert connect.call_count == 2
        assert [call[0] for call in client.method_calls] == ['starttls', 'login', 'send_message']
        assert client.send_message.call_args[0][0]['To'] == 'ops@example.com'
`, alert], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

for (const failure of ['dump', 'missing-oplog', 'upload', 'download', 'corrupt', 'none']) {
  test(`mongo backup: ${failure}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-backup-test-'));
    try {
      const config = path.join(root, 'mongo.yml');
      fs.writeFileSync(config, 'uri: mongodb://127.0.0.1:1\n', { mode: 0o600 });
      const fake = path.join(root, 'fake.py');
      fs.writeFileSync(fake, `#!/usr/bin/env python3
import os,sys,pathlib,shutil
a=sys.argv[1:]; fail=os.environ['FAILURE']; root=pathlib.Path(os.environ['TEST_ROOT'])
if a[0].startswith('--config='):
 assert '--oplog' in a
 if fail=='dump': sys.exit(2)
 d=pathlib.Path(next(x[6:] for x in a if x.startswith('--out=')))
 (d/'sample').mkdir(parents=True)
 (d/'sample'/'items.bson').write_bytes(b'\\x05\\x00\\x00\\x00\\x00')
 if fail!='missing-oplog': (d/'oplog.bson').write_bytes(b'')
else:
 assert a[0]=='cp'
 upload=a[2].startswith('oss://')
 with (root/'calls').open('a') as f: f.write(('upload' if upload else 'download')+'\\n')
 if fail==('upload' if upload else 'download'): sys.exit(3)
 if upload:
  assert '--acl' in a and a[a.index('--acl')+1]=='private'
  shutil.copyfile(a[1],str(root/'remote'))
 elif fail=='corrupt': pathlib.Path(a[2]).write_bytes(b'corrupt')
 else: shutil.copyfile(str(root/'remote'),a[2])
`, { mode: 0o700 });
      const backupDir = path.join(root, 'backups');
      const result = spawnSync('python3', [script], {
        env: { ...process.env, MONGO_BACKUP_CONFIG: config, BACKUP_DIR: backupDir,
          MONGODUMP_BIN: fake, OSSUTIL_BIN: fake, TEST_ROOT: root, FAILURE: failure },
        encoding: 'utf8',
      });
      const retained = fs.readdirSync(backupDir).filter(name => name.startsWith('mongo_backup_'));
      if (failure === 'none') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /SUCCESS/);
        assert.deepEqual(retained, []);
        const record = JSON.parse(fs.readFileSync(path.join(backupDir, 'last-success.json')));
        assert.equal(record.oplog, true);
        assert.match(record.sha256, /^[a-f0-9]{64}$/);
      } else {
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout, /SUCCESS/);
        assert.equal(retained.length, 1);
        assert.equal(fs.existsSync(path.join(backupDir, 'last-success.json')), false);
        if (failure === 'dump' || failure === 'missing-oplog') {
          assert.equal(fs.existsSync(path.join(root, 'calls')), false);
        }
        if (failure === 'upload') {
          assert.equal(fs.readFileSync(path.join(root, 'calls'), 'utf8'), 'upload\n');
        }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('mongo backup: refuse exposed credentials and overlapping runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-backup-lock-'));
  let holder;
  try {
    const config = path.join(root, 'mongo.yml');
    fs.writeFileSync(config, 'uri: mongodb://127.0.0.1:1\n', { mode: 0o644 });
    const backupDir = path.join(root, 'backups');
    const env = { ...process.env, MONGO_BACKUP_CONFIG: config, BACKUP_DIR: backupDir };
    const exposed = spawnSync('python3', [script], { env, encoding: 'utf8' });
    assert.notEqual(exposed.status, 0);
    assert.equal(fs.existsSync(backupDir), false);
    fs.chmodSync(config, 0o600);
    fs.mkdirSync(backupDir);
    holder = spawn('python3', ['-c',
      'import fcntl,sys; f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.read()',
      path.join(backupDir, '.backup.lock')]);
    await once(holder.stdout, 'data');
    const overlapping = spawnSync('python3', [script], { env, encoding: 'utf8' });
    assert.notEqual(overlapping.status, 0);
    assert.match(overlapping.stderr, /BlockingIOError/);
    assert.deepEqual(fs.readdirSync(backupDir), ['.backup.lock']);
  } finally {
    if (holder) { holder.stdin.end(); await once(holder, 'exit'); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
