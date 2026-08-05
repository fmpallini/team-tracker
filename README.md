# Team Tracker

A zero-runtime-dependency, single-file web app for tracking teams: people and
hierarchy, daily/per-person notes, action items, milestones (with a calendar
view), and risks.

![Team Tracker screenshot — daily notes and team hierarchy side by side](docs/screenshots/daily-notes-and-org.png)

**[Try it now](https://fmpallini.github.io/team-tracker/)** — runs entirely in
your browser, nothing to install.

<details>
<summary>More screenshots</summary>

| | |
|---|---|
| ![Action items kanban board with tags, due dates, and assignees](docs/screenshots/action-items-kanban.png) | ![Milestones timeline and list, with a done and an overdue item](docs/screenshots/milestones.png) |
| Action items — kanban board | Milestones — timeline + list |
| ![Risks matrix with chance/impact/exposure and mitigation plans](docs/screenshots/risks.png) | ![Ctrl+K command palette for jumping to any team, person, or item](docs/screenshots/command-palette.png) |
| Risks — chance × impact exposure | `Ctrl+K` command palette |
| ![Ctrl+Shift+F cross-team search with highlighted matches](docs/screenshots/global-search.png) | |
| `Ctrl+Shift+F` search across every team | |

</details>

## Why

Most team-tracking tools require an account, a server, and your data leaving
your machine. Team Tracker doesn't:

- 🔌 **100% offline** — works without internet; nothing leaves your machine.
  The one exception: the app checks GitHub for a newer release at most once a
  day (a plain, read-only request to the public releases API — no data of
  yours is sent) and shows a banner if one exists; it never downloads or
  installs anything on its own; that's always something you have to trigger
  — see [Checking for updates](#checking-for-updates).
- 🗄️ **A single `.tmv` file** you keep wherever you want — copy it, back it up,
  put it in your own cloud sync, put it on a USB stick. There is no vendor
  storing it for you.
- 🔒 **Encryption is the default, and optional** — a `.tmv` file is normally
  AES-256, decrypted only on your device with your password; you can also
  create (or later migrate to) a password-less plain-text file if you'd
  rather skip that overhead, at the cost of anyone with file access being
  able to read it.
- 🪶 **Tiny** — the entire app is a single HTML file under 170 KB
  (as of v1.2), smaller than most web pages' hero image.
- 🖥️ **Desktop-only by design** — built for keyboard and large screens
  (shortcuts, split view, dense panes). Phones and tablets show a notice
  instead of the app: mobile browsers lack the File System Access API the
  open/save flow depends on, so there is no good way to work with your
  `.tmv` file there.

There's no server and no backend. Everything lives in one password-encrypted
`.tmv` file that you open, edit, and save yourself, either straight off disk
(`dist/app.html` via `file://`) or through an installable PWA build
(`dist/pwa/`).

## Why zero runtime dependencies

The app ships as one HTML file with the CSS and JS inlined into it — open it
years from now, on any machine, with any browser, and it still works exactly
as built. That guarantee only holds if nothing at runtime depends on a
third-party library that could have a vulnerability, an abandoned maintainer,
or a breaking major-version bump. `esbuild`, `typescript`, `vitest`, and
`jsdom` are dev-only tooling used to build and test the app — none of their
code ships in `dist/app.html` or `dist/pwa/`. This is a hard project
constraint: no runtime dependency is ever added, however small.

It also means the entire attack surface for supply-chain compromise is
whatever ships in the two build outputs, which you can read end to end — there
is no `node_modules` tree running in the user's browser.

## Using the local file (`app.html`)

Download `app.html` from the
[latest release](https://github.com/fmpallini/team-tracker/releases/latest):
on the release page, expand the **Assets** arrow at the bottom of the release
notes and click `app.html` there — that single file is everything you need
(or build it yourself, see [Build](#build), where it lands in `dist/app.html`).
Just double-click it, or open it from your browser's file picker. No install,
no server required — the whole app (HTML, CSS, JS) is inlined into that one
file. The only network request it ever makes is the once-a-day update check
(see [Checking for updates](#checking-for-updates)); nothing else needs, or
uses, a connection.

To open it in its own app-like window (no address bar/tabs) instead of a
regular browser tab, launch Chrome with the `--app` flag:

```
chrome --app=file:///C:/path/to/dist/app.html
```

(On macOS/Linux, drop the drive letter: `--app=file:///path/to/dist/app.html`.)

## Installable version (PWA)

The same app — always the same version as the `app.html` release asset — is
published at **<https://fmpallini.github.io/team-tracker/>**. Unlike the local
file, it can be installed as a local app (Chrome/Edge show an install prompt;
it opens in its own standalone window), and it **updates automatically**
whenever a new version is released — no re-downloading a release asset by
hand.

## Checking for updates

This is the one network call the app ever makes, in both build variants:
once a day, it fetches `https://api.github.com/repos/fmpallini/team-tracker/releases/latest`
(a public, unauthenticated read — nothing about you or your data is sent) and
shows a banner if a newer version is out. It's purely informational — the
app never downloads or installs anything by itself; you decide whether to
act on the banner:

- **PWA build**: the banner offers a "Reload now" button that has the
  already-updated service worker take over on reload — no re-download by
  hand.
- **Standalone `app.html`**: a static file:// build can't self-update, so the
  banner instead links to the GitHub releases page for you to download the
  new `app.html` yourself.

Dismissing the banner silences it for that version; there's no preference to
turn the check off entirely.

## Verifying a release

Every tagged release publishes `checksums.txt` alongside `app.html`, plus a
[GitHub build-provenance attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)
for `app.html` and every file in the PWA build (`dist/pwa/**`) — cryptographic
proof (Sigstore-backed, not just a checksum) that a given file was built by
this repo's own `Release` GitHub Actions workflow from that exact tagged
commit, not hand-assembled or modified after the fact. You can verify this
yourself instead of taking it on faith:

```
# 1. Download the release assets for the tag you want to verify (example: v1.5.1)
gh release download v1.5.1 -R fmpallini/team-tracker -p "*"

# 2. Confirm app.html matches the published checksum
sha256sum -c checksums.txt

# 3. Verify the build-provenance attestation — requires the GitHub CLI (gh).
#    Confirms the file's hash was attested by the "Attest build provenance"
#    step in this repo's release.yml, tying it to a specific workflow run and
#    source commit.
gh attestation verify team-tracker-1.5.1.html -R fmpallini/team-tracker
```

A successful verify exits with status `0` (silently, in most shells); a
tampered or unrelated file fails with a `404` — there's no matching
attestation for that file's hash. To see exactly which commit the file was
built from, add `--format json` (requires [`jq`](https://jqlang.org/)):

```
gh attestation verify team-tracker-1.5.1.html -R fmpallini/team-tracker --format json \
  | jq -r '.[0].verificationResult.statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit'
```

Compare that SHA against the tag's commit on the
[commits page](https://github.com/fmpallini/team-tracker/commits/main) to
confirm they match.

The PWA build isn't a separate downloadable release asset — it's attested
directly and deployed straight from that same attested build to GitHub Pages,
so you can verify what's actually live by downloading each served file and
checking its attestation directly, no zip needed:

```
for f in index.html sw.js manifest.json; do
  curl -s "https://fmpallini.github.io/team-tracker/$f" -o "live-$f"
  gh attestation verify "live-$f" -R fmpallini/team-tracker
done
```

## Data file

Team Tracker never uploads or syncs your data anywhere. All state lives in a
single encrypted `.tmv` file (password-based encryption) that you create,
open, and save through the app's own file dialogs (or the download-fallback
path in browsers without File System Access API support). **You own the
file and are responsible for backing it up** — losing the file, or forgetting
its password, means the data is unrecoverable. See the next section for the
recommended way to keep it backed up.

Team Tracker also supports password-less files (chosen at creation, or via
Settings → Security's "Migrate to password-less") for cases where you don't
need the encryption — the trade-off is anyone with access to the file,
including automated scanning by a cloud backup provider, can read it as
plain text.

## Backing up your team file

Team Tracker has no backup service of its own — and doesn't need one. Keep
your `.tmv` file in a folder synced by any cloud client, such as
[Google Drive for desktop](https://workspace.google.com/products/drive/#download),
OneDrive, or Dropbox, and every save is backed up automatically. This works
the same with the local `app.html` and the installed PWA:

- **Privacy is preserved** — the file is encrypted (AES-256, key derived from
  your password) before it ever touches disk, so the cloud provider — or
  anyone else with access to the cloud account — only ever sees ciphertext.
- **Available anywhere** — download the file from the provider's web UI
  (e.g. drive.google.com) on any machine and open it with the app.
- **Version history for free** — most providers keep previous versions of a
  synced file for a while (Google Drive keeps them for ~30 days), so you can
  also recover an earlier state by downloading an older version of the file.

### Daily backup file (`.bck`)

As a second, independent line of defense against file corruption (distinct
from a cloud provider's version history, which covers *losing* the file —
this covers the file on disk becoming unreadable), Settings → General offers
"Maintain daily backup file". Once enabled, the app keeps a `.bck` file —
wherever you chose to save it (the picker defaults to the same folder as
the original) — refreshed at most once every 24 hours (and immediately
after any password change), containing the same bytes as the primary
file. To recover from it, just rename it from `.bck` to `.tmv` and
open it normally — it uses the exact same format as the file it was copied
from, encrypted or plain.

## FAQ

**Where do notes or action items go if they aren't about one specific team?**
Every module (daily notes, general notes, action items, milestones, risks) is
scoped to a team. If you have org-wide stuff that doesn't belong to any one
team, make a dedicated team for it — e.g. `🌐 General` or `🔗 Cross-team` — and
use that team's General Notes / action items for anything that doesn't fit
elsewhere. The global search bar (`Ctrl+F`) and its all-teams mode
(`Ctrl+Shift+F`) then find it alongside everything else.

**Can I use this for just myself, not an actual "team"?**
Yes. A "team" is just a grouping — one person, one project, one client,
whatever's useful to you. Nothing about the app assumes multiple people.

**How many teams can I have?**
No hard limit. `Alt+1` … `Alt+9` quick-switches the first nine; beyond that,
the sidebar and `Ctrl+K` palette still get you anywhere.

**Can multiple people edit the same file at the same time?**
No — this isn't a real-time collaboration tool. Only one browser tab can hold
write access to a given file at a time (a cross-tab lock enforces this);
opening it elsewhere shows a read-only view with a "take control" option.
Think of it as one manager's tracking tool, not a shared team workspace.

**Can I use it across my phone and laptop?**
Not on the phone — mobile browsers get a blocking screen instead of the app,
since they lack the file APIs the save flow depends on and the UI is
keyboard/desktop-only by design. Across desktops, copy the `.tmv` file
yourself or keep it in a cloud-synced folder (see [Backing up your team
file](#backing-up-your-team-file)) — there's no live sync between devices.

**What happens if I forget my password?**
There's no recovery — the file is encrypted with a key derived from that
password, and nobody (including the app's author) can decrypt it without
it. Use a password manager.

**What if I lose the `.tmv` file itself?**
Team Tracker has no backup service — if the file's gone and you never synced
it anywhere, the data is gone too. See [Backing up your team
file](#backing-up-your-team-file).

**Can I skip the password entirely?**
Yes — choose "Use without password" when creating a file, or migrate an
existing encrypted file via Settings → Security → "Migrate to
password-less". The trade-off: the file is then stored as plain,
unencrypted text, readable by anyone with access to it (including automated
scanning by a cloud backup provider). You can set a password on a
password-less file at any time from the same tab.

**What's the `.bck` file next to my `.tmv` file?**
An optional daily backup (see [Daily backup file](#daily-backup-file-bck)),
enabled per-file in Settings → General. It's a plain copy of your file at
its last backup point — rename it to `.tmv` to open it like any other file.

**Is there version history or an undo for past edits?**
Not inside the app. Whatever version history your cloud sync provider offers
(e.g. Google Drive keeps ~30 days) is the only way to recover an earlier
state of the file.

**Does any of my data leave my machine — analytics, telemetry, anything?**
No. There's no analytics or telemetry, ever. The one network call the app
makes, in either build, is a once-a-day read-only check against GitHub's
public releases API to see if a newer version exists (see [Checking for
updates](#checking-for-updates)) — it sends no data of yours, and it never
downloads or installs anything by itself; updating is always something you
choose to do.

**How secure is the `.tmv` file's encryption — could someone brute-force my password?**
The file is AES-256-GCM encrypted with a key derived from your password via
PBKDF2-SHA256 at 600,000 iterations — that iteration count is deliberately
expensive, so guessing passwords against a stolen file is slow even on
dedicated hardware. In practice the real variable is your password's length:
a password of 10+ characters (mixed case/numbers/symbols, not a dictionary
word or reused password) would take a regular computer far longer than a
human lifetime to brute-force. Shorter or common passwords are much weaker —
password strength, not the encryption itself, is the limiting factor. Since
there's no "forgot password" recovery (see above), we strongly recommend
generating and storing the password in a password manager rather than
memorizing something short enough to type easily.

**Can I import an org chart from a CSV or HR system?**
No bulk import. The only import/export feature is team-to-team: exporting a
team's people/hierarchy (no notes, action items, milestones, or risks) so a
teammate can import it and skip re-typing the org chart — see the Data tab
in preferences.

**Does it send reminders or notifications for due dates?**
No push or email notifications — due/overdue items only show up (sidebar
badge, kanban highlighting) while you actually have the app open.

**Is the "clean up" button in preferences safe to click?**
It's irreversible and deliberately cross-team: it permanently deletes every
done/cancelled action item, completed milestone, closed risk, and daily note
older than the day count you set, across **all** teams in the file in one
go. It shows you the exact counts before you confirm — read them first.

## Architecture

- **`src/core/`** — headless logic, no DOM construction. Document shape and
  schema migrations (`document.ts`, `types.ts`), the `.tmv` encryption format
  (`crypto.ts`), the mutable document store (`store.ts`), the File System
  Access API wrapper (`fs.ts`), and save orchestration (`save-controller.ts`).
- **`src/modules/`** — one file per feature pane: daily notes, people trees
  (stakeholders/members), person notes, action items, milestones, risks. Each
  module exports a single render function with the signature
  `(container: HTMLElement, loc: Loc, ctx: ModuleCtx) => void` and is wired up
  in `src/main.ts` via `pm.registerModule(kind, renderFn)`.
- **`src/ui/`** — shell, sidebar, pane manager (split view + per-pane
  history), command palette, search, modals, preferences. `ui/dom.ts`'s `el()`
  helper is the one DOM-building primitive used everywhere — no templating
  engine, no virtual DOM.
- **`src/main.ts`** — wires everything together: start screen →
  `onDocumentOpened` builds the shell/store/panes/save-controller, registers
  hotkeys, and sets up cross-tab single-writer locking so only one tab can
  write to a given file at a time.

### Adding a new module/pane

Because every pane is just a render function registered by string key, adding
a new tracked entity (say, a "decisions log", kind `decisions`) is mostly
additive. The one thing that's easy to half-do is wiring it into global search
and the `Ctrl+K` palette — both are covered explicitly below, since they don't
come for free just from registering the module.

1. **Shape and schema.** Add its shape to `Team` (or `Doc`) in
   `src/core/types.ts`, add a `ModuleRef` variant (`{ kind: 'decisions';
   itemId?: string }` — the `itemId?` is only needed if items are individually
   addressable, the way action items/milestones/risks are for deep-linking
   from search and `@`-mentions). Bump `SCHEMA_VERSION` in
   `src/core/document.ts` and add a step to the `MIGRATIONS` ladder there if
   existing `.tmv` files need the field backfilled on open.

2. **The renderer.** Write `src/modules/<name>.ts` exporting a function
   matching `ModuleRenderer` — `(container: HTMLElement, loc: Loc, ctx:
   ModuleCtx) => void`. `ctx` gives you `store`, `pm` (for opening other
   locs), `paneIdx`, `locale`. Read the team via
   `ctx.store.doc.teams.find(...)`, build DOM with `src/ui/dom.ts`'s `el()`
   helper, mutate through `ctx.store.update((d) => { ... })`, and re-render on
   every store change via `ctx.store.subscribe(renderAll)`. Conventions worth
   matching rather than reinventing — look at `src/modules/action-items.ts`
   (no live inputs → full rebuild on every change) or
   `src/modules/milestones.ts` (has inline-editable fields → skips rebuild
   while one is focused, so an in-progress edit's caret survives a foreign
   store change):
   - `store.update()` is for content (marks the doc dirty, fires
     `subscribe()`); `store.updateNav()` is for navigation-only state (pane
     focus, split %) and deliberately bypasses `subscribe()` so switching
     panes doesn't blow away an in-progress edit elsewhere. Don't mix them up.
   - Anything your renderer attaches outside `container` — a document-level
     listener, an overlay appended to `document.body` (see `src/ui/atref.ts`'s
     `@`-mention dropdown) — needs an explicit disposer, tracked in a
     per-container `WeakMap<HTMLElement, () => void>` and called both at the
     top of the renderer (before rebuilding) and from the pane manager's own
     teardown. `panes.ts` clears `container`'s DOM children between renders,
     but has no way to know about listeners/overlays living outside it.

3. **Register it.** In `src/main.ts`, alongside the other
   `pm.registerModule(...)` calls: `pm.registerModule('decisions',
   renderDecisions)`. Do this before the post-registration `pm.renderAll()`
   call a few lines down, or a pane whose saved nav state already points at
   the new kind renders "Módulo em construção…" and never gets a second pass.

4. **Pane switcher + palette (one list, both surfaces).** Add it to
   `FIXED_MODULE_KEYS` in `src/ui/panes.ts`. `buildModuleItems()` in that same
   file turns that list into the `ModuleItem[]` array shown in the pane's own
   "＋" module dropdown — **and `src/ui/palette.ts`'s `Ctrl+K` palette calls
   this exact same function.** There's no separate palette item list to
   maintain; wiring the pane switcher wires the palette too.
   If individual items (not just the module as a whole) should get their own
   palette entries — the way each action item/milestone/risk shows up as its
   own line — extend `buildModuleItems()`'s per-kind branch the way `actions`/
   `milestones`/`risks` do, sourcing the list from `teamRefCandidates()` (step
   6 below — you'll likely want that list anyway).

5. **Global search.** The header search bar (`Ctrl+F` / `/`,
   `src/ui/search-ui.ts`) is backed by `searchDocument()` in
   `src/core/search.ts`, which works over a flat candidate list built by that
   file's `collectCandidates()`. Add a loop over your module's items there:
   ```ts
   for (const d of team.decisions) {
     out.push({ raw: `${d.title}\n${d.rationale}`, title: d.title, ref: { kind: 'decisions', itemId: d.id } })
   }
   ```
   `raw` is whatever free text should be searchable — `searchDocument()`
   strips markdown syntax from it and does a normalized (accent/case
   insensitive), term-by-term substring match; if there's no free-text field,
   `raw` can just equal `title`. Then add an icon to `KIND_ICON` (same file)
   so results render with a matching glyph — that's the only other piece;
   snippet highlighting and the results dropdown are already generic over
   `ref.kind`.

6. **i18n.** Add `pt-BR`/`en-US` strings to `src/core/i18n.ts` — every
   user-visible string goes through `t(locale, key)`, in both locale blocks.

7. **Optional: `@`-mentions.** If notes should be able to `@`-link to one of
   your items, add an entry to the `REF_KINDS` registry in `src/core/refs.ts`
   (drives the mention regex, auto-unlink-on-delete via `unlinkRefsInTeam` —
   call it from your delete path — and the `@`-picker's group header/icon),
   and add the item list to `teamRefCandidates()` in `src/core/search.ts` —
   the same function step 4 mentioned, and what the `@` picker and palette
   both actually filter over.

8. **Tests.** Add `test/<name>.test.ts`. Pure logic gets plain unit tests; the
   renderer gets exercised against a real `createStore(createEmptyDocument(locale))`
   + jsdom the way `test/action-items.test.ts` does — mount, assert on
   `container.querySelector(...)`, dispatch DOM events, assert on the mutated
   `store.doc`.

No other module needs to know the new one exists — the pane manager, sidebar,
and search all work off the registered module list and the `Loc` union. The
two places that genuinely don't come for free are global search
(`collectCandidates`/`KIND_ICON`) and, if wanted, `@`-mentions (`REF_KINDS`) —
everything else (pane switcher, palette, history, print) is generic.

## Build

```
npm install
npm run build
```

This produces:

- `dist/app.html` — a single self-contained HTML file with no external
  references. Copy it anywhere and open it directly.
- `dist/pwa/` — the same app plus `manifest.json`, `sw.js`, and `icon.svg`,
  meant to be served over http(s) so it can be installed as a PWA.

## Development

```
npm test              # run the test suite (vitest)
npx vitest run test/store.test.ts   # run a single test file
npm run test:watch    # vitest watch mode
npm run typecheck     # tsc --noEmit, strict mode
npm run build          # produce dist/app.html and dist/pwa/
```

The codebase has zero runtime dependencies — `esbuild`, `typescript`,
`vitest`, and `jsdom` are dev-only tooling.

## License

AGPL-3.0. See [LICENSE](LICENSE).
