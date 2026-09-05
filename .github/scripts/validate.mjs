/*
 * CEnote 軽量バリデーション
 * - index.html 内のインラインJSの構文チェック（構文エラー＝全停止を防ぐ）
 * - マージ競合マーカーの残留チェック
 * - manifest.json / sw.js の妥当性チェック
 * ビルドも依存パッケージも不要。Node 標準機能のみで動く。
 */
import { readFileSync, existsSync } from 'node:fs';

let failed = 0;
function ok(msg)   { console.log('  ✓ ' + msg); }
function fail(msg) { console.error('  ✗ ' + msg); failed++; }

/* ===== 1. index.html ===== */
const htmlPath = 'index.html';
if (!existsSync(htmlPath)) {
  fail('index.html が見つかりません');
} else {
  const html = readFileSync(htmlPath, 'utf8');

  /* --- 競合マーカー残留チェック --- */
  const markers = html.match(/^(<{7}|={7}|>{7})/gm);
  if (markers) fail('マージ競合マーカーが残っています (' + markers.length + '箇所)');
  else ok('マージ競合マーカーなし');

  /* --- インラインJSの構文チェック --- */
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!scripts.length) {
    fail('インライン <script> が見つかりません');
  } else {
    const main = scripts.sort((a, b) => b.length - a.length)[0];
    try {
      new Function(main); // パースのみ。実行はしない
      ok('インラインJS構文OK (' + main.length + ' 文字)');
    } catch (e) {
      fail('インラインJS構文エラー: ' + e.message);
    }
  }
}

/* ===== 2. manifest.json ===== */
if (existsSync('manifest.json')) {
  try {
    const m = JSON.parse(readFileSync('manifest.json', 'utf8'));
    if (!m.name || !m.icons) fail('manifest.json に name / icons がありません');
    else ok('manifest.json 妥当');
  } catch (e) {
    fail('manifest.json が不正なJSON: ' + e.message);
  }
}

/* ===== 3. sw.js ===== */
if (existsSync('sw.js')) {
  try {
    new Function(readFileSync('sw.js', 'utf8'));
    ok('sw.js 構文OK');
  } catch (e) {
    fail('sw.js 構文エラー: ' + e.message);
  }
}

/* ===== 4. CLAUDE.md の規約チェック =====
 * 構文エラーは new Function() で捕まるが、規約違反は捕まらない。
 * CLAUDE.md に「〜すること」と書いただけの決まりは、破っても誰も気づかないまま本番に出る
 * （実際に「復元キー配列の1本だけ更新漏れ → 12設定が復元されない」事故が起きている）。
 * 機械的に判定できる規約だけをここで落とす。判定は保守的に——誤検知でCIを赤くしない。 */
