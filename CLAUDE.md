# CENOTE — 分院CE連絡表（開発メモ / CLAUDE.md）

臨床工学部（CE）向けの病院業務管理ツール。連絡表・担当表・日次スケジュール・
業務チェックリスト・申し送りを1ファイルで提供する。

## 全体構成

- **単一ファイル**：`/Users/hirotakaito/Downloads/CENOTE/index.html`（約7,800行、CSS/JS埋め込み）
  - これがアプリ本体。基本的にすべての変更はこの1ファイルに対して行う。
- `index_27.html` … 旧バックアップ（2025-05-31）。簡易diffの基準として使うことがある。
- **GitHubリポジトリ**：`https://github.com/torabuncenote/CEnote`（`gh`未インストールのため `git` コマンドで操作）。
- デプロイ：`git add index.html && git commit -m "メッセージ" && git push` で GitHub Pages に自動反映（数分）。
- 配信：GitHub Pages（`main` ブランチの `index.html` が反映される）。

## 技術スタック

- 素のHTML/CSS/JS（フレームワーク無し）。`var`中心のES5的な書き方で統一。
- **Firebase**：Realtime Database（`/data`）＋ Auth ＋ Storage。未接続時は localStorage（キー`ce2`）にフォールバック。
- **SheetJS（XLSX）**：CDN読み込み済み。Excel勤務表の取り込み／担当表のExcel出力に使用。
- グローバル状態 `D`（オブジェクト）。`saveD()` が `fbDB.ref('/data').set(D)` で**D全体を保存**。
  → Dにキーを足せば自動で永続化されるが、**読み込み側（loadD と /data リスナー）に該当キーの
  復元を必ず追加**しないと次回同期で消える。

## 主要なデータ構造（D 直下）

- `pages` … 連絡表 `{ 'YYYY-MM-DD': { duties, phsNums, dutyNotes, dutyRoles, customDuties,
  ops, ocData, checks, memos, surplus, schedule, schUpdatedBy, schUpdatedAt } }`
  - `duties` … 担当割り当て `{ dutyId: スタッフ名 }`
  - `schedule` … 日次スケジュールのブロック配列
    `{ id, label, staffName, color, startMin, durationMin, note, dutyId }`
- `stf / phs / dly / wd` … スタッフ・PHS・共通業務・曜日別業務
- `opeTree / cathTree / supTree` … 3階層マスタ（科→中カテゴリ→項目）。マスタタブでダブルクリック編集
- `dutyCfgMaster / dutyCfg` … 担当枠マスタ／テンプレート
- `schPresets` … スケジュール「＋ブロック追加」の定番/カスタムプリセット（編集可・共有）
- `shift` … 勤務表 `{ 'YYYY-MM': { 名前: { 日: {shift,oc} } } }`（Excel取り込み）
- `evts / manual / lk` … イベント・業務マニュアル・ロック設定

## 重要な実装規約・落とし穴

- **メイン領域を占有するパネル**：担当表(`pane-assign`) / スケジュール(`pane-schedule`) /
  資料系(`pane-guide,-spec,-manual,-adminm,-dev`) は `.ab` 直下に置き、`swTab()` が
  `#main` の表示/非表示を**中央集約**で制御する。各ブランチで個別に `#main` を出し入れすると
  「半々表示」バグになるので注意（過去に発生・修正済み）。スマホは `position:fixed` 全画面＋戻るボタン。
- **/data リアルタイムリスナー**（`fbInit` 内、`fbDB.ref('/data').on('value')`）：
  - 新しい D のキーを追加したら、このリスナーと `loadD()` の両方に復元行を足す。
  - スケジュール表示中は `buildSchedule(_schDs)` も呼んで再描画する（共有反映）。
  - 保存直後は `_savingTs`（800ms）で再描画を抑制している。
- **`init()` は素で呼ばれ try/catch 無し**（ファイル末尾）。途中で例外を投げると以降の初期化が
  止まる。DOM要素や関数の参照漏れに注意（過去に `in-ope` 等の旧ID参照でクラッシュ→修正済み）。
- 文字列連結でHTML生成。ユーザー入力は `escH()` でエスケープ。
- onclick等のインラインハンドラに値を渡す時は**文字列直挿しを避けインデックス渡し**にする（クォート崩れ防止）。
- D&D並び替えは「`splice(from,1)` 後に `from<to ? to-1 : to` で挿入」する（下方向ドラッグのズレ防止）。
- マルチバイト等で `index.html` 内に `\uXXXX` エスケープ表記の文字列が混在する。Editで
  `old_string` が一致しない時は実ファイルの該当行を Read して正確にコピーする。

