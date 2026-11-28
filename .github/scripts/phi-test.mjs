// 患者情報の判定（detectPHI）の試験。index.html から該当部分だけを取り出して動かす。
// 実行: node .github/scripts/phi-test.mjs
// 守ること：本物の氏名は赤（送信できない）か黄（確認）にする。普通の言葉で赤にしない（2026-11-29「原因不明」で送信できなかった）。
import fs from 'fs'; import vm from 'vm'; import assert from 'assert';
import { fileURLToPath } from 'url'; import path from 'path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const h = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const grab = (name) => { const i = h.indexOf(name); assert.ok(i > 0, name + ' が見つかりません'); let d = 0; const j = h.indexOf('{', i); for (let k = j; k < h.length; k++) { if (h[k] === '{') d++; else if (h[k] === '}') { d--; if (!d) return h.slice(i, k + 1); } } };
const a = h.indexOf('var PHI_PATTERNS'), b = h.indexOf('return { surnames:surnames };', a);
const e1 = h.indexOf('var PHI_EXCLUDE_WORDS'), e2 = h.indexOf('function phiIsExcludedCompound');
assert.ok(a > 0 && b > a && e1 > 0 && e2 > e1, '判定の部分が index.html に見つかりません');
const src = h.slice(a, b) + 'return { surnames:surnames };})();\n' + h.slice(e1, e2) + grab('function phiIsExcludedCompound') + '\n' + grab('function detectPHI') + '\n' + grab('function phiHasBlock');
const ctx = { D: { stf: ['原 一郎', '林 実'] } }; vm.createContext(ctx); vm.runInContext(src, ctx);
const cases = [
  ['レギュラーPtの補液量が何故かFNで1日のみ変更になっていた事例がありました。原因不明。他でも起きないかタイムアウトの際しばらく注意して下さい。', 'none'],
  ['原則として原液で', 'none'], ['原理を説明', 'none'],
  ['原太郎さんの透析', 'red'], ['患者は原田花子', 'red'], ['林花子の件', 'red'],
  ['原一郎が対応、山田太郎の件', 'red'],      // 職員の名前の後ろにある患者名も見つける
  ['田中先生に確認', 'yellow'], ['原因は林さんの件', 'yellow'],
  ['患者ID 12345678', 'red'],
];
let pass = 0;
for (const [t, exp] of cases) {
  const r = ctx.detectPHI(t), got = r.red.length ? 'red' : r.yellow.length ? 'yellow' : 'none';
  assert.equal(got, exp, '「' + t + '」は ' + exp + ' のはずが ' + got + '：' + JSON.stringify(r)); pass++;
}
assert.ok(!ctx.phiHasBlock(ctx.detectPHI('田中先生に確認')), '医師への連絡が送信できなくなっている');
console.log('OK ' + pass + '件');
