// test/scope-contract.ts — a tripwire for the store's change-scope contract.
//
// `store.update(fn, scope)` takes the caller's word for what `fn` changed, and
// everything downstream believes it: subscribers skip re-renders, and
// core/search.ts keeps a team's prepared text when the scope doesn't name it.
// Nothing in the store checks the claim, so a call site whose callback reaches
// beyond its scope fails silently, as stale UI or stale search results.
//
// This module checks it. `wrapStore` snapshots the document around each
// scoped `update()` callback and each `updateNav()` callback, and records
// anything that changed outside what the scope (or the nav-only contract)
// allows. test/setup-scope-contract.ts installs the wrapper on every store the
// suite creates, so each module test that drives a real call site also audits
// its scope, and fails in afterEach if one lied.
//
// A scope is checked against these rules (see scope.ts for the vocabulary):
//
//  - `teamId` set: no other team's data may change, and no other team may be
//    added or removed (unless 'teams' is named). Prefs and templates are not
//    team data, so they may not change either unless named.
//  - `sections` set: only the named parts of a team may change. A section maps
//    to the team fields it owns: notes+people -> the free text (daily notes,
//    general notes, both people lists, whose notes edits are scoped either
//    way); actions -> items, columns and tag names; milestones; risks;
//    teams -> name, emoji and the team list's membership and order.
//  - 'prefs' / 'templates' must be named to change doc.prefs / doc.templates.
//  - A scope naming neither field is "unrestricted" and is not checked.
//
// `updateNav` has one rule: it may not change teams, prefs or templates.
import type { Doc } from '../src/core/types'
import type { ChangeScope, Section } from '../src/core/scope'
import type { Store } from '../src/core/store'

type Group = 'text' | 'actions' | 'milestones' | 'risks' | 'meta'

const GROUP_SECTIONS: Record<Group, readonly Section[]> = {
  text: ['notes', 'people'],
  actions: ['actions'],
  milestones: ['milestones'],
  risks: ['risks'],
  meta: ['teams'],
}

export interface Snapshot {
  ids: string[]
  teams: Map<string, Record<Group, string>>
  prefs: string
  templates: string
}

/** One JSON string per team group, so a comparison is a handful of string equalities rather than a deep walk. */
export function snapshot(doc: Doc): Snapshot {
  const teams = new Map<string, Record<Group, string>>()
  for (const t of doc.teams) {
    teams.set(t.id, {
      text: JSON.stringify([t.dailyNotes, t.generalNotes, t.stakeholders, t.members]),
      actions: JSON.stringify([t.actionItems, t.actionColumns, t.actionTagNames]),
      milestones: JSON.stringify(t.milestones),
      risks: JSON.stringify(t.risks),
      meta: JSON.stringify([t.name, t.emoji]),
    })
  }
  return { ids: doc.teams.map((t) => t.id), teams, prefs: JSON.stringify(doc.prefs), templates: JSON.stringify(doc.templates) }
}

const isUnrestricted = (scope: ChangeScope | null | undefined): boolean =>
  !scope || (scope.teamId === undefined && scope.sections === undefined)

/** Everything that changed between two snapshots that `scope` did not declare. Empty means the scope told the truth. */
export function scopeViolations(before: Snapshot, after: Snapshot, scope: ChangeScope | null | undefined): string[] {
  if (isUnrestricted(scope)) return []
  const { teamId, sections } = scope!
  const names = (s: Section): boolean => sections?.includes(s) ?? false
  const out: string[] = []

  for (const id of [...after.ids.filter((i) => !before.ids.includes(i)), ...before.ids.filter((i) => !after.ids.includes(i))]) {
    if (id !== teamId && !names('teams')) out.push(`team "${id}" was added or removed`)
  }
  const common = (ids: string[], other: string[]): string[] => ids.filter((i) => other.includes(i))
  if (JSON.stringify(common(before.ids, after.ids)) !== JSON.stringify(common(after.ids, before.ids)) && !names('teams')) {
    out.push('the team order changed')
  }

  for (const id of common(before.ids, after.ids)) {
    const was = before.teams.get(id)!
    const now = after.teams.get(id)!
    for (const group of Object.keys(was) as Group[]) {
      if (was[group] === now[group]) continue
      if (teamId !== undefined && id !== teamId) out.push(`team "${id}" (${group}) changed but the scope names team "${teamId}"`)
      else if (sections !== undefined && !GROUP_SECTIONS[group].some(names)) out.push(`team "${id}" ${group} changed but sections are [${sections.join(', ')}]`)
    }
  }

  if (before.prefs !== after.prefs && !names('prefs')) out.push("prefs changed but the scope does not name 'prefs'")
  if (before.templates !== after.templates && !names('templates')) out.push("templates changed but the scope does not name 'templates'")
  return out
}