## 検証方法（重要）

- ローカルに `node` は無い。**ブラウザ実機で確認**する。
- `file://` は拡張機能のファイルアクセス権限が要るため、**ローカルHTTPで配信して確認**する：
  ```bash
  cd /Users/hirotakaito/Downloads/CENOTE
  python3 -m http.server 8765   # → http://localhost:8765/index.html
  ```
- Chrome拡張「Claude in Chrome」接続時は `mcp__Claude_in_Chrome__*` で操作可能。
  - 注意：`navigate` は `file://` を `https://file://` に壊すので、HTTP配信URLを使う。
  - アプリ起動時にログインモーダル（`#login-ov`, z9999）が出る。背後のUI確認時は一時的に
    `display:none` にして検証し、終わったら戻す。
- 確認観点：起動時コンソールエラー無し → 各機能の関数存在 → 実際のDOM/描画。

## このセッションで実装済みの主な機能

- 担当表のExcel出力（`exportAtExcel`、3シート：担当表/OC集計/担当枠集計）
- 業務チェックリストのサイドパネルにPDF/ファイル格納・閲覧（`renderSPMedia`/`openPDFViewer`）
- ログ刷新（`loadLogs`/`filterLogs`/`_logActionBadge`、検索・ソート）
- 日次スケジュール（タイムテーブル）：`buildSchedule` / `initSchFromDuties`（オペは入室時間に配置、
  それ以外は未配置プール、再生成しても重複しない） / `saveSchData`（最終更新者記録・共有バッジ）
- スケジュール「＋ブロック追加」プリセット：担当マスタ＋定番(`DEF_SCH_PRESETS`)＋編集可能
  （`openSchPresetModal` / `addSchPresetMaster` / `addSchPresetCustom` / `schPresetCustomAdd/Del`）
- CE/OC選択モーダル（`openPoolStaffModal` / `addPoolStaff` 共通化）
- 3階層マスタのダブルクリック編集（`editTreeItem` / `saveTreeItem`）
- 担当カード・オペ/カテ項目のD&D並び替え（`reorderDutyCfg` / `reorderOpsItems`）
- 連絡表・スケジュールの前後日移動（`goPageRel` / `_adjPageDs`、既存ページを日付順に移動）
- 資料系タブ（使い方/仕様書/マニュアル/管理者設定/引き継ぎ）をメイン領域で全幅表示
- **Excel取り込みの上書き保護**：担当割当済みの日（`_pageHasDuties`）は旧勤務表の列を維持し、
  未割当の日のみ更新（`_mergeShiftPreserve`）。保存後に維持した日付を通知。

## ドキュメント（アプリ内資料タブ）

`renderGuide`（使い方）/ `renderSpec`（仕様書）/ `renderManual`（操作マニュアル）/
`renderAdminManual`（管理者設定）/ `renderDev`（引き継ぎ資料）。
**機能を追加・変更したら、これらの該当資料も更新する**こと。

## コンプライアンス上の設計方針（重要）

- 参照：厚労省「医療情報システムの安全管理に関するガイドライン 第6.0版」(2023/5、最新)、
  3省2ガイドライン、個人情報保護法（患者情報＝要配慮個人情報）。
- **本アプリは「患者個人情報を保存しない運用ツール」を貫く設計**。
  申し送り投稿時にフルネーム・8桁患者ID等を検知してブロック／警告する仕組みが生命線。
  患者特定情報を保存しない限り、重い規制要件の大半は対象外にできる。
- 既存の安全対策：認証(Firebase Auth)・権限分離・監査ログ・30分自動ログオフ・自動削除・通信TLS。
- 患者個人情報を保存する方向に拡張する場合は、3省2ガイドライン準拠（国内リージョン・保存暗号化・
  クラウド委託契約・BCP等）が別途必要。現構成(Firebase/GitHub Pages)のままでは不足。
- 最終的な適合判断は院内の医療情報システム安全管理責任者・法務に委ねる（私は判断主体ではない）。

## デプロイ

1. 修正済み `index.html` を GitHub リポジトリにアップロード（Edit→Upload files）。
2. Commit → 数分で GitHub Pages に反映。
3. Firebase のデータは index.html 更新では消えない。データ構造の大きな変更は事前確認。
   （自動化したい場合は git 初期化＋GitHub Actions の workflow を別途用意する。）
