import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync('index.html', 'utf8');
const finalRules = JSON.parse(readFileSync('database.rules.json', 'utf8')).rules;
const prepRules = JSON.parse(readFileSync('database.rules.prepare.json', 'utf8')).rules;
const storage = readFileSync('storage.rules', 'utf8');
const admin = "auth != null && root.child('admins').child(auth.uid).val() === true";

assert.equal(finalRules.data['.write'], admin, 'whole D must be admin-only');
const ADM = "root.child('admins').child(auth.uid).val() === true", ACC = "root.child('access').child(auth.uid).val() === true";
const KEY = "$date.matches(/^\\d{4}-\\d{2}-\\d{2}_\\d{2}$/)";
assert.deepEqual(finalRules.backup_meta, { '.read': admin, $date: {
  '.write': `auth != null && (${ADM} || (${ACC} && !data.exists() && newData.exists()))`,
  '.validate': `${KEY} && newData.child('uid').val() === auth.uid && newData.child('ts').val() === now && newData.child('admin').val() === (${ADM})` } });
assert.deepEqual(finalRules.backups, { '.read': admin, $date: {
  '.write': `auth != null && (${ADM} || (${ACC} && !data.exists() && newData.exists() && root.child('backup_meta').child($date).child('uid').val() === auth.uid))`,
  '.validate': KEY } });
assert.deepEqual(finalRules.recent_backup, { '.read': admin, '.write': admin }, 'shared recent backup must be admin-only');
/* 画像は1枚ずつ：一覧（/media 全体）は誰も読めない、作るのは本人名義で新規だけ、消せるのは本人と管理者 */
assert.equal(finalRules.media['.read'], undefined, 'no bulk read of /media');
assert.equal(finalRules.media['.write'], undefined, 'no write grant above /media/$id');
assert.ok(finalRules.media.$id['.write'].includes("newData.child('by').val() === auth.uid") && finalRules.media.$id['.write'].includes("data.child('by').val() === auth.uid"));
assert.ok(prepRules.media && !prepRules.media['.read'], 'preparation rules must allow /media per item');
assert.deepEqual(finalRules.recent_backup_staff, { '.read': admin, $uid: { '.write': `auth != null && auth.uid === $uid && ${ACC}`, '.validate': "newData.hasChild('pages')" } });
/* ルート直下に書き込み許可が無いこと（下の階層の制限を全部打ち消すため） */
assert.equal(finalRules['.write'], undefined, 'no root write grant');
for (const k of ['backups', 'backup_meta', 'recent_backup_staff']) assert.equal(finalRules[k]['.write'], undefined, `${k}: no write grant above the per-key rule`);
/* ロック判定は「!val()」ではなく「val() !== true」（! は真偽値にしか使えず、ルール全体が文法エラーになる——9/28版で実際に公開できなかった） */
assert.ok(!JSON.stringify(finalRules).includes("(!root.child('data').child('lk')"), 'lock checks must use !== true');
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
