// 災害モードの操作ログ（ofDiffPages / ofApply）の単体試験。index.html から該当部分だけを取り出して動かす。
// 実行: node .github/scripts/oplog-test.mjs
import fs from 'fs'; import vm from 'vm'; import assert from 'assert';
import { fileURLToPath } from 'url'; import path from 'path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const A = '/* ===== 災害モード段3・4：操作ログ（比べる・当てはめる）', B = '/* ===== 災害モード段3：記録（操作ログを端末に残す）';
const ia = html.indexOf(A), ib = html.indexOf(B);
assert.ok(ia > 0 && ib > ia, '操作ログの部分が index.html に見つかりません');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(html.slice(ia, ib), ctx);
const { ofDiffPages, ofApply, ofGet } = ctx;
const clone = o => JSON.parse(JSON.stringify(o));
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; };

// 災害前の控え（オフラインになった時点）
const base = { '2026-10-21': {
  checks: { 0: true },
  memos: [ { ts: 100, uid: 'u1', name: 'A', text: '前からの申し送り', done: false } ],
  duties: { slot_ope: '佐藤', slot_cath: '' },
  tabletLogs: [ { id: 't1', tablet: 'iPad1', borrower: '鈴木', lentAt: 540, returned: false } ],
  ops: { ope_items: [ { _rid: 'a', sel: '胆摘', time: '9:00' } ] },
  ocData: { staff: '', done: false },
  note: 'これは記録しない欄'
} };

// --- 1. 災害モード中の操作（端末側） ---
const off = clone(base);
const p = off['2026-10-21'];
p.checks['2'] = true;                                                            // チェックを付ける
p.memos.push({ ts: 200, uid: 'offline', name: 'B', text: '災害時の申し送り' });      // 申し送りを書く
p.memos[0].done = true;                                                          // 前からの申し送りを済に
p.duties.slot_cath = '高橋';                                                      // 担当を入れる
p.tabletLogs[0].returned = true; p.tabletLogs[0].returnedAt = 600;               // タブレット返却
p.ops.ope_items.push({ _rid: 'b', sel: '虫垂', time: '13:00' });                    // 症例を足す
p.ocData.staff = '伊藤';                                                          // OC担当
p.note = '変えたが記録しない';                                                      // 記録しない欄
const ops = ofDiffPages(base, off);
const fields = ops.map(o => o.path[2]);
ok(!fields.includes('note'), '記録しない欄は操作にならない');
ok(ops.length === 8, '操作の数：' + ops.length + ' ' + JSON.stringify(ops.map(o => o.kind + ':' + o.path.slice(2).map(s => typeof s === 'object' ? s.k : s).join('/'))));
ok(ops.some(o => o.kind === 'add' && o.path[2] === 'memos' && o.after.text === '災害時の申し送り'), '申し送りの追加は「追加」になる');
ok(ops.some(o => o.kind === 'set' && o.path[2] === 'memos' && o.path[4] === 'done'), '既存の申し送りの済は、その件の done だけ');
ok(ops.some(o => o.path[2] === 'checks' && o.path[3] === '2'), 'チェックは項目の位置ごと');

// --- 2. 同じ間にオンライン側で起きていたこと ---
const live = clone(base);
const L = live['2026-10-21'];
L.checks['1'] = true;                                                            // 別のチェック（食い違わない）
L.memos.push({ ts: 150, uid: 'u2', name: 'C', text: 'オンラインの申し送り' });        // 別の申し送り（食い違わない）
L.duties.slot_cath = '田中';                                                      // 同じ枠に別の人（食い違う）
L.ops.ope_items.push({ _rid: 'c', sel: '鼠径', time: '10:00' });                    // 別の症例（食い違わない）

const LIVE = { pages: live };
const res = ops.map(o => ({ o, r: ofApply(LIVE, o) }));
const by = r => res.filter(x => x.r === r).map(x => x.o.path[2]);
ok(by('conflict').length === 1 && by('conflict')[0] === 'duties', '食い違いは同じ担当枠だけ：' + JSON.stringify(by('conflict')));
ok(live['2026-10-21'].checks['1'] === true && live['2026-10-21'].checks['2'] === true, 'チェックは両方残る');
ok(live['2026-10-21'].memos.length === 3, '申し送りは3件（前から・オンライン・災害時）');
ok(live['2026-10-21'].memos.find(m => m.ts === 100).done === true, '前からの申し送りが済になる');
ok(live['2026-10-21'].duties.slot_cath === '田中', '食い違った担当枠は今のまま（管理者が選ぶまで）');
ok(live['2026-10-21'].ops.ope_items.length === 3, '症例は3件');
ok(live['2026-10-21'].tabletLogs[0].returned === true, 'タブレットは返却済みになる');
ok(live['2026-10-21'].ocData.staff === '伊藤', 'OC担当が入る');

// --- 3. もう一度当てはめても増えない（同じ端末で二度取り込んだとき） ---
const again = ops.map(o => ofApply(LIVE, o));
ok(again.filter(r => r === 'applied').length === 0, '二度目は何も変わらない：' + JSON.stringify(again));
ok(live['2026-10-21'].memos.length === 3, '申し送りが二重にならない');

// --- 4. 食い違いを「災害時の記録を採用」 ---
const c = res.find(x => x.r === 'conflict').o;
ok(ofApply(LIVE, c, true) === 'applied' && live['2026-10-21'].duties.slot_cath === '高橋', '採用すると災害時の値になる');

// --- 5. Firebase が配列をオブジェクトで返していても動く ---
const live2 = clone(base); live2['2026-10-21'].memos = { 0: live2['2026-10-21'].memos[0] };
const add = ops.find(o => o.kind === 'add' && o.path[2] === 'memos');
ok(ofApply({ pages: live2 }, add) === 'applied' && Array.isArray(live2['2026-10-21'].memos) && live2['2026-10-21'].memos.length === 2, 'オブジェクト形の配列にも追加できる');

// --- 6. 災害中にページそのものが無かった日（新しい日）も入る ---
const off3 = clone(base); off3['2026-10-22'] = { checks: { 0: true }, memos: [ { ts: 300, uid: 'offline', text: '翌日' } ] };
const ops3 = ofDiffPages(base, off3), live3 = clone(base);
ops3.forEach(o => ofApply({ pages: live3 }, o));
ok(live3['2026-10-22'] && live3['2026-10-22'].memos.length === 1 && live3['2026-10-22'].checks['0'] === true, '新しい日のページもできる');

// --- 7. 削除：オンラインで変えられていれば消さない ---
const off4 = clone(base); off4['2026-10-21'].memos = [];
const del = ofDiffPages(base, off4).find(o => o.kind === 'remove');
const live4 = clone(base); live4['2026-10-21'].memos[0].text = 'オンラインで直した';
ok(ofApply({ pages: live4 }, del) === 'conflict' && live4['2026-10-21'].memos.length === 1, '直された申し送りは消さずに食い違いへ');

// --- 8. 災害中に作った空の日ページ：オンライン側に同じ日があっても食い違わない ---
const off5 = clone(base); off5['2026-10-23'] = { duties: {}, checks: {}, memo: '', ops: {}, ocData: {} };
off5['2026-10-23'].duties.slot_ope = '佐藤';
const ops5 = ofDiffPages(base, off5);
ok(ops5.length === 1 && ops5[0].path.join('/') === 'pages/2026-10-23/duties/slot_ope', '空の欄は操作にならず、入れた枠だけ：' + JSON.stringify(ops5.map(o => o.path.join('/'))));
const live5 = clone(base); live5['2026-10-23'] = { duties: { slot_cath: '田中' }, ocData: { staff: '伊藤' } };
ok(ofApply({ pages: live5 }, ops5[0]) === 'applied' && live5['2026-10-23'].duties.slot_cath === '田中' && live5['2026-10-23'].duties.slot_ope === '佐藤', '別の枠は両方残る');

// --- 9. 人員配置は1人分ずつ。キーの順・空欄の違いは同じとみなす ---
const b9 = { '2026-10-21': { placement: { fixed: true, people: { '佐藤': { side: 'ce', spot: '', offer: '', memo: '' } } } } };
const o9 = clone(b9); o9['2026-10-21'].placement.people['佐藤'].spot = 'off';
const ops9 = ofDiffPages(b9, o9);
ok(ops9.length === 1 && ops9[0].path.length === 6, '1人分で1件：' + JSON.stringify(ops9.map(o => o.path.join('/'))));
const l9 = { pages: { '2026-10-21': { placement: { fixed: true, people: { '佐藤': { side: 'ce' } } } } } };
ok(ofApply(l9, ops9[0]) === 'applied', '空欄が無いだけの受信側にも食い違わずに入る');
ok(ofDiffPages({ x: { duties: { a: '1', b: '2' } } }, { x: { duties: { b: '2', a: '1' } } }).length === 0, 'キーの順だけの違いは操作にならない');

// --- 10. 記録する欄の外・おかしな経路は当てはめない（食い違いの記録はページに置かれ、職員なら書けるため） ---
const R = { pages: {}, lk: {} };
ok(ofApply(R, { kind: 'set', path: ['lk', 'duty'], before: null, after: true }, true) === 'conflict' && !R.lk.duty, 'ページの外は書かない');
ok(ofApply(R, { kind: 'set', path: ['pages', '2026-10-21', 'note'], before: null, after: 'x' }, true) === 'conflict', '記録しない欄は書かない');
ok(ofApply(R, { kind: 'set', path: ['pages', '2026-10-21', 'duties', '__proto__', 'x'], before: null, after: 1 }, true) === 'conflict' && ({}).x === undefined, '__proto__ は通さない');

console.log('すべて通過：' + pass + '件');
