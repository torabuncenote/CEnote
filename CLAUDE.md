# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**分院CE連絡表 (CEnote)** — A clinical engineering department daily scheduling and communication web app for a hospital branch. Written entirely in Japanese, intended for staff to manage daily duty assignments, checklists, memos, OPE/catheter procedures, and shift data.

## Project Structure

This is a **single-file web app**: all HTML, CSS, and JavaScript lives in `index.html` (~480KB). There is no build system, no bundler, no package manager, and no test framework.

Additional files:
- `manifest.json` / `sw.js` — PWA support (offline caching, cache name `cenote-v4`)
- `icon-192.svg` / `icon-512.svg` — PWA icons
- `.github/scripts/validate.mjs` — lightweight syntax checker (run after every change)

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
  _migVer: 4        // data migration version flag (increment when running one-time migrations)
};
```

Each `D.pages["YYYY-MM-DD"]` contains all data for a single day: `duties`, `checks`, `memos`, `ops`, `ocData`, `schedule`, `surplus`, `surplusStatus`, `hdStatus`, `ops_cards`, etc.

### Adding New D Properties

When adding a new top-level property to `D`, update **all five** of these locations:

1. `var D = {...}` initialization (line ~1539)
2. `loadD()` — localStorage hydration (`D.newProp = s.newProp || default`)
3. Firebase `/data` listener — hydration from Firebase (`D.newProp = d.newProp || default`)
4. Logout reset block (`D.newProp = default`)
5. Backup/restore key arrays — two `forEach` calls containing `'emailjsCfg','fcmCfg','stfLinks',...` (search for this pattern; appears twice)

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

#### Lock IDs (`LOCK_DEFS`)

| id | label | notes |
|---|---|---|
| `duty` | 担当割り当て | |
| `phs` | PHS番号の変更 | |
| `ops` | 業務内容（オペ/カテ等） | |
| `dm` | チェックリスト（共通）の編集 | pane-master 共通業務セクション |
| `wm` | チェックリスト（曜日別）の編集 | pane-master 曜日別業務セクション |
| `mst` | 各種マスタの編集 | OPE/カテ/使用物品/担当枠/スケジュール/PSG通知セクション |
| `sm` | スタッフマスタの編集 | |
| `cl` | チェックリストの入力 | |
| `memo` | 業務連絡・申し送りの編集 | |
| `pg` | 連絡表の生成・削除 | |
| `show_phs` | PHS番号欄の表示切替 | 反転ロジック（ON=表示、OFF=非表示） |

#### Tab Visibility

`updateTabVisibility()` controls which sidebar tabs non-admin users can see. It must be called after any change to `currentUser.perms` (e.g., inside `saveUserPerm()` when the current user's own permissions change).

```js
// Tab visibility is controlled by explicit tab_ permissions, NOT by edit-lock permissions
'master': isAdmin || hasPerm('tab_master'),  // 業務タブ
'staff':  isAdmin || hasPerm('sm') || hasPerm('tab_staff'),
'lock':   isAdmin,
'logs':   isAdmin,
'docs':   isAdmin,
```

`tab_master` and `tab_staff` are stored in `/userPerms/{uid}` alongside regular lock permissions, but are granted via the "タブ表示" section in `renderAdminUsers()` rather than the lock-permission buttons.

#### pane-master Section Gating

Each section div in `#pane-master .sp` has a `data-perm` attribute. `swTab('master')` evaluates them after rendering:

```js
document.querySelectorAll('#pane-master .sp > div[data-perm]').forEach(function(sec){
  var perm = sec.getAttribute('data-perm');
  sec.style.display = (perm === 'admin' ? isAdmin : can(perm)) ? '' : 'none';
});
```

- `data-perm="dm"` — 共通チェックリスト section
- `data-perm="wm"` — 曜日別チェックリスト section
- `data-perm="mst"` — OPE/カテ/使用物品/担当枠/PSG通知 sections
- `data-perm="admin"` — メール通知/Web Push/月次自動割り当て sections (admin-only regardless of locks)

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
    pane-assign — assignment table (月次担当一覧) with subtabs:
                  at (担当表) / oc (OC集計) / ops (業務集計) / fair (公平性) / my (マイ担当) / task (タスク)
    pane-sched  — daily timetable (⏰ スケジュール)
    pane-board  — 掲示板 (department bulletin board)
    pane-guide  — user guide
    pane-staff / pane-master / pane-lock / pane-logs — admin-only
    pane-spec / pane-manual / pane-adminm / pane-dev / pane-regs / pane-changelog — docs sub-tabs
  .main   — day detail view (right, scrollable)
  .es     — empty-state placeholder (shown when no page is selected)
