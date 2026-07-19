# AGENTS.md

**このリポジトリのエージェント向け開発ガイドの本体は [`CLAUDE.md`](./CLAUDE.md) です。作業を始める前に必ず全文を読んでください。** このファイルはCLAUDE.mdへのポインタと最重要ルールの要約のみで、詳細は一切ここに書きません（二重管理による乖離を防ぐため。規約を更新するときはCLAUDE.mdだけを編集してください）。

## 最重要ルールの要約

- **単一ファイルアプリ**: HTML/CSS/JSのすべてが `index.html`（~570KB）にある。ビルドシステム・パッケージマネージャ・テストフレームワークは無い。
- **コミット前に必ず** `node .github/scripts/validate.mjs` を実行して構文チェックを通すこと。
- **グローバル状態 `D`**: トップレベルプロパティを追加するときは5箇所（初期化 / `loadD()` / Firebase `/data` リスナー / ログアウトリセット / バックアップキー配列×2）をすべて更新する。詳細はCLAUDE.mdの「Adding New D Properties」。
- **保存**: `D` を変更したら `saveD()`。単一ページ（`D.pages[ds]`）で完結する変更のみ `saveDPage(ds)` 可。使い分けの条件はCLAUDE.mdの「saveDPage(ds)」節に従う。
- **PHI検知**: 自由入力欄には個人情報検知（`detectPHI`）が必要。`#main` 内のtext入力は自動カバーされるが、モーダル等 `#main` 外は保存ハンドラで明示的に呼ぶ。
- **権限**: 表示/操作のゲートは `can(id)` を使う（`lk(id)&&!isAdmin` は使わない）。
- **ローカル確認**: `python3 -m http.server 8080` → `?preview=1`（管理者）/ `?preview=2`（一般ユーザー）でFirebaseログインなしに動作確認できる。
- **テスト文言はひらがなのみ**にする（PHI誤検知でポップアップが出て自動テストが壊れるため）。

## ブランチ・PR運用

- `main` へ直接pushしない。作業ブランチ → PR → squashマージ。
- `claude/` プレフィックスのブランチはClaude Code用。**Codex等の他エージェントは別のプレフィックス（例: `codex/`）を使うこと**（同名ブランチの取り合いによる履歴衝突を防ぐ）。
- 変更履歴（`APP_VERSION` / `APP_CHANGELOG`）の更新ルールはCLAUDE.mdの「Changelog System」節に従う。
