# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**分院CE連絡表 (CEnote)** — A clinical engineering department daily scheduling and communication web app for a hospital branch. Written entirely in Japanese, intended for staff to manage daily duty assignments, checklists, memos, OPE/catheter procedures, and shift data.

## Project Structure

This is a **single-file web app**: all HTML, CSS, and JavaScript lives in `index.html` (~480KB). There is no build system, no bundler, no package manager, and no test framework.

Additional files:
- `manifest.json` / `sw.js` — PWA support (offline caching, cache name `cenote-v5`)
- `icon-192.svg` / `icon-512.svg` — PWA icons
- `.github/scripts/validate.mjs` — lightweight syntax checker (run after every change)
- `AGENTS.md` — pointer file for other AI agents (Codex etc.): it references this CLAUDE.md as the single source of truth. Do **not** duplicate rules there — update only CLAUDE.md.

## Validation

```sh
node .github/scripts/validate.mjs
```

Checks: merge conflict markers, inline JS syntax (`new Function()`), manifest.json validity, sw.js syntax. **Run this before every commit.**

## Running Locally

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

**Preview mode (no Firebase login required):**
- `?preview=1` — admin mode (all tabs unlocked, local storage only)
- `?preview=2` — regular user mode (restricted tabs, local storage only)

## Architecture

### Global State Object `D`

All application data lives in a single global variable `D`:

```js
var D = {
  pages: {},        // daily pages keyed by "YYYY-MM-DD"
  stf: [],          // staff names list
  stfHidden: {},    // { name: true } — hidden from assignment table/dropdowns
  phs: [],          // phone extension numbers
  dly: [],          // daily checklist items (every day)
  wd: {},           // weekday-specific checklist items { 月: [...], 火: [...], ... }
  lk: {},           // lock flags { duty: true, sm: true, ... }
  ope: [], cath: [], sup: [],          // procedure/supply type lists
  opeTree: [], cathTree: [], supTree: [], // hierarchical masters
  dutyCfgMaster: [], dutyCfg: [],     // duty slot definitions
  opsCfg: [], oc: [],                 // ops config, on-call config
  shift: {}, evts: {},                // shift/event data
  manual: {},       // task manuals { taskName: { text, media: [{url, name, type, pending?}] } }
  schedPresets: [], // schedule timetable presets
  stfLinks: {},     // { name: uid } — staff ↔ Firebase auth linkage
  stfEdu: {},       // { name: [...slots] } — education slot config
  fcmCfg: {},       // FCM push notification config
  emailjsCfg: {},   // EmailJS notification config
  autoAssignMode: 'weekday', // auto-assign mode
  psgAlertTime: '10:00',     // PSG 付箋未入力アラート時刻
  psgBannerStart: '07:30',   // PSG取り外しバナー表示開始時刻
  psgBannerEnd:   '08:30',   // PSG取り外しバナー表示終了時刻
  autoDelCfg: { enabled:false, period:365, interval:30, lastClean:0 }, // 自動削除設定（旧: localStorage個別キー、_migVer 4で移行）
  tablets: [],      // タブレット台帳（貸出対象名の配列）— 日々の貸出ログは D.pages[ds].tabletLogs
  ocFlow: '',       // OC対応フローチャート本文（複数行テキスト。OC集計タブのボタン→openOcFlowModal で全員閲覧、業務マスタの mst セクションで編集）
  makers: { cats: [], list: [] }, // メーカー担当者連絡先。cats:[{id,name}]（表示順）、list:[{id,cat,maker,person,tel1,tel2,mail,note,upd,ts,by}]。詳細は下記「メーカー担当者連絡先」節
  wdDepts: [],      // 設置部署マスタ（D.wd項目のsubsで選ぶ部署名の共通リスト。PHSマスタ/tabletsと同型の単純な文字列配列）
  _migVer: 5        // data migration version flag (increment when running one-time migrations)
};
```

Each `D.pages["YYYY-MM-DD"]` contains all data for a single day: `duties`, `checks`, `memos`, `ops`, `ocData`, `schedule`, `placement`, `ops_cards`, `tabletLogs`, etc.（`staffZone`/`staffAdj`/`hdDuty` は `placement` に統合済みの旧フィールド。削除はせず読み出し時に吸収する）

### Adding New D Properties

When adding a new top-level property to `D`, update **all five** of these locations:

1. `var D = {...}` initialization (line ~1539)
2. `loadD()` — localStorage hydration (`D.newProp = s.newProp || default`)
3. Firebase `/data` listener — hydration from Firebase (`D.newProp = d.newProp || default`)
4. Logout reset block (`D.newProp = default`)
5. Backup/restore key arrays — **three** `forEach` calls containing `'emailjsCfg','fcmCfg','stfLinks',...`: Firebase snapshot restore, local auto-backup restore, and `importBackup()` (JSON file restore). All three must stay identical; `importBackup()` was previously missed and silently dropped 12 settings on restore.

### Persistence

- **Firebase ON**: `saveD()` writes the entire `D` object to `fbDB.ref('/data').set(D)`
- **Firebase OFF / fallback**: writes to `localStorage` key `'ce2'`
- **Logs**: written via `writeLog()` to Firebase `/logs`
- **Media**: uploaded to Firebase Storage at `manual/{taskName}/{timestamp}_{filename}` (manuals), `memo/{ds}/{ts}_{idx}_{filename}` (memos), `board/{ts}_{idx}_{filename}` (board post images), `board/reply_{ts}_{idx}_{filename}` (board reply images)
- **Board**: stored at Firebase `/board` (independent of `/data`). Posts (and replies) may carry a `media` array (images only); non-admin uploads get `pending: true` and go through the same approval flow as memo media (`approveBoardMedia`/`rejectBoardMedia` for posts, `approveBoardReplyMedia`/`rejectBoardReplyMedia` for replies — both scanned by `listPendingMedia`, which emits `kind:'board'` and `kind:'boardReply'` entries)
  - **既読 (read receipts)**: each post carries `reads: { uid: { n: displayName, ts } }`. `renderBoard()` writes the current user's read entry the first time it renders a post they haven't read yet (checked via `p.reads[currentUser.uid]` so it never re-writes — no infinite loop). The 👀 count shown excludes the post author's own read; `toggleBoardReads(id)` expands the name+time list.
  - **カテゴリタグ**: posts carry `tag` (`'info'`|`'req'`|`'etc'`, default `'etc'`, see `BOARD_TAGS`). `req`-tagged posts can be marked `resolved: true/false` (with `resolvedBy`/`resolvedAt`) by the author or an admin via `toggleBoardResolved()`; resolved posts render dimmed (`.brd-post.resolved`). `board-list` has a filter chip row (`setBoardFilter()`, module-level `_boardFilter`) for all/info/req/etc/unresolved-only.
  - **ピン留め期限**: `pinBoard(id, pin)` prompts for a number of days when pinning (blank = no expiry) and stores `pinUntil` (ts). `boardPinActive(p)` — `p.pin && (!p.pinUntil || p.pinUntil > Date.now())` — is the single source of truth for sort order and the 📌 badge/expiry-date label. Admins auto-clear expired pins (`/board/{id}/pin` → `false`) inside `renderBoard()`.

`saveD()` always writes the **full** `D` object. After mutating any property of `D`, call `saveD()`.

**Critical guard**: `_fbDataLoaded` must be `true` before `saveD()` writes to Firebase. It is set when the `/data` listener first fires. This prevents empty-D overwrites on login. **Do not bypass this guard.**

After `saveD()`, `_savingTs` suppresses listener-triggered re-renders for 2 seconds to prevent the Firebase echo from overwriting in-progress UI state.

#### `saveDPage(ds)` — page-level partial write (limited use)

`saveDPage(ds)` writes only `/data/pages/{ds}` (`fbDB.ref('/data/pages/'+ds).set(D.pages[ds])`) instead of the full `D` object, to reduce the chance that two people editing different days' pages at the same time clobber each other's changes via `saveD()`'s full-object overwrite. It always writes the full `D` to `localStorage` first (identical to `saveD()`), so the local/offline behavior is unchanged.

- Uses its own state (`_savePageWriting`, `_savePageQueue`) — completely separate from `saveD()`'s queue (`_saveWriting`/`_saveQueued`). Multiple `saveDPage()` calls serialize through this queue (dedup by `ds`).
- Same `_fbDataLoaded` guard as `saveD()` — never bypassed.
- If `D.pages[ds]` doesn't exist (page deleted), delegates to full `saveD()`.
- **Ordering guard**: if a full `saveD()` write is in-flight or pending (`_saveWriting || _savePending`), `saveDPage()` defers entirely to `saveD()` instead of writing the page directly. This prevents a stale full-`D` snapshot (taken *before* the page edit) from landing in Firebase *after* the page-level write and silently reverting it.
- Does **not** touch `/recent_backup` — that's updated only by full `saveD()`'s success callback.

