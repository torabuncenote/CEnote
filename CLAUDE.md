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
  _migVer: 3        // data migration version flag (increment when running one-time migrations)
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
- **Media**: uploaded to Firebase Storage at `manual/{taskName}/{timestamp}_{filename}`
- **Board**: stored at Firebase `/board` (independent of `/data`)

`saveD()` always writes the **full** `D` object. After mutating any property of `D`, call `saveD()`.

**Critical guard**: `_fbDataLoaded` must be `true` before `saveD()` writes to Firebase. It is set when the `/data` listener first fires. This prevents empty-D overwrites on login. **Do not bypass this guard.**

After `saveD()`, `_savingTs` suppresses listener-triggered re-renders for 2 seconds to prevent the Firebase echo from overwriting in-progress UI state.

### Firebase Setup

```js
var FB_CFG = { apiKey: "...", ... };
var FB_ON = !FB_CFG.apiKey.includes("YOUR_");
```

`FB_ON` is `true` when a real API key is configured.

### Authentication & Access Control

- Firebase Email/Password auth
- Admin status: `/admins/{uid}` = `true` in Firebase
- Per-user granular permissions: `/userPerms/{uid}` = `{ duty: true, memo: true, ... }`
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

Lock IDs (`LOCK_DEFS`): `duty`, `sm` (staff mgmt), `phs` (phones), `dm` (daily master), `wm` (weekday master), `pg` (page generation), `memo`, `ops`, `oc`.

**Always use `can(id)` for permission checks — not `lk(id)&&!isAdmin`.** The latter ignores per-user grants.

### Firebase Listener Lifecycle

Both `/data` and `/board` listeners are set inside a single `if (!dataListenerOn)` block in `fbInit()`. On logout, **both** must be detached:
```js
fbDB.ref('/data').off(); fbDB.ref('/board').off();
dataListenerOn = false;
```
On logout also reset: `_saveWriting`, `_savePending`, `_saveQueued`, `_fbEverConn`, `_fbConnected`, `_fbDataLoaded`, `_fbLastPageCount`.

### Firebase Database Structure

```
/data/                      — full D object (saveD())
/board/                     — 掲示板 posts (independent of /data)
/logs/                      — activity log (append-only via push())
/admins/{uid}               — true for admin users
/users/{uid}                — { email, displayName, lastLogin }
/userPerms/{uid}            — { lockId: true, ... } per-user permission grants
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

### UI Layout

```
.tb       — top bar (fixed)
.ab       — app body (flex row)
  .sb     — sidebar (left, collapsible)
    .stabs — tab strip
    pane-cal    — calendar with month navigation
    pane-assign — assignment table (月次担当一覧) + 公平性 subtab
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
| `fbInit()` | Firebase auth listener → login → `/data` + `/board` listeners |
| `saveD()` | Persist `D` to Firebase or localStorage |
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
| `renderBoard()` / `postBoard()` / `postBoardReply()` | Bulletin board |
| `renderSurplusArea(ds, dat, locked)` | 余剰人員エリア（デフォルト折りたたみ: `_surplusOpen = false`） |
| `updatePendingBadge()` | Media approval badge (debounced 200ms) |
| `writeLog(action, detail)` | Append to Firebase `/logs` |
| `autoSaveSnapshot(label)` | Add to local PC backup ring buffer |
| `saveFirebaseSnapshot(label)` | Write to `/backups/YYYY-MM-DD_HH` |
| `renderAdminUsers()` / `deleteAppUser(uid, name)` | User management (soft-delete removes `/users/{uid}`, `/admins/{uid}`, `/userPerms/{uid}`) |
| `can(id)` / `lk(id)` | Access control helpers |
| `opsHeaderChips(opeN, cathN, mwN, psgN, psgRemoval)` | Builds 業務 header chips (5th arg = PSG外し flag) |
| `updateOpsHeader(ds)` | Refreshes `#ops-header-row` DOM element dynamically |
| `updatePsgRemovalBanner(ds)` | Shows/hides `#psg-removal-banner` (today only, within `psgBannerStart`–`psgBannerEnd`) |
| `toggleStfHidden(name)` | Toggle `D.stfHidden[name]`; affects AT columns, dropdowns, fairness matrix |
| `setAtZoom(z)` / `initAtPinchZoom()` | 担当表ピンチズーム（ease-out animation for buttons, GPU transform during pinch） |

