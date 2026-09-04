# Changelog

All notable changes to Team Tracker are documented here, written for people using the app — not a commit log. Newest release first. Dates are release dates.

See [CLAUDE.md](CLAUDE.md#changelog) for how and when to update this file.

## [2.7.4] - 2026-09-03

### Changed
- The "Create file" dialog is clearer about its two options. The "saved as plain text, no encryption" disclaimer used to sit above the password fields, where it read as a warning about the whole dialog, and the "Use without password" button was wedged between Cancel and OK. Now Cancel and OK stand alone as the normal encrypted-file flow, and the password-less option — button plus its disclaimer — sits in its own section below them. The disclaimer text is also smaller and less heavy.

## [2.7.3] - 2026-09-02

### Changed
- Navigation shortcuts now work while an action-item card is open instead of doing nothing: the command palette (Ctrl+Shift+K), team switch (Alt+1‑9 or the sidebar), pane-module jump (F1‑F7), the pane focus/split/swap and history shortcuts (Alt+arrows), and closing the file (Ctrl+Alt+L). The card closes first, keeping everything you'd entered — including notes still being typed. Clicking an `@` reference inside a card's notes does the same when it opens in the same pane (with "open references in the secondary pane" on, the card stays put). A card with notes/assignee/etc. but no name still can't be dismissed this way — you're returned to it to fill in the name, same as pressing Escape.
- Preferences → Backup no longer shows a "Next backup" time. Backups don't run on a background timer — they're written when you save your file, at most once per the interval you pick. After restarting your computer with nothing edited since, that field just showed a time stuck hours in the past for a backup that was never actually scheduled. The tab now says backups happen on save.

### Fixed
- While editing an action-item card (or any dialog), pressing Escape to dismiss something opened on top of it — the editor help window, the `@`-mention list, the emoji or template picker, a right-click menu, or a confirmation prompt — also closed the card dialog underneath. Escape now closes just the topmost thing, one press at a time.

## [2.7.2] - 2026-09-01

### Changed
- Scrollbars across the app — the sidebar, panes, note editors, and dialog bodies — now take on the current color palette's accent tint instead of the plain grey operating-system scrollbar.

### Fixed
- In Preferences → Data, when the tab had enough content to scroll, the "Clear data" button at the bottom was jammed right against the scrollbar with no space around it. It now keeps a small margin from the scrollbar and the panel's bottom edge.

## [2.7.1] - 2026-08-31

### Added
- The link dialog now has a "Remove link" button when you open it on an existing link (Ctrl+K, or the 🔗 button with the cursor inside a link). It strips the link but keeps its text, and leaves the cursor right after it.

### Fixed
- Confirming the link dialog with Enter could split off a stray empty line and leave the cursor sitting on it, instead of just after the link you created.
- Starting a code block inside a blockquote — with Ctrl+Shift+E / Ctrl+Shift+6 or the { } toolbar button — made a code block that turned back into plain quoted text with literal ``` fences the next time the file was opened. Those two now do nothing inside a blockquote, matching what typing ``` already did.
- In a code block collapsed to its preview, the "+N more lines" count and the text copied by its copy button could disagree with the block's actual contents after certain edits.

## [2.7.0] - 2026-08-29

### Fixed
- When only the daily backup file's write permission had lapsed (the primary file was still saving fine), clicking "Grant access…" re-granted it but didn't actually write the backup — the backup stayed out of date until the next scheduled backup, up to a day later. It now writes the backup immediately once you re-grant access.
- After typing `**bold**`, `*italic*`, or `~~strike~~` to auto-format a word, the cursor stayed stuck inside the formatting: whatever you typed next was still bold/italic, and pressing Enter carried the formatting onto the new line. The cursor now lands cleanly after the formatted word.
- Applying a heading (H1/H2/H3, by shortcut, toolbar button, or typing `# `) to a bullet or numbered list item did nothing useful: on a nested item it split the list and jumped the cursor to another line, on a top-level item it flattened the whole list to plain text on the next save, and either way the heading was gone after reopening the file. A list item can't also be a heading, so headings now simply don't apply on a list line — take the line out of the list first (Shift+Tab) if you want it to be a heading.

### Added
- Rich-text notes now support blockquotes (`> text`) and external links (`[text](url)`), each with a toolbar button. The link button (or Ctrl+K) opens a dialog with **Link text** and **Link address** fields: it pre-fills the text from your selection, or — when the cursor is already inside a link — pre-fills both fields so you can edit that link in place. If you type an address with no scheme (`google.com`, `www.google.com`) it's saved as `https://…`. The address is checked when you confirm; a blank or unsupported one (only `http`, `https`, and `mailto` are allowed) shows an error and keeps the dialog open instead of silently doing nothing. Hovering a link shows its destination URL in a tooltip, plus how to open it (Ctrl/Cmd- or middle-click) and edit it (Ctrl+K). To open a link, Ctrl/Cmd-click (or middle-click) it — it opens in a new tab; a plain click just puts the cursor in the link so you can edit it.
- A toolbar button for inserting a horizontal divider line (previously only possible by typing `---`).
- Blockquotes: type `> ` at the start of a line to begin one; pressing Enter keeps the quote going on the next line with the bar unbroken, and Enter on an empty line ends the quote and drops you back into a normal paragraph. The quote shortcut (or the ❝ button) with the cursor already inside a quote now removes it. Headings, lists, and dividers don't apply inside a quote (they can't be saved there).
- Code blocks: at the start of a line, type ```` ``` ```` followed by a space, or ```` ``` ```` then Enter, to begin a fenced code block (or use the new **{ }** toolbar button / Ctrl+Shift+E). Everything inside is kept as literal, monospaced text — Enter adds a plain line break, and Enter on an empty last line ends the block. No other formatting (bold, links, `@` mentions, headings, lists) applies inside a code block, and pasting into one always pastes plain text. A code block longer than 8 lines opens collapsed to a short preview with a "+N more lines" strip; click it to expand. Hovering any code block shows a copy button (copies the whole block) and a collapse/expand toggle in its top-right corner. The collapsed/expanded state is per-view only — it isn't saved to the file and resets to the preview when you reopen the note.
- Keyboard shortcuts: Ctrl+Shift+E for a code block, Ctrl+Shift+9 (or Ctrl+Shift+Q, for keyboards where the browser or a driver swallows the first) for blockquote, Ctrl+K to insert a link.

