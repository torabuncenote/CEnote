import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync('index.html', 'utf8');
const finalRules = JSON.parse(readFileSync('database.rules.json', 'utf8')).rules;
const prepRules = JSON.parse(readFileSync('database.rules.prepare.json', 'utf8')).rules;
const storage = readFileSync('storage.rules', 'utf8');
const admin = "auth != null && root.child('admins').child(auth.uid).val() === true";

assert.equal(finalRules.data['.write'], admin, 'whole D must be admin-only');
for (const k of ['backups', 'backup_meta']) {
  assert.equal(finalRules[k]['.read'], admin, `${k} must be readable by admins only`);
  assert.ok(finalRules[k].$date['.write'].includes('!data.exists() && newData.exists()'), `${k}: staff may only create new snapshots`);
}
assert.equal(finalRules.recent_backup['.read'], admin, 'recent backup must be readable by admins only');
assert.ok(finalRules.data['.read'].includes("root.child('access').child(auth.uid)"));
for (const path of ['board', 'tasks', 'robotImg', 'users']) {
  assert.ok(finalRules[path]['.read'].includes("root.child('access').child(auth.uid)"), `${path} must require approval`);
}
assert.equal(prepRules.data['.write'], 'auth != null', 'preparation rules must not interrupt existing writes');
assert.ok(prepRules.access && prepRules.security, 'preparation rules must allow access setup');
assert.ok(storage.includes('request.auth.uid == uid'), 'new uploads must be tied to uploader UID');
assert.ok(!storage.includes('allow read, write: if request.auth != null'), 'no global Storage write');

const start = html.indexOf('var DATA_WRITE_PERM = {');
const end = html.indexOf('/* リトライ付きFirebase書き込み', start);
assert.ok(start >= 0 && end > start);
const source = html.slice(start, end);
const run = new Function('data', 'can', 'currentUser', 'isAdmin', source + '\nreturn regularDataUpdate(data);');
const keys = ['pages/2026-10-18','manual','stf','phs','lk','fcmCfg','emailjsCfg','autoDelCfg','stfNo','shift','dly','wd','makers','eduProgress','supMaster','_appSeq'];
const fixture = Object.fromEntries(keys.map(k => [k, { example: true }]));
const common = run(fixture, () => false, { perms: {} }, false);
assert.ok('pages/2026-10-18' in common && 'manual' in common && '_appSeq' in common);
for (const key of ['stf','phs','lk','fcmCfg','emailjsCfg','autoDelCfg','stfNo','shift','dly','wd','makers','eduProgress','supMaster']) {
  assert.ok(!(key in common), `regular user unexpectedly writes ${key}`);
}
const permitted = run(fixture, () => true, { perms: { perm_edu: true } }, false);
for (const key of Object.keys(permitted)) assert.ok(finalRules.data[key.split('/')[0]]?.['.write'], `no DB write rule for ${key}`);
for (const key of ['dly','wd','makers','eduProgress','supMaster']) assert.ok(key in permitted, `permissioned field missing: ${key}`);
for (const key of ['stf','phs','lk','fcmCfg','emailjsCfg','autoDelCfg','stfNo','shift']) assert.ok(!(key in permitted), `admin-only field leaked: ${key}`);
const adminAll = run(fixture, () => false, { perms: {} }, true);
assert.equal(Object.keys(adminAll).length, keys.length, 'admin must send every changed path');
console.log('Security rule structure and regular-user write selection: OK');