```

Mobile (`max-width: 768px`): sidebar becomes a fixed full-screen overlay toggled by `.hbg`. `#pane-assign` and `#pane-sched` are `position:fixed` full-screen overlays on mobile.

`openDefaultPage()` — called at Firebase first-load and in preview mode; opens today's page if it exists, else shows the `.es` placeholder.

`swSubTab(id)` switches between the subtabs inside `pane-assign` (`at` / `oc` / `ops` / `fair` / `my` / `task`). Each subtab has a matching `subpane-{id}` div.

### CSS Conventions

All class names are abbreviated:
- `.tb` toolbar, `.sb` sidebar, `.ab` app body, `.cw` calendar, `.cg` calendar grid, `.cd` calendar day
- `.dg` duty grid, `.dc` duty card, `.ds2` duty select
- `.btn-p` primary (blue), `.btn-g` ghost/secondary, `.btn-d` danger
- `.ov` overlay backdrop, `.md` modal dialog, `.sp-panel` side peek panel
- `.brd-*` board post/reply elements
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
| `renderAT()` / `renderFairness()` | Monthly assignment table / fairness matrix (both filter `D.stfHidden`) |
| `buildDG(ds, dat, locked)` | Duty card grid |
| `buildCL(ds, dat, wtl, all, locked)` | Checklist section |
| `buildOPS(ds, dat, locked)` | OPE/cath/ops record section |
| `renderMemos(ds, dat, locked)` | Memo/comment thread |
| `renderSched()` | Per-day timetable for `curDs` |
| `renderBoard()` / `postBoard()` / `postBoardReply()` | Bulletin board (also handles read-receipt marking, tag/resolved rendering, pin-expiry sort/cleanup, filter chips) |
| `toggleBoardResolved(id, val)` / `pinBoard(id, pin)` / `boardPinActive(p)` | Board: 依頼解決トグル／ピン留め（期限プロンプト）／ピン有効判定 |
| `toggleBoardReads(id)` / `setBoardFilter(f)` | Board: 既読者一覧の開閉／フィルタチップ切替（`_boardFilter`） |
| `renderSurplusArea(ds, dat, locked)` | 余剰人員エリア（デフォルト折りたたみ: `_surplusOpen = false`） |
| `renderOpsSummary()` | 業務集計サブタブ — monthly OPE/cath/6MW/PSG counts |
| `renderOCSummary()` | OC集計サブタブ — on-call response log |
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

### Duty/Assignment System

`DUTIES` defines fixed slot types. `DEF_DUTY_MASTER` is the admin-editable master. Each day stores assignments as `{ ope: "name", cath: "name", ... }` plus a pool of unassigned staff for drag-and-drop.

**Pool ↔ Surplus**: `refreshPool(ds)` only touches `#pool-chips .pchip:not(.hd)` — do not broaden this selector or surplus zone chips will be hidden. `surplusStatus[name] = zoneKey` places staff in a zone (hd/maint/off/other).

**Duty assignment paths** (3 total — all must call `maybeLateToast` and `writeLog`):
1. `<select>` onchange in `buildDutyCard`
2. Touch drop (`onTouchEnd`)
3. Mouse drop (`onDrop`)

**Staff visibility**: `D.stfHidden[name] = true` hides staff from `renderAT()` columns, `renderFairness()` names, and duty dropdown options. Hidden staff who are already assigned show as `（非表示）` in the dropdown. HD workers (from shift data) are unaffected.

### OPE / カテカード（buildOPS内）

`buildItemList(card, key, masterList, labelName, itemId, withTime, withOrder, withSup, withDept)` and `buildItemListTree(card, key, masterTree, labelName, itemId, withTime, withOrder, withSup)` build per-item rows inside an ops card.

- OPE card: `withTime=true, withOrder=false, withSup=true`
- カテ card: `withTime=true, withOrder=false`（入室時間ドロップダウン表示）

**入室時間ピッカー**: `withTime=true` の行は、カテのブリーフィング欄と同じ「○時：△分」の2セレクト方式（`makeTimeHourOpts`/`makeTimeMinuteOpts`）。○は8〜16時＋AM／PM、△は0〜55分（5分刻み）＋OC。値は `item.time` に単一文字列で保存（`combineItemTime(h,m)` で結合、`parseItemTime(t)` で復元。旧形式 `"8:15"` `"AMOC"` `"PMOC"` も読める）。「自由入力」ボタンで `item.time='__free__'` に切替えるとテキスト入力（`item.timeTxt`）に変わる。`buildItemList` / `buildItemListTree` の両方に実装。

カテカード固定フィールド（`ops.` に保存）:
- `cath_briefing_h` / `cath_briefing_m` — ブリーフィング時間（時・分）、8〜16時・5分刻み
- `cath_note` — 備考