### Changed
- The command palette shortcut moved from Ctrl+K to Ctrl+Shift+K, so Ctrl+K can insert a link while editing a note.
- Strikethrough now also responds to Ctrl+Shift+X (in addition to Ctrl+Shift+5).
- Editor toolbar: the copy button now sits on the right, next to the help button, instead of mid-toolbar.

## [2.6.2] - 2026-08-28

### Added
- The Backup settings tab now detects when the configured backup file can't be reached from the browser or computer you're on — which happens when backups were set up on a different machine, or the backup was later pointed somewhere else from another browser. Automatic backup is switched off and a "Set up backup…" prompt appears, instead of the tab showing backups as still on with a blank status area.

### Changed
- Start screen: the hosted-version card lists its three benefits (automatic updates; its own window with a taskbar shortcut; works fully offline) on separate lines, and the "Open hosted version" button is reworded and centered. On the installable version, that button now jumps straight to the install card — bringing it back even if you'd dismissed it — and focuses the Install button.

### Fixed
- Saving could fail with a generic error and fall back to a full "Save as…" prompt — most often during an automatic save — when it should have offered the one-click "Grant access…" recovery. The file's write permission is now requested up front when you pick the file.

## [2.6.1] - 2026-08-28

### Changed
- Strikethrough moved from Ctrl+Shift+X to Ctrl+Shift+5. On some Windows setups the browser or a keyboard driver swallowed Ctrl+Shift+X before the editor ever received it, so the shortcut did nothing. The toolbar **S** button and `~~text~~` markdown still work as before.
- "Clear formatting" (the 🧹 button) now also turns any heading in the selection back into a normal paragraph, matching Google Docs and Word — previously it only removed inline styling (bold, italic, strikethrough). List indentation is still left untouched.
- Person notes: the edit (✎) and "show in org chart" (🗺️) buttons in the header now use the same bordered-button look as the printer and split buttons above them, instead of appearing as faint icons.

### Fixed
- Applying a heading (Ctrl+1 / Ctrl+2 / Ctrl+3, or the H1/H2/H3 toolbar buttons) to a selection that spanned several lines, or to a bullet or numbered list, made the text grow larger on every press instead of snapping to a fixed heading size.

## [2.6.0] - 2026-08-28

### Added
- Person notes: the header now shows a second line under the name with the person's role and their classification (team member or stakeholder), and gains two buttons — one edits their name and role in place without leaving the page, the other jumps to their box in the org chart (stakeholders or team members) and flashes it.

### Changed
- Action items: the assignee field's dropdown is now a custom list grouped into "Stakeholders" and "Members" (each with its icon), filters as you type, and is fully keyboard-navigable (arrows / Enter / Escape) — replacing the plain browser autocomplete. The ▾ button always opens the full roster, even when the field already has text.

