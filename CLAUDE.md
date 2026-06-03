# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**分院CE連絡表 (CEnote)** — A clinical engineering department daily scheduling and communication web app for a hospital branch. Written entirely in Japanese, intended for staff to manage daily duty assignments, checklists, memos, OPE/catheter procedures, and shift data.

## Project Structure

This is a **single-file web app**: all HTML, CSS, and JavaScript lives in `index.html` (~370KB). There is no build system, no bundler, no package manager, and no test framework.

## Running Locally

Open `index.html` directly in a browser, or serve it with any static file server:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

**Preview mode (no Firebase login required):**
- `?preview=1` — admin mode (all tabs unlocked, local storage only)
- `?preview=2` — regular user mode (restricted tabs, local storage only)

## Architecture

### Global State Object `D`

All application data lives in a single global variable `D` (line ~1049):

```js
var D = {
  pages: {},        // daily pages keyed by "YYYY-MM-DD"
  stf: [],          // staff names list
  phs: [],          // phone extension numbers
  dly: [],          // daily checklist items (every day)
  wd: {},           // weekday-specific checklist items { 月: [...], 火: [...], ... }
  lk: {},           // lock flags { duty: true, sm: true, ... }
  ope: [],          // OPE procedure types
  cath: [],         // catheter procedure types
  sup: [],          // surgical supplies list
  opeTree: [],      // hierarchical OPE procedure master
  cathTree: [],     // hierarchical catheter procedure master
  supTree: [],      // hierarchical supply master
  dutyCfgMaster: [],// duty slot master definitions
  dutyCfg: [],      // duty slot config per template
  opsCfg: [],       // operations config
  oc: [],           // on-call config
  shift: {},        // shift data
  evts: {},         // events per date
  manual: {},       // task manuals { taskName: { text, media: [...] } }
  schedPresets: []  // schedule timetable presets [{ label, color, dur(min), custom? }]
};
```

Each `D.pages["YYYY-MM-DD"]` contains all data for a single day: duty assignments (`duties`), checklist state, memos, pool staff, OPE/cath records, per-day timetable (`schedule: [{ id, staff, label, start, end, color }]`, times in minutes-from-midnight), etc.

### Persistence

- **Firebase ON**: `saveD()` writes the entire `D` object to `fbDB.ref('/data').set(D)`
- **Firebase OFF / fallback**: writes to `localStorage` key `'ce2'`
- **Logs**: written via `writeLog()` to Firebase `/logs` (never to localStorage)
- **Media**: uploaded to Firebase Storage at path `manual/{taskName}/{timestamp}_{filename}`

`saveD()` always writes the **full** `D` object — there is no partial/field update. This is important: after mutating any property of `D`, call `saveD()`.

### Firebase Setup (line ~1140)

```js
var FB_CFG = {
  apiKey: "...",
  authDomain: "...",
  databaseURL: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
var FB_ON = !FB_CFG.apiKey.includes("YOUR_");
```

`FB_ON` is `true` when a real API key is configured. When `false`, the app runs offline using only localStorage.

### Authentication

- Firebase Email/Password auth
- Admin status: checked via `fbDB.ref('/admins/' + user.uid).once('value')` — returns `true` if admin
- Global `isAdmin` boolean and `currentUser = { uid, email, displayName, isAdmin }`
- Idle auto-logout: 30 minutes with 5-minute countdown warning

### Access Control

```js
function lk(id)  { return !!(D.lk && D.lk[id]); }   // is section locked?
function can(id) { return isAdmin || !lk(id); }       // can current user act?
```

Lock IDs are defined in `LOCK_DEFS` (line ~958): `duty`, `sm` (staff mgmt), `phs` (phones), `dm` (daily master), `wm` (weekday master), `pg` (page generation), `memo`, `ops`, `oc`.

### Firebase Listener Deduplication

The `/data` listener is set only once per session using a `dataListenerOn` flag (inside `fbInit()`). Firebase auth token refreshes (~every hour) re-trigger `onAuthStateChanged` — the flag prevents duplicate listeners from accumulating.

After `saveD()`, a `_savingTs` timestamp suppresses listener-triggered re-renders for 800ms to prevent the Firebase echo from overwriting in-progress UI state.

### UI Layout

```
.tb       — top bar (fixed)
.ab       — app body (flex row)
  .sb     — sidebar (left, collapsible)
    .stabs — tab strip
    pane-cal    — calendar with month navigation
    pane-assign — assignment table (月次担当一覧)
    pane-guide  — user guide
    pane-staff  — staff management (admin only)
    pane-master — duty/checklist master (admin only)
    pane-lock   — lock management (admin only)
    pane-logs   — activity log (admin only)
    pane-spec / pane-manual / pane-adminm / pane-dev — docs sub-tabs (admin only)
  .main   — day detail view (right, scrollable)
```

Mobile (`max-width: 768px`): sidebar becomes a fixed full-screen overlay toggled by `.hbg` hamburger button.

### CSS Conventions

All class names are abbreviated. Key patterns:
- `.tb` toolbar, `.sb` sidebar, `.ab` app body, `.cw` calendar widget, `.cg` calendar grid, `.cd` calendar day
- `.dg` duty grid, `.dc` duty card, `.dl` duty label, `.ds2` duty select
- `.pp` patient/page properties panel, `.pr` property row, `.pl` property label, `.pv` property value
- `.co` comment/note box, `.ln` warning/lock notice
- `.mo` memo textarea, `.clg` checklist group, `.cli` checklist item
- `.btn-p` primary button (blue), `.btn-g` ghost/secondary button, `.btn-d` danger button
- `.ov` overlay backdrop, `.md` modal dialog
- `.sp-panel` side peek panel (task manual viewer/editor)
- CSS custom properties in `:root`: `--ac` accent blue, `--rd` red, `--gr` green, `--or` orange, `--pu` purple, `--gd` gold, `--oc` light blue (on-call)