**Only use `saveDPage(ds)` where the change is unambiguously scoped to a single page** — currently: ops card item lists and field binds (`buildOPS`'s `saveItems()` / `bind()` / free-card / PSG付箋 handlers), checklist checkbox toggles (`mkCk`), memo post/done-check/delete (`_finishPostMemo`, `doneMemo` handler, `delMemo`), and schedule block add/import/clear/move/resize/delete (`schedAddBlock`, `schedImportDuties`, `schedClear`, `schedBindInteractions`). Duty assignment, staff/master edits, and anything with cross-page side effects still use full `saveD()` — do not switch those to `saveDPage()` without re-checking every side effect (`maybeLateToast`, `writeLog`, pool refresh, etc.).

### Firebase Setup

```js
var FB_CFG = { apiKey: "...", ... };
var FB_ON = !FB_CFG.apiKey.includes("YOUR_");
```

`FB_ON` is `true` when a real API key is configured.

### Authentication & Access Control

- Firebase Email/Password auth
- Admin status: `/admins/{uid}` = `true` in Firebase
- Per-user granular permissions: `/userPerms/{uid}` = `{ duty: true, memo: true, tab_master: true, ... }`
- Global: `isAdmin` boolean, `currentUser = { uid, email, displayName, isAdmin, perms: {} }`
- Idle auto-logout: 30 minutes with 5-minute countdown warning

```js
function lk(id)  { return !!(D.lk && D.lk[id]); }  // is section globally locked?
function can(id) {
  if (isAdmin) return true;
  if (!lk(id)) return true;
  return !!(currentUser && currentUser.perms && currentUser.perms[id]); // per-user override
}
```

**Always use `can(id)` for permission checks — not `lk(id)&&!isAdmin`.** The latter ignores per-user grants.

**Exception — スタッフマスタ is `isAdmin`, not a lock.** `renderStfList` / `addStf` / `rmStf` / `mvStf` / `editStfItem` / `confirmEditModal`'s `type:'stf'` branch all gate on `isAdmin` directly, and the 👥 スタッフ tab itself is admin-only (which also puts PHS番号 and 勤務表インポート behind admin, since they share `pane-staff`). The old `sm` lock was **removed from `LOCK_DEFS`** rather than left as a dead toggle. Before removing it, `sm` was doubling as the permission for 使用物品マスタ (`supTree`) renames while `opeTree`/`cathTree` referenced `om`/`cm` — ids that never existed in `LOCK_DEFS`, so `lk()` returned false and `can()` always allowed them; all three now use `mst`, matching their sections' own `data-perm`. Stale `D.lk.sm` / `userPerms[uid].sm` values are simply never read.

#### Lock IDs (`LOCK_DEFS`)

| id | label | notes |
|---|---|---|
| `duty` | 担当割り当て | |
| `phs` | PHS番号の変更 | |
| `ops` | 業務内容（オペ/カテ等） | |
| `dm` | チェックリスト（共通）の編集 | pane-master 共通業務セクション |
| `wm` | チェックリスト（曜日別）の編集 | pane-master 曜日別業務セクション |
| `mst` | 各種マスタの編集 | OPE/カテ/使用物品/担当枠/スケジュール/PSG通知/タブレット台帳/HD特殊治療セクション。3階層ツリー（`opeTree`/`cathTree`/`supTree`）のリネーム（`confirmEditModal` の `type:'tree'` と `editTreeItem`）もこれ |
| `cl` | チェックリストの入力 | |
| `memo` | 業務連絡・申し送りの編集 | |
| `pg` | 連絡表の生成・削除 | |
| `show_phs` | PHS番号欄の表示切替 | 反転ロジック（ON=表示、OFF=非表示） |
| `tablet` | タブレット貸出の記録 | 貸出/返却/削除の操作をゲート。台帳マスタ編集は `mst` |
| `maker` | メーカー連絡先の編集 | 閲覧・検索・コピーは常に全員可。追加/編集/削除のみゲート。既定は未ロック。Excel一括取り込みはこのロックと無関係に常に管理者限定（`isAdmin` 判定） |

#### Tab Visibility

`updateTabVisibility()` controls which sidebar tabs non-admin users can see. It must be called after any change to `currentUser.perms` (e.g., inside `saveUserPerm()` when the current user's own permissions change).

```js
// Tab visibility is controlled by explicit tab_ permissions,
// NOT by edit-lock permissions
'staff':  isAdmin, // スタッフ一覧・PHS番号・勤務表インポートはまとめて管理者限定
'master': isAdmin || hasPerm('tab_master'),  // マスタタブ（中身は data-mode でさらに出し分け）
'lock':   isAdmin,
'logs':   isAdmin,
'docs':   isAdmin,
```

`cal` / `assign` / `sum` / `task` / `lib` are deliberately **not** in the `show` map — they are visible to everyone in both modes, and the map only lists tabs that need controlling.

**主観モードによる出し分けはタブではなくサブタブで行う。** `updateTabVisibility()` の後半が `subtab-at`（CE担当表）と `subtab-fair`（CE公平性）を HD主観で、`subtab-hdfair`（HD公平性）を CE主観で隠し、隠れたサブタブを開いたままモードを切り替えたときは `swSubTab('my')` へ退避させる。公平性2つはどちらも管理者のみ。担当表タブごと隠さないのは、**マイ担当がHD勤務のシフトも出す画面**（`renderMySchedule` は `_viewMode` で分岐しない）で、HD主観からも辿れる必要があるため。`swTab('assign')` の既定サブタブも主観で変わる（HDなら `my`）。

集計タブ（`sum`）は主観でもパーミッションでも出し分けない——集計は「どちらの目で見るか」に依らない事実だから。HD集計サブタブもCE主観から見える。

**`swTab` must never call `updateTabVisibility()`** or the escape lines become an infinite loop.

`tab_master` is stored in `/userPerms/{uid}` alongside regular lock permissions, but is granted via the "タブ表示" section in `renderAdminUsers()` rather than the lock-permission buttons. `tab_staff` used to work the same way and was removed when the スタッフ tab became admin-only; stale `tab_staff` values in existing `/userPerms` are simply never read.

#### pane-master Section Gating

Each section div in `#pane-master .sp` carries a `data-perm` attribute (permission) and optionally a `data-mode` attribute (主観モード). `swTab('master')` evaluates both after rendering:

```js
document.querySelectorAll('#pane-master .sp > div[data-perm]').forEach(function(sec){
  var perm = sec.getAttribute('data-perm');
  var mode = sec.getAttribute('data-mode');
  var permOk = (perm === 'admin' ? isAdmin : can(perm));
  var modeOk = (!mode || mode === _viewMode);
  sec.style.display = (permOk && modeOk) ? '' : 'none';
});
```

- `data-perm="dm"` — 共通チェックリスト section (CE and HD each have their own)
- `data-perm="wm"` — 曜日別チェックリスト section (CE and HD each have their own) ＋ 設置部署マスタ
- `data-perm="mst"` — OPE/カテ/使用物品/担当枠/スケジュールプリセット/PSG通知/タブレット台帳/HD特殊治療/OC対応フローチャート sections
- `data-perm="admin"` — メール通知/Web Push/月次自動割り当て sections (admin-only regardless of locks)
- `data-mode="ce"` / `data-mode="hd"` — show only in that 主観モード. **Omitting `data-mode` means "both modes"**, which is currently true of exactly one section: 🏥 設置部署マスタ.

**設置部署マスタ must stay its own top-level section.** It was originally nested inside the CE 📅 曜日別業務 block, but `D.wdDepts` is shared by both CE and HD 曜日別業務 (the 🏥 部署 modal on either side reads the same list). Leaving it nested meant hiding the CE block in HD mode also took away the only place to add or reorder departments.

The selector is `.sp > div[data-perm]` — a **direct-child** selector — so a new section must be a direct child of `.sp`. Nesting it inside another section makes it invisible to both gates and it ends up shown to everyone in every mode.

### Firebase Listener Lifecycle

`/data`, `/board`, and `/tasks` listeners are all set inside a single `if (!dataListenerOn)` block in `fbInit()`. On logout, **all three** must be detached:
```js
fbDB.ref('/data').off(); fbDB.ref('/board').off(); fbDB.ref('/tasks').off();
dataListenerOn = false;
```
On logout also reset: `_saveWriting`, `_savePending`, `_saveQueued`, `_fbEverConn`, `_fbConnected`, `_fbDataLoaded`, `_fbLastPageCount`.

### Firebase Database Structure

```
/data/                      — full D object (saveD())
/board/                     — 掲示板 posts (independent of /data)
/tasks/                     — タスク管理 (independent of /data; see Task Management section)
/logs/                      — activity log (append-only via push())
/admins/{uid}               — true for admin users
/users/{uid}                — { email, displayName, lastLogin }
/userPerms/{uid}            — { lockId: true, tab_master: true, tab_staff: true, ... }
/backups/YYYY-MM-DD_HH      — hourly Firebase snapshots (7-day retention)
/backup_meta/YYYY-MM-DD_HH  — snapshot metadata { ts, label, pages, stf }
/recent_backup              — latest successful write snapshot (always 1 entry)
```

### Backup System (3 layers)

| Layer | Where | Retention | Trigger |
|---|---|---|---|
| ☁️ Firebase hourly snapshot | `/backups/YYYY-MM-DD_HH` | 7 days × 24h | `saveFirebaseSnapshot()` — daily auto + 1h interval |
| ⚡ Recent backup | `/recent_backup` | Latest 1 | Every successful `saveD()` write |
| 🔄 PC local auto-backup | `localStorage ce2_autobk` | Latest 5 | Firebase first-load, 30-min interval, before destructive ops |

`autoSaveSnapshot(label)` adds to the local ring buffer. It is called **after Firebase first load** (not at `init()` time) to ensure fresh data is saved.

**Auto-delete settings** (`D.autoDelCfg`, used by `checkAndDeleteOldData()`/`checkAutoDelTiming()`) live in the synced `D` object, not per-PC `localStorage` — previously they were `localStorage` keys (`autoDelEnabled`/`autoDelPeriod`/`autoDelInterval`/`lastAutoClean`), which meant the auto-delete schedule could disagree between devices. `_migVer` 4 migrates any existing per-PC values into `D.autoDelCfg` once.

### Firebase Security Rules

`database.rules.json` and `storage.rules` (repo root) hold the recommended, path-scoped Realtime Database / Storage security rules — replacing the earlier "any authenticated user can read/write everything" default. They are **not auto-deployed**; an admin must paste them into the Firebase Console manually (see `FIREBASE_RULES.md` for steps, the per-path rationale table, a post-apply verification checklist, and rollback instructions). The in-app spec/docs pages (`renderSpec`, `renderAdminManual`, `renderDevDocs`) source the RTDB rule text from the shared `LATEST_DB_RULES` string (defined once near the top of the script) so the three doc displays never drift out of sync with `database.rules.json`.

### UI Layout

```
.tb       — top bar (fixed)
.ab       — app body (flex row)
  .sb     — sidebar (left, collapsible)
    .stabs — tab strip
    pane-cal    — calendar with month navigation
    pane-assign — 📊 担当表, with subtabs (swSubTab / `_curSubTab`):
                  at (担当表) / my (マイ担当) / fair (CE公平性) / hdfair (HD公平性)
                  タブ自体は両主観で出す。at と fair がCE主観、hdfair がHD主観（下記）
    pane-sum    — 📈 集計, with subtabs (swSumTab / `_curSumTab`):
                  ops (CE集計) / oc (OC集計) / hd (HD集計)
                  全ユーザー・両主観。パーミッションでも主観でも出し分けない
    pane-task   — 📋 タスク管理 (all users; was a subtab of pane-assign until it was promoted to a top-level tab — it was too easy to miss in there)
    pane-guide  — user guide
    pane-makers — 🏭 メーカー担当者連絡先 (all users; see メーカー担当者連絡先 section below)
    pane-staff / pane-master / pane-lock / pane-logs — admin-only
    pane-spec / pane-manual / pane-adminm / pane-dev / pane-regs / pane-changelog — docs sub-tabs
  .main   — day detail view (right, scrollable)
  .es     — empty-state placeholder (shown when no page is selected)
```

`pane-board`（掲示板）と `pane-sched`（⏰ スケジュール）はどちらも元々サイドバーのタブだったが、タブに置いていると活用されないため連絡表ヘッダーのボタン（📢/⏰、`openBoardPanel()`/`openSchedPanel()`）から開くモーダルに変換済み——`.ov`/`.hd` トグルで開閉する `#board-panel-ov`/`#sched-panel-ov` が `<body>` 直下にあり、中身の要素 id（`#pane-board`、`#sched-title`/`#sched-tools`/`#sched-body`）は元のまま移設しているため `renderBoard()`/`renderSched()` は無改造で動く。`#pane-sched` は以前 `.sb` の内側にあり、スマホで `.sb` の `transform:translateX(-100%)` に巻き込まれて真っ白になる不具合を避ける防御コードが複数箇所に必要だったが、モーダル化によりその防御コードごと不要になった。

Mobile (`max-width: 768px`): sidebar becomes a fixed full-screen overlay toggled by `.hbg`. `#pane-assign` is a `position:fixed` full-screen overlay on mobile.

`openDefaultPage()` — called at Firebase first-load and in preview mode; opens today's page if it exists, else shows the `.es` placeholder.

`swSubTab(id)` switches between the subtabs inside `pane-assign` (`at` / `my` / `fair`), `swSumTab(id)` between those inside `pane-sum` (`ops` / `oc` / `hd`). Each subtab has a matching `subpane-{id}` div, and the two panes keep separate state (`_curSubTab` / `_curSumTab`) because each has its own CSV and 印刷 button targeting a different thing.

CSVは対象を持つサブタブにだけ出す：担当表は `at` のみ（マイ担当・公平性はボタンごと隠す）、集計は3つとも出す。印刷は `_printSubPane(phId, subId)` が共通処理で、担当表(`at`)だけは専用レイアウトの `printAt()` へ抜ける。印刷CSSは `body[data-print-sub="…"]` で1枚だけ開くので、**サブタブを足したらこの行も足すこと**（足し忘れると紙が白紙になる）。

**Adding a top-level sidebar tab** touches six places, and the last one is the easy miss: the `.stabs` button (`tab-{id}`), the `pane-{id}` div, `swTab`'s `tabs` array, `swTab`'s `contentPanes` array (PC full-width), the per-tab render call in `swTab`, and **any Firebase listener that re-renders only while that pane is visible**. When `task` was promoted out of `pane-assign`, the three `/tasks` + `/taskMemos` listeners still queried `#subpane-task`; leaving them would have silently stopped real-time updates.

`init()` calls `updateTabVisibility()` once at startup (right after `fbInit()`). Without it the mode-dependent tabs are never evaluated on a cold load: `_viewMode` is restored from `localStorage` at the top of `init()`, but the Firebase path only re-evaluates on login and the preview path used to hand-set `display=''` on the admin tabs, so reloading while in HD mode left 担当表 showing and HD集計 hidden. Do not replace that call with per-tab `style.display` assignments again.

### テーマ（ライト／ダーク）

端末ローカル設定（localStorage `ce2_theme`、`getTheme()`/`setTheme(t)`/`cycleTheme()`）。`_viewMode` と同じく `D` には入れず、ログアウトでもリセットしない。トップバーの `#theme-toggle` が **☀️ライト → 🌙ダーク → 🌓端末に合わせる** の3状態を回す。

**既定はライト（`auto` ではない）。** 端末のダーク設定に勝手に引きずられると、更新した瞬間に職員の画面が黒くなって驚かせるため、端末設定への追従は🌓を選んだときだけの動作にしている。**`getTheme()` の既定値を `'auto'` に戻さないこと。**

**`setTheme()` は `'auto'` も localStorage に保存する。** 既定がライトになったので、`'auto'` をキー削除で表すと「端末に合わせる」を選んだこと自体が次回起動時に失われる（キー無し＝ライト、と解釈されるため）。`<head>` のちらつき防止スクリプトも同じ3分岐を持つので、**片方だけ直さないこと**。

**`data-theme` には必ず `light`/`dark` のどちらかが入る。** `auto` は `localStorage` 側の状態としてのみ存在し、`applyTheme()` が `effectiveTheme()`（`matchMedia('(prefers-color-scheme: dark)')` を見る）で解決してから属性に書く。こうすることで CSS 側は `:root[data-theme="dark"]` 1ブロックで済み、`@media (prefers-color-scheme:dark)` に同じパレットを二重管理せずに済む。`auto` のまま端末設定が変わったときは `matchMedia` の `change` リスナーが `applyTheme()` + `repaintForTheme()` を呼ぶ。**`data-theme` を消して `@media` に任せる形に戻さないこと** — 戻すとパレットの定義箇所が2つになり、片方だけ直したときに端末設定追従のユーザーにだけ古い色が残る。

**ダークのパレットは `@media screen` の中に置く。** 印刷時はこのブロック自体が適用されず `:root` のライト値がそのまま効くので、紙用のパレットを別に転記する必要がない（転記すると二重管理になり、ライト側の色を変えたときに紙だけ古い色になる）。

`<head>` に小さなインラインスクリプトがあり、CSSより先に `data-theme` を当てている。`init()` を待つと、暗い設定の端末で起動時に一瞬ライトの画面が見える。

**新しい色は直書きせずCSS変数を足す。** ライト `:root` とダークブロックの2箇所に定義すれば全体に効く。既存の意味色に加えて `--rd-bdr`（赤系ボーダー）、`--ac-bg2`（`--ac-bg` より一段濃い青。担当表のホバー時に日付列 `td.sc` を通常セルと見分けるためだけに存在する——同じ `--ac-bg` にすると区別が消える）、`--alert-fg`/`--alert-bg`/`--alert-bdr`（**患者個人情報の警告専用**。通常の `--rd` より鮮やかにして他の赤より強く目に入るようにしている。`--rd` で代用しないこと）、`--warn-bg`/`--warn-fg`/`--warn-fg2`/`--warn-bdr`（PHI警告・OCアラート・PSGバナーで共有）、`--toast-bg`/`--toast-fg`/`--toast-warn`、`--code-bg`/`--code-fg`（資料ページのコードブロック）、`--on-ac`（**意味色をベタ塗りした上に載せる文字色**。ライトは白、ダークは地の色。ダークでは意味色を明るくしてあるので、白のままだとコントラストが2倍前後まで落ちて10pxのバッジが読めなくなる。`background:var(--ac)` 等と組で使い、`#fff` を直書きしないこと）がある。トーストはライトでは地より暗く、ダークでは地より明るい——「反転」ではなく「浮かせる」方向で揃えている。

`color-scheme` を `light`/`dark` で切り替えているので、背景色を指定していない `input`/`textarea`/`select`、日付・時刻ピッカー、スクロールバーもまとめて追従する。加えて `input:not([type=checkbox]):not([type=radio]):not([type=color]),textarea,select{background:var(--sur);color:var(--txt)}` を1行だけ置いている（詳細度が低いのでクラスで色を持つ入力欄には影響しない）。

**JSが色を計算して埋めている箇所はCSS変数だけでは変わらない**ので、テーマ切替時に `repaintForTheme()` が塗り直す（`_dutyDarkCache` のクリア＋開いている日ページ・カレンダー・担当表・業務集計・公平性の再描画）。対象は担当枠の色と集計グラフの系列色。

**担当枠の17色（`DUTY_COLOR_MAP` / `DUTY_PALETTE`）はダーク用に手書きし直さない。** `dutyColorFor(slot)` が `themePair()` → `darkenPair()` を通し、文字色(`fg`)の**色相を軸に計算で**「暗い地＋明るい文字」を作る（`_dutyDarkCache` にメモ化）。ライト用の定義だけを正本にしておくことで、枠を1つ足すたびにダーク用の色も足す、という二重作業が発生しない。`bg`/`fg` が `var(...)` の組（`__free` など）は `_hexToRgb` が `null` を返すのでそのまま素通しになり、CSS変数側の切り替えに任せる。

集計グラフの系列色は `getComputedStyle(document.documentElement).getPropertyValue('--sum-'+k)` で読む。`renderOpsSummary()` 内の `COLORS` に直書きしないこと。

### CSS Conventions

All class names are abbreviated:
- `.tb` toolbar, `.sb` sidebar, `.ab` app body, `.cw` calendar, `.cg` calendar grid, `.cd` calendar day
- `.dg` duty grid, `.dc` duty card, `.ds2` duty select
- `.btn-p` primary (blue), `.btn-g` ghost/secondary, `.btn-d` danger
- `.ov` overlay backdrop, `.md` modal dialog, `.sp-panel` side peek panel
- `.brd-*` board post/reply elements
- **`.pchip.sp`（余剰人員チップ）の `sp` はサイドバーのスクロール枠 `.sp` とクラス名が衝突する。** `.sp` が持つ `flex:1` / `flex-direction:column` / `overflow-y:auto` をチップ側は一切上書きしていなかったため、flex親の中に置くと横いっぱいに伸び、氏名とシフトコードが縦積みになっていた。`.pchip.sp`（specificity 0,2,0）で `flex:0 0 auto;flex-direction:row;overflow:visible` を打ち消している。`.sp` は汎用名なので、新しいチップ系クラスに `sp` を使い回さないこと
- CSS custom properties: `--ac` accent blue, `--rd` red, `--gr` green, `--or` orange, `--pu` purple, `--gd` gold, `--oc` light blue (on-call)

### Key Functions

| Function | Purpose |
|---|---|
| `init()` | Bootstrap — `loadD()`, start intervals, `fbInit()`, render UI |
| `loadD()` | Hydrate `D` from localStorage |
| `fbInit()` | Firebase auth listener → login → `/data` + `/board` + `/tasks` listeners |
| `saveD()` | Persist `D` to Firebase or localStorage |
| `updateTabVisibility()` | Show/hide sidebar tabs based on `isAdmin` and `currentUser.perms` |
| `openDefaultPage()` | Open today's page on startup (if exists) |
| `openPage(ds)` | Open a day's detail view in `.main`; calls `updateOpsHeader` + `updatePsgRemovalBanner` |
| `renderPage(ds)` | Re-render the open day page |
| `safeRenderPage()` | `renderPage(curDs)` only if page is open |
| `renderCal()` | Render calendar sidebar |
| `renderAT()` / `renderFairness()` / `renderHdFairness()` | Monthly assignment table / CE公平性 / HD公平性（いずれも `D.stfHidden` を除外） |
| `buildDG(ds, dat, locked)` | Duty card grid |
| `buildCL(ds, dat, wtl, all, locked)` | Checklist section |
| `buildOPS(ds, dat, locked)` | OPE/cath/ops record section |
| `renderMemos(ds, dat, locked)` | Memo/comment thread (incl. nested replies) |
| `memoKeyOf(m)` / `findMemoByKey(ds, key)` | 申し送り1件を指す安定キー（`ts+uid`）と逆引き。配列インデックスは Firebase のエコーでずれるので返信はこちらで親を特定する |
| `memoReplies(m)` / `memoMediaArr(m)` / `memoReplyMediaArr(r)` | 申し送りの返信・添付の正規化アクセサ（Firebase の配列→オブジェクト化対策） |
| `postMemoReply(ds, mkey)` / `delMemoReply(ds, mkey, rid)` / `toggleMemoReply(mkey)` | 申し送りへの返信の投稿・削除・入力欄の開閉 |
| `bindMemoListEvents(el)` | `#memo-list` のクリック/change を**一度だけ**登録する（下記参照） |
| `mediaBufPreview(wrap, buf, onChange)` | 送信前の画像バッファのサムネイル表示（申し送り返信・タスクで共有） |
| `ocSetDone(ds, val)` / `updateOcDashChip(ds)` | OC「対応済み」の唯一の書き換え口／ダッシュボードチップの部分更新 |
| `taskMediaArr(t)` / `taskMediaHTML(t)` / `taskMediaCleanup(list)` | タスク・自分専用メモの添付画像の正規化・表示・Storage削除 |
| `clStatus(ds)` | Single done/total counting entry point for the checklist (`{done,total,undone,exists}`); `getPct`/dashboard/`closeItems` all call it |
| `itemRebuild(oldIt, patch)` | Merges `patch` into a `D.dly`/`D.wd` item without dropping unmentioned keys (`null`/`undefined` in patch deletes that key); all writes to those items go through this |
| `wdEntriesForDate(ds)` / `wdOnce(it)` / `wdSubs(it)` / `wdSid(it)` | Accessors for weekday-item flags (`{t,it}` pairs for a date / once flag / installed-location array / stable id) |
| `wdOnceDoneOn(ds, ent)` | Returns the earlier date this month (if any) an `once` item was already done — only scans backward, never forward |
| `wdSubProgress(ds, sid)` | `{locationName: doneDs}` map for a `subs`-bearing item, scanning only pages in `ds`'s calendar month (monthly reset) |
| `renderWdDeptList()` / `addWdDept()` / `rmWdDept(i)` / `mvWdDept(i,d)` | `D.wdDepts` master list editor (add/reorder/remove) in the 曜日別業務 master section, gated by `can('wm')` |
| `openWdSubsModal(i)` / `renderWdSubsModalBody(i)` / `addWdDeptFromModal(i)` / `saveWdSubs(i)` | Per-item department picker modal — checkboxes sourced from `D.wdDepts`; `addWdDeptFromModal` adds to the master inline without closing the modal |
| `renderSched()` | Per-day timetable for `curDs` |
| `renderBoard()` / `postBoard()` / `postBoardReply()` | Bulletin board (also handles read-receipt marking, tag/resolved rendering, pin-expiry sort/cleanup, filter chips) |
| `toggleBoardResolved(id, val)` / `pinBoard(id, pin)` / `boardPinActive(p)` | Board: 依頼解決トグル／ピン留め（期限プロンプト）／ピン有効判定 |
| `toggleBoardReads(id)` / `setBoardFilter(f)` | Board: 既読者一覧の開閉／フィルタチップ切替（`_boardFilter`） |
| `renderPlacementBoard(ds, dat, locked)` / `bindPlacementDnD(ds)` | 配置盤の描画／クリック・ドラッグの委譲登録（`#placement-wrap` に1回だけ） |
| `plPeople(ds)` / `plDerive(ds)` / `plFix(ds)` / `plNames(ds)` | 名簿の取得／勤務表＋旧フィールドからの導出／名簿の固定／表示順 |
| `plSpot(ds, name)` / `plSpotLabel(sp)` / `plClearSpot(ds, name)` | いま居る場所の判定／その表示名／どこからでも外す（保存しない） |
| `plMove(ds, name, spec)` | **配置を変える唯一の口**。担当枠・フリー枠・HD役割・余剰・ゾーン・未割当のすべてがここを通る |
| `plOffer` / `plCancelOffer` / `plAccept` / `plSetRole` / `plEditMemo` | 提供／取り下げ／受け取り／HD役割の付与／メモ |
| `plAddPerson(ds, side)` / `plRemovePerson(ds, name)` / `plResync(ds)` | 名簿への追加（スタッフ選択モーダル）／除外／勤務表から取り込み直す |
| `plCounts(ds)` / `plSurplusNames(ds)` | 見出しバッジの集計／担当表・CSVの「余剰」列 |
| `staffZoneCounts(ds)` / `updateStaffZoneBadge(ds)` | 「👥 人員配置管理」見出しの「当日N名」「未割当N」バッジ（集計の実体は `plCounts(ds)`）／DOM部分更新 |
| `dashJump(sel)` / `dashJumpTop(el)` | ダッシュボードカード・消し込みバーからの共通ジャンプ＋2秒ハイライト（詳細は下記 Dashboard Jump 節） |
| `closeItems(ds)` / `updateCloseBar(ds)` | 消し込みバー（`.cbar`）の6カテゴリ集計の唯一の入口／バー本体の再描画（詳細は下記 消し込みバー 節） |
| `renderOpsSummary()` | CE集計サブタブ（旧「業務集計」）— monthly OPE/cath/6MW/PSG counts |
| `renderOCSummary()` | OC集計サブタブ — on-call response log |
| `fairnessHTML(o)` | 公平性マトリクスの表組み。CE/HDで共通（複製しないこと） |
| `updatePendingBadge()` | Media approval badge (debounced 200ms) |
| `writeLog(action, detail)` | Append to Firebase `/logs` |
| `autoSaveSnapshot(label)` | Add to local PC backup ring buffer |
| `saveFirebaseSnapshot(label)` | Write to `/backups/YYYY-MM-DD_HH` |
| `renderAdminUsers()` / `deleteAppUser(uid, name)` | User management (soft-delete removes `/users/{uid}`, `/admins/{uid}`, `/userPerms/{uid}`) |
| `saveUserPerm(uid, permId, grant)` | Grant/revoke single permission in `/userPerms/{uid}`; calls `updateTabVisibility()` when uid === currentUser.uid |
| `can(id)` / `lk(id)` | Access control helpers |
| `opsHeaderChips(opeN, cathN, mwN, psgN, psgRemoval, opeDone, cathDone)` | Builds 業務 header chips (5th arg = PSG外し flag; 6th/7th = 業務終了済み件数 → 「2/3件終了」進捗表示) |
| `updateOpsHeader(ds)` | Refreshes `#ops-header-row` DOM element dynamically |
| `updatePsgRemovalBanner(ds)` | Shows/hides `#psg-removal-banner` (today only, within `psgBannerStart`–`psgBannerEnd`) |
| `toggleStfHidden(name)` | Toggle `D.stfHidden[name]`; affects AT columns, dropdowns, fairness matrix |
| `setAtZoom(z)` / `initAtPinchZoom()` | 担当表ピンチズーム（ease-out animation for buttons, GPU transform during pinch） |
| `getPct(ds)` | Correct checklist completion % — use this as the reference implementation for done/total counting |
| `renderTasks()` / `renderTaskPerson(el, name)` | タスク管理 — 俯瞰ビュー（負荷グラフ+フィルタ+リスト）／個人詳細ビュー |
| `taskCycleStatus(id)` / `taskPersist(id, t)` / `taskDelete(id)` | タスクのステータス循環（未着手→進行中→完了）／楽観更新保存／削除 |
| `openTaskModal(id)` / `saveTaskFromModal(id)` | タスク作成・編集モーダル（動的生成の `.ov`/`.md`） |
| `openMoveMemoModal(ds, idx)` / `moveMemo(ds, idx, targetDs)` | 申し送りを別日へ移動するモーダルと移動処理（`movedFrom`付与、`saveD()`使用） |
| `openTabletPanel(ds)` / `renderTabletPanelBody(ds)` | タブレット貸出・返却モーダルパネル（ヘッダーの📱ボタンから起動）— 貸出中サマリ＋リスト/タイムライン切替（`_tabletView`） |
| `updateTabletBtnBadge(ds)` | ヘッダー📱ボタンの貸出中バッジ（未返却台数）を更新 |
| `renderTabletList()` / `addTablet()` / `rmTablet()` | タブレット台帳マスタ（`D.tablets`、`mst`権限、PHSマスタと同型） |
| `openOcFlowModal()` / `saveOcFlow()` | OC対応フローチャートの閲覧モーダル（OC集計サブタブ上部の常設ボタンから、全ユーザー可）／マスタ保存（`mst`権限。textareaの値投入は `renderDlyList` 内） |
| `openTabletLendModal(ds)` / `openTabletReturnModal(ds, idx)` | 貸出/返却の記録モーダル（datalistでスタッフ選択＋手入力、`saveDPage`使用） |
| `renderMakers()` / `renderMakersList()` | メーカー担当者連絡先パネル全体（ヘッダーボタン・`#mk-catnav`のカテゴリチップ）／一覧のみ（`#mk-list`）を再描画。検索欄自体は静的HTMLで作り直さない |
| `mkCatColor(catId)` | カテゴリIDをハッシュして`MK_PALETTE`（アプリ既存の7色 --ac/--gr/--or/--pu/--rd/--oc/--gd を再利用、新規hexは定義しない）から固定色を返す。並べ替え・改名しても同じカテゴリは常に同じ色。カテゴリチップ・セクション見出し・カード左帯・電話アイコンの4箇所で同じ値を使い回して視覚的に連動させる |
| `openMakerModal(id)` / `saveMakerFromModal(id)` | 追加・編集モーダル（`id`省略で新規）／保存（備考欄だけ`phiGuardText`を通し`saveD()`） |
| `mkCopyTel(id, which)` / `mkCopyMail(id)` / `mkFlashCopied(el)` | 電話番号(1/2)・メールをクリップボードへコピー（`navigator.clipboard`失敗時は`<textarea>`+`execCommand('copy')`にフォールバック）。コピー成功時はトーストに加え、押したボタン自体のアイコンを`data-ic`属性の元絵文字から一瞬✓に変える（`mkFlashCopied`）。ボタンDOM idは`mk-tel-{id}-{1|2}` / `mk-mail-{id}`で固定 |
| `parseMakerBook(wb, fileName)` | Excelワークブック全件をパースしプレビュー用の中間データを返す（`D`へは未反映）。`wb.SheetNames`を全件ループし、シート内の複数見出し行を別カテゴリとして分離 |
| `doSaveMkImp()` | Excel取り込みの確定保存（管理者限定）。保存直前に`autoSaveSnapshot()`/`saveFirebaseSnapshot()`でバックアップ |
| `getTheme()` / `setTheme(t)` / `cycleTheme()` / `effectiveTheme()` / `applyTheme()` | 表示テーマ（ライト／ダーク／端末設定）。`data-theme` には常に light/dark のどちらかを書く |
| `repaintForTheme()` | テーマ切替時に、JSが色を埋めている箇所（担当枠・集計グラフ）を塗り直す |
| `darkenPair(c)` / `themePair(c)` | ライト用の「淡い地＋濃い文字」ペアを、色相を軸に暗背景用へ計算変換（`_dutyDarkCache` にメモ化） |
| `openSubmenu(id)` | `docs-submenu`（🔑 管理資料）と`lib-submenu`（📚 資料）を相互排他で開閉。`id`が`null`なら両方閉じる |

### Duty/Assignment System

`DUTIES` defines fixed slot types. `DEF_DUTY_MASTER` is the admin-editable master. Each day stores assignments as `{ ope: "name", cath: "name", ... }` plus a pool of unassigned staff for drag-and-drop.

**人員配置台帳（`dat.placement`）**: 「その日この人はどこにいるか」を1人1レコードで持つ唯一の台帳。詳細は下記「人員配置管理（配置盤）」節を参照。担当枠の割り当ては従来どおり `dat.duties` が正本で、台帳側は `plSpot()` がそれを読んで答える。**割り当て・移動はすべて `plMove(ds, name, spec)` を通すこと** — その中で担当枠・フリー枠・台帳から一旦外してから入れるので、1人が2か所に居る状態は作れない。

**Duty assignment paths** (3 total — all must call `maybeLateToast` and `writeLog`):
1. `<select>` onchange in `buildDutyCard`
2. Touch drop (`onTouchEnd`)
3. Mouse drop (`onDrop`)

**Staff visibility**: `D.stfHidden[name] = true` hides staff from `renderAT()` columns, `renderFairness()` names, and duty dropdown options. Hidden staff who are already assigned show as `（非表示）` in the dropdown. HD workers (from shift data) are unaffected.

### 人員配置管理（配置盤 / `dat.placement`）

その日の人員配置は **`dat.placement` 1本**が正本。

```js
dat.placement = {
  fixed: true,                 // その日の名簿を固定したか（一度でも書き込むと true）
  people: {
    "氏名": {
      base:'ce'|'hd'|'oc'|'',  // 勤務表由来の所属（写し取り）
      shift:'CE'|'A1'|'準'|'', oc:false, night:false,
      side:'ce'|'hd',          // いま居る側
      spot:''|'pool'|'surplus'|'maint'|'off'|'other'|'<HD役割>',
      offer:''|'ce'|'hd',      // 相手側へ提供中（まだ受け取られていない）
      from:''|'ce'|'hd',       // 応援で来た元の側
      memo:''
    }
  }
}
```

**これ以前は同じ人の居場所が7か所（`D.shift` / `staffAdj` / `duties` / `extra_free` / `ocData.staff` / `staffZone.ce`+`.hd` / `hdDuty.overrides`）に分散していた。** 「移動」が『片方から消して、もう片方に足す』2操作でしか表せず、片方だけ動かすと中途半端な状態が残る——`refreshPool` が「担当・余剰・フリーに居る人はプールから隠す」という隠蔽ルールで辻褄を合わせ、隠れた理由を説明するためだけの `poolHiddenReason()` まで存在していた。これらは配置盤の導入で全て削除済み。

- **担当枠への書き込みも必ず `plMove` を通す**（`poolAssign` のタップ割り当て、担当カードの `<select>`・ドロップを含む）。`dat.duties` へ直接書くと台帳側の `spot` が古い値のまま残り、`plSpot` は duties を優先するので画面は正しく見えるのに台帳だけ食い違う。`plDerive` も担当枠・フリー枠に居る人の `spot` を空に正規化する。
- **書き込みは必ず `plMove(ds, name, spec)` を通す。** `spec` は `{kind:'duty',slot}` / `{kind:'free'}` / `{kind:'pool'}` / `{kind:'surplus',side}` / `{kind:'zone',zone,side}` / `{kind:'hdrole',role}`。冒頭で `plClearSpot()` を呼び、担当枠・フリー枠・台帳のすべてから外してから入れるので、**1人が2か所に居る状態は原理的に作れない**。担当枠の `<select>`・担当カードへのドロップ・配置盤のドラッグ・タップ割り当ての4経路すべてがここを通る。
- **担当枠（`dat.duties`）とフリー枠（`dat.extra_free`）だけは従来どおりそこが正本**。担当表・公平性・マイ担当・CSVがすべて `dat.duties` を読んでいるため。`plSpot()` が duties/extra_free を先に見て「いま担当枠にいる」と答えるので、台帳と二重管理にはならない。**`placement.people[name].spot` に担当枠IDを入れてはいけない**（正本が2つになる）。
- **ヘルプ（他部署からの応援）は `base:'help'`。** 勤務表の下部にある「サポート」欄は**2行1組**——見出し行（col2 が `SUPPORT_ROW_RE` に一致）の日付セルに**名前**、そのすぐ下の行の同じ日付セルに**役割**（HDのコード）が入る（スタッフ行が「職員番号行→氏名行」の2行組なのと同じ）。実データではこの組が2つ並ぶ。`parseShiftSheet` がこれを読み `D.shift[ym][名前][日]={shift:役割, help:true}` として取り込み、`getShiftForDay().help` → `plDerive` の順で名簿に載る（役割があればHD側のその持ち場、無ければCEの未割当）。役割は `plHdRole()` を通すので「休」等は役割にならない。**`getShiftForDay` ではヘルプを CE/OC/HD のどの枠にも入れないこと** — HDの役割コードを持つので、素通しすると通常のHD勤務者として二重に数えられ、HD担当表にも分院スタッフとして並ぶ。**`D.stf` には登録しない**（分院のスタッフではないため）。1セル複数名は「、・,／改行」で区切り、**空白では割らない**（「田中 太郎」を2人に割ってしまう）。手入力は配置盤の「＋追加」モーダル下部の欄（`addHelpStaffFromModal`）から——名前と一緒にHDの役割も選べ、選べばそのままHD担当表のその枠に入る（あとからメニューで選び直す2手を避けるため）。**手で足した人には `manual:true` を立て、`plResync` の「除外」候補から外すこと** — 勤務表に載っていないのは当たり前なので、取り込み直しのたびに消えてしまう。ここは職員名を入れる欄なので**氏名パターンの黄色警告では止めない**（メーカー担当者名と同じ判断。`phiHasBlock` の対象＝患者IDなどだけ弾く）。`validateShiftData` の「名簿に未登録」警告もヘルプには出さない。
- **名簿は書き込むまで導出、書き込んだら固定**。`plPeople(ds)` は `placement.fixed` が立っていれば `people` を、立っていなければ `plDerive(ds)`（勤務表＋旧フィールド）を返す。**判定に「人が1人以上いること」を混ぜないこと** — 全員を名簿から外した日が導出へフォールバックして勤務表から全員復活する（Firebaseは空オブジェクトを保存しないので再読込後も同じ経路に落ちる）。同じ理由で `plFix` の再スナップショット条件も `!p.fixed` だけを見る。
- **読み取りのために `plFix()` を呼ばないこと。** `plFix` は名簿を固定する副作用を持つので、表示・ダイアログの初期値取得には `plPeople(ds)[name]` を使う。以前 `plEditMemo` がこれを誤り、メモを開いて閉じただけでその日が勤務表に追随しなくなっていた。
- **HDの役割コードは `plHdRole(code)` を通す**（`HD_DAY_CODES` と `'準'` 以外は空＝役割なし）。勤務表に `shift:'CE'` かつ `hd:'day'` の行があるとHD側にも載るため、素通しすると役割名として `'CE'` や内部値がそのまま画面に出る。`plDerive`・`plSpot`・`plMove` の押し出し判定の3か所で同じ式を使う。`plFix(ds)` が書き込み前に必ず呼ばれてスナップショットを取る。あとから勤務表を直したときは `plResync(ds)` が差分（追加／除外／勤務コード変更）を出して確認のうえ反映する——**担当枠に入っている人の割り当ては変えない**。
- **旧フィールドは消さない。** `plDerive()` が読み出し時に吸収する（`ensureStaffZone` と同じ方針）。`staffZone.ce[名前]==='hd'` は「HDへ応援（受け取り済み）」、`staffZone.hd[名前]==='to_ce'` は「CEへ応援」として読む。`hdDuty.overrides` の `{元の人:差し替え後}` は、元の人を名簿から外して差し替え後の人にその役割を持たせる形に読み替える。**`spot` を空にしてHDへ移すと、CEの勤務コード（`shift='CE'`）が役割名として表示されてしまう** ので、応援は必ず `spot:'応援'` を入れる。
- **提供 → 受け取りの2段階**。`plOffer(ds,name,to)` は**どの持ち場からでも呼べる**（未割当・担当枠・フリー枠・ゾーンのいずれからでもメニューに出す）。冒頭で `plClearSpot()` を通すので、担当枠から直接出したときはその割り当てが外れる——ここを通さないと担当枠に名前が残ったまま提供中にもなり、1人が2か所に居る状態ができる。自分側の余剰に残したまま `offer` を立て、相手側の「⇦ 提供されています」枠にも出す（同じ人が2か所に見えるのはこの状態だけで、意図的）。`plAccept(ds,name)` で初めて `side` が移り `from` が付く。`plCancelOffer()` で取り下げ。**直接ドラッグして相手側へ移すことも許している** — 提供は「相手に判断を委ねたいとき」の手段であって、責任者が両方を見て決める操作を禁じるものではない。
- **HD担当表（`buildHdRoster`/`hdShiftWorkers`）は台帳から作る。** `side==='hd'` かつ `plSpot().kind==='hdrole'` の人だけが並ぶ（余剰・ゾーンの人は配置盤側に出る）。役割は `spot || shift`。行の `<select>` は「その行の担当者を差し替える」操作で、**その行に居た人（`data-derived`）だけ**をHDの余剰へ回してから `plMove(…,{kind:'hdrole',role})` を呼ぶ。**`plMove` 側で「同じ役割の人を押し出す」ことはしない** — 準夜は3名固定のように同じ役割を複数人で持つ枠があり、押し出すと3名のうち1人を触っただけで残り2名が余剰へ落ち、担当表に1枠しか残らなくなる（実際に起きた）。
- 見出しバッジは `.staffz`（`toggleStaffZone()` / `_staffZoneOpen`、既定 `false`）に出す。集計の実体は `plCounts(ds)` ひとつで、`staffZoneCounts()` はその別名。`updateStaffZoneBadge(ds)` が `#staffz-badge-staff` / `#staffz-badge-unassigned` だけを差し替える。
- **スマホのドラッグは長押し（250ms）で開始する。** `touchstart` で即ドラッグ状態に入ると、以降の `touchmove` を `preventDefault` するせいでチップの上から始めたスワイプがページスクロールにならず、指を離した枠へその人が移動してしまう（配置盤は面積の大半がチップなので誤操作が起きやすい）。長押しが成立する前に8px以上動いたらスクロールとみなしてドラッグ候補を捨てる。
- 監査ログは `plMove`（`人員配置変更`）・`plOffer`/`plCancelOffer`/`plAccept`（`応援の提供`／`取り下げ`／`受け取り`）・`plAddPerson`/`plRemovePerson`（`名簿に追加`／`名簿から除外`）・`plResync`（`勤務表から取り込み直し`）が書く。
- **配置盤は主観で中身を変えない。** `_viewMode` が効くのは「自分側の列を先に並べる」ことだけ（スマホでは自分側が上に来る）。CE主観・HD主観で別の画面を作らないこと——CE/HDの双子関数がこれ以上増えるのを避けるため、`renderPlacementBoard` は1つしかない。

### HD主観モード（`_viewMode`）

`_viewMode`（`'ce'|'hd'`）は端末ローカル設定（localStorage `ce2_viewmode`、`getViewMode()`/`setViewMode(m)`/`toggleViewMode()`）で、`D`には入れずログアウトでもリセットしない。トップバーの `#mode-toggle` ボタン（`updateModeToggleBtn()` が絵文字とラベル・`.hd-on`クラスを付け替え）で切り替える。`renderPage(ds)` は冒頭で `if(_viewMode==='hd'){ renderPageHD(ds); return; }` と分岐する。

`renderPageHD(ds)` はCE版と別の日ページビルダー。並び順は **ヘッダー → イベント → 血液浄化ダッシュボード → HD担当表 → CE担当表（読み取り専用） → 進捗バー → HDチェックリスト → 人員配置管理 → 申し送り**。「今日の件数と人員」を上にまとめたいのでHD担当表をダッシュボードの真下に置いている（HD担当表のイベント委譲は `innerHTML` 差し込み後に `#hd-roster-wrap` を引き直しているので、組み立て順を変えても動く）。人員配置管理は `renderPlacementBoard` をCEとそのまま共有し、申し送りは `dat.memos` をCEと共有する。**`#dg`/`#pool-chips`/`#ops-grid` は絶対に作らない**（`buildDG`はnullチェックが無くこれらのidが無い状態で呼ぶと例外になるため、呼ばない。`buildOPS`はnullガード付きなので将来的にHD側で使うこと自体は可能）。CE専用の`#dcl`/`#wcl`（`buildCL`が対象、nullガード無し）とは別に、HD版の`#hdcl`/`#hdwcl`は`buildHdCL`が冒頭で`if(!el) return;`する独自実装なので作ってよい。

`dat.hdDuty = { overrides: { 元の氏名: 差し替え後の氏名 } }` — HD担当表の手動修正（`hdRosterRowHTML`の`<select>`）。`dat.hdNotes = { 実効氏名: 'テキスト' }` — 担当表の備考欄。どちらも`saveDPage(ds)`。`buildHdRoster(ds)`は`hdShiftWorkers(ds)`（`getShiftForDay(ds).hd`に`hdDuty.overrides`を適用した実効HD勤務者一覧。HD担当表と余剰人員パネルの両方がこの1関数を共通の入口にする）を`HD_DAY_CODES`順にソートして返す。

**血液浄化の実施件数（`dat.hdCount`）**：その日に実施した血液浄化の回数を区分ごとに数える（スタッフ数ではない）。`{ day, night, bw, ward }`（数値文字列を直接入力）＋ `sp`（特殊治療名の配列、`D.hdTreatments`から選ぶ。**配列の長さがそのまま件数**）。読み取りは必ず `hdCountN(v)`（数値化）／`hdCountSpArr(dat)`（Firebaseの疎配列→オブジェクト化対策。`ensureStaffZone`等と同じパターン）を経由する。`sp`を書き換える前には`hdCountEnsureSpArr(dat)`で実配列に正規化してから push/splice する。保存は`saveDPage(ds)`（`buildOPS`の`ops_cards`カード方式には乗せない——HD日ページには`#ops-grid`もカード追加/削除UIも無いため独立実装）。表示は`renderPageHD`内の`#hd-count-panel`（`.hdash`、安定要素で中身だけ`hdCountPanelInnerHTML(ds,dat)`が差し替える）：既定は**数字タイルを5枚横並び**にしたダッシュボード、`✏️編集`で5行の入力フォームに変わる（開閉状態はモジュール変数`_hdCountOpen`、非永続）。**0件の区分は`.hdash-tile.zero`で彩度を落とす** — 実際に実施した区分へ目が行くようにするための減算で、意図的な差。**特殊治療は件数だけでなく治療名をタグで出す**。同じ治療が複数あれば `PMX ×2` に集約する。**治療を選ぶ前の空行は件数から除く** — 読み取りは必ず `hdCountSpFilled(dat)`（＝`hdCountSpArr(dat).filter(Boolean)`）を通すこと。`hdCountSpArr` は編集フォームの行数をそのまま返すので、行の描画にだけ使う。編集中は入力のたびに全体を再描画せず `.hdash-total b` の合計だけ差し替える（フォーカスを保つため）。ロックは新規IDを作らずCE側の`ops`ロックを流用。マスタ`D.hdTreatments`は`D.wdDepts`と同型の単純文字列配列（Dの5箇所ルール＋バックアップ3配列に登録済み）。

**HD集計（`renderHdSummary()`）**：`dat.hdCount`の期間集計。📈 集計タブ（`pane-sum`）の `subpane-hd` にCE集計・OC集計と並べて置く。**主観でもパーミッションでも出し分けない**——集計は「どちらの目で見るか」に依らない事実なので、CE主観からもHD集計が見える（逆も同様）。集計の骨格は`renderOCSummary()`と同型（`sumRange()`/`sumDsList()`/`sumCtlHTML('hd')`/`sumMonthKeys()`を共有、グラフ無し）。詳細は Summary Period 節を参照。

**HDモードのタブ構成**：**タブの並び自体は主観で変わらない**（予定 / 担当表 / 集計 / タスク / 資料、＋管理者専用タブ）。主観で切り替わるのは担当表タブの中のサブタブだけで、`updateTabVisibility()` が HD主観で `subtab-at`（CE担当表）と `subtab-fair`（公平性）を隠す。管理者専用タブはHD主観でも管理者には出したままにする（モード切替はボタン1回なので締め出さない）。マスタタブ（`master`）はタブ自体は両モードで出し、**中身のセクションを `data-mode` で出し分ける**（pane-master Section Gating 節を参照）——HD主観ではHD共通業務・HD曜日別業務・HD特殊治療マスタと、CE/HD共通の設置部署マスタだけが残る。

**マイ担当（`renderMySchedule`）は担当表と同じ表示月（`asY`/`asM`）の1か月だけを出す。** 以前は「当月1日〜今日+30日」の固定窓で、月ナビ（`‹ ›`）を動かしても中身が変わらず常に2か月ぶんが混ざっていた。`asPrevM()`/`asNextM()` は `#subpane-my` が表示中なら `renderMySchedule()` を呼び直す。表示対象のスタッフは `_mySchedName`（非永続、ログアウトで破棄）にキャッシュし、「変更」ボタンは `_mySchedPick=true` を立てて選択画面を強制表示する — このフラグが無いと、アカウントが自分のスタッフ名に紐づいている人（＝ほぼ全員）は `_mySchedName` を空にしても即座に自分へ再解決され、ボタンが無反応に見える。

**マイ担当（`renderMySchedule`）はHDの役割も出す**：CE担当枠（`getDutyCfg`＋`dat.duties`）とスケジュールブロックに加えて、`buildHdRoster(ds)` から自分の行のシフトコード（M・A1・準夜等）を `🩸 ` 付きで並べる。**`_viewMode` で分岐させない** — その人がその日HD勤務かどうかは主観と無関係な事実で、HD勤務が無い人は `getShiftForDay(ds).hd` に載らず何も出ない。`buildHdRoster` 経由なので `dat.hdDuty.overrides` の手動修正も反映される。

**CE⇄HD 相互参照（読み取り専用の担当表）**：同じ日の同じ現場を別主観で見ているだけなので、相手側の割り当ては見えるべき、という方針。`ceRosterRefHTML(ds,dat)` がHD日ページに「🩺 CE担当表」（`getDutyCfg`＋`dat.duties`、枠の色は`dutyColorFor(slot)`）を、`hdRosterRefHTML(ds,dat)` がCE日ページに「🩸 HD担当表」（`buildHdRoster(ds)`＋`dat.hdNotes`）を出す。どちらも**`<select>`/`<textarea>`を使わないテキスト表示**で、編集はそれぞれの主観の自分の担当表で行う。折りたたみの外枠は人員配置管理と同じ`.staffz`シェルを流用（新規CSS不要・見た目も揃う）、開閉は`_ceRefOpen`/`_hdRefOpen`（非永続、既定は閉じる）。対象が0件のときは見出しごと出さない。印刷CSSでは`#ce-ref-body`/`#hd-ref-body`を`#staffz-body`と同様に強制表示する。

**カレンダーの完了ドットは主観に追従する**：`renderCal()` の日セル判定は `pctForView(ds)`（`_viewMode==='hd' ? getHdPct : getPct`）を通す。HD勤務者にCEの未完了を見せても意味が無いため。`setViewMode` と `updHdProg` の両方が `renderCal()` を呼んで塗り直す。**担当表（`renderAT`）はCE専用画面なので `getPct` のまま**——ここを `pctForView` にすると、HD主観で担当表を開いたときに日付セルの色だけHD基準になってしまう。

**申し送りセクションのマークアップは `memoSectionHTML(ds, mlk)` に集約**：CE版とHD版が同一の `dat.memos` を共有しており、以前は両方に逐語的な複製があった。とくに患者情報を書かせないための注意書き（`.memo-notice`）が2箇所にあると、片方だけ文面を直したときにもう一方の主観に古い注意書きが残る。**患者安全に関わる文言なので複製を戻さないこと。**

**未返却タブレットの台数は `tabletUnreturnedCount(ds)` が唯一の集計元**：ヘッダーバッジ・CE日ページ・HD日ページが同じ数を出す必要がある。以前は同じ式が3箇所に複製され「完全に同じにすること」というコメントで支えられていた。

**申し送り・スケジュール・掲示板・イベントのCE/HD分離**：どれも「読む相手が違う」ため分ける。関数は複製せず、主観で切り替えるアクセサ1組で扱う（`dat.checks`のような添字の共有規約が無いので複製が不要）。

| 対象 | CE | HD | アクセサ |
|---|---|---|---|
| 申し送り | `dat.memos` | `dat.hdMemos` | `memoKey()` / `memosOf(dat)` / `ensureMemos(dat)` |
| スケジュール | `dat.schedule` | `dat.hdSchedule` | `schedKey()` / `schedOf(dat)` / `ensureSched(dat)` ＋ 列は `schedColumns(ds,dat)` |
| タブレット台帳 | `D.tablets` / `dat.tabletLogs` | `D.hdTablets` / `dat.hdTabletLogs` | `tabletMaster()` / `tabletLogsOf(dat)` / `ensureTabletLogs(dat)` |
| 掲示板 | `/board` の投稿（`kind`無しまたは`'ce'`） | `/board` の投稿（`kind:'hd'`） | `boardKindOf(p)` / `boardInView(p)` / `boardReadKey()` |

- **掲示板だけは保存先を分けない。** `/board` 1つのまま投稿に `kind` を付けて振り分ける——**Firebaseのセキュリティルールを触らずに済み**（別パス新設は管理画面での手作業が要る）、既読・ピン留め・タグ・返信の仕組みをそのまま使えるため。`renderBoard`/`boardUnreadCount`/既読マークの3箇所すべてで `boardInView` を通す（画面に出ていない投稿を既読にしないため）。
- **`kind`／`hdMemos`／`hdSchedule` が無い既存データは全てCE扱い**になるので、移行処理は不要。
- **読み取りは `*Of`、要素を足し引きするときは `ensure*` を使う。** `memosOf`/`schedOf` は `normArr` を通すため、Firebaseがオブジェクト形状で返したときには**正規化した別配列**を返す。その戻り値に対して `splice`/`push` しても元データは変わらないので、削除が効かない・移動すると移動元に残って二重になる、という形で壊れる（`delMemo`/`moveMemo` で実際に起きていた）。`ensure*` は `dat[k]` を実配列に置き換えてからその実体を返すので、破壊的操作はこちらを通すこと。
- **`*Of` / `ensure*` アクセサは必ず `normArr(v)` を通す。** Firebaseは疎な配列をオブジェクトとして返すことがあり（`ensureStaffZone` で実害が出たのと同じ罠）、`Array.isArray` だけで判定して空配列に差し替えると**既存データを破壊する**。`renderSched` は開くたびに `ensureSched` を呼ぶため、その日のスケジュールが消える事故になる。
- **既読の基準時刻も主観ごとに分ける**（`boardReadKey()` が `ce2_boardread` / `ce2_boardread_hd` を返す）。1つのキーを共有すると、HDの掲示板を開いただけでCEの未読バッジが0になる。
- **`schedImportDuties`（🔄 業務割当から取込）はCE専用。** 取り込み元の `dat.duties`/`getDutyCfg` がCEのデータなので、HD主観ではボタンを出さず実行側でも弾く（通すとCEの担当枠が `hdSchedule` に流れ込む）。
- 掲示板・スケジュールのパネルは同じモーダルが主観で別スレッドを映すので、**見出しに主観を出す**（`📢 掲示板（CE/HD）`／`🩺 CE|🩸 HD …のスケジュール`）。
- `setViewMode` は掲示板のバッジ更新と、開いていればパネルの再描画も行う。
- **横断検索と自動削除のメディア掃除は両スレッドを走査する** — 検索は「どこかに書いたはず」を探す機能なので主観に関係なくヒットさせ、掃除は片方だけだと添付がStorageに残り続けるため。
- **マイ担当（`renderMySchedule`）も両方のタイムテーブルを見る**（HD分は`🩸`付き）。自分の予定であることは主観と無関係なので。

**イベントはCE/HD共通で見せ、登録した側で色分けする**（`evtAreaHTML(ds,dat,allEvts)`／`evtKindOf(dat,name)`）。同じ日の同じ現場の予定なので両方から見えるべきだが、どちら発かは分かったほうがよい。出所は `dat.evtKinds = { イベント名:'hd' }` の**別マップ**で持つ——イベント本体は文字列の配列（`dat.events` / `D.evts[ym][day]`）で既存データが入っているため、形を変えずに横へ足せる。**印が無いものはCE扱い**（CE発＝橙・📅／HD発＝紫・🩸）。`removeEvt` は削除時に印も片付ける。

**人員配置管理は主観で中身を変えない（`renderPlacementBoard`）**：CE列とHD列を1枚に並べ、`_viewMode` は**並び順だけ**を変える（自分側を先に置くので、スマホでは自分側が上に来る）。以前は主観ごとに「上のチップ行」と「折りたたみのソースパネル」を入れ替えて出し分けていたが、同じものを2通りに描き分ける必要は無くなった。開閉（`#staffz-body` / `toggleStaffZone()` / `_staffZoneOpen`）と見出しバッジ（`#staffz-badge-staff` / `#staffz-badge-unassigned`）はCE/HDで共有する。**開閉の矢印は必ず`id`で引く**（`#staffz-arrow`/`#ce-ref-arrow`/`#hd-ref-arrow`）——HD日ページには`.staffz`シェルを流用したセクションが複数並ぶため、`querySelector('.staffz-arrow')`で先頭1つを取ると別セクションの矢印が反転して本体と食い違う。

> **⚠️ チェックリスト周りを次に変更するときは、機能を足す前に双子関数の共通化を先に行うこと。**
> CE版とHD版の双子関数が33組あり、うち14組は変数名を置き換えると1文字も違わない完全な複製（`mkCk`↔`mkHdCk` 95行、`clStatus`↔`hdClStatus`、`getPct`↔`getHdPct`、`remapDlyChecks`↔`remapHdDlyChecks`、`remapWdChecks`↔`remapHdWdChecks`、`wdOnceDoneOn`↔`hdWdOnceDoneOn`、`togWdWeek`↔`togHdWdWeek`、`setWdWeeks`↔`setHdWdWeeks` ほか）。26組が95%以上一致。
> **片方だけ直しても例外は出ず、CE主観で動作確認すると正常に見えるため気づけない** — HD主観で開いた透析スタッフだけが古い挙動に当たる。チェックリストは機器点検の記録なので、月次リセット絡み（`wdOnceDoneOn`）でズレると月末まで発覚しない。
> 共通化の方針：関数を引数で分岐させるのではなく、**名前空間の記述子**（`{dlyKey:'dly', wdKey:'wd', checksKey:'checks', prefix:''}` のような組）を渡す形にする。`wdText`/`dlyText`/`itemRebuild`/`isDlyShownOnDate`/`wdApplies` などは既に「渡された項目オブジェクトだけを見る純粋な関数」なので、そのまま両方から使える。
> 優先度：`mkCk`（最大かつ最も触られる）→ `clStatus`/`getPct`（進捗率の計算）→ `remap*`（マスタ並べ替え時のチェック移動。壊れるとデータが消える）→ 残り。上位4組でリスクの大半が消える。
> 2026-08-23 時点でズレは発生していない（`renderDlyList`↔`renderHdDlyList` と `buildCL`↔`buildHdCL` の差は下記の意図的なもの）。

**HDチェックリスト（`D.hdDly`/`D.hdWd` + `dat.hdChecks`）**：CE側（`D.dly`/`D.wd` + `dat.checks`、[Checklist Items & Week-of-Month Filtering](#checklist-items--week-of-month-filtering) 節を参照）とは名前空間もdat上のキーも完全に別。**`dat.checks`に相乗りしてはいけない** — `remapDlyChecks`/`remapWdChecks`は`D.dly.length`基準の固定オフセット規約に強く依存しており、HD項目をその末尾に継ぎ足す実装にするとCE側マスタを1回並べ替えるだけでHD側のチェックが全部ずれる／消える。別キーにすることで、CE側マスタ編集は`dat.checks`しか触らずHD側は自動的に無傷になる（逆も同様）。

- `wdText`/`dlyText`/`dlyNotif`/`itemRebuild`/`isDlyShownOnDate`/`wdWeeks`/`wdOnce`/`wdSubs`/`wdSid`/`newSid`/`nthWk`/`isLastWeek`/`wdApplies`/`wdSubProgress`/`renderSubPanel`は渡された項目オブジェクトだけを見る純粋な関数（`D.dly`/`D.wd`を直接参照しない）なので、CE版をそのままHD版にも使い回す。`renderSubPanel`が書く`dat.subChecks`と設置部署マスタ`D.wdDepts`もCE/HD共通——院内の部署は主観と無関係なため、ここだけは別マスタを持たない。
- HD版だけ新規に用意した関数：`hdWdEntriesForDate`/`hdWdItemsForDate`/`hdWdOnceDoneOn`（`wdOnceDoneOn`のHD版。`D.dly.length`→`D.hdDly.length`、`pg.checks`→`pg.hdChecks`、`wdItemsForDate`→`hdWdItemsForDate`の3点だけが違う）/`remapHdDlyChecks`/`remapHdWdChecks`（呼ぶタイミングもCE版と同じ非対称性を踏襲：dlyは変更の**前**、wdlyは変更の**後**）/`hdClStatus`/`getHdPct`/`buildHdCL(ds,dat,locked)`/`mkHdCk`/`updHdProg(ds)`（`updProg`のHD版。`#hd-pgf`/`#hd-pgt`/`#hd-pgp`を更新し、CE版と同じく`renderCal()`も呼ぶ）。
- `buildHdCL`は冒頭で`if(!el) return;`する（`#hdcl`/`#hdwcl`が無い状態で呼ばれても安全）ため、CE版`buildCL`と違い呼び出し側でのnullガードは不要。`renderPageHD`から無条件に呼ぶ。
- マスタ編集UI：`renderHdDlyList`/`addHdDly`/`rmHdDly`/`mvHdDly`/`editHdDly`/`togHdDlyDay`（共通業務）と`renderHdWdTabs`/`renderHdWdlyList`/`addHdWdly`/`rmHdWdly`/`mvHdWdly`/`editHdWdly`/`setHdWdWeeks`/`togHdWdWeek`/`togHdWdOnce`/`openHdWdSubsModal`/`saveHdWdSubs`（曜日別業務、選択中の曜日は`_hdSelWd`＝CE版`selWd`のHD版）。`pane-master`の`.sp`直下にCE版と同じ`data-perm="dm"`/`"wm"`の別セクションとして追加する（新規ロックIDは作らない）。**通知設定（🔔）の入力欄はCE版と違い出さない** — `itemRebuild`が`notif`キーを保持できる形状はCE版と揃えてあるが、実際に監視して通知を飛ばす`checkTimeNotifs`側のHD対応は別スコープのため、「設定したのに鳴らない」状態を画面に出さない判断。`confirmEditModal`の`state.type`に`'hdDly'`/`'hdWdly'`分岐を追加。
- `renderPageHD`は`buildHdCL(ds, dat, clk)`を呼ぶ（`clk = !can('cl')`、CE版と同じ`cl`ロックを流用）。チェックリストのラッパー`<div class="clg">`はCE版と**同じクラス名**を使う——`dashJump('.clg')`と`closeItems`の`{key:'checklist', sel:'.clg', ...}`が`#main`内を`querySelector`するだけの実装なので、クラス名さえ揃えれば新規分岐なしでHD日ページでも正しくジャンプ・消し込みバー連動する。
- `closeItems(ds)`の`checklist`カテゴリは`_viewMode`で分岐：HDモードは`hdClStatus(ds).undone`を数える（CE版の`clStatus`のままだとCE共通業務がHD日ページの消し込みバーに出てしまう）。`mine`判定もCE側「オペ/カテ担当枠が無い人だけ自分ごと」はHDに担当枠の概念自体が無いため意味を成さず、HDでは`!!self`（自分が特定できていれば自分ごと）に単純化する。`ope`/`cath`/`oc`の3カテゴリはHD主観では**丸ごと数えない**（`if (_viewMode === 'hd') return cats;` で打ち切る）。`dat.ops`/`dat.ocData`はCE・HDで**同じページオブジェクトを共有している**ので、分岐させないとHD日ページでCEの未了が数えられてしまい、しかもジャンプ先（`#ops-card-ope`/`.oc-card`）はHD日ページに存在しないため「→」も「▶次へ」も無反応になる（`dashJump`は要素が無いと黙って何もしない）。

### OPE / カテカード（buildOPS内）

`buildItemList(card, key, masterList, labelName, itemId, withTime, withOrder, withSup, withDept)` and `buildItemListTree(card, key, masterTree, labelName, itemId, withTime, withOrder, withSup)` build per-item rows inside an ops card.

- OPE card: `withTime=true, withOrder=false, withSup=true`
- カテ card: `withTime=true, withOrder=false`（入室時間ドロップダウン表示）

**入室時間ピッカー**: `withTime=true` の行は、カテのブリーフィング欄と同じ「○時：△分」の2セレクト方式（`makeTimeHourOpts`/`makeTimeMinuteOpts`）。○は8〜16時＋AM／PM、△は0〜55分（5分刻み）＋OC。値は `item.time` に単一文字列で保存（`combineItemTime(h,m)` で結合、`parseItemTime(t)` で復元。旧形式 `"8:15"` `"AMOC"` `"PMOC"` も読める）。「自由入力」ボタンで `item.time='__free__'` に切替えるとテキスト入力（`item.timeTxt`）に変わる。`buildItemList` / `buildItemListTree` の両方に実装。

**科・中カテゴリ・術式の自由入力**: `buildItemListTree` の3セレクト（科/中カテゴリ/術式）はそれぞれ独立に「自由入力...」へ切り替えられる（入室時間と同じ`'__free__'`＋`*Txt`の型）。科は `item.dept==='__free__'` で `item.deptTxt`、中カテゴリは `item.cat==='__free__'` で `item.catTxt`。術式は既存の `item.sel`（マスタ選択値）とは別に `item.name==='__free__'` のときだけ `item.nameTxt` を使う（自由入力に切替えた瞬間 `item.sel` は空にするため、既存の「マスタから選んだ値」の読み出しには影響しない）。切替後は⌄ボタンで選択式に戻せる。フラット版 `buildItemList` は元々 `item.sel==='__free__'`→`item.txt` で自由記述に対応済みで、これも同じ枠組みで吸収する。表示・集計は必ず `opsItemDept(it)` / `opsItemCat(it)` / `opsItemName(it)` を経由し（`'__free__'`という内部値が画面・CSVに出ないようにする）、`opsItemFilled(it)` もこの3つのヘルパー経由に統一済み。横断検索（`_doSearch`）も同じ3ヘルパーを経由してヒット判定する — `item.sel`/`item.name` を生のまま文字列比較すると自由入力とマスタ選択のどちらか一方を取りこぼす。tree導入前の生 `item.sel` のみのデータ・旧仕様で科全体を自由記述にしていたデータ（`item.dept==='__free__'`のまま`item.sel`に実データが残る旧形）は「（旧）」表示＋再選択ボタンで保護し、値を消さない。

**症例ごとの備考**: `item.note`（1症例=1行ごとの備考、`buildItemList`/`buildItemListTree` 共通）。値が空なら「＋備考」リンクのみ表示し、1文字でも入っていれば開いたまま（担当カードの備考欄と同じ開閉パターン）。カード全体で1つだけの旧仕様（`ops.ope_note`/`ops.cath_note`）は新規作成不可になったが、既存値があるカードだけ「📝 備考（旧・カード共通）」として表示・編集を残す（値は消さない）。横断検索も `item.note` を対象に含む。

**使用物品の折り返し表示**: `item.sup`（カンマ区切りで直接入力する `<input>`）は仕様上1行しか見えず、品目を入れすぎると未フォーカス時に枠外が見切れる。`supViewHTML(supArr)`（`opsItemSup` の直後で定義）が入力欄の下に読み取り専用の折り返しビュー（`.ops-sup-view`）を生成する — 各品目を `.sup-tok`（`white-space:nowrap`）で包むことで、品目名の途中では改行させず、品目とカンマの間でだけ折り返す。`buildItemList`/`buildItemListTree` 双方の入力（`oninput`/`onblur`/カスケード選択の追記）が値を変えるたびに `supViewEl.innerHTML = supViewHTML(...)` で更新する。

カテカード固定フィールド（`ops.` に保存）:
- `cath_briefing_h` / `cath_briefing_m` — ブリーフィング時間（時・分）、8〜16時・5分刻み
- `cath_note` — 備考

**opeN / cathN の集計ルール**: `ope_items` / `cath_items` の配列長ではなく、`opsItemFilled(it)` が true の行だけをカウントする（科・中カテゴリのみの選択、自由記述、入室時間、順番、使用物品、担当者、終了時刻など何らかの入力があれば1件。完全に空の初期行は除外）。`updateOpsHeader()`・`renderPage()`・`renderOpsSummary()`・`opsDetailRows()`・`exportOpsCsv()` すべてでこの共通ヘルパーを使用する。

**症例行の取得は必ず `opsItemsOf(pg, 'ope'|'cath')` を経由する**（`pg.ops.ope_items` を直接読まない）。`pg.ops_cards` が配列で、その中に当該カードが無ければ空を返す — カードを削除した日の残骸を数えないための門で、フリーカードの `opsFreeCards(pg)` と同じ方針。`ops_cards` が `null`/`undefined` のときはテンプレ表示中なので従来どおり全部数える（ここで `D.opsCfg` を見に行かないこと。テンプレからカードを1つ外すだけで、過去の全ページの件数が集計から消えてしまう）。`removeOpsCard()` 側でもオペ/カテを消すときは入力済み症例数を出して `confirm()` し、OKなら `ops.ope_items`/`cath_items` ごと削除する（PSG・フリーと揃えた）。**横断検索（`_doSearch`）だけは意図的に `opsItemsOf` を通していない** — 「どこかに書いたはず」を探す機能なので、カードを消した日の記録もヒットさせる。

**症例ごとの印（急患・スコープ）**: `item.emergency` / `item.scope`（true のときだけ持つ）。**オペカードのみ**に出す（`buildItemMetaRows` の `itemId === 'ope'` で分岐。カテには概念が無い）。`.ops-done-btn` と同じ作りのトグルで、`.ops-tag-btn.em` / `.sc` が色だけ変える。**`opsItemFilled()` に `it.emergency || it.scope` を含めてある** — 含めないと「急患だけ押して他は未入力」の行が件数・明細・CSVから丸ごと漏れる。集計側は `opsDetailRows()` の `emergency`/`scope`、フィルタは `_opsDetFilter.emOnly`/`scOnly`、CE集計のサマリーバッジと明細の「印」列（`opsTagLabel`）、`exportOpsDetailCsv` の2列。

**業務終了フラグ・担当者・終了時刻**: 各術式/種別行に「終了」トグルボタンがあり、`item.done = true` で行全体（`.ops-item-wrap.ops-item-done`）が薄暗く表示される。件数カウントには影響しない。`buildItemList` / `buildItemListTree` の両方に実装。付随動作:
- `opsToggleDone(items, idx)` — 押した行は配列内の位置を変えずその場に残す（どれを押したか見失うため並べ替えはしない）。終了にした瞬間、`item.endTime` が未設定なら現在時刻（0時からの分）を、`item.staff`（担当者名の配列）に誰もいなければ `opsSelfName()` で解決したログイン中スタッフ名を自動追加し `item.doneBy` にも記録する。取り消し時は `endTime`/`staff` のどちらかに値があるときだけ `confirm()` で確認し、OKなら `endTime`/`doneBy`/`staff` を全てクリア、キャンセルなら `done` フラグだけ外して他は残す（値が無ければ確認なしでそのまま外す）
- `item.staff` は行の「👤 担当者」行（常時表示、`buildItemMetaRows()` が Tree版・フラット版共通で描画）でチップの追加・削除が手動でも可能。候補は `opsStaffCandidates(ds)`（当日の `duties`/`extra_free`/`ocData.staff` を「本日の担当」、`D.stf` を「スタッフ」としてoptgroup分け）。Firebase の配列オブジェクト化対策として読み出しは必ず `opsItemStaff(it)` を通す
- `item.endTime`（終了時刻、0時からの分）は `done || endTime != null` のときだけ「🏁 終了」行を表示し、`<input type="time">` で手動修正できる（`schedMinToHM`/`tabletHMToMin` を流用）。入室時間 `item.time` とは別物 — `item.time` は `'8:15'`/`'AMOC'`/`'PMOC'`/自由入力という予定を大づかみに入れる語彙で実時刻を表せないため、所要時間計算のために分単位で別途持たせている（`opsItemStartMin(it)` が入室時間を分に変換、表せない値は `null`）
- `updateOpsCardDoneBadge(cardEl, items)` — 入力済み全行が終了ならカードタイトルに「✅ 本日終了」バッジ（`.ops-card-done-badge`）を表示
- ヘッダーチップは終了数があると「🔪 オペ 2/3件終了」形式になり、全件終了で緑色+✅表示（`opsHeaderChips` の第6・7引数 `opeDone`/`cathDone`）

**フリー業務カード**: `buildFreeCard(uid)` は本文 `ops['free_'+uid]`（単一文字列）に加え、`.ops-ttl` 内に業務名入力欄（`ops.freeNames[uid]`）を持つ。カードの走査（件数集計・削除）は必ず `opsFreeCards(pg)` / `opsFreeFilled(f)` を経由する — `ops` のキーを直接 `indexOf('free_')===0` で走査すると、`removeOpsCard()` でカードを消した後も本文が残って集計され続けるバグを再発させる（`opsFreeCards` は `pg.ops_cards` が配列ならそれを正として走査し、削除済みカードの残骸を数えない）。

### 業務集計サブタブ（renderOpsSummary）

`_opsSumView`（`'day'|'detail'`、既定 `'day'`）で日別ビュー（既存・週/月別グラフ＋日別テーブル・印刷対象）と明細ビューを切替。明細ビューは `opsDetailRows()`（期間内の全 `ope_items`/`cath_items` を `{ds,kind,dept,cat,name,startMin,endMin,dur,staff,sup,done}` に平坦化、`opsItemFilled` で採否を揃える）と `_opsDetFilter`（種別/科/担当者/使用物品/終了済/グルーピング）を `renderOpsDetailBody()` が描画。集計カードは科別・術式別TOP10・担当者別（所要時間の平均は入室と終了が両方揃った行のみ算入）・使用物品別（カテには使用物品欄が無いため常にオペのみ）の4枚。CSVは `exportOpsCsv()` が `_opsSumView` で `exportOpsDetailCsv()` に分岐する。

### 担当表の色分け（dutyColorFor）

担当枠の色はどこにも保存せず、`dutyColorFor(slot)` が呼ばれるたびに導出する（`DEF_DUTY_MASTER`/`D.dutyCfgMaster` に色を持たせると既存環境の保存済みデータに届かずマイグレーションが要るため）。既定枠（`slot_ope`〜`slot_late_free`）は `DUTY_COLOR_MAP` で旧 `.dc-*` と同じ色、カスタム枠は `id` の安定ハッシュで `DUTY_PALETTE` から選ぶ（並び順や `customDuties` の配列位置に依存させると同じ枠が日によって色が変わるため index は使わない）。凡例は静的HTMLではなく `renderAtLegend(adates)` が実際にその期間で使われている枠から生成し、`renderAT()` の早期return（連絡表が無い月）より前に呼ぶ。

### On-Call (OC) 対応済み判定

`D.pages[ds].ocData` is a single object (one OC record per day): `{staff, note, done, kind, startTime, endTime, nenkyu}` (plus a dead legacy `time` that nothing writes).

**対応は2種別（`ocData.kind`）**：`'dispatch'`（🚑 OC出動対応＝病院からのコールで出動）と `'leftover'`（🕔 残り当番＝日勤帯で終わらない手術の残りを引き継ぐ）。日ページでは横並びの2つのチェックボックス（`#oc-done-dispatch` / `#oc-done-leftover`）で**排他選択**する。対応時間（開始・退勤）と年休の欄は**両種別で共用**で、どちらにチェックを入れたかで計上先が変わる。

- **`done` を false にするときも `kind` は消さないこと。** `ocSyncFromTimes` は「開始と退勤が両方揃っているか」で done を切り替えるので、退勤を打ち間違えて消す・開始を直すといった操作のたびに done=false を通る。そこで kind を捨てると、次に true へ戻ったとき既定の出動対応に化け、残り当番として記録したはずの日が黙って書き換わる（実際に再現した）。done=false の間は kind が残っていても画面にも集計にも出ない（どちらも done で判定するため）
- **読み取りは必ず `ocKind(od)` を通す**（`kind` を持たない過去の記録はすべて出動対応として読むので、移行処理は不要）。表示名は `ocKindLabel(k)`、アイコンは `ocKindIcon(k)`
- 残り当番をONにしたとき `startTime` が空なら `OC_LEFTOVER_START`（`'16:45'`）を入れる。日勤から引き継ぐのでそこから退勤までが対応時間になる（手で直せる）
- **翌日の出勤ルール（`calcOcNextDayRule` / `notifyOcRule` / `ocAlertFor`）は種別を見ない**。実際に遅くまで働いた事実は同じなので両方に適用する。文言にだけ種別を出す
- 「✅対応済」のような種別非依存の文言をUIに書かないこと。ダッシュボードチップは `renderPage` の初期描画と `updateOcDashChip` の**2か所**にあるので、片方だけ直すと開いた直後だけ古い表記が出る

`done` と `kind` is written from two places — the 対応 checkboxes and the 開始/退勤 time inputs — so **every write goes through `ocSetDone(ds, val, kind)`**, which updates `ocData.done`/`.kind`, auto-fills 16:45 for 残り当番, `saveD()`s, syncs the checkbox DOM (`syncOcKindCheckboxes` — 排他はここで担保する), refreshes the dashboard chip (`updateOcDashChip`), calls `updateCloseBar` and `notifyOcRule`, and fires the admin notification **only on the false→true edge**. `kind` を省略すると現在の種別を保つ（未設定なら `'dispatch'`）。

- The 対応時間/年休 block (`#oc-done-detail`) is now **always visible**. It used to be revealed only when the checkbox was ticked, which made "enter the leave time and it's done" impossible.
- Entering both `startTime` and `endTime` sets `done`; clearing either one clears it. Ticking the checkbox by hand still works with no times entered (the tick-first-fill-later workflow is intact).
- Un-ticking by hand `confirm()`s before wiping `startTime`/`endTime`/`nenkyu`; cancelling keeps the times. Previously they were destroyed silently.
- `exportOcCsv` must format the time column from `startTime`/`endTime` the same way `renderOCSummary` does — reading the legacy `oc.time` alone leaves the column permanently blank. 種別列も `ocKindLabel(ocKind(oc))` で同じ表記にする。
- OC集計（`renderOCSummary`）のバッジ・月別内訳・明細はすべて種別ごとに分けて数える。「対応件数」という種別をまたいだ数え方に戻さないこと（分けるのが今回の目的）

### PSG外し Detection

```js
var prevDs = getPrevDs(ds);
var prevDat = D.pages[prevDs];
var isPsgRemoval = !!(prevDat && (
  (prevDat.ops_cards && prevDat.ops_cards.indexOf('psg') !== -1) ||
  (prevDat.ops && prevDat.ops.psg_on)
));
```

Used in: `buildDG` (duty card checkbox), `updateOpsHeader` (header chip), `updatePsgRemovalBanner` (persistent banner). The banner shows only when `ds === todayStr` and `nowMin` is within `[psgBannerStart, psgBannerEnd)`. Called every minute via `runPsgFusenCheck()`.

### Dashboard Jump（`dashJump(sel)` / `dashJumpTop(el)`）

Used by the day-page dashboard cards (✅進捗/📊業務/📞オンコール/📝申し送り, each `.dash-chip`) and the 消し込みバーの各行・「▶ 次へ」ボタン to scroll to and 2-second-highlight (`.dash-highlight`) a target element inside `#main`.

**Why not `scrollIntoView`**: `#main` has `overflow:auto`, so on narrow (mobile) viewports the browser's "nearest scrollable ancestor" search for `scrollIntoView` stops at `#main` and never reaches the container that actually needs to scroll. `dashJumpTop(el)` instead re-measures on every call which container is truly scrollable (`mainEl.scrollHeight > mainEl.clientHeight` → use `#main`, else `document.scrollingElement`) and computes the target offset itself (element position minus the fixed `.tb` top-bar height).

`dashJump(sel)` queries `sel` inside `#main` only (avoids false hits from same-selector elements elsewhere in the DOM), scrolls via `scrollTo({behavior:'smooth'})`, then re-measures and snaps to the exact position 400ms later — a safety net for environments where smooth-scroll doesn't animate or stops short, since layout can shift mid-animation and the click-time offset would otherwise be stale.

### 担当表ピンチズーム

Structure: `.ato#ato-wrap` > `#at-zoom-inner` > `#at-body` (table content).

- During pinch: applies `transform: scale(ratio)` with `transform-origin` at the pinch midpoint (GPU-accelerated, no reflow)
- On `touchend`: commits to `zoom` property and corrects scroll position; 8-frame `requestAnimationFrame` relock overrides iOS's async `scrollTop` adjustment
- Button clicks: ease-out cubic animation over 10 frames via `_atZoomAnimRAF`
- `_atZoom` global tracks current zoom level (0.25–3)

### Schedule Timetable

Vertical time axis 8:00–21:00 in 15-min steps, one column per on-duty staff. Blocks stored in `D.pages[ds].schedule` as `{ id, staff, label, start, end, color }` (times in minutes-from-midnight). Drag body to move, drag bottom handle to resize.

### Checklist Items & Week-of-Month Filtering

`wdItemsForDate(ds)` returns the weekday items applicable to the given date (text only), filtered by `wdApplies(ds, it)` (week-of-month). `wdEntriesForDate(ds)` returns the same set as `{t, it}` pairs (text + the raw master item) — `wdItemsForDate` just maps it to `.t` — so code that needs to inspect item flags (`once`, `subs`, ...) should call `wdEntriesForDate` instead of re-deriving the list. `dat.checks[]` is indexed against the **original** `D.dly` array positions, not filtered positions.

**`clStatus(ds)` is the single counting entry point** for done/total. It returns `{done, total, undone, exists}` (`exists:false` when `D.pages[ds]` doesn't exist, distinguishing "no page → 0%" from "page exists but 0 items → 100%"). `getPct(ds)`, the dashboard progress chip, and `closeItems(ds)`'s checklist category all call it — none of them re-implement the counting loop. Previously the same counting logic was duplicated across ~4 call sites, and one of them silently ignored `skip_wd`/`skip_sat`/`skip_sun` (weekday-exclusion settings on common tasks), making the progress bar and its text disagree on the denominator on days affected by those settings. When writing new code that needs done/total, call `clStatus(ds)` — do not re-iterate `D.dly`/`D.wd` by hand.

```js
// clStatus's internal pattern (do not duplicate elsewhere — call clStatus instead):
for (var i = 0; i < D.dly.length; i++) {
  if (!isDlyShownOnDate(D.dly[i], ds)) continue;
  total++;
  if (dat.checks && dat.checks[i]) done++;
}
var ents = wdEntriesForDate(ds);
for (var j = 0; j < ents.length; j++) {
  total++;
  if ((dat.checks && dat.checks[D.dly.length + j]) || wdOnceDoneOn(ds, ents[j])) done++;
}
```

#### `once` / `subs` / `sid` — per-item fields on `D.wd[曜日]` entries

Weekday-master items (`D.wd[曜日][i]`) are either a plain string (legacy) or an object `{t, wk, once, subs, sid, notif, ...}`. **All writes to these items (and to `D.dly[i]`) must go through `itemRebuild(oldIt, patch)`** — it merges `patch` into a copy of the existing item (a `null`/`undefined` value in `patch` deletes that key) and collapses back to a plain string if only `t` remains. Building the replacement object inline (e.g. `{t:..., notif:...}`) instead silently drops any key not mentioned — this exact bug previously wiped `once`/`wk`/`subs` when only toggling notifications, and vice versa.

- **`once:true`** ("月内どれか1回でよい" — only one occurrence in the month needs doing) is only allowed when `wk` (week-of-month restriction) is set; going back to "毎週" auto-clears it. `wdOnceDoneOn(ds, ent)` looks for whether the item was already checked on an earlier applicable date **in the same month** — it only scans backward (`d < day`), never forward, so checking a later occurrence can never retroactively flip an earlier day's display (that would look like a past inspection record being rewritten after the fact). Notification firing (`checkTimeNotifs()`'s weekday-item loop, not `runPsgFusenCheck`) also skips items already satisfied via `wdOnceDoneOn`.
- **`subs`** is an array of installed-location names (e.g. department names) for items that need per-location sign-off (e.g. "各部署の生体情報モニタ点検"), selected via checkboxes from the shared **`D.wdDepts`** master (not free-typed per item — an earlier free-text-per-item design was replaced after real-world feedback, since retyping the same ward names on every item invites spelling drift). `openWdSubsModal`/`renderWdSubsModalBody` render one checkbox per `D.wdDepts` entry; `addWdDeptFromModal` lets an admin add a missing department to the master inline (saved immediately) without leaving the modal — but, like the other checkboxes, whether it ends up in *this item's* `subs` is only decided when `saveWdSubs` is clicked. **`sid`** is a stable id assigned once (`newSid()`) when the list is first saved, and is deliberately kept even if `subs` is later emptied — signoff progress is looked up by `sid`, not by item text, so renaming the item or removing/renaming a department in `D.wdDepts` never breaks the link (mirrors — and is a deliberate fix for — the weakness where `D.manual` keys by task name and breaks on rename). Per-location signoffs live in `D.pages[ds].subChecks[sid][name] = {by, ts}` (a page-scoped field, not a new top-level `D` property — this makes the monthly reset automatic, since `wdSubProgress(ds, sid)` only scans pages within the current calendar month). The parent checklist item itself is **not** auto-checked when all locations are signed off — that requires a manual check.
- The **`once` checkbox is always rendered** in `renderWdlyList()` once `can('wm')`, even when the item has no week restriction (`wk` unset = 毎週) — it's shown `disabled` with an explanatory label/title rather than omitted entirely. It was originally hidden outright when `!weeks`, but the seed data's `月一BSM点検（第二 or 第四）` item is actually stored as a plain string (`wk` unset) despite its name, and with `weeks=null` every week-chip renders as "selected" — so an admin looking at that item saw no obvious next step to reach the `once` option. Showing it disabled-with-reason fixed the discoverability gap.

### 消し込みバー（`.cbar` / `closeItems(ds)` / `updateCloseBar(ds)`）

Fixed bar at the bottom of the screen, shown only while a day page is open — `updateCloseBar(ds)` hides it and clears `body.has-cbar` when `ds` is falsy or `!D.pages[ds]` (e.g. via `showEmpty()`).

`closeItems(ds)` is the **single counting source** for 6 categories of "not finished today": ①自分あてメンションを含む未完了の申し送り（`extractMentions` に自分の名前が含まれ `m.done` でない `memos`） ②チェックリスト未了（`clStatus(ds).undone`） ③オペ終了未チェック（`opsItemFilled(it) && !it.done`） ④カテ終了未チェック（同上） ⑤タブレット未返却（当日分＋`tabletCarryOver(ds)` の前日以前持ち越し分） ⑥オンコール担当未設定（`!dat.ocData.staff`）。各カテゴリは `{mine:boolean}` を持つ `items[]` を返し、`mine` の判定は `taskSelfName()`（表示名がスタッフ名簿と完全一致→その名前／一致しなければ `D.stfLinks` で逆引き）。**アカウントが未紐づけのユーザーは常に `mine:false`**。

**`mine` はその日の担当枠と連動する**（`myDutyLabels(ds)`、`closeItems` 内で1回だけ呼ぶ）。スロットの `id` は「追加」のたびに `'slot_'+Date.now()` で再採番されるため、`dutyColorFor`/`FAIR_MERGE` と同じくスロットの `label` 文字列（部分一致：`オペ|OPE` → ope、`カテ` → cath）で照合する。オペ/カテ担当枠を持つ人は、症例行に自分の名前がまだ無くてもその日の ope/cath が `mine:true`。逆にどちらの枠も持たない人（フリー・機器管理・担当なしなど）は checklist が `mine:true` になる——共通業務の担い手という実際の運用に合わせたもの。担当枠の割り当て（`<select>` onchange・タッチ/マウスドロップ・`poolAssign`）は必ず `updateCloseBar(ds)` も呼び、割り当て直後に `mine` の再評価を反映させる。

**HD主観では③④⑥（オペ・カテ・オンコール）を数えない。** 詳細は「HD主観モード」節を参照。ジャンプ先が存在しないカテゴリを数えると「→」も「▶次へ」も無反応になる（`dashJump` は要素が無いと黙って何もしない）ので、**新しいカテゴリを足すときは、そのセレクタが両主観の日ページに存在するかを必ず確認すること。**

`D.pages[ds].closeSkip[key]`（`key` はカテゴリの `key`、`saveDPage(ds)` で保存）で「今日は対象外」をカテゴリ単位・その日限りで持てる。`closeBarSkip(ds, key)` がトグル、`renderCbarDetail()` の「対象外」／「戻す」ボタンから呼ぶ。

`updateCloseBar(ds)` は `closeItems(ds)` を集計し、`.warn`（🔴 今日・未了あり）/`.ref`（⚪ 今日以外を開いている・グレーの参照表示）/`.ok`（✅ 残り0）の3状態を切り替える。`body.classList.add('has-cbar')` は CSS 側で `.fb-toast`（`toast()` の一般トースト）・`#idle-warn`（自動ログアウトのカウントダウン警告）・`.notif-toast`・`#scroll-top-btn` の `bottom` をバーの高さぶん押し上げ、画面下端での重なりを防ぐ。`updateCloseBar(ds)` に単独の集中呼び出し口はなく、`updateOpsHeader(ds)`/`updateTabletBtnBadge(ds)` と同じ箇所（担当割り当て・OPS入力・タブレット貸出返却・申し送り投稿など）から都度呼ぶ。

**画面下端が隠れない仕組み（`--cbar-h`）**：バーは `position:fixed` なので、何も手当てしないとページ末尾がバーの裏に入る。`syncCbarHeight()` が**バーの実測高さ**を `--cbar-h` に流し込み、`.main`・`.sp`（サイドバーの各タブ）・画面下端の固定要素（`.fb-toast`／`#idle-warn`／`.notif-toast`／`#scroll-top-btn`）がすべて `calc(... + var(--cbar-h, 0px))` でこれを避ける。**決め打ちの数値に戻さないこと** — 以前は `.main{padding-bottom:80px}` 固定で、セーフエリアや端末の下部UI（`--vv-bottom` は最大160px）でバーが厚くなると末尾が隠れていた。`updateCloseBar`（表示/非表示・文言変更の後）・`syncCbarInset`（`--vv-bottom` はバーの padding に入るため）・`resize` の3経路から測り直す。バーが出ていないときは 0 になるので余分な余白は残らない。

**Android対策3点**（実機フィードバックで判明した「バーが出ない／出たり出なかったりする」不具合の修正）：①`updateCloseBar(ds)` の冒頭で `_cbarInputFocused` を `document.activeElement` の実態から毎回上書きする自己修復を入れている——`focusin`/`focusout` リスナー（入力欄フォーカス中はバーを隠す）は、フォーカス中の要素が `renderPage()` の `#main` 丸ごと差し替えで DOM ごと消えると `focusout` が発火せず、フラグが `true` のまま固まってリロードするまでバーが出なくなるため。②`.cbar` の `z-index` は `250`——スマホの全画面サイドバー（`.sb`=200）や `#pane-assign`（201）より上に置かないと、サイドバーを開くたびにその裏へ完全に隠れる。③`syncCbarInset()` は実測した下端インセットを、以前は120px超で一律0（補正なし）に捨てていたが、ナビゲーションバー＋ブラウザUIが厚い端末では平常時でもこれを超えてバーが沈む機種があったため、キーボード（200px超）と単に厚いUI（120〜200px）を分け、後者は160pxで捨てずにクランプするよう変更した。

### Shift Import

`parseShiftSheet(wb, fileName)` parses Excel → `D.shift[ym][name][day] = { shift, hd, oc }`. `doSaveSIM()` protects days with existing duty assignments from being overwritten. Shift codes: `'CE'` (clinical engineer on duty), `'OC'` (on-call flag), HD day codes `['M','A1','A2',...]`, HD night codes `['準','準夜']`.

### PHI Detection

`detectPHI(text)` → `{ red: [...], yellow: [...] }`. `showPHIPopup(opts)` is the unified warning modal.

- **Memos**: `postMemo(ds)` calls `detectPHI` explicitly.
- **`#main` free-text fields**: `initPHIGuard()` attaches a delegated `focusout` listener on `#main` — covers all `textarea`/`input[type=text]` added under `#main` automatically.
- **Board (`#pane-board`)**: Outside `#main` — `postBoard()` and `postBoardReply()` call `detectPHI` explicitly. Any new board input fields must do the same.
- **Memo replies**: Inside `#main`, but `postMemoReply()` still calls `detectPHI` explicitly on send, honouring `phiHasBlock` exactly like `postMemo`.
- **Tasks (`#pane-task`)**: Outside `#main` — `saveTaskFromModal()` calls `detectPHI` on `title+'\n'+desc` explicitly before persisting.
- **Makers (`#pane-makers`)**: Outside `#main`, so `initPHIGuard` does not cover its modals either. Only the 備考 field is guarded — `saveMakerFromModal()` calls `phiGuardText(note, ...)` explicitly. メーカー名・担当者名・電話番号・メールには**意図的に** `detectPHI` をかけない: `detectPHI` detects 姓＋漢字 patterns as a personal name and hard-blocks the save, but the 担当者 field's whole purpose is to hold a manufacturer employee's name, so applying it there would permanently block legitimate input.

### Media Uploads

Storage paths: `manual/{taskName}/…`, `memo/{ds}/…`, `memo/{ds}/reply_…`, `board/…`, `board/reply_…`, `task/{taskId}/…`, `taskMemo/{uid}/{memoId}/…`. Everything except memos and manuals is images only. `uploadToStorage(path, blobOrData, cb)` and `compressImage(file, cb)` are the shared primitives; `mediaBufPreview(wrap, buf, onChange)` renders the pre-send thumbnails for the newer call sites (memo replies, tasks) — the four older per-feature preview renderers were left alone deliberately rather than migrated.

All image/video uploads (memo, memo reply, board post, board reply, manual, task) display immediately regardless of uploader — there is no admin approval gate. This was removed after real-world feedback that the review step was unnecessary friction; the earlier `pending: true` flag, the approve/reject UI, and the toolbar's pending-count badge were deleted outright rather than left dormant, since nothing sets `pending` anymore and no legacy `pending:true` records are known to exist in production. If a stray `pending:true` value is ever found on an old record, it is simply inert — no code reads that field anymore, so the media just displays like any other.

### Fairness Check（CE公平性 / HD公平性）

担当表タブのサブタブ2枚。どちらも `asY/asM` の1か月ぶんを「スタッフ×列」の回数マトリクスにし、列ごとに最多(赤)/最少(青)を強調、`max−min ≥ FAIR_GAP_WARN`（既定3）で偏り警告を出す。`D.stfHidden` のスタッフは除外する。

| | 数える対象 | 列 | データ元 |
|---|---|---|---|
| `renderFairness()`（CE公平性） | CE担当枠の割り当て回数 | `FAIR_MERGE` で束ねた枠名 | `pg.duties` ＋ `getDutyCfg(pg)` |
| `renderHdFairness()`（HD公平性） | HDの役割が当たった回数 | `HD_DAY_CODES` 順（M→A1→…→B）＋ 準夜 ＋ 未知コード | `hdShiftWorkers(ds)` |

**表の組み立ては `fairnessHTML(o)` に集約してある。** CE版とHD版で違うのは「何を数えるか」だけで、最多/最少のハイライト・偏り警告・出勤日数バーは同じなので、ここを複製しないこと（CE/HDの双子関数がこれ以上増えるのを避ける）。`o` は `{counts, labelsOrder, workedDays, periodLabel, totalHead, dayUnit, note, emptyMsg}`。

- HD側が `buildHdRoster` ではなく **`hdShiftWorkers(ds)` を直接使う**のは、並べ替えや行の組み立てが要らないため。どちらも同じ関数を通るので、日ページのHD担当表で担当を差し替えた分（`dat.hdDuty.overrides`）は自動で反映される。
- 準夜は `getShiftForDay` が `shift:'準', night:true` に正規化して返すので、`h.night` を見て `'準夜'` の1列に寄せる。`'準'` と `'準夜'` の表記ゆれを列として分けないこと。
- 警告列のヘッダーは地を `--warn-fg` で塗るので、文字色に `--sur` を当てて反転させている（これが無いとライトは暗地に暗字、ダークは明地に明字で読めない）。

### Task Management (`/tasks`)

Independent Firebase path (like `/board`), not part of the `D` object — the "5 locations" rule for `D` properties does not apply. Cached client-side in `_tasksData` (mirrors `_boardData`'s pattern), rendered by `renderTasks()` (overview) / `renderTaskPerson(el, name)` (per-staff detail, toggled via module-level `_taskView`).

`swTab('task')` resets `_taskView = taskSelfName() || null` on every entry — the tab opens straight to the current user's own page when their account is linked to a staff name (same "always reset to a default sub-view on entry" convention as `swTab('assign')` resetting to the `at` subtab), falling back to the overview when unlinked. `taskMemoListHTML(today, opts)` renders the 🔒自分専用メモ block and is shared by both views, placed at the very top of the content (`opts.filter:false` skips the `_taskFilter` status filter for the personal page, since that page doesn't filter its task lists either). It only appears in `renderTaskPerson` when `name === taskSelfName()` — the memo data is always the viewer's own, so showing it while looking at someone else's task page would be misleading.

```js
/tasks/{taskId} = {
  title:     '...',                 // required, PHI-checked
  desc:      '...',                 // optional, PHI-checked, '' if empty
  assignees: ['松野 敏宏', ...],    // D.stf names, 1+ required
  status:    'todo',                // 'todo' | 'doing' | 'done'
  due:       '2026-07-20',          // optional, '' if unset
  media:     [{type:'image', name, url, storagePath, data}],  // images only
  createdBy: { uid, name },
  ts: 0, updatedTs: 0, doneAt: 0    // doneAt is 0 while not done
}
```

- **Attachments** are images only (no video) and live at `task/{taskId}/{ts}_{idx}_{file}` in Storage. Read them through `taskMediaArr(t)` — same Firebase array→object normalization as `taskAssignees`. `taskMediaHTML(t)` renders the card thumbnails; `taskMediaCleanup(list)` deletes the `storagePath`s and is called from `taskDelete`/`memoDelete` and from the save path for attachments removed while editing.
- Because uploads are async, **`saveTaskFromModal` reads every modal DOM value up front** into a `form` object and hands it to `_doSaveTask(id, form)` / `_doSaveMemo(id, form)`; those call `_uploadTaskMedia(prefix, cb)` and only persist + close the modal in the callback. Reading `task-md-st`/`task-md-due` inside the save function (as the old synchronous version did) breaks the moment the modal closes first. `_uploadTaskMedia` short-circuits when nothing new was picked, so attachment-free saves stay effectively synchronous.
- Modal-scoped attachment state is three module-level arrays reset by `openTaskModal`: `_taskMediaBuf` (newly picked, not yet uploaded), `_taskMediaKeep` (existing attachments still wanted), `_taskMediaDrop` (existing attachments the user removed — deleted from Storage on save, not on click, so cancelling the modal doesn't destroy anything).

- `assignees` is stored by **staff name**, not uid, so the load graph and per-staff view can key off `D.stf` directly. `taskAssignees(t)` normalizes Firebase's array→object coercion (same shape as `_boardMediaArr`).
- **Permission model is app-side, not Firebase-rule-enforced** (RTDB rules cannot inspect array membership against `auth.uid`): everyone can create/edit; `taskCanStatus(t)` additionally allows any assignee to cycle status; `taskCanDelete(t)` / `taskCanEditAll(t)` restrict to the creator or an admin. The `/tasks` RTDB rule hard-enforces two boundaries: the delete permission, and `createdBy.uid` immutability via `.validate` (must be a string on create, must equal the existing value on update — otherwise anyone could rewrite `createdBy` to themselves and then delete). See `database.rules.json` / `LATEST_DB_RULES`.
- `taskCycleStatus(id)` cycles todo→doing→done→todo (Notion-style tag click) and updates `doneAt`/`updatedTs`.
- Completed tasks are kept (not deleted) but rendered dimmed (`.task-card.st-done`, `opacity:.45`) and excluded from the staff load graph.
- `taskPersist(id, t)` follows the optimistic-update pattern: mutate `_tasksData` + re-render immediately, then `fbDB.ref('/tasks/'+id).set(t)` (local/preview mode skips the Firebase write, cache-only, same as `postBoard`). On write failure the `.catch` rolls the cache back to the previous value and re-renders (`taskDelete` likewise restores the deleted entry) so the UI never shows a phantom saved/deleted state.
- Listener setup/teardown mirrors `/board`: `fbDB.ref('/tasks').on('value', ...)` inside `fbInit()`'s `if (!dataListenerOn)` block; `fbDB.ref('/tasks').off()` plus `_tasksData={}; _taskView=null; _taskFilter='all';` on logout.
- **Assignment notification**: `_doSaveTask()` calls `notifyTaskAssigned(name, t)` for each name in `asg` that is **not** already in the previous `assignees` and is **not** `taskSelfName()`. That helper resolves the name via `getUidByName()` and pushes to `/notifications/{uid}` through the existing `sendNotificationToUid()` (which also fires FCM + EmailJS). The recipient's `startNotifListener()` → `showNotifPopup()` shows it in real time, or on next login if they're offline. Staff with no linked account are silently skipped.

### Private Memos (`/taskMemos/{uid}`)

Self-only notes shown at the bottom of the タスク tab (`#pane-task`). **Separate Firebase path from `/tasks`, and unlike task permissions this one IS rule-enforced**: `/taskMemos/$uid` grants read+write only when `auth.uid === $uid`, so no other user (admin included) can read them. Adding the RTDB rule is mandatory — without it the writes fail.

```js
/taskMemos/{uid}/{memoId} = { title, desc, status, due, media, ts, updatedTs, doneAt }
```

- Memos take the same image attachments as tasks, stored at `taskMemo/{uid}/{memoId}/{ts}_{idx}_{file}`. **The RTDB record is private but the Storage object is not** — `storage.rules` grants read to any authenticated user — so the path deliberately carries no title or other content, only ids.

- No `assignees` and no `createdBy` — ownership is the path itself.
- Cached in `_memosData`; listener ref kept in `_memoRef` (set in `fbInit()`'s `if (!dataListenerOn)` block, `.off()`'d and `_memosData={}` on logout so the next user never sees the previous user's memos).
- `memoPersist` / `memoDelete` / `memoCycleStatus` mirror the task equivalents including the optimistic-update rollback. `memoCycleStatus` copies the object before mutating (the task-side bug that made rollback a no-op).
- The modal is shared: `openTaskModal(id, isMemo)` hides the assignee block and swaps the store; `saveTaskFromModal(id, isMemo)` branches to `_doSaveMemo`. PHI detection still runs (blocking categories are refused, same as tasks).
- Memo contents are **never** written to `/logs`.

### Summary Period (OC集計 / 業務集計 / HD集計)

`renderOCSummary()`, `renderOpsSummary()`, and `renderHdSummary()` no longer iterate the days of `asY/asM` directly. All three go through:

- `_sumMode` (`'month'|'year'|'range'`), `_sumFrom`, `_sumTo` — module-level state shared by all three.
- `sumRange()` → `{from, to, label, multi}` (`multi` = spans more than one calendar month).
- `sumDsList()` → existing `D.pages` keys inside the range, sorted (string compare works for `YYYY-MM-DD`).
- `sumCtlHTML(pfx)` renders the 月／年／期間指定 switcher; `pfx` (`'oc'`/`'ops'`/`'hd'`) keeps the date-input ids unique because all three subpanes are in the DOM at once. 期間の指定・前後の月移動は `sumCtlHTML` が自前で持つので、`pane-sum` のヘッダーには月ナビを置かない（置くと同じ操作が画面に2つ並ぶ）。

When `multi` is true all three renderers add a per-month breakdown, the ops trend graph buckets by month instead of week (bar width shrinks via `BW`/`BG` so 12 groups still fit), and date cells show `M/D` instead of `D日`. `exportOcCsv()` / `exportOpsCsv()` / `exportHdCsv()` follow the same range and name the file via `sumFileLabel()`.

`sumShift(d)` は月モードなら前後の月（`asPrevM()`/`asNextM()` に委譲）、年モードなら `asY` を±1して3集計を描き直す。`sumCtlHTML` が期間ラベルの左右に `‹ ›` として出す（期間指定モードでは出さない）。**集計タブのヘッダーには月ナビを置かない**方針なので、ここを消すと「📅 月」を選んでいるのに表示月を変える手段が画面から無くなる（担当表タブで月を変えてから戻る、という操作を強いていた）。印刷見出しも `printSumTab()` が `sumRange().label` を `_printSubPane(phId, subId, periodLabel)` へ渡す — `asY/asM` 固定だと「2026年」を集計しているのに紙には「2026年8月」と刷られる。

**表の並べ替え（`_sumSort` / `setSumSort` / `sumSortTh` / `sumSortRows`）**：CE明細・OC集計・HD集計の3つの表で同じ仕組みを共有する（表ごとに実装を書き写さない）。列見出しをクリックすると昇順→降順で反転し、**値が空の行は方向に関わらず常に末尾**に置く（未入力が先頭に並ぶのを避けるため）。`sumSortRows` は安定ソートなので、CE明細のグルーピングは「全体をソートしてからグループに割る」だけでグループ内も指定順になる。OC集計の「対応時間」列は開始時刻ではなく**対応の長さ（分）**で並べる（日跨ぎの退勤は24時間足して負にしない）。集計カード（科別・術式別・担当者別・使用物品別）は列が無いので `_opsCardSort`（件数順／名前順／平均所要順）を見出しの `<select>` で切り替える。**この状態はカードごとに持つこと**——1つの変数を4枚で共有すると、1枚を変えただけで他の3枚まで並びが変わり（各カードに選択欄があるので「このカードだけ」と読める）、担当者別だけにある「平均所要順」を選んだときに他3枚の選択欄が「件数順」表示に戻ってちぐはぐになる。

`setSumMode(m)` and `applySumRange(pfx)` call all three renderers unconditionally (`renderOCSummary(); renderOpsSummary(); renderHdSummary();`) regardless of which pane is actually visible — each renderer's own `if(!el) return` (element-existence, not visibility) is the only guard, and writing into a hidden pane's `innerHTML` is harmless. The calendar month-nav `asPrevM()`/`asNextM()`, by contrast, checks whether `pane-sum` is open and re-renders only `_curSumTab`'s sheet, since walking `D.pages` on every month click is wasted work when nothing will be shown — follow this existing asymmetry (unconditional in the two setters, display-gated in the month-nav) rather than "fixing" it to be consistent.

### Memo Move-to-Another-Day

Incomplete memo posts show a 📅 button (`.mp-move`) next to the 済 checkbox in `renderMemos()`, gated by `can('memo')` (`!locked`) — **not** `canDel`. Unlike delete, moving never rewrites `m.name`/`m.uid`, so it's safe to let anyone with memo edit permission relocate a post (not just the original author or an admin); the original author stays correctly attributed regardless of who performed the move. Clicking it opens `openMoveMemoModal(ds, idx)` (dynamic `.ov`/`.md` with a date input, defaulting to tomorrow), which calls `moveMemo(ds, idx, targetDs)`.

`moveMemo` splices the memo out of `D.pages[ds].memos`, tags it with `movedFrom: ds`, and pushes it into `D.pages[targetDs].memos` (auto-creating the target page via the same minimal structure as `_doPostMemo` if it doesn't exist yet, gated by `can('pg')`). **Because this mutates two different pages, it must use full `saveD()` — not `saveDPage()`** (per the page-scoped-only rule above). Moved memos display a small "(M/DDから移動)" annotation in `.mp-meta` when `m.movedFrom` is set.

### Memo Editing (申し送りの編集)

投稿済みの申し送りは `✏️` から本文を編集できる（`editMemo` / `cancelMemoEdit` / `saveMemoEdit` / `_doSaveMemoEdit`）。

- **編集できるのは投稿者本人と管理者だけ**（`canEdit = canDel`）。移動（`mp-move`）は `can('memo')` があれば誰でもできるが、あれは本文を書き換えないため。**編集は本文そのものを変えるので削除と同じ範囲に絞る。**
- 対象の特定は `memoKeyOf`（`ts+uid`）→ `findMemoByKey`。**インデックスを使わない** — Firebaseのエコーで `memos` の並びが変わっても同じ投稿を指し続けるため（返信と同じ理由）。`_doSaveMemoEdit` は保存直前にもう一度引き直す。
- **`m.name` / `m.uid` は書き換えない。** 誰が最初に書いたかの表示は編集後も変わらず、代わりに `m.editedAt` / `m.editedBy` を記録して本文末尾に「◯◯ に △△ が編集」と出す。
- PHI検知は `postMemo` と同じ契約（`phiHasBlock(result)` なら送信を止め、それ以外は確認して続行可）。
- 保存は `saveDPage(ds)`（ページ単独スコープ）。`writeLog('申し送り編集', …)` に編集前後の冒頭20文字を残す。
- **「済」チェックと操作ボタン（✏️📅✕）は `.mp-actions` の1つのflex行にまとめる。** 以前はそれぞれを個別に `position:absolute` ＋ 固定の `right` 値で並べており、編集ボタンを足したときに位置計算を更新し忘れて「済」の文字がボタンの下に隠れた。**個別の絶対配置に戻さないこと** — 横並びなら表示されるボタンの数が変わっても自動で詰まる。

### Memo Replies (申し送りの返信)

Each memo carries `m.replies = { [rid]: {uid, name, isAdmin, text, media, ts} }` — **a keyed object, not an array**. `memos` itself is an array under `/data/pages/{ds}`, so a nested array would collide on index whenever two people reply at once; this mirrors the board's `/board/{id}/replies`. The key is `'r' + ts + '_' + uid.slice(0,8)`.

- Read replies through `memoReplies(m)` (sorted by `ts`, each entry tagged `_rid`) and their images through `memoReplyMediaArr(r)`.
- The parent memo is located by `memoKeyOf(m)` (`ts + '_' + uid`) via `findMemoByKey(ds, key)` — never by array index, and `_finishPostMemoReply` **re-looks-up the parent after the upload finishes** rather than closing over it, since the Firebase echo can reorder `memos` mid-upload.
- Replies take images only (`memo/{ds}/reply_{ts}_{idx}_{file}`); video stays on the top-level post. `delMemo` sweeps reply attachments too, so deleting a parent leaves no orphans in Storage.
- PHI detection follows `postMemo`'s contract — `phiHasBlock(result)` blocks the send. (`postBoardReply` does *not* honour `phiHasBlock`; do not copy that behaviour into new code.)
- **Mentions inside a reply send a notification but are not counted by the 消し込みバー.** `closeItems`'s `mention` category counts *unfinished memos*, and a reply has no individual 済 checkbox to clear.

`renderMemos` re-fills `#memo-list` with `innerHTML`, but `#memo-list` itself is a persistent element — `addEventListener` on it inside `renderMemos` accumulated one more handler on every render (this is why a single delete click could raise several confirms). Handlers now go through `bindMemoListEvents(el)`, which guards on an `el._memoBound` flag. Any new memo-list interaction belongs in that one delegated listener.

### Tablet Lending/Return (タブレット貸出・返却)

Digitizes the paper tablet loan log. Two data pieces:

- **Master `D.tablets`** — array of tablet names (strings), top-level D property (follows the 5-location rule; edited in pane-master's `📱 タブレット台帳` section via `renderTabletList`/`addTablet`/`rmTablet`, gated `can('mst')`, modeled on the PHS master).
- **CE/HDで台帳が分かれる**：透析室のタブレットはCEのものとは別の端末なので、マスタ（`D.tablets` / `D.hdTablets`）も貸出ログ（`dat.tabletLogs` / `dat.hdTabletLogs`）も別に持つ。分けないと片方の未返却がもう片方のヘッダーバッジ・消し込みバー・持ち越し判定（`tabletCarryOver`）に混ざる。**読み書きは必ず `tabletMaster()` / `tabletLogsOf(dat)` / `ensureTabletLogs(dat)` / `tabletLogsKey()` を通す**（`_viewMode` で切り替わる）。チェックリスト（`dat.checks`/`dat.hdChecks`）と違い、ログは id で引く独立した配列で添字の共有規約が無いため、関数を複製せずこのアクセサ1組で足りている。マスタ編集UIだけはCE/HDそれぞれの `data-mode` セクションに分かれている（`renderTabletList`/`renderHdTabletList`）
- **Per-page `D.pages[ds].tabletLogs`** — array of loan records `{ id, tablet, borrower, lentAt, returnedBy, returnedAt }`. Times are **minutes-from-midnight** (same unit as `schedule`; format with `schedMinToHM(m)`, parse with `tabletHMToMin("HH:MM")`, "now" via `tabletNowMin()`/`tabletNowHM()`). Unreturned = `returnedAt === 0`. Lazy-init with `dat.tabletLogs = dat.tabletLogs || []` (old pages predate the field). Persisted with `saveDPage(ds)` (single-page scope).

The day page does **not** show an inline tablet section (it would occupy too much space). Instead, `renderPage` adds a compact `📱 タブレット` button (`#tablet-btn`) to the page header next to 印刷, carrying a red `#tablet-btn-badge` showing the current unreturned count (glanceable 揃い確認; hidden when 0). Clicking it calls `openTabletPanel(ds)`, a modal `.ov`/`.md` (`#tablet-panel-ov`, max-height 85vh scroll, click-outside/✕ closes) whose body is filled by `renderTabletPanelBody(ds)`. That body shows the "現在貸出中: N台" summary (red when N>0), a record button, and a list/timeline toggle (`_tabletView`, `setTabletView` → re-renders the panel body). The **list** view shows each loan (green/red left-border by returned state) with 返却/削除 buttons; the **timeline** view (`buildTabletTimeline`) reuses the schedule grid structure — vertical time axis × one column per tablet — with returned loans as solid blocks and unreturned ones as red-striped blocks extending to the current time (today only, else axis end). Timeline is view-only; editing happens in the list. After any lend/return/delete, the handlers call `renderTabletPanelBody(ds)` **and** `updateTabletBtnBadge(ds)` so both the open panel and the header badge stay current.

`openTabletLendModal(ds)` / `openTabletReturnModal(ds, idx)` are dynamic `.ov`/`.md` modals (appended to `document.body`, click-outside closes) with a tablet `<select>`, a borrower/returner `<input list=…>` backed by a `<datalist>` of `D.stf` (staff-pick **plus** free text for other-department people), and an `<input type="time">` defaulting to now with a 「今」button. Because the modals live **outside `#main`**, `initPHIGuard` does not cover them — `saveTabletLend`/`saveTabletReturn` call `detectPHI` on the free-text name explicitly (mirrors `saveTaskFromModal`). All record/return/delete operations are gated by `can('tablet')` (new lock, default unlocked = everyone can record). **No Firebase rule change needed** — both `D.tablets` and `tabletLogs` live under `/data`, unlike `/tasks`.

### メーカー担当者連絡先 (`D.makers`)

Independent of any day page — a flat lookup table for manufacturer support contacts (機器トラブル時にすぐ電話できるように), reachable from `pane-guide`'s sibling tab `pane-makers` (📚 資料 → 🏭 メーカー, visible to all users).

```js
D.makers = {
  cats: [ { id:'mc_xxxxx', name:'...' }, ... ],   // array order = display order
  list: [ {
    id:'mk_xxxxx', cat:'mc_xxxxx',                // cat:'' means 未分類 (uncategorized)
    maker:'', person:'', tel1:'', tel2:'', mail:'', note:'',
    upd:'',                                        // 'YYYY-MM-DD'
    ts:0, by:''                                    // last-edit epoch ms / editor display name
  }, ... ]
};
```

- **Always read through the accessors** — `mkCats()` / `mkList()` / `mkFind(id)` — never `D.makers.list.forEach` directly (except inside the category-modal editing flow, which deliberately mutates `D.makers` in place before a single batched `saveD()`; see below). Firebase turns sparse arrays into objects, so all three accessors funnel through `normMakers(x)`, which normalizes `cats`/`list` to real arrays and fills in missing fields — same pattern as `taskAssignees`/`opsItemStaff`.
- **`onclick` handlers pass only the record `id`, never inline field values** (`mkEdit('mk_xxx')`, `mkCopyTel('mk_xxx', 1)`, etc. — never e.g. `onclick="mkEdit('${r.maker}')"`). A manufacturer name containing an apostrophe would otherwise break the generated `onclick` string (this class of bug has bitten this codebase before — see the `changelog` entry for staff/duty names with `'`). Card text itself still goes through `escH()`.
- **Excel bulk import (`openMkImpModal`/`doSaveMkImp`) is admin-only** (`isAdmin`, not `can('maker')`) — a single import can replace or delete on the order of a hundred records in one action, a blast radius roughly two orders of magnitude larger than editing one record, so it is deliberately not covered by the `maker` lock/per-user-permission model that governs individual add/edit/delete.
- **Category deletion never deletes records.** `mkCatDel(i)` in the category-management modal: if the category being removed still has records (`mkCountByCat`), it prompts for confirmation, then sets `cat:''` on every record that referenced it (moving them to the virtual "未分類" bucket, which only appears in the UI when it has ≥1 member) before splicing the category out of `cats`. The modal batches all category add/rename/reorder/delete edits into a single `saveD()` on close (`mkCatModalClose()`) rather than saving on every keystroke/click, since a ~150-record dataset makes a full-`D` write on every micro-edit expensive.
- Manufacturer/person/phone/email fields are intentionally excluded from `detectPHI` (see PHI Detection section above); only `note` is guarded.

### Changelog System

`APP_VERSION` (string) and `APP_CHANGELOG` (array, newest release first) live near line 3480, hand-maintained — there is no build step that generates them. Each release is `{ ver, date, title, items:[{t, d, admin?}] }` where `t` is `'new'|'fix'|'imp'`.

- **`admin` flag**: optional on each item; omit for general-audience items (default), set `admin:true` for entries that only matter to admins (master-data editing, backups, EmailJS/FCM config, user management, `/logs`, monthly bulk auto-assign, etc.). `filterChangelogForGeneral(changelog)` strips `admin:true` items and drops any release left with zero items.
- **`fix` items are always hidden from general users, regardless of `admin`**: `filterChangelogForGeneral` also strips every `t:'fix'` item (`it.t !== 'fix'`) — a bug fix has no "here's what you can now do" framing for someone who never knew the bug existed, so surfacing it is just noise. General users only ever see `new`/`imp`; the admin-only `renderChangelog()` view still shows all types including `fix`. When writing a new release entry, phrase every non-`admin` item as something the user can now *do* (`new`/`imp`), and keep actual bug-fix wording under `t:'fix'` even if the fix is user-facing.
- **Version format**: new releases use `formatVerString('YYYY-MM-DD', nextChangelogSeq())` → `'Ver.YYYY/MM/DD-N'` where N is the all-time cumulative release count (`nextChangelogSeq()` scans existing `Ver.*-N` entries and returns max+1, defaulting to 24 as the base since the pre-existing 24 releases used the old `'2026.06y'`-style string and are never renumbered). `verDisplay(ver)` renders old-style strings with a `v` prefix and new-style strings as-is, so both eras display correctly side by side.
- **Two render paths, one HTML builder**: `buildChangelogHTML(changelog, opts)` is shared. `renderChangelog()` (admin-only, sidebar `資料▾→変更履歴` / `pane-changelog`) calls it with the full unfiltered `APP_CHANGELOG` — output is unchanged from before this system existed. `renderChangelogPublic()` (all users, opened via the "📝 変更履歴" button in the top-right of the 使い方 guide tab → `openChangelogPublic()`/`closeChangelogPublic()`, modal `#modal-changelog-public`) calls it with `filterChangelogForGeneral(APP_CHANGELOG)` and `{heading:false}` since the modal's own `<h3>` already provides the title.
- When adding a new release entry: prepend it to `APP_CHANGELOG` (array is newest-first), update `APP_VERSION` to match, and judge each item's `admin` flag by who the change is actually relevant to — not by whether the *setting* lives on an admin screen (e.g. EmailJS notifications are admin-configured but the resulting emails land in general users' inboxes, so that kind of item is left general).

## Making Changes

Since everything is in one file, search for function names or CSS classes to locate sections. File organization:
1. `<head>` — CDN scripts, CSS
2. HTML structure (modals, toolbar, sidebar panes, main area)
3. `<script>` — all JS starting at line ~933

**Key rules:**
- After mutating `D`, call `saveD()`.
- For rendering, call the targeted function (e.g., `renderStfList()`) rather than `renderPage()` to avoid full re-renders.
- `renderPage()` must sometimes be called **before** `saveD()` to avoid the Firebase echo overwriting the new UI state.
- For one-time data migrations: check `D._migVer`, run migration, increment `D._migVer`, call `saveD()`. Current `_migVer` is **5** (v4: migrates auto-delete settings from per-PC `localStorage` keys `autoDelEnabled`/`autoDelPeriod`/`autoDelInterval`/`lastAutoClean` into `D.autoDelCfg`, applied in both `loadD()` and the Firebase `/data` listener. v5: migrates each page's `surplus`/`surplusStatus`/`hdStatus` fields into `dat.staffZone={ce,hd}` via `ensureStaffZone(pg)`, applied the same way in both locations — this migration is a convenience only, not the safety net; the legacy fields are never deleted, so `ensureStaffZone()` keeps absorbing them lazily on read even for pages the migration never touched, e.g. pages restored from a pre-v5 backup via `importBackup()`, which does not re-run `_migVer` gating).
- Stale closure bug: closures that capture `dat` become stale after Firebase updates `D`. Always reference `D.pages[ds]` (live) inside async callbacks, not the closed-over `dat`.
- When changing `currentUser.perms` (e.g., in `saveUserPerm`), call `updateTabVisibility()` if the change affects the currently logged-in user.