### Fixed
- Action items: closing a card with no title but with notes, an assignee, a due date, or a color no longer silently discards it. The card stays open with a "name the card" hint instead. A genuinely empty new card still closes and is discarded as before.
- Rich-text fields: Ctrl+Shift+X (strikethrough) and other Ctrl/Alt shortcuts did nothing on many international and non-QWERTY keyboard layouts. Shortcuts now match the physical key, so bold, italic, underline, strikethrough, save, the command palette, team switching, and daily-note navigation all work regardless of layout.
- Rich-text fields: Shift+Tab to outdent a nested bullet or numbered item silently did nothing in some cases once the list had been edited. It now promotes the item as expected, and nested items are no longer dropped when the note is saved.
- Installed app: the "update available" banner could sit under the window-controls overlay strip at the top of the window. It now stays clear of it.

## [2.5.2] - 2026-08-26

### Fixed
- The update-available banner's button ("Reload now" / "View release") became unreadable on hover — the label took on the banner's own background color and vanished. It now stays white with a subtle highlight.

## [2.5.1] - 2026-08-25

### Added
- Daily notes: Alt+[ and Alt+] step to the previous/next day, Alt+T jumps to today — works even while typing in the note, documented in Help.
- Action items: typing or picking an assignee name that matches an existing team member or stakeholder now turns it into a linked reference instead of plain text — it shows up on that person's page and stays correct if they're renamed. A clear (x) button reverts it back to free text.
- Start screen: when the last file is password-less, a "Reopen this file automatically next time" checkbox appears under the Reopen button. Enable it once and the app skips straight past the start screen on future launches — no click needed. Only works while the browser still remembers file access permission for that file; otherwise it falls back to the normal Reopen button.

### Fixed
- Closing a file (🔒 / Ctrl+Alt+L) with auto-reopen enabled no longer immediately reopens the same file, trapping you — it now returns to a normal start screen so you can open or create another file.
- Preferences → Backup: turning backup off then on, or picking a new backup location, could get stuck showing (and writing to) the *previous* backup file instead of the new one, with the status table failing to load. Picking a new target now takes effect immediately.

## [2.5.0] - 2026-08-24

### Added
- Preferences → Backup now shows a status block (filename, size, last/next backup time) that updates live as you toggle backup or change its target file.

### Changed
- Preferences → Backup: "Change backup location" moved below the new status block.
- Risks quadrant chart shows the team's total exposure (sum of chance × impact across open risks) next to the chart, and the chart itself renders bigger by default. Hovering a quadrant label now shows a tooltip too, not just the dot.