### Key Functions

| Function | Purpose |
|---|---|
| `init()` | App bootstrap — loads data, inits Firebase, renders calendar |
| `loadD()` | Hydrates `D` from localStorage (called before Firebase connects) |
| `fbInit()` | Sets up Firebase auth listener and `/data` realtime listener |
| `saveD()` | Persists `D` to Firebase `/data` or localStorage |
| `openPage(ds)` | Opens a day's detail view in `.main` |
| `renderPage(ds)` | Re-renders the currently open day page |
| `safeRenderPage()` | Calls `renderPage(curDs)` only if a page is open |
| `renderCal()` | Renders the calendar sidebar widget |
| `renderAT()` | Renders the monthly assignment table |
| `buildDG(ds, dat, locked)` | Builds the duty card grid for a day |
| `buildCL(ds, dat, wtl, all, locked)` | Builds the checklist section |
| `buildOPS(ds, dat, locked)` | Builds the OPE/cath/operations record section |
| `renderMemos(ds, dat, locked)` | Renders the memo/comment thread |
| `renderSched()` | Renders the per-day timetable (⏰ スケジュール tab) for `curDs` |
| `writeLog(action, detail)` | Appends an entry to Firebase `/logs` |
| `can(id)` / `lk(id)` | Access control helpers |

### Duty/Assignment System

`DUTIES` (line ~935) defines the fixed duty slot types (`ope`, `ope_sub`, `cath`, `cath_sub`, `ward`, `device`). `DEF_DUTY_MASTER` (line ~949) is the editable master that admins can customize.

Each day's `D.pages[ds]` stores duty assignments as `{ ope: "name", cath: "name", ... }` alongside a "pool" of unassigned staff that can be drag-and-dropped into slots.

### Schedule Timetable (⏰ スケジュール)

A sidebar tab (`tab-sched` / `pane-sched`) that builds a per-day timetable for `curDs`: vertical time axis 8:00–21:00 in 15-min steps, one column per on-duty staff member. Blocks are stored in `D.pages[ds].schedule` and rendered absolutely-positioned. Editing is pointer-based (drag body to move/change staff column, drag bottom handle to resize). Preset blocks (`D.schedPresets`, defaults in `DEF_SCHED_PRESETS`) are added by tap-to-select + tap-column or HTML5 drag-and-drop. `schedImportDuties()` seeds blocks from `dat.duties`. Like `pane-assign`, this pane hides `.main` and fills the area; on mobile it is `position:fixed` full-screen with a 戻る button. Available to all users (read-only when `duty` is locked for non-admins).

### Shift Import

`parseShiftSheet(wb, fileName)` (line ~3512) parses an Excel file (via xlsx.js) to populate `D.shift`. The SIM modal (`openSIM()`) lets admins upload shift spreadsheets.

**Overwrite protection:** `doSaveSIM()` detects days that already have duty assignments (`dayHasDutyAssigned(ds)` — any non-empty value in `D.pages[ds].duties`). If any exist it confirms with the admin, then preserves the old `D.shift`/`D.evts` columns for those "protected" days while importing the rest, so a re-import never clobbers a day whose assignments are already built.

### PHI Detection

`detectPHI(text)` scans text for patient health information patterns. Returns `{ red:[...], yellow:[...] }`. `phiHasBlock(result)` is true when a hard block (8-digit ID or full name) is present.

`showPHIPopup(opts)` is the unified warning **popup modal** (`#modal-phi`): it lists detected items and a 是正方法 (fix guidance). Buttons: 修正する (close + refocus) always; 確認済み・このまま送信/保存 only when not block-level. `opts = { result, mode:'memo'|'field', onProceed, onFix }`.

- **Memos:** `postMemo(ds)` runs `detectPHI` on send; if anything is detected it opens the popup (block-level PHI cannot be sent; soft warnings can be confirmed).
- **All other free-text fields:** `initPHIGuard()` (called in `init()`) attaches one delegated `focusout` listener on `#main` covering every `textarea`/`input[type=text]` (except `#memo-new`). On blur with detected PHI it opens the same popup. New free-text fields added under `#main` are covered automatically — no per-field wiring needed.

### Fairness Check (⚖️ 公平性)

`renderFairness()` is the 4th subtab of the assignment pane (`subtab-fair` / `subpane-fair`). For the `asY/asM` month it counts duty assignments per staff per slot label (via `getDutyCfg(pg)` so per-page `customDuties` are honored), shows a staff×duty matrix with per-column max(red)/min(blue) highlighting, a total bar with worked-day count, and an imbalance warning when any column's max−min ≥ `FAIR_GAP_WARN` (default 3).

## Firebase Database Structure

```
/data/          — full D object (written by saveD())
/logs/          — activity log entries (append-only via push())
/admins/{uid}   — set to true for admin users
```

## Making Changes

Since everything is in one file, locate the relevant section by searching for the function name or CSS class. The file is organized as:

1. `<head>` — external CDN scripts, CSS styles
2. HTML structure (modals, login overlay, toolbar, sidebar panes, main area)
3. `<script>` — all JavaScript starting at line ~933

When modifying behavior, always call `saveD()` after mutating `D`. When modifying rendering, prefer calling the targeted render function (e.g., `renderStfList()`) rather than `renderPage()` to avoid full re-renders. In some cases `renderPage()` must be called **before** `saveD()` to avoid the Firebase echo overwriting the new UI state before the save completes.