**opeN / cathN の集計ルール**: `ope_items` / `cath_items` の配列長ではなく、`opsItemFilled(it)` が true の行だけをカウントする（科・中カテゴリのみの選択、自由記述、入室時間、順番、使用物品など何らかの入力があれば1件。完全に空の初期行は除外）。`updateOpsHeader()`・`renderPage()`・`renderOpsSummary()`・`exportOpsCsv()` の4箇所すべてでこの共通ヘルパーを使用する。

**業務終了フラグ**: 各術式/種別行に「終了」トグルボタンがあり、`item.done = true` で行全体（`.ops-item-wrap.ops-item-done`）が薄暗く表示される。件数カウントには影響しない。`buildItemList` / `buildItemListTree` の両方に実装。付随動作:
- `opsToggleDone(items, idx)` — トグル時に終了行を配列末尾へ移動（解除時は未終了ブロックの末尾へ戻す）。データ自体の並びを変えるので全端末に同期される
- `updateOpsCardDoneBadge(cardEl, items)` — 入力済み全行が終了ならカードタイトルに「✅ 本日終了」バッジ（`.ops-card-done-badge`）を表示
- ヘッダーチップは終了数があると「🔪 オペ 2/3件終了」形式になり、全件終了で緑色+✅表示（`opsHeaderChips` の第6・7引数 `opeDone`/`cathDone`）

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

### 担当表ピンチズーム

Structure: `.ato#ato-wrap` > `#at-zoom-inner` > `#at-body` (table content).

- During pinch: applies `transform: scale(ratio)` with `transform-origin` at the pinch midpoint (GPU-accelerated, no reflow)
- On `touchend`: commits to `zoom` property and corrects scroll position; 8-frame `requestAnimationFrame` relock overrides iOS's async `scrollTop` adjustment
- Button clicks: ease-out cubic animation over 10 frames via `_atZoomAnimRAF`
- `_atZoom` global tracks current zoom level (0.25–3)

### Schedule Timetable

Vertical time axis 8:00–21:00 in 15-min steps, one column per on-duty staff. Blocks stored in `D.pages[ds].schedule` as `{ id, staff, label, start, end, color }` (times in minutes-from-midnight). Drag body to move, drag bottom handle to resize.

### Checklist Items & Week-of-Month Filtering

`wdItemsForDate(ds)` returns the weekday items applicable to the given date, filtered by `wdApplies(ds, it)` (week-of-month). `dat.checks[]` is indexed against the **original** `D.dly` array positions, not filtered positions.

**Critical**: When computing done/total counts, iterate `D.dly` with original index `i` and skip hidden items via `isDlyShownOnDate()` — do NOT use a filtered array's sequential index. `getPct(ds)` is the canonical reference implementation.

```js
// Correct pattern (matches getPct):
for (var i = 0; i < D.dly.length; i++) {
  if (!isDlyShownOnDate(D.dly[i], ds)) continue;
  total++;
  if (dat.checks && dat.checks[i]) done++;
}
for (var j = 0; j < wtl.length; j++) {
  total++;
  if (dat.checks && dat.checks[D.dly.length + j]) done++;
}
```

### Shift Import

`parseShiftSheet(wb, fileName)` parses Excel → `D.shift[ym][name][day] = { shift, hd, oc }`. `doSaveSIM()` protects days with existing duty assignments from being overwritten. Shift codes: `'CE'` (clinical engineer on duty), `'OC'` (on-call flag), HD day codes `['M','A1','A2',...]`, HD night codes `['準','準夜']`.

### PHI Detection

`detectPHI(text)` → `{ red: [...], yellow: [...] }`. `showPHIPopup(opts)` is the unified warning modal.

- **Memos**: `postMemo(ds)` calls `detectPHI` explicitly.
- **`#main` free-text fields**: `initPHIGuard()` attaches a delegated `focusout` listener on `#main` — covers all `textarea`/`input[type=text]` added under `#main` automatically.
- **Board (`#pane-board`)**: Outside `#main` — `postBoard()` and `postBoardReply()` call `detectPHI` explicitly. Any new board input fields must do the same.
- **Tasks (`#pane-assign` task subtab)**: Outside `#main` — `saveTaskFromModal()` calls `detectPHI` on `title+'\n'+desc` explicitly before persisting.

### Media Approval

Uploads by non-admins get `pending: true`. In `renderMemos`, non-admins see a placeholder; admins see approve/reject buttons. `approveMemoMedia()` / `rejectMemoMedia()` flip the flag. `listPendingMedia()` scans all pages+manual; called via debounced `updatePendingBadge()`.

### Fairness Check

`renderFairness()` — 4th subtab of the assignment pane. Counts duty assignments per staff×slot for `asY/asM`, shows a matrix with max(red)/min(blue) highlighting. Warns when any column's max−min ≥ `FAIR_GAP_WARN` (default 3). Hidden staff (`D.stfHidden`) are filtered from the matrix.