if (existsSync(htmlPath)) {
  const H = readFileSync(htmlPath, 'utf8');
  const seg = (from, len) => { const i = H.indexOf(from); return i === -1 ? '' : H.slice(i, i + len); };

  /* --- 4-1. D のプロパティは5箇所すべてに登録する --- */
  const dm = H.match(/^var D = \{([\s\S]*?)\};$/m);
  if (!dm) fail('var D = {...} の初期化が見つかりません');
  else {
    /* ネストしたオブジェクトのキー（autoDelCfg の中身など）は対象外 */
    const NESTED = new Set(['enabled','period','interval','lastClean','cats','list','ceEdu','ward','device','hd']);
    const props = [...dm[1].matchAll(/([a-zA-Z_]\w*)\s*:/g)].map(m => m[1]).filter(p => !NESTED.has(p));
    const loadD    = seg('function loadD()', 4000);
    const listener = seg('D.pages = d.pages', 4000);
    const logout   = seg('D.pages={}; D.stf=[]', 1600);
    const arrays   = [...H.matchAll(/\[\s*'pages','stf','phs'[\s\S]*?\]\.forEach/g)].map(m => m[0]);
    let miss = 0;
    props.forEach(p => {
      const where = [];
      if (!new RegExp(`D\\.${p}\\s*=`).test(loadD))    where.push('loadD');
      if (!new RegExp(`D\\.${p}\\s*=`).test(listener)) where.push('/dataリスナー');
      if (!new RegExp(`D\\.${p}\\s*=`).test(logout))   where.push('ログアウトリセット');
      arrays.forEach((a, i) => { if (!a.includes(`'${p}'`)) where.push(`復元配列${i + 1}`); });
      if (where.length) { fail(`D.${p} が未登録: ${where.join(' / ')}`); miss++; }
    });
    if (arrays.length !== 3) fail(`バックアップ復元のキー配列が3本ではありません（${arrays.length}本）`);
    else {
      const n = arrays.map(a => a.replace(/\s+/g, ''));
      if (n[0] !== n[1] || n[1] !== n[2]) fail('復元キー配列3本の中身が食い違っています（importBackup の更新漏れが再発）');
      else if (!miss) ok(`D の5箇所ルールOK（${props.length}プロパティ / 復元配列3本一致）`);
    }
  }

  /* --- 4-2. 権限判定は can() を使う（lk()&&!isAdmin は per-user 付与を無視する） --- */
  const lkDirect = [...H.matchAll(/lk\(['"][a-z_]+['"]\)\s*&&\s*!\s*isAdmin/g)];
  if (lkDirect.length) fail(`lk()&&!isAdmin での権限判定が${lkDirect.length}箇所（can() を使うこと）`);
  else ok('権限判定は can() 経由');

  /* --- 4-3. 到達度の項目キーは eduKey() で作る（禁止文字と同名術式の両方を吸収する） --- */
  const rawKey = [...H.matchAll(/.*(?:catId|cat\.id)\s*\+\s*['"]:['"]\s*\+.*/g)]
    .map(m => m[0]).filter(l => !l.includes('function eduKey') && !l.includes('parts.join'));
  if (rawKey.length) fail(`到達度キーの直接連結が${rawKey.length}件（eduKey() を通すこと）`);
  else ok('到達度キーは eduKey() 経由');

  /* --- 4-4. サブタブは印刷CSSにも登録する（漏れると印刷が白紙になる） --- */
  const subIds  = [...H.matchAll(/id="subpane-(\w+)"/g)].map(m => m[1]);
  const printed = [...H.matchAll(/data-print-sub="(\w+)"/g)].map(m => m[1]);
  const noPrint = subIds.filter(id => !printed.includes(id));
  if (noPrint.length) fail(`印刷CSSに未登録のサブタブ: ${noPrint.join(', ')}`);
  else ok(`サブタブの印刷CSS対応OK（${subIds.length}件）`);

  /* --- 4-6. CLAUDE.md が参照する関数が実在するか ---
     CLAUDE.md は「どれが正本の入口か」を示す索引でもあるので、消した関数の名前が
     残っていると、次に読む人（や別のエージェント）が存在しない関数を呼びに行く。
     実際に updatePendingBadge() が、同じ文書の別の節に「バッジごと削除した」と
     書いてあるのに Key Functions 表だけ残っていた。
     「削除済み」と本文で明記している名前は対象外にするため、除外リストを持つ。 */
  if (existsSync('CLAUDE.md')) {
    const MD = readFileSync('CLAUDE.md', 'utf8');
    /* JSの組み込み・DOM API・「もう無いことの記録」として意図的に残している名前 */
    const IGNORE = new Set([
      'confirm', 'alert', 'prompt', 'set', 'get', 'parseInt', 'push', 'map', 'filter',
      'addEventListener', 'querySelector', 'scrollIntoView', 'scrollTo', 'splice',
      /* 以下は「もう無いこと」自体を記録するために本文が名前を挙げているもの。
         消したという事実は残す価値があるので、名前ごと消させない。 */
      'poolHiddenReason',  /* 配置盤の導入で削除済み */
      'updatePendingBadge' /* メディア承認フローの廃止で削除済み。このチェックを入れた発端 */
    ]);
    const names = new Set();
    for (const m of MD.matchAll(/`([a-zA-Z_][a-zA-Z0-9_]*)\(\)`/g)) names.add(m[1]);
    for (const row of MD.matchAll(/^\|\s*`([^`]+)`/gm))
      for (const f of row[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) names.add(f[1]);
    const ghosts = [...names].filter(n =>
      !IGNORE.has(n) && !new RegExp('\\bfunction ' + n + '\\s*\\(').test(H));
    if (ghosts.length) fail(`CLAUDE.md が存在しない関数を参照: ${ghosts.join(', ')}`);
    else ok(`CLAUDE.md の関数参照OK（${names.size}件）`);
  }

  /* --- 4-5. マスタタブのセクションはグループ(.mgrp-body)の中に置く（外に置くと画面に出ない） --- */
  const pmStart = H.indexOf('<div id="pane-master"');
  const pmEnd   = H.indexOf('<!-- ロックタブ -->');
  if (pmStart !== -1 && pmEnd > pmStart) {
    const outside = H.slice(pmStart, pmEnd).split('<div class="mgrp"')[0];
    if (/data-perm=/.test(outside)) fail('マスタタブに、どのグループにも入っていないセクションがあります（画面に出ません）');
    else ok('マスタタブのセクションは全てグループ内');
  }
}

/* ===== 結果 ===== */
if (failed) {
  console.error('\n❌ ' + failed + ' 件の問題が見つかりました');
  process.exit(1);
} else {
  console.log('\n✅ すべてのチェックを通過しました');
}
