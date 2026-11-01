#!/usr/bin/env node
/* 本番の改善要望・エラー記録を「読むだけ」で見るための確認コマンド（Claude が要望の意味を理解するため）。
   使い方：
     node tools/peek.mjs feedback        … 未完了（見送り・対応済み以外）の改善要望
     node tools/peek.mjs feedback --all  … すべての改善要望
     node tools/peek.mjs errors          … 職員の端末で起きたエラー（同じものはまとめて件数を出す）
   ・Firebase CLI（firebase database:get）でログイン中のアカウントの権限で読む。書き込みは一切しない。
   ・職員の名前は出さない（記名／匿名だけ）。添付の写真は「写真あり」とだけ出す。
   ・管理者メモ（/feedbackMemo）も一緒に出す。 */
import { execFileSync } from 'child_process';

const PROJECT = 'torabunce-ce814';
const STATUS = { new: '未確認', seen: '確認済み', plan: '対応予定', done: '対応済み', skip: '見送り' };
const KIND = { bug: '不具合', hard: '使いにくい', want: 'ほしい機能', how: '使い方', etc: 'その他' };
const LEVEL = { low: 'いつでもよい', mid: '困っている', high: '業務に支障' };

function get(path) {
  try {
    const out = execFileSync('firebase', ['database:get', path, '--project', PROJECT], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out || 'null') || {};
  } catch (e) {
    console.error('読み込めませんでした: ' + path + '\n' + String(e.stderr || e.message).trim());
    process.exit(1);
  }
}
const fmt = ts => {
  if (!ts) return '';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function feedback(all) {
  const fb = get('/feedback'), memo = get('/feedbackMemo');
  const rows = Object.entries(fb).map(([id, r]) => ({ id, ...r })).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const list = all ? rows : rows.filter(r => !['done', 'skip'].includes(r.status || 'new'));
  console.log(`改善要望 ${list.length} 件（全 ${rows.length} 件中、${all ? 'すべて' : '未完了だけ'}）\n`);
  list.forEach((r, i) => {
    console.log(`#${i + 1} ${fmt(r.ts)}  [${KIND[r.kind] || r.kind || '?'} / ${r.area || ''} / ${LEVEL[r.level] || ''}]  状態:${STATUS[r.status || 'new'] || r.status}  ${r.anon ? '匿名' : '記名'}${r.img ? '・写真あり' : ''}`);
    console.log(`   版 ${r.ver || '?'}・${r.dev || ''}`);
    String(r.text || '').split('\n').forEach(l => console.log('   ' + l));
    const cs = Object.values(r.comments || {}).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    cs.forEach(c => console.log(`   └ ${c.by === 'admin' ? '管理者' : '本人'}（${fmt(c.ts)}）: ${String(c.text || '').replace(/\n/g, ' / ')}`));
    const m = memo[r.id] || r.memo;
    if (m) console.log(`   ✎ 管理者メモ: ${m}`);
    console.log('');
  });
}

function errors() {
  const el = get('/errLogs');
  const rows = Object.values(el);
  const groups = {};
  rows.forEach(r => {
    const k = `${r.msg}|${r.src}|${r.line}`;
    const g = groups[k] || (groups[k] = { msg: r.msg, src: r.src, line: r.line, col: r.col, n: 0, last: 0, vers: new Set(), devs: new Set(), wheres: new Set(), stack: '' });
    g.n++; if ((r.ts || 0) > g.last) { g.last = r.ts || 0; g.stack = r.stack || g.stack; }
    if (r.ver) g.vers.add(r.ver); if (r.dev) g.devs.add(r.dev); if (r.where) g.wheres.add(r.where);
  });
  const list = Object.values(groups).sort((a, b) => b.last - a.last);
  console.log(`エラー記録 ${rows.length} 件（${list.length} 種類）\n`);
  list.forEach((g, i) => {
    console.log(`#${i + 1} ${g.n}回・最後 ${fmt(g.last)}  ${g.src || '?'}:${g.line || 0}:${g.col || 0}`);
    console.log(`   ${g.msg}`);
    console.log(`   版: ${[...g.vers].join(', ')}  端末: ${[...g.devs].join(', ')}  画面: ${[...g.wheres].join(', ')}`);
    if (g.stack) g.stack.split('\n').slice(0, 6).forEach(l => console.log('   | ' + l.trim()));
    console.log('');
  });
}

const [cmd, opt] = process.argv.slice(2);
if (cmd === 'feedback') feedback(opt === '--all');
else if (cmd === 'errors') errors();
else { console.log('使い方: node tools/peek.mjs feedback [--all] | errors'); process.exit(1); }
