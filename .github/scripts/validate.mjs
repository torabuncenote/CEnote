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

/* ===== 結果 ===== */
if (failed) {
  console.error('\n❌ ' + failed + ' 件の問題が見つかりました');
  process.exit(1);
} else {
  console.log('\n✅ すべてのチェックを通過しました');
}