/** `updateNav` may touch `doc.nav` only. */
export function navViolations(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = []
  if (JSON.stringify(before.ids) !== JSON.stringify(after.ids)) out.push('updateNav changed the team list')
  for (const [id, was] of before.teams) {
    const now = after.teams.get(id)
    if (now && (Object.keys(was) as Group[]).some((g) => was[g] !== now[g])) out.push(`updateNav changed team "${id}"`)
  }
  if (before.prefs !== after.prefs) out.push('updateNav changed prefs')
  if (before.templates !== after.templates) out.push('updateNav changed templates')
  return out
}

// One log per worker, reachable from both the setup file and any test that
// needs to read it back. Held on globalThis so a module instance duplicated by
// vitest's isolation still shares it.
const LOG_KEY = '__tt_scope_violations__'
const log = (): string[] => ((globalThis as Record<string, unknown>)[LOG_KEY] ??= []) as string[]

const OFF_KEY = '__tt_scope_contract_off__'

/**
 * Switches the audit off or on for the rest of the file (or until switched
 * back). For tests that time store.update() itself or loop it thousands of
 * times: snapshotting the document around every callback is real work and would
 * distort a timing ratio or a heap measurement. Say why at the call site.
 */
export function setScopeContractEnabled(on: boolean): void {
  (globalThis as Record<string, unknown>)[OFF_KEY] = !on
}
const enabled = (): boolean => !(globalThis as Record<string, unknown>)[OFF_KEY]

/** Returns and clears the violations recorded so far. */
export function drainScopeViolations(): string[] {
  return log().splice(0)
}

/**
 * Runs `fn` and returns the violations it provoked instead of leaving them for
 * the suite-wide afterEach to fail the test with. For tests that lie about a
 * scope on purpose.
 */
export function expectScopeViolations(fn: () => void): string[] {
  drainScopeViolations()
  fn()
  return drainScopeViolations()
}

const callSite = (): string => (new Error().stack ?? '').split('\n').filter((l) => !l.includes('/scope-contract.ts:')).slice(1, 4).map((l) => l.trim()).join(' <- ')

/**
 * The same store, with every scoped `update()` and every `updateNav()` audited.
 *
 * Patches the two methods on the store object rather than returning a Proxy: a
 * test that does `vi.spyOn(store, 'update')` replaces the property on whatever
 * it is handed, and a Proxy would route that spy straight back into the wrapper
 * it wraps. Patched in place, a spy simply wraps the audited method.
 */
export function wrapStore<S extends Store>(store: S): S {
  const update = store.update
  const updateNav = store.updateNav
  store.update = (fn: (d: Doc) => void, scope?: ChangeScope): void => {
    if (!enabled() || isUnrestricted(scope)) return update(fn, scope)
    const site = callSite()
    return update((d) => {
      const before = snapshot(d)
      fn(d)
      for (const v of scopeViolations(before, snapshot(d), scope)) log().push(`${v} — scope ${JSON.stringify(scope)} at ${site}`)
    }, scope)
  }
  store.updateNav = (fn: (d: Doc) => void): void => {
    if (!enabled()) return updateNav(fn)
    const site = callSite()
    return updateNav((d) => {
      const before = snapshot(d)
      fn(d)
      for (const v of navViolations(before, snapshot(d))) log().push(`${v} at ${site}`)
    })
  }
  return store
}