### Task Management (`/tasks`)

Independent Firebase path (like `/board`), not part of the `D` object — the "5 locations" rule for `D` properties does not apply. Cached client-side in `_tasksData` (mirrors `_boardData`'s pattern), rendered by `renderTasks()` (overview) / `renderTaskPerson(el, name)` (per-staff detail, toggled via module-level `_taskView`).

```js
/tasks/{taskId} = {
  title:     '...',                 // required, PHI-checked
  desc:      '...',                 // optional, PHI-checked, '' if empty
  assignees: ['松野 敏宏', ...],    // D.stf names, 1+ required
  status:    'todo',                // 'todo' | 'doing' | 'done'
  due:       '2026-07-20',          // optional, '' if unset
  createdBy: { uid, name },
  ts: 0, updatedTs: 0, doneAt: 0    // doneAt is 0 while not done
}
```

- `assignees` is stored by **staff name**, not uid, so the load graph and per-staff view can key off `D.stf` directly. `taskAssignees(t)` normalizes Firebase's array→object coercion (same shape as `_boardMediaArr`).
- **Permission model is app-side, not Firebase-rule-enforced** (RTDB rules cannot inspect array membership against `auth.uid`): everyone can create/edit; `taskCanStatus(t)` additionally allows any assignee to cycle status; `taskCanDelete(t)` / `taskCanEditAll(t)` restrict to the creator or an admin. The `/tasks` RTDB rule only hard-enforces the delete-permission boundary (see `database.rules.json` / `LATEST_DB_RULES`).
- `taskCycleStatus(id)` cycles todo→doing→done→todo (Notion-style tag click) and updates `doneAt`/`updatedTs`.
- Completed tasks are kept (not deleted) but rendered dimmed (`.task-card.st-done`, `opacity:.45`) and excluded from the staff load graph.
- `taskPersist(id, t)` follows the optimistic-update pattern: mutate `_tasksData` + re-render immediately, then `fbDB.ref('/tasks/'+id).set(t)` (local/preview mode skips the Firebase write, cache-only, same as `postBoard`).
- Listener setup/teardown mirrors `/board`: `fbDB.ref('/tasks').on('value', ...)` inside `fbInit()`'s `if (!dataListenerOn)` block; `fbDB.ref('/tasks').off()` plus `_tasksData={}; _taskView=null; _taskFilter='all';` on logout.

### Memo Move-to-Another-Day

Incomplete memo posts show a 📅 button (`.mp-move`, same `canDel` gate as the existing delete button) next to the 済 checkbox in `renderMemos()`. Clicking it opens `openMoveMemoModal(ds, idx)` (dynamic `.ov`/`.md` with a date input, defaulting to tomorrow), which calls `moveMemo(ds, idx, targetDs)`.

`moveMemo` splices the memo out of `D.pages[ds].memos`, tags it with `movedFrom: ds`, and pushes it into `D.pages[targetDs].memos` (auto-creating the target page via the same minimal structure as `_doPostMemo` if it doesn't exist yet, gated by `can('pg')`). **Because this mutates two different pages, it must use full `saveD()` — not `saveDPage()`** (per the page-scoped-only rule above). Moved memos display a small "(M/DDから移動)" annotation in `.mp-meta` when `m.movedFrom` is set.

### Changelog System

`APP_VERSION` (string) and `APP_CHANGELOG` (array, newest release first) live near line 3480, hand-maintained — there is no build step that generates them. Each release is `{ ver, date, title, items:[{t, d, admin?}] }` where `t` is `'new'|'fix'|'imp'`.

- **`admin` flag**: optional on each item; omit for general-audience items (default), set `admin:true` for entries that only matter to admins (master-data editing, backups, EmailJS/FCM config, user management, `/logs`, monthly bulk auto-assign, etc.). `filterChangelogForGeneral(changelog)` strips `admin:true` items and drops any release left with zero items.
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
- For one-time data migrations: check `D._migVer`, run migration, increment `D._migVer`, call `saveD()`. Current `_migVer` is **4** (v4: migrates auto-delete settings from per-PC `localStorage` keys `autoDelEnabled`/`autoDelPeriod`/`autoDelInterval`/`lastAutoClean` into `D.autoDelCfg`, applied in both `loadD()` and the Firebase `/data` listener).
- Stale closure bug: closures that capture `dat` become stale after Firebase updates `D`. Always reference `D.pages[ds]` (live) inside async callbacks, not the closed-over `dat`.
- When changing `currentUser.perms` (e.g., in `saveUserPerm`), call `updateTabVisibility()` if the change affects the currently logged-in user.
