# Shell layout, sidebar collapse, export text, and two small bug fixes

Date: 2026-07-21

## Summary

Five changes, bundled because they touch the same shell/header area:

1. Collapsible team selector (sidebar), to free up working area.
2. Responsive shell: on narrow windows, auto-hide split-view first, then the sidebar; keep header-right controls always visible.
3. Clarify the Data-tab export support text (scope + unencrypted).
4. Fix missing top padding on the due-date notifier button.
5. Hide the "Window without browser UI" help tip in the PWA build.

Items 3-5 are copy/CSS/conditional fixes with no design ambiguity. Items 1-2 are the actual feature/behavior work this spec defines.

## 1. Sidebar collapse

- New toggle button at the top of `.tt-sidebar`, above the due-date button, visually consistent with the existing split-pane toggle (`⧉`-style icon button) in `src/ui/panes.ts`.
- New persisted preference: `prefs.sidebarCollapsed: boolean` — a doc-level pref (not per-team; it's a global layout choice, unlike `nav.teamSplit` which is per-team).
- Collapsed state: `.tt-body` grid changes from `220px 1fr` to `0 1fr` (sidebar content hidden), with a small always-visible re-expand tab/handle at the body's left edge so the user can get back in.
- Toggle handler lives alongside `toggleSplit()` in intent (same "flip pref, notify, re-render" shape), but sidebar visibility is a pure CSS/layout concern — no pane content needs folding, unlike un-splitting.

## 2. Responsive auto-hide

- A `ResizeObserver` watches `.tt-shell` (or `.tt-body`) width.
- Two thresholds:
  - **900px**: below this, split-view auto-hides (single pane), reusing the existing `toggleSplit()` code path.
  - **650px**: below this, the sidebar also auto-hides, reusing the toggle from Section 1.
- **State model** — manual (persisted) state and space-driven (transient) state are tracked separately so neither clobbers the other:
  - Persisted: `nav.teamSplit[teamId]` (existing) and `prefs.sidebarCollapsed` (new, Section 1) — set only by explicit user toggle clicks, and are what gets restored when the file is reopened.
  - Transient, in-memory only, not persisted: `spaceHidden` flags for split and sidebar independently.
  - Effective visibility = `!manualState.collapsed && !spaceHidden`.
  - Crossing a threshold **downward** (wide → narrow) sets the relevant `spaceHidden = true` (edge-triggered, fires once per crossing).
  - Crossing a threshold **upward** (narrow → wide) clears `spaceHidden` (auto-reflow back open) — unless the persisted manual preference is also collapsed, in which case it stays hidden.
  - A manual toggle click always forces the opposite effective state immediately, overriding `spaceHidden` if the user chooses to expand while narrow. A further downward threshold crossing is required before auto-hide fires again (matches "manual wins until width crosses threshold again").
- **Header-right never disappears**: `headerRight`'s children (`saveIndicator`, `fullscreenBtn`, `helpBtn`, `closeFileBtn`, `settingsBtn`) get `flex-shrink: 0`. `headerLeft`'s contents (app name / search bar) absorb the squeeze instead. This is a plain CSS fix, independent of the two JS thresholds above, and addresses "keep header-right elements visible on any window size."

## 3. Export support text

`team-export.ts` / the Data-tab export (`src/ui/prefs.ts`) already exports only teams/members/stakeholders structure, unencrypted, with notes stripped — this already matches the requirement. Only the user-facing copy needs to change.

Rewrite `data_export_hint` (both `pt-BR` and `en-US` in `src/core/i18n.ts`) to explicitly state:
- Only team/member/stakeholder structure is included (no notes, no other content).
- The file is **not encrypted**.
- Intended for teammates working on the same team to import and skip initial setup.

No format, schema, or code changes — copy only.

## 4. Due-button padding (bug)

`.tt-due-btn` (in `src/ui/sidebar.ts`, styled in `styles.css`) is the first child appended to `.tt-sidebar`, which sits directly under the header's `border-bottom` with no spacing. Add top padding/margin so the button doesn't look flush against that divider line.

## 5. Help tip visibility (bug)

`showGlobalHelp()` in `src/ui/help.ts` unconditionally renders the `help_appwindow_heading` / `help_appwindow_body` / `chrome --app=...` block. Gate that block behind `!__PWA__` (the existing build-time define already used elsewhere, e.g. `src/main.ts`) so it only appears in the plain `dist/app.html` build, never in the PWA build (which doesn't need a Chrome app-mode workaround since it's already installable/standalone).

## Testing

- New `store`/prefs coverage for `sidebarCollapsed` persistence and migration default (existing docs opening without the field).
- Unit tests for the effective-visibility logic (manual vs spaceHidden interplay) — extract as a small pure function so it's testable without a real `ResizeObserver` in jsdom (jsdom doesn't implement `ResizeObserver`; code must feature-detect/degrade the same way Web Locks/BroadcastChannel already do).
- i18n test coverage already asserts both locales have matching keys — updated hint text just needs both locales kept in sync.
- `help.ts` test: assert app-window tip absent when `__PWA__` true, present when false (vitest config already sets `__PWA__: false` — add a case that simulates true, likely via dependency injection/param rather than re-defining the global).