### Fixed
- Tabbing out of a rich-text field (a risk's plan, a milestone's concluded checkbox, a task's title) no longer lands on a toolbar button — it goes straight to the text area.
- The date picker's calendar popover now closes when you tab away instead of staying open over whatever you tabbed onto next.
- Action item board column titles now truncate with "…" on one line instead of wrapping or squeezing the add-card/delete buttons onto a second row.

## [2.4.8] - 2026-08-23

### Changed
- Preferences: the "Advanced" tab is now "Backup", holding only backup settings. Auto-save timing moved to the General tab, next to a clearer note that it saves your regular file (not the backup). Spacing throughout the dialog is more consistent and less cramped.
- Preferences → Backup: turning the checkbox on always opens the file picker, so backup never silently reuses an old file reference. "Change backup location" is hidden while backup is off.
- Clicking into a pane showing Daily Notes or General Notes (or opening one of those modules) now puts the cursor straight into the note so you can start typing immediately.

### Fixed
- The daily/hourly backup interval used to reset every time the app was reopened, so the first save of every session wrote a fresh backup regardless of how recently the real one on disk was written. It now checks the backup file's own last-modified time, so the interval is honored across reopens too.

## [2.4.7] - 2026-08-22

### Fixed
- The Window Controls Overlay titlebar area (added in 2.4.6, installed app only) was overlapping and misaligning the header, search bar, and view below it. It now sits correctly alongside the OS window controls without disturbing the rest of the layout.

### Changed
- "Reopen last file" is back on the start screen: confirmed the 2.4.6 titlebar change fixes the crash it was hidden for, so it no longer needs to be.

## [2.4.6] - 2026-08-22

### Changed
- "Reopen last file" is temporarily removed from the start screen: the previous fix traded the crash for an extra confirmation step every time, which wasn't a good trade. The underlying browser crash (installed app only, on a lapsed file permission) still has no clean fix, so the button is hidden until a browser update resolves it.
- The installed app now asks Windows/ChromeOS for a titlebar area when available, as part of investigating that same crash.

## [2.4.5] - 2026-08-22

### Fixed
- "Reopen last file" (installed app) no longer triggers the browser's permission-confirmation dialog that was crashing the app when the previous access had expired. Instead, it now asks you to pick the file again in the normal file-open dialog — the same one used by "Open…", which never crashed.

## [2.4.4] - 2026-08-22

### Fixed
- Attempted fix for a crash on "Reopen last file" in the installed app: it now asks for read-only access up front instead of read-write (write access is still requested normally the moment you save), and pauses briefly after the permission prompt closes before rebuilding the screen.
- The taskbar/dock badge no longer shows a stale count left over from a previous session — it's cleared on launch (before any file is open) and when you close the current file.

## [2.4.3] - 2026-08-22

### Added
- When installed as an app, the icon in the taskbar/dock now shows a badge with your total overdue and due-soon count across all teams, so you can see it without opening the window.
- The toast that appears when daily backup gets disabled because its file wasn't found now has a "Set up backup…" button that jumps straight to the backup settings, instead of just the earlier heads-up notice with no way to act on it.

### Fixed
- Opening a file (reopen-last, "Open…", or double-clicking a .tmv) that fails partway through now shows an error message instead of silently leaving a half-loaded, unresponsive screen with no feedback.

### Changed
- Added internal diagnostics around file-opening to help track down a reported crash on "reopen last file" in the installed app — no visible change in normal use.

## [2.4.2] - 2026-08-21

### Fixed
- Automatic backup no longer fails silently forever when a team file is moved to a different computer: it now turns itself off and shows a notice, instead of leaving the checkbox on while quietly never backing up again.

## [2.4.1] - 2026-08-21

### Fixed
- The "+ Column" button now matches the look of the "Edit tags" button instead of a dashed outline style of its own.
- Pressing Esc while renaming a column now cancels the rename instead of leaving it stuck in edit mode.
- The board can now be scrolled horizontally with the mouse wheel when it has a horizontal scrollbar but the hovered column has nothing to scroll vertically.
- Dragging a column onto the column immediately to its right no longer silently fails to reorder it.

## [2.4.0] - 2026-08-20

### Added
- Kanban boards can now have custom columns between the fixed To Do and Done/Cancelled columns — add, rename, remove, and reorder them per team. Removing a column that still has cards on it asks where those cards should go first.
- Once a board has enough columns to need it, the board scrolls horizontally instead of squeezing columns below a readable width.
- Copying or moving a task card to another team now asks which column it should land in on the destination board, instead of always dropping it in the first one.

### Fixed
- The "+ Column" button now lives in the board's toolbar instead of taking up a full column-width slot of its own.
- A column's delete (trash) button now sits at the far right of its header, after the "+ Card" button, instead of between the column name and "+ Card".
- Reordering a column is now done via a dedicated grip handle, with a clear highlight on the column being dragged and the column it would drop before — dragging used to have no visual indication at all.
- Unselected tag chips (in the board's filter strip and a card's tag picker) are no longer dimmed so much their label becomes unreadable.

## [2.3.4] - 2026-08-19

### Added
- The save-status indicator now shows a distinct amber "Grant needed" state when the browser has revoked write access to the main file or the daily backup file, separate from a real save error. Clicking it re-authorizes whichever file(s) need it and saves — one click covers both the main file and the backup, not just the one that failed.

### Changed
- A lapsed backup-file permission is now caught right after the next successful save, instead of only surfacing whenever the backup itself was next due to run (which could be up to a day later).

## [2.3.3] - 2026-08-19

### Fixed
- A save failure caused by the browser revoking file write access mid-session now shows a clearer "grant access" prompt that re-authorizes the same file, instead of the generic save-failed message that only offered "Save as…".

## [2.3.2] - 2026-08-18

### Added
- Task cards can now be expanded to fill the pane — a button at the top of the edit window — showing a save-status indicator and a manual save button while expanded, for a card you're working on for a while.

### Changed
- Task cards now save each change as you type, the same as risks, milestones, and notes — the edit window's Save/Cancel buttons are now a single Close.

### Fixed
- Search results now get the same selection highlight arrow-key navigation uses, instead of a different-looking outline.
- Landing on a task from a search result now selects it directly (Enter opens it), instead of only highlighting it with no keyboard way to open it.

## [2.3.1] - 2026-08-15

### Added
- Each risk's plan (Mitigate/Transfer/Eliminate/Accept) now shows as a distinct shape on the quadrant chart, with a legend below the chart explaining them.
- Risks can now be dragged directly on the quadrant chart to change their chance/impact, instead of only through the dropdowns — the target cell highlights as you drag.

### Fixed
- The quadrant chart's plan legend sat beside the chart instead of below it, wasting horizontal space.

## [2.3.0] - 2026-08-15

### Added
- Risks now show a chance/impact quadrant chart above the list: each open risk is plotted as a ring, with cell backgrounds lightly tinted red/yellow/green by exposure. Risks sharing a cell are spread apart automatically, with a short title label next to each dot when there's room. Clicking a dot expands (if needed) and jumps to that risk in the list below. The chart grows to use extra space in a larger pane, down to a fixed minimum size.
- Kanban column headings (To Do / WIP / Done+Cancelled) now show each column's item count, e.g. "To Do (3)".

## [2.2.3] - 2026-08-14

### Added
- Dialogs now trap Tab/Shift+Tab within themselves and focus their first field or row on open, instead of letting Tab escape to the page behind them.
- The due-items panel's rows can now be reached and opened by keyboard (Tab to focus, Enter/Space to open, Up/Down to move between rows).

### Fixed
- Opening the due-items panel from the command palette's "⏰ Due" entry with Enter closed it again immediately instead of showing it.

## [2.2.2] - 2026-08-13

### Added
- Keyboard navigation (arrow keys) for rows and cards in Risks, Milestones, and Tasks, plus a Delete option in their right-click menus.
- Alt+Shift+Up jumps pane history straight to its most recent entry.

### Changed
- Pane history is now Alt+Shift+Left/Right (plain Alt+Left/Right stopped reliably reaching the app in some browsers). Alt+Left/Right now select the left/right pane, Alt+Up toggles single/dual pane view, and Alt+Down swaps the two panes' contents.

### Fixed
- Alt+1-9 (team switch), Alt+Arrow/Alt+Shift+Arrow (pane navigation and history), and F1-F7 (module jump) now work reliably while typing in a note or editor, instead of sometimes falling through to the browser's own shortcut (e.g. F5 refreshing the page).
- Right-click and keyboard-opened context menus now support arrow-key navigation and restore keyboard focus to the row or card that opened them after closing.
- Closing a task's edit window with Escape could leave keyboard focus stuck, breaking further arrow-key navigation until you clicked elsewhere.
- Several dropdown menus (search, pane module picker, team switcher, command palette, editor's copy-format menu) could act behind an already-open dialog instead of being blocked by it.

## [2.2.1] - 2026-08-12

### Fixed
- The daily notes calendar now remembers whether you collapsed it, instead of reopening expanded every time.

## [2.2.0] - 2026-08-12

### Changed
- The references chip under the daily notes calendar toggle now centers under the button instead of sitting flush left.

### Fixed
- Renaming a person, action item, milestone, or risk now updates its `@`-mention chips live in every other pane that has a note open showing that mention, instead of leaving them frozen until that note was reopened.
- Typing right after inserting an `@`-mention no longer leaves you with no real cursor position to continue typing into.
- Clicking an `@`-mention inside an expanded milestone or risk follow-up to open its target in the other pane no longer collapses that expanded row.
- Deleting a task (kanban card) could occasionally cause a later card to land in the same position as another card.
- The person notes pane header could keep showing a person's old name after they were renamed from another pane.
- Unchecking daily backup in Preferences (or double-clicking "Change location") while a file picker was still resolving could silently leave the old backup setting active.

## [2.1.8] - 2026-08-11

### Fixed
- Closed a security issue where a maliciously crafted paste from another app could inject unexpected content into a note.
- Pasting a partial selection on Windows no longer leaves stray "StartFragment"/"EndFragment" text in the note.
- Pasting from Google Docs no longer bolds the entire pasted text, and multi-paragraph pastes no longer collapse onto one line.
- Pasted bold/italic/underline/strikethrough text from Google Docs, Gmail, and similar apps is now preserved (previously silently dropped).
- Pasting a table now renders readable rows instead of every cell's text jumbled together.
- Pasting a `<script>`/`<style>` block no longer leaks its raw contents into the note as visible text.

## [2.1.7] - 2026-08-11

### Added
- Two new color palettes: Verdant (green) and Ember (red) — the first green and red options in the picker.

### Changed
- Pasting between two notes now keeps lists, indentation, and bold/italic/underline/strikethrough formatting, instead of flattening everything to plain text.
- The copy-options menu (🗐 in the note toolbar) can now be navigated with the arrow keys and Enter, and no longer opens partly off-screen near a pane's right or bottom edge — same fix applied to the `@`-mention dropdown, the `/` template picker, and the team switcher.
- The "Warn about due dates within" field in Preferences is no longer a full-width input.
- The Muster color palette was removed — it looked nearly identical to Forest. Anyone who had it selected is switched to Forest.

## [2.1.6] - 2026-08-10

### Added
- Typing `---` (three or more dashes) then Space or Enter in any note field now inserts a horizontal divider — documented in the editor's help screen.

### Changed
- The pane's module ▾ menu now shows an icon per row and can be navigated with the arrow keys, Enter, and Escape — same as every other dropdown in the app. Jumping straight to one person's notes is now done via Ctrl+K (renamed "Fast Switch") instead of the pane menu.
- The Ctrl+K picker is now called "Fast Switch" throughout the app.
- The "Action items" module is now called "Tasks" throughout the app.
- The pane's module switcher moved to the left of the toolbar and now shows the current module's name — click the name to switch modules.
- The pane module dropdown's ▾ arrow is bigger, and each row shows its F1–F7 shortcut — press F1 through F7 to jump the focused pane straight to a module. Documented in the global shortcuts help screen.

### Fixed
- Switching the app's language no longer leaves the `/` template picker showing template names in the language you switched away from.
- Arrow-key navigation in dropdown lists (@ mentions, Ctrl+K palette, `/` template picker, search results, team switcher) now scrolls the highlighted item into view instead of leaving it hidden below the visible area.

## [2.1.5] - 2026-08-09

### Changed
- The six action-item tag colors now suggest category names (Process, People, Financial, Technical, Operations, Legal) instead of the old status-flavored Urgent/Blocked/In Review.
- An action item's color tag is optional again: a new card starts uncategorized, and you can clear an existing card's color by clicking its already-selected swatch a second time.
- Stakeholders and members now use different icons (🧑‍💼 vs 👥) instead of sharing one, across the sidebar, search, backlinks, and the command palette.
- Search results are now ranked instead of shown in an arbitrary order: matches where your search terms sit close together, or appear earlier in the text, are listed first.

## [2.1.4] - 2026-08-09

### Fixed
- Deleting a renamed person, action item, milestone, or risk left the *old* pre-rename name behind in every note that mentioned it, instead of its current name.
- The Data tab's cleanup tool (Prefs → Data → Cleanup) removed done/cancelled/closed items without updating notes that mentioned them, leaving broken-looking references behind.
- Right-clicking a card near the right or bottom edge of the screen (most often the right pane in split view) could open its actions menu partly or fully off-screen.

### Changed
- Deleting or purging something that's mentioned elsewhere now leaves a muted, italicized trace of the reference instead of plain, indistinguishable text — a visual cue that it used to link to something.
- A new action-item card no longer starts with a color/tag already picked for you — choose one before saving.

## [2.1.3] - 2026-08-08

### Fixed
- Closing a file (or switching to a different module) with a right-click card menu, a "↩ N" backlinks panel, or a milestone's date popover still open left it floating on screen — sometimes stranded on top of the start screen — and pinned that file's data in memory until you happened to open the same kind of popover again.

## [2.1.2] - 2026-08-08

### Changed
- The header search box no longer keeps its own separate copy of the search cache alongside the one already built for backlink badges — one shared cache instead of two doing the same work.

## [2.1.1] - 2026-08-08

### Changed
- The "↩ N" backlink badges (added in 2.1.0) now load noticeably faster on teams with large boards or lots of notes — they used to be recomputed from scratch for every card on every render.

## [2.1.0] - 2026-08-08

### Added
- People, days, action items, milestones, and risks now show a small "↩ N" badge whenever something else mentions them, so you can see what's pointing at a note or card without hunting for it. Click the badge to see every reference, grouped by where it comes from, and jump straight there.

## [2.0.5] - 2026-08-07

### Fixed
- Job titles in the org chart were shaved off along their right edge and underneath, most visibly when a search highlighted one.
- The org chart's connector lines had a gap between each pair of siblings, so the line joining a set of children read as broken instead of continuous.
- The milestones timeline needed horizontal scrolling whenever dates were closely clustered, and never adjusted when you resized a split pane. It now always scales to fit the pane's width, matching what its print preview already showed.

## [2.0.4] - 2026-08-07

### Fixed
- **Your last few keystrokes could be lost.** Typing into a note and then immediately switching module, team, or pane — within a fraction of a second — discarded whatever you had just typed. It never reached the file, so saving didn't help.
- **The same loss on closing.** Closing the file, closing the browser tab, or switching away from the tab right after typing saved a version of your notes that was missing those last keystrokes. Closing the tab also failed to warn you about unsaved changes in that moment.
- **Memory grew every time you closed and reopened a file.** Each close/reopen left the previous window's interface behind in memory instead of releasing it, so a long session that opened several files kept getting heavier. Closing a file now frees it properly.

### Changed
- Typing is noticeably smoother, especially with several teams: the sidebar no longer rebuilds itself on every keystroke, and searching no longer re-scans teams you haven't touched.
- Editing a risk or milestone title no longer causes a stutter when you click away from the field.

## [2.0.3] - 2026-08-07

### Fixed
- Copying notes as plain text ("Copy plain text") flattened nested bullet lists, losing the indentation. Nested lists now copy with their structure intact.

## [2.0.2] - 2026-08-07

### Added
- The "Copy formatted" and "Copy plain text" buttons are now combined into a single "Copy…" menu (plain / formatted / markdown).
- New toolbar button to quickly insert @ for referencing people, action items, milestones, or risks.

## [2.0.1] - 2026-08-07

### Fixed
- Making a multi-line selection bold or italic could silently drop line breaks — both when saving and when copying as plain text.

## [2.0.0] - 2026-08-05

### Added
- **Optional passwords.** `.tmv` files no longer require a password. Skip it when creating a file, or remove it later from an existing one — your notes stay in a plain, readable file instead. Prefer to keep a password? Nothing changes for you.
- **Password strength meter.** Setting or changing a password now shows live feedback so you know if it's strong enough before you save.
- **Daily backup.** Point Team Tracker at a second file (e.g. on a different drive or cloud folder), and every save now mirrors to it automatically — once every 24h. If your main file ever gets corrupted, your backup has you covered.

## [1.8.2] - 2026-08-03

### Fixed
- Ctrl+K (or the "Team Tracker" header button) no longer opens a command palette full of dead-end options when no team exists yet.
- Your work now also saves when the window loses focus (e.g. minimized, or you switch to another app) — not only when you switch browser tabs.

### Added
- Text size options expanded from 3 to 5 steps (XS–XL) for finer control.

## [1.8.1] - 2026-08-02

Usability and accessibility pass.

### Changed
- Risks are now usable in a split (narrower) pane — long titles no longer get cut off, and the layout adapts to the available width instead of overflowing.
- Every row action (expand, close, delete) is now reachable by keyboard, not just mouse.
- Milestone timeline labels no longer overlap each other.
- An empty people group now shows a proper message instead of a generic "no module open."
- The color palette picker now consistently themes every part of the UI, including the exposure indicator.
- Several smaller polish items: clearer chance/impact labels, cleaner kanban cards, a capped notification stack, clearer save-status text, and a friendlier first-run screen.

## [1.8.0] - 2026-08-02

### Changed
- The app now re-renders only the parts of the screen affected by your edit instead of the whole view — noticeably snappier on larger teams.

### Added
- The active tag filter on the action items board is now clearly highlighted.

## [1.7.3] - 2026-07-30

_No user-facing changes — documentation only._

## [1.7.2] - 2026-07-30

### Added
- Opening a `.tmv` file from your operating system's file browser can now launch Team Tracker directly.
- New filterable Due Dates panel, reachable from the sidebar, header, or command palette.
- Clicking a reference can now open it in the secondary pane instead of always the current one.

### Fixed
- Polish across the sidebar's due-date indicators, the date picker, and scroll behavior.

## [1.7.1] - 2026-07-27

### Fixed
- Some correctly-typed passwords — especially ones with accented characters, common in pt-BR — could be rejected as "wrong password," caused by how different keyboards/operating systems encode accented characters.

### Added
- Team switcher dropdown added to the sidebar's team pill — switch teams without expanding the sidebar.

## [1.7.0] - 2026-07-26

### Added
- **Cross-team cleanup tool** (Preferences → Data): bulk-remove old completed action items, milestones, risks, and daily notes across every team at once, with a preview of what will be deleted before you confirm.
- `Ctrl+Shift+F` now jumps straight into cross-team search.
- The "due soon" alert window default was raised from 3 to 7 days.

## [1.6.2] - 2026-07-24

### Added
- The daily-notes calendar now flags days with a due action item (✅), alongside the existing milestone flag (🚩).
- The save-status pill is now clickable to trigger a save.

### Fixed
- The header no longer overlaps itself on narrow windows.

## [1.6.1] - 2026-07-22

### Fixed
- Un-splitting and then re-splitting the view could show duplicated content in both panes instead of restoring your original two-pane layout.

### Added
- "Today" button added to the daily-notes calendar.
- Command palette rows now show an icon for each module, with clearer placeholder text.

## [1.6.0] - 2026-07-22

### Fixed
- Clicking a due-date reminder, or jumping to a cross-team search result, could silently do nothing if the target team's pane layout was single-pane instead of split.

## [1.5.3] - 2026-07-21

### Added
- Team Tracker now checks for updates and lets you know when a new version is available.
- The sidebar can be collapsed, and the layout adapts better to narrower windows.

## [1.5.2] - 2026-07-21

### Added
- **Nested lists.** Bullet and numbered lists can now be nested up to 4 levels deep. Press **Tab** on a list item to indent it under the item above; **Shift+Tab** to bring it back out. Works on multiple selected items at once too.
- **Right-click actions on cards.** Action items, risks, and milestones now support right-click → Duplicate, Copy to team, or Move to team, with a team picker to choose the destination.
- **Settings → Tags tab.** Rename an action-item tag once and apply it across every team at once, instead of editing each team separately.
- **Expand all / Collapse all** for risks and milestones.
- **Header polish.** The open file's name is now shown in the header, along with the exact save time.
- Custom date picker and locale-aware time formatting throughout the app, plus a clearer save-status indicator.

### Fixed
- Shift+Tab no longer jumps your cursor to the start of the line — it now stays right where you were typing.
- Moving a card to another team no longer leaves behind dangling `@`-references pointing at the old team.
- Switching teams could leave a pane showing stale data from the previous team.

### Changed
- Release downloads are now just the standalone `app.html` (+ checksums). The installable PWA version is still published at https://fmpallini.github.io/team-tracker/ — it's just no longer bundled as a separate zip on the releases page.

## [1.5.1] - 2026-07-20

_No user-facing changes — internal CI/versioning cleanup only._

## [1.5.0] - 2026-07-19

Maintenance and code-quality pass. No new features, no data/file format changes — every `.tmv` file you already have opens and saves exactly as before.

### Fixed
- Search bar no longer leaks memory across file sessions — closing a file and opening another used to leave the old search bar's listeners attached in the background.
- Header buttons no longer show stale text after switching language.
- The kanban board's overdue-date highlighting and the sidebar's "Due" badge now always agree on what counts as overdue.

### Changed
- The kanban board re-renders more efficiently on every edit — noticeable on boards with many cards.
- The sidebar's due-date scan is now cached instead of recomputed on every click.
- The `@`-mention picker and the `Ctrl+K` command palette do less redundant work each time they open.

## [1.4.4] - 2026-07-19

### Fixed
- Found and fixed the real root cause of the "Install" prompt reappearing after install: a bug silently broke the install-detection check under the hood. Confirmed fixed on a live installed copy.

## [1.4.3] - 2026-07-19

### Fixed
- Follow-up fix for the "Install" prompt still appearing after install (v1.4.2) — corrected the app identity used to check install status. _Still not fully resolved for everyone — see v1.4.4._

## [1.4.2] - 2026-07-19

### Fixed
- Attempted fix for the "Install" prompt still appearing after you'd already installed Team Tracker as an app. _Incomplete for some users — see v1.4.3 and v1.4.4._

## [1.4.1] - 2026-07-19

### Added
- **@-mentions now work for action items, milestones, and risks**, not just people. Type @ to link directly to any of them; the label stays in sync automatically, and unlinks itself if you delete the referenced item.
- The command palette (Ctrl+K) now lists individual action items, milestones, and risks by name.

### Fixed
- Command palette rows now respond reliably to clicks in every case.

## [1.4.0] - 2026-07-18

### Added
- **Due-date reminders**: a sidebar badge plus a due-items list, with a configurable "due soon" window.
- **Named action-item tags**, editable per team, with filter chips and labels on the kanban board.
- **Export and import whole teams** (Preferences → Data tab).
- A visual highlight now shows where a dragged card will land on the kanban board.

### Fixed
- Color chips only show a name once you've actually named that color, instead of a generic placeholder.

## [1.3.2] - 2026-07-16

### Added
- **7 new color palettes** to choose from (Signal, Blueprint, Muster, Forest, Desert, Cosmic, 80's Hacker), alongside the original Field Ledger theme.

### Fixed
- Missing favicon.
- A harmless but noisy browser warning shown near the password field.
- The installed app's icon no longer clips at the corners, and relaunching now focuses the existing window instead of opening a new one.

### Changed
- Smaller download size (188KB → 176KB).

## [1.3.1] - 2026-07-16

### Fixed
- Closing the app's browser tab now reliably saves your latest changes first — previously a save could be missed in that exact moment.

### Changed
- Saving is quicker on repeat saves: the encryption key is now cached for your session instead of being recomputed from your password every time.

## [1.3.0] - 2026-07-15

### Added
- The start screen now shows the app version, linked to the GitHub releases page.

### Fixed
- The installed-app entry on Windows was always showing version "1.0" regardless of the actual release.

### Changed
- Auto-save interval increased from 5 to 10 minutes — easier on files synced through Google Drive Desktop, OneDrive, etc.

## [1.2.0] - 2026-07-15

### Added
- **Action items are now a kanban board** (To Do / WIP / Done / Cancelled) instead of a flat checklist — drag and drop cards between columns, with due dates, assignees, and color labels.
- **Install Team Tracker as an app.** The hosted version now offers a one-click "Install" prompt; the downloadable file version points you to the hosted app if you'd rather not manage a file.

### Fixed
- Closing a split pane now keeps the pane you were focused on, instead of jumping back to the first one.
- Header and search box no longer show stale text after switching language.
- The file-open dialog no longer lists unrelated file types.

## [1.1.0] - 2026-07-15

First public release.

Team Tracker is a zero-dependency, single-file app for tracking teams: people and hierarchy, daily notes, per-person notes, action items, milestones, and risks. Everything lives in one password-encrypted `.tmv` file that you open and save yourself — no server, no account, no sync.

### Added
- The core app: people tree, daily notes, action items, milestones, risks.
- A downloadable, installable web app version at https://fmpallini.github.io/team-tracker/.
- Full documentation and an AGPL-3.0 license.