### Duty/Assignment System

`DUTIES` defines fixed slot types. `DEF_DUTY_MASTER` is the admin-editable master. Each day stores assignments as `{ ope: "name", cath: "name", ... }` plus a pool of unassigned staff for drag-and-drop.

**Pool ↔ Surplus**: `refreshPool(ds)` only touches `#pool-chips .pchip:not(.hd)` — do not broaden this selector or surplus zone chips will be hidden. `surplusStatus[name] = zoneKey` places staff in a zone (hd/maint/off/other).

**Duty assignment paths** (3 total — all must call `maybeLateToast` and `writeLog`):
1. `<select>` onchange in `buildDutyCard`
2. Touch drop (`onTouchEnd`)
3. Mouse drop (`onDrop`)

**Staff visibility**: `D.stfHidden[name] = true` hides staff from `renderAT()` columns, `renderFairness()` names, and duty dropdown options. Hidden staff who are already assigned show as `（非表示）` in the dropdown. HD workers (from shift data) are unaffected.

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
- On `touchend`: commits to `zoom` property and corrects scroll position: `scrollLeft = scrollLeft * ratio + pinchCenter * (ratio - 1)`
- Button clicks: ease-out cubic animation over 10 frames via `_atZoomAnimRAF`
- `_atZoom` global tracks current zoom level (0.25–3)

### Schedule Timetable

Vertical time axis 8:00–21:00 in 15-min steps, one column per on-duty staff. Blocks stored in `D.pages[ds].schedule` as `{ id, staff, label, start, end, color }` (times in minutes-from-midnight). Drag body to move, drag bottom handle to resize.

### Checklist Items & Week-of-Month Filtering

`wdItemsForDate(ds)` returns the weekday items applicable to the given date, filtered by `wdApplies(ds, it)` (week-of-month). `dat.checks[]` is indexed positionally against `D.dly.concat(wdItemsForDate(ds))`. **If week-of-month filters are added to existing items, saved check indices for older days may skew — requires a migration.**

### Shift Import

`parseShiftSheet(wb, fileName)` parses Excel → `D.shift`. `doSaveSIM()` protects days with existing duty assignments from being overwritten.

### PHI Detection

`detectPHI(text)` → `{ red: [...], yellow: [...] }`. `showPHIPopup(opts)` is the unified warning modal.

- **Memos**: `postMemo(ds)` calls `detectPHI` explicitly.
- **`#main` free-text fields**: `initPHIGuard()` attaches a delegated `focusout` listener on `#main` — covers all `textarea`/`input[type=text]` added under `#main` automatically.
- **Board (`#pane-board`)**: Outside `#main` — `postBoard()` and `postBoardReply()` call `detectPHI` explicitly. Any new board input fields must do the same.

### Media Approval

Uploads by non-admins get `pending: true`. In `renderMemos`, non-admins see a placeholder; admins see approve/reject buttons. `approveMemoMedia()` / `rejectMemoMedia()` flip the flag. `listPendingMedia()` scans all pages+manual; called via debounced `updatePendingBadge()`.

### Fairness Check

`renderFairness()` — 4th subtab of the assignment pane. Counts duty assignments per staff×slot for `asY/asM`, shows a matrix with max(red)/min(blue) highlighting. Warns when any column's max−min ≥ `FAIR_GAP_WARN` (default 3). Hidden staff (`D.stfHidden`) are filtered from the matrix.

## Making Changes

Since everything is in one file, search for function names or CSS classes to locate sections. File organization:
1. `<head>` — CDN scripts, CSS
2. HTML structure (modals, toolbar, sidebar panes, main area)
3. `<script>` — all JS starting at line ~933

**Key rules:**
- After mutating `D`, call `saveD()`.
- For rendering, call the targeted function (e.g., `renderStfList()`) rather than `renderPage()` to avoid full re-renders.
- `renderPage()` must sometimes be called **before** `saveD()` to avoid the Firebase echo overwriting the new UI state.
- For one-time data migrations: check `D._migVer`, run migration, increment `D._migVer`, call `saveD()`. Current `_migVer` is **3**.
- Stale closure bug: closures that capture `dat` become stale after Firebase updates `D`. Always reference `D.pages[ds]` (live) inside async callbacks, not the closed-over `dat`.
