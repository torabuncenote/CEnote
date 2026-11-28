// 申し送りの自動繰越（carryOverMemos）の試験。index.html から該当部分だけを取り出して動かす。
// 実行: node .github/scripts/memo-carry-test.mjs
// 守ること：開いたまま日付をまたいだ端末の手元のデータが古くても、他の人が付けた返事を消さない。
import fs from 'fs'; import vm from 'vm'; import assert from 'assert';
import { fileURLToPath } from 'url'; import path from 'path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const A = '/* ===== 申し送りの自動繰り越し =====', B = 'function fmtTS(ts)';
const ia = html.indexOf(A), ib = html.indexOf(B);
assert.ok(ia > 0 && ib > ia, '繰越の部分が index.html に見つかりません');
const clone = o => JSON.parse(JSON.stringify(o));
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; };

const YDAY = '2026-11-23', TODAY = '2026-11-24';
const memo = (replies) => ({ ts: 100, uid: 'u1', name: 'A', text: '機器の申し送り', carry: true, done: false, replies });
const R1 = { r1: { uid: 'u2', name: 'B', text: '了解', ts: 200 } };
const R12 = Object.assign({}, R1, { r2: { uid: 'u3', name: 'C', text: '対応しました', ts: 300 } });

// サーバー（/data/pages）と端末を1組つくる。saveD は「受信した時点の値」と違うページだけを送る（差分保存と同じ）。
function setup({ server, local, connected }) {
  const srv = { pages: clone(server) };
  const base = clone(local);           // 端末が最後に受信した値（_syncBase に当たる）
  const queued = [];                   // つながっていない間に積まれた書き込み
  const ctx = {
    D: { pages: clone(local) }, _viewMode: 'ce', FB_ON: true, _fbDataLoaded: true, _fbConnected: connected,
    curDs: '', _savePageQueue: {}, _saveWriting: false, _savePending: false, _savePageWriting: false,
    toDS: () => TODAY,
    normArr: v => Array.isArray(v) ? v.filter(Boolean) : (v && typeof v === 'object' ? Object.keys(v).map(k => v[k]).filter(Boolean) : []),
    memoKeyOf: m => String(m && m.ts || 0) + '_' + String((m && m.uid) || ''),
    writeLog() {}, fmtJ: s => s, renderCal() {}, safeRenderPage() {}, updateCloseBar() {}, toast() {},
    escH: s => s, can: () => true, console, setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref(); return t; }, clearTimeout,
    saveD() {
      const out = {};
      Object.keys(ctx.D.pages).forEach(ds => {
        if (JSON.stringify(ctx.D.pages[ds]) !== JSON.stringify(base[ds])) { out[ds] = clone(ctx.D.pages[ds]); base[ds] = clone(ctx.D.pages[ds]); }
      });
      if (ctx._fbConnected) Object.assign(srv.pages, out); else queued.push(out);
    },
    fbDB: {
      ref(p) {
        return {
          get() {
            if (!ctx._fbConnected) return Promise.reject(new Error('offline'));
            const ds = p.replace('/data/pages/', '');
            const v = srv.pages[ds];
            return Promise.resolve({ val: () => (v === undefined ? null : clone(v)), exists: () => v !== undefined });
          }
        };
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(ia, ib), ctx);
  const reconnect = () => { ctx._fbConnected = true; queued.forEach(o => Object.assign(srv.pages, o)); queued.length = 0; };
  // 日付をまたいだときの入口（無ければ以前の直接呼び出し）
  const dayChange = () => ctx.memoCarryOnDayChange ? ctx.memoCarryOnDayChange() : (ctx.carryOverMemos(), Promise.resolve());
  return { ctx, srv, reconnect, dayChange };
}
const allReplies = srv => {
  const out = [];
  Object.keys(srv.pages).forEach(ds => (srv.pages[ds].memos || []).forEach(m => Object.keys(m.replies || {}).forEach(k => out.push(ds + ':' + k))));
  return out.sort();
};

// 1. つながっていない端末（スマホを閉じていた等）が古いデータのまま日付をまたぐ
{
  const server = { [YDAY]: { memos: [memo(R12)] }, [TODAY]: { memos: [] } };
  const local  = { [YDAY]: { memos: [memo(R1)] },  [TODAY]: { memos: [] } };
  const t = setup({ server, local, connected: false });
  await t.dayChange();
  t.reconnect();
  ok(allReplies(t.srv).some(k => k.endsWith(':r2')), '1. オフラインの古い端末の繰越で返事 r2 が消えた：' + JSON.stringify(allReplies(t.srv)));
}

// 2. つながってはいるが、受信が追いついていない端末
{
  const server = { [YDAY]: { memos: [memo(R12)] }, [TODAY]: { memos: [] } };
  const local  = { [YDAY]: { memos: [memo(R1)] },  [TODAY]: { memos: [] } };
  const t = setup({ server, local, connected: true });
  await t.dayChange();
  const reps = allReplies(t.srv);
  ok(reps.includes(TODAY + ':r1') && reps.includes(TODAY + ':r2'), '2. 受信が遅れた端末の繰越で返事が欠けた：' + JSON.stringify(reps));
  ok((t.srv.pages[YDAY].memos || []).length === 0, '2. 元の日に申し送りが残った');
  ok(t.srv.pages[YDAY].memoCarry && t.srv.pages[YDAY].memoCarry['100_u1'].to === TODAY, '2. 元の日に「→繰越」の記録が無い');
}

// 3. 手元が最新なら、これまでどおり返事ごと移る
{
  const server = { [YDAY]: { memos: [memo(R12)] }, [TODAY]: { memos: [] } };
  const t = setup({ server, local: server, connected: true });
  await t.dayChange();
  ok(JSON.stringify(allReplies(t.srv)) === JSON.stringify([TODAY + ':r1', TODAY + ':r2']), '3. 返事ごと移っていない：' + JSON.stringify(allReplies(t.srv)));
}

// 4. つながっていない間に日付をまたいだ端末は、つながってから繰り越す
{
  const server = { [YDAY]: { memos: [memo(R12)] }, [TODAY]: { memos: [] } };
  const t = setup({ server, local: server, connected: false });
  await t.dayChange();
  t.reconnect();
  await t.dayChange();
  ok((t.srv.pages[TODAY].memos || []).length === 1, '4. つながった後に繰り越されていない');
}

// 5. 2回目以降の繰越：「→繰越」の記録を書く最初の日のページも読み直す（そこに付いた他の人の返事を消さない）
{
  const FIRST = '2026-11-20';
  const carried = Object.assign(memo(R1), { origDs: FIRST, lastMove: 'carry' });
  const other = (r) => ({ ts: 50, uid: 'u9', name: 'D', text: '別の申し送り', done: false, replies: r });
  const server = { [FIRST]: { memos: [other(R12)], memoCarry: { '100_u1': { to: YDAY } } }, [YDAY]: { memos: [carried] }, [TODAY]: { memos: [] } };
  const local  = { [FIRST]: { memos: [other(R1)],  memoCarry: { '100_u1': { to: YDAY } } }, [YDAY]: { memos: [carried] }, [TODAY]: { memos: [] } };
  const t = setup({ server, local, connected: true });
  await t.dayChange();
  ok(allReplies(t.srv).includes(FIRST + ':r2'), '5. 最初の日の別の申し送りの返事 r2 が消えた：' + JSON.stringify(allReplies(t.srv)));
  ok(t.srv.pages[FIRST].memoCarry['100_u1'].to === TODAY, '5. 最初の日の記録の行き先が今日になっていない');
}

console.log('OK ' + pass + '件');
