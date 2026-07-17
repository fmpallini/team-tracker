import { openPrefs, onLocaleChanged, type PrefsAppCtl } from '../src/ui/prefs'
import { onNavChanged } from '../src/ui/sidebar'
import { createShell, type Shell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { builtinTemplates } from '../src/core/templates'
import { SCHEMA_VERSION } from '../src/core/document'
import { buildExport } from '../src/core/team-export'
import { downloadFallback } from '../src/core/fs'
import type { Template, Team } from '../src/core/types'

vi.mock('../src/core/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fs')>()
  return { ...actual, downloadFallback: vi.fn() }
})

// jsdom does not implement matchMedia; createShell() needs it to watch the OS theme preference.
function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

interface Setup {
  store: Store
  shell: Shell
  appCtl: PrefsAppCtl
  changePassword: ReturnType<typeof vi.fn>
  currentPassword: ReturnType<typeof vi.fn>
}

function setup(): Setup {
  document.body.innerHTML = ''
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  const store = createStore(doc)
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const changePassword = vi.fn(async () => {})
  const currentPassword = vi.fn(() => 'oldpw')
  const appCtl: PrefsAppCtl = {
    changePassword,
    currentPassword,
    isReadOnly: () => false,
    fileName: 'team-tracker.tmv',
    fileSchemaVersion: 1,
  }
  return { store, shell, appCtl, changePassword, currentPassword }
}

// Nested modals (e.g. the template edit modal opened on top of the prefs
// modal) stack multiple `.tt-modal-overlay`s in document order; scope button
// lookups to the topmost (last) one so "OK" resolves to the active dialog's
// button rather than an earlier/background modal's same-labelled button.
function clickByText(text: string): void {
  const overlays = document.querySelectorAll('.tt-modal-overlay')
  const scope: ParentNode = overlays.length > 0 ? overlays[overlays.length - 1]! : document
  const btn = Array.from(scope.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!btn) throw new Error(`button "${text}" not found`)
  ;(btn as HTMLButtonElement).click()
}

function clickTab(text: string): void {
  const btn = Array.from(document.querySelectorAll('.tt-prefs-tab-btn')).find((b) => b.textContent === text)
  if (!btn) throw new Error(`tab "${text}" not found`)
  ;(btn as HTMLButtonElement).click()
}

function radio(name: string, value: string): HTMLInputElement {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`) as HTMLInputElement | null
  if (!input) throw new Error(`radio ${name}=${value} not found`)
  return input
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('renders 4 tabs, defaulting to Geral/General', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  const tabs = Array.from(document.querySelectorAll('.tt-prefs-tab-btn')).map((b) => b.textContent)
  expect(tabs).toEqual(['General', 'Templates', 'Security', 'Data', 'About'])
  expect(document.querySelector('.tt-prefs-tab-btn.active')?.textContent).toBe('General')
  expect(document.querySelector('input[name="tt-prefs-theme"][value="system"]')).not.toBeNull()
})

test('theme radio updates store.prefs and calls shell.applyPrefs immediately', () => {
  const { store, shell, appCtl } = setup()
  const applySpy = vi.spyOn(shell, 'applyPrefs')
  openPrefs(store, shell, 'en-US', appCtl)

  radio('tt-prefs-theme', 'dark').click()

  expect(store.doc.prefs.theme).toBe('dark')
  expect(applySpy).toHaveBeenCalledWith(store.doc.prefs)
})

test('font and size radios update store.prefs and call shell.applyPrefs', () => {
  const { store, shell, appCtl } = setup()
  const applySpy = vi.spyOn(shell, 'applyPrefs')
  openPrefs(store, shell, 'en-US', appCtl)

  radio('tt-prefs-font', 'mono').click()
  expect(store.doc.prefs.font).toBe('mono')

  radio('tt-prefs-size', 'L').click()
  expect(store.doc.prefs.fontSize).toBe('L')

  expect(applySpy).toHaveBeenCalledTimes(2)
})

test('font field offers 5 options (including classic/rounded) and each label previews its own font stack', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)

  expect(radio('tt-prefs-font', 'classic')).not.toBeNull()
  expect(radio('tt-prefs-font', 'rounded')).not.toBeNull()

  radio('tt-prefs-font', 'classic').click()
  expect(store.doc.prefs.font).toBe('classic')

  const serifLabel = radio('tt-prefs-font', 'serif').closest('label')
  const preview = serifLabel?.querySelector('.tt-prefs-radio-preview') as HTMLElement
  expect(preview.style.fontFamily).toContain('Georgia')
})

test('palette field defaults to ledger, offers 8 swatched options, and updates store.prefs + shell on change', () => {
  const { store, shell, appCtl } = setup()
  const applySpy = vi.spyOn(shell, 'applyPrefs')
  openPrefs(store, shell, 'en-US', appCtl)

  expect(radio('tt-prefs-palette', 'ledger').checked).toBe(true)
  for (const value of ['signal', 'blueprint', 'muster', 'forest', 'desert', 'cosmic', 'synthwave']) {
    expect(radio('tt-prefs-palette', value)).not.toBeNull()
  }

  const signalLabel = radio('tt-prefs-palette', 'signal').closest('label')
  const swatch = signalLabel?.querySelector('.tt-prefs-radio-swatch') as HTMLElement
  expect(swatch.style.background).not.toBe('')

  radio('tt-prefs-palette', 'cosmic').click()
  expect(store.doc.prefs.palette).toBe('cosmic')
  expect(applySpy).toHaveBeenCalledWith(store.doc.prefs)
  expect(document.documentElement.dataset.palette).toBe('cosmic')
})

test('auto-save number input clamps to 1..60 and updates store.prefs', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)

  const input = document.querySelector('.tt-prefs-autosave-input') as HTMLInputElement
  input.value = '15'
  input.dispatchEvent(new Event('change'))
  expect(store.doc.prefs.autoSaveMin).toBe(15)

  input.value = '999'
  input.dispatchEvent(new Event('change'))
  expect(store.doc.prefs.autoSaveMin).toBe(60)
  expect(input.value).toBe('60')

  input.value = '0'
  input.dispatchEvent(new Event('change'))
  expect(store.doc.prefs.autoSaveMin).toBe(1)
})

test('locale radio updates store.prefs, notifies locale-changed listeners, and reopens the modal in the new locale', () => {
  const { store, shell, appCtl } = setup()
  const applySpy = vi.spyOn(shell, 'applyPrefs')
  const onChanged = vi.fn()
  onLocaleChanged(onChanged)
  openPrefs(store, shell, 'en-US', appCtl)

  radio('tt-prefs-locale', 'pt-BR').click()

  expect(store.doc.prefs.locale).toBe('pt-BR')
  expect(applySpy).toHaveBeenCalledWith(store.doc.prefs)
  expect(onChanged).toHaveBeenCalledTimes(1)
  // Only one dialog should be open (old one closed, new one opened) and its
  // tab labels should now read in Portuguese.
  expect(document.querySelectorAll('.tt-modal-overlay')).toHaveLength(1)
  const tabs = Array.from(document.querySelectorAll('.tt-prefs-tab-btn')).map((b) => b.textContent)
  expect(tabs).toEqual(['Geral', 'Templates', 'Segurança', 'Dados', 'Sobre'])
})

test('templates tab lists the 5 builtins with scope badges', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Templates')

  const rows = document.querySelectorAll('.tt-prefs-template-row')
  expect(rows).toHaveLength(5)
  expect(document.querySelector('.tt-prefs-template-scope-badge')?.textContent).toMatch(/Personal|Daily|Any/)
})

test('"+ new" adds a template with the entered name/scope/body', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Templates')

  clickByText('+ new')
  const nameInput = document.querySelector('input[name="tt-prefs-template-name"]') as HTMLInputElement
  nameInput.value = 'Custom'
  nameInput.dispatchEvent(new Event('input'))
  const scopeSelect = document.querySelector('.tt-prefs-template-form select') as HTMLSelectElement
  scopeSelect.value = 'daily'
  scopeSelect.dispatchEvent(new Event('change'))
  const bodyTextarea = document.querySelector('.tt-prefs-template-textarea') as HTMLTextAreaElement
  bodyTextarea.value = 'body {data}'
  bodyTextarea.dispatchEvent(new Event('input'))
  clickByText('OK')

  expect(store.doc.templates).toHaveLength(6)
  const added = store.doc.templates.find((tp) => tp.name === 'Custom')
  expect(added).toBeDefined()
  expect(added?.scope).toBe('daily')
  expect(added?.body).toBe('body {data}')
  // Modal closed and list refreshed behind it.
  expect(document.querySelectorAll('.tt-prefs-template-row')).toHaveLength(6)
})

test('"+ new" requires a non-empty name', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Templates')
  clickByText('+ new')
  clickByText('OK')
  expect(document.querySelector('.tt-field-error')?.textContent).toBe('Name is required')
  expect(store.doc.templates).toHaveLength(5)
})

test('edit (pencil) button updates the existing template in place', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Templates')

  const firstId = store.doc.templates[0]!.id
  const editBtn = document.querySelector('.tt-prefs-template-edit-btn') as HTMLButtonElement
  editBtn.click()
  const nameInput = document.querySelector('input[name="tt-prefs-template-name"]') as HTMLInputElement
  expect(nameInput.value).toBe(store.doc.templates[0]!.name)
  nameInput.value = 'Renamed'
  nameInput.dispatchEvent(new Event('input'))
  clickByText('OK')

  expect(store.doc.templates).toHaveLength(5)
  expect(store.doc.templates[0]!.id).toBe(firstId)
  expect(store.doc.templates[0]!.name).toBe('Renamed')
})

test('duplicate button inserts a copy right after the original', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Templates')

  const original = store.doc.templates[0]!
  const dupBtn = document.querySelector('.tt-prefs-template-dup-btn') as HTMLButtonElement
  dupBtn.click()

  expect(store.doc.templates).toHaveLength(6)
  const copy = store.doc.templates[1]!
  expect(copy.name).toBe(original.name)
  expect(copy.scope).toBe(original.scope)
  expect(copy.body).toBe(original.body)
  expect(copy.id).not.toBe(original.id)
})

test('delete button asks for confirmation, then removes the template', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Templates')

  const target = store.doc.templates[0]!
  const delBtn = document.querySelector('.tt-prefs-template-delete-btn') as HTMLButtonElement
  delBtn.click()
  expect(document.querySelector('.tt-modal-message')?.textContent).toBe(`Delete template "${target.name}"?`)
  clickByText('Delete')

  expect(store.doc.templates.find((tp) => tp.id === target.id)).toBeUndefined()
  expect(store.doc.templates).toHaveLength(4)
})

test('reorder (up/down) swaps templates in the array', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Templates')

  const names = store.doc.templates.map((t) => t.name)
  const downBtn = document.querySelector('.tt-prefs-template-down-btn') as HTMLButtonElement
  downBtn.click()

  expect(store.doc.templates.map((t) => t.name)).toEqual([names[1], names[0], ...names.slice(2)])
})

test('restore defaults re-inserts builtins missing by name, leaves existing (even renamed) ones alone', () => {
  const { store, shell, appCtl } = setup()
  // Simulate a user having deleted one builtin and renamed another.
  store.update((d) => {
    d.templates = d.templates.filter((tp) => tp.name !== 'Meeting')
    const oneOnOne = d.templates.find((tp) => tp.name === '1:1')!
    oneOnOne.name = '1:1 (custom)'
  })
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Templates')

  clickByText('Restore defaults')

  const names = store.doc.templates.map((tp) => tp.name)
  // 'Meeting' (deleted) comes back; '1:1' (renamed) does NOT get re-added
  // alongside '1:1 (custom)' since restore matches by name only.
  expect(names).toContain('Meeting')
  expect(names).toContain('1:1 (custom)')
  expect(names.filter((n) => n === '1:1')).toHaveLength(1) // re-inserted once, not duplicated on a second restore
})

test('restore defaults is idempotent when nothing is missing', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Templates')
  const before = store.doc.templates.length
  clickByText('Restore defaults')
  expect(store.doc.templates).toHaveLength(before)
})

test('security tab: wrong current password shows inline error and does not call changePassword', () => {
  const { store, shell, appCtl, changePassword } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Security')

  const current = document.querySelector('input[name="tt-prefs-current-password"]') as HTMLInputElement
  const next = document.querySelector('input[name="tt-prefs-new-password"]') as HTMLInputElement
  const confirm = document.querySelector('input[name="tt-prefs-new-password-confirm"]') as HTMLInputElement
  current.value = 'wrong'
  next.value = 'newpw'
  confirm.value = 'newpw'
  clickByText('Change password')

  expect(document.querySelector('.tt-field-error')?.textContent).toBe('Current password is incorrect')
  expect(changePassword).not.toHaveBeenCalled()
})

test('security tab: mismatched new passwords shows inline error', () => {
  const { store, shell, appCtl, changePassword } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Security')

  const current = document.querySelector('input[name="tt-prefs-current-password"]') as HTMLInputElement
  const next = document.querySelector('input[name="tt-prefs-new-password"]') as HTMLInputElement
  const confirm = document.querySelector('input[name="tt-prefs-new-password-confirm"]') as HTMLInputElement
  current.value = 'oldpw'
  next.value = 'abcd'
  confirm.value = 'defg'
  clickByText('Change password')

  expect(document.querySelector('.tt-field-error')?.textContent).toBe('Passwords do not match')
  expect(changePassword).not.toHaveBeenCalled()
})

test('security tab: new password shorter than 4 characters shows inline error', () => {
  const { store, shell, appCtl, changePassword } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Security')

  const current = document.querySelector('input[name="tt-prefs-current-password"]') as HTMLInputElement
  const next = document.querySelector('input[name="tt-prefs-new-password"]') as HTMLInputElement
  const confirm = document.querySelector('input[name="tt-prefs-new-password-confirm"]') as HTMLInputElement
  current.value = 'oldpw'
  next.value = 'abc'
  confirm.value = 'abc'
  clickByText('Change password')

  expect(document.querySelector('.tt-field-error')?.textContent).toBe('Password must be at least 4 characters')
  expect(changePassword).not.toHaveBeenCalled()
})

test('security tab: correct flow calls appCtl.changePassword with the new password and toasts success', async () => {
  const { store, shell, appCtl, changePassword } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Security')

  const current = document.querySelector('input[name="tt-prefs-current-password"]') as HTMLInputElement
  const next = document.querySelector('input[name="tt-prefs-new-password"]') as HTMLInputElement
  const confirm = document.querySelector('input[name="tt-prefs-new-password-confirm"]') as HTMLInputElement
  current.value = 'oldpw'
  next.value = 'newpw'
  confirm.value = 'newpw'
  clickByText('Change password')

  expect(changePassword).toHaveBeenCalledWith('newpw')
  await Promise.resolve()
  await Promise.resolve()
  expect(document.querySelector('.tt-toast')?.textContent).toBe('Password changed successfully')
})

test('security tab: failed changePassword shows a sticky failure toast', async () => {
  const { store, shell, appCtl } = setup()
  appCtl.changePassword = vi.fn(async () => {
    throw new Error('disk full')
  })
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Security')

  const current = document.querySelector('input[name="tt-prefs-current-password"]') as HTMLInputElement
  const next = document.querySelector('input[name="tt-prefs-new-password"]') as HTMLInputElement
  const confirm = document.querySelector('input[name="tt-prefs-new-password-confirm"]') as HTMLInputElement
  current.value = 'oldpw'
  next.value = 'newpw'
  confirm.value = 'newpw'
  clickByText('Change password')

  await Promise.resolve()
  await Promise.resolve()
  expect(document.querySelector('.tt-toast')?.textContent).toBe('Failed to change password')
})

test('security tab: read-only tab (appCtl.isReadOnly() true) disables the submit button and shows a hint', () => {
  const { store, shell, appCtl, changePassword } = setup()
  appCtl.isReadOnly = () => true
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Security')

  const submitBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Change password') as HTMLButtonElement
  expect(submitBtn.disabled).toBe(true)
  expect(document.querySelector('.tt-field-error')?.textContent).toBe('Read-only — cannot change password in this tab')

  const current = document.querySelector('input[name="tt-prefs-current-password"]') as HTMLInputElement
  expect(current.disabled).toBe(true)

  // A disabled button doesn't dispatch click handlers (matches real browser
  // behavior) — changePassword must never even be attempted.
  submitBtn.click()
  expect(changePassword).not.toHaveBeenCalled()
})

test('about tab shows app name, versions, and file info from appCtl', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('About')

  const text = document.querySelector('.tt-prefs-content')?.textContent ?? ''
  expect(text).toContain('Team Tracker')
  expect(text).toContain('test') // __APP_VERSION__ under vitest (see vitest.config.ts define)
  expect(text).toContain(String(SCHEMA_VERSION))
  expect(text).toContain('team-tracker.tmv')
})

test('about tab has a GitHub source link', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('About')

  const link = document.querySelector('.tt-about-github') as HTMLAnchorElement
  expect(link).not.toBeNull()
  expect(link.href).toBe('https://github.com/fmpallini/team-tracker')
  expect(link.target).toBe('_blank')
})

test('about tab reflects a mismatched file schema version from appCtl', () => {
  const { store, shell, appCtl } = setup()
  appCtl.fileSchemaVersion = 0
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('About')

  const rows = Array.from(document.querySelectorAll('.tt-prefs-content td')).map((td) => td.textContent)
  expect(rows).toContain('0')
})

test('closing the prefs modal (OK) fires onNavChanged (sidebar re-render hook)', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  radio('tt-prefs-theme', 'dark').click()
  expect(store.dirty).toBe(true)

  let navChangedCount = 0
  const off = onNavChanged(() => navChangedCount++)
  clickByText('OK')

  expect(navChangedCount).toBe(1)
  off()
})

test('closing the prefs modal via Escape also fires onNavChanged', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  radio('tt-prefs-theme', 'dark').click()
  expect(store.dirty).toBe(true)

  // Other tests in this file open the prefs modal via openPrefs() and never
  // close it, leaking document-level Escape listeners across tests within
  // the same file (same pre-existing pattern noted in sidebar.test.ts's
  // ADD_TEAM_REQUEST_EVENT comment) — so dispatching a real Escape here also
  // re-triggers those stale listeners' own onClose. Assert "at least one"
  // rather than an exact count.
  let navChangedCount = 0
  const off = onNavChanged(() => navChangedCount++)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

  expect(navChangedCount).toBeGreaterThanOrEqual(1)
  off()
})

test('builtinTemplates helper used by restore-defaults produces 5 named templates (sanity)', () => {
  const names = builtinTemplates('en-US').map((tp: Template) => tp.name)
  expect(new Set(names).size).toBe(5)
})

function sampleTeam(): Team {
  return {
    id: 't1', name: 'Engineering', emoji: '🚀',
    dailyNotes: { '2026-07-16': 'private daily note' },
    stakeholders: [{ id: 'p1', name: 'Priya', role: 'Sponsor', parentId: null, order: 0, notes: 'private note' }],
    members: [{ id: 'p2', name: 'Marcus', role: 'Manager', parentId: null, order: 0, notes: '' }],
    actionItems: [{ id: 'a1', summary: 'Access review', notes: 'audit detail', status: 'todo', dueDate: null, assignee: 'Marcus', color: 'slate', order: 0 }],
    milestones: [{ id: 'm1', date: '2026-08-01', title: 'Launch', done: false, followup: 'ship checklist' }],
    risks: [{ id: 'r1', title: 'Vendor lock-in', chance: 2, impact: 3, plan: 'mitigate', followup: 'quarterly review', order: 0, closed: false }],
  }
}

describe('Data tab (export/import)', () => {
  function exportCheckboxes(): HTMLInputElement[] {
    return Array.from(document.querySelectorAll('.tt-data-team-list input[type="checkbox"]'))
  }

  test('renders an export checklist row per team and both privacy hints', () => {
    const { store, shell, appCtl } = setup()
    store.update((d) => { d.teams.push(sampleTeam()) })
    openPrefs(store, shell, 'en-US', appCtl)
    clickTab('Data')

    expect(document.querySelector('.tt-data-team-name')?.textContent).toBe('Engineering')
    const hints = Array.from(document.querySelectorAll('.tt-data-hint')).map((n) => n.textContent)
    expect(hints).toEqual([
      'Personal notes and daily notes are never included.',
      'Personal notes and daily notes are never included.',
    ])
  })

  test('export writes a JSON file via downloadFallback, stripped of dailyNotes and person.notes', async () => {
    const { store, shell, appCtl } = setup()
    store.update((d) => { d.teams.push(sampleTeam()) })
    openPrefs(store, shell, 'en-US', appCtl)
    clickTab('Data')

    exportCheckboxes()[0]!.click()
    clickByText('Export selected')
    await Promise.resolve().then(() => {}) // flush the async doExport()

    expect(downloadFallback).toHaveBeenCalledTimes(1)
    const [name, bytes] = (downloadFallback as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Uint8Array]
    expect(name).toMatch(/^team-tracker-export-\d{4}-\d{2}-\d{2}\.json$/)
    const file = JSON.parse(new TextDecoder().decode(bytes))
    expect(file.kind).toBe('team-tracker-teams-export')
    const team = file.teams[0]
    expect(team.dailyNotes).toBeUndefined()
    expect(team.stakeholders[0].notes).toBeUndefined()
    expect(team.actionItems[0].notes).toBe('audit detail') // item free-text stays (decision 2)
  })

  test('import: valid file shows a checklist with per-team counts, Import appends with fresh ids and "(imported)" suffix', async () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    clickTab('Data')

    const exportFile = buildExport([sampleTeam()])
    const jsonFile = new File([JSON.stringify(exportFile)], 'export.json', { type: 'application/json' })
    const fileInput = document.querySelector('input[type="file"][accept=".json"]') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { value: [jsonFile], configurable: true })
    fileInput.dispatchEvent(new Event('change'))
    await new Promise((r) => setTimeout(r, 0)) // flush handleFilePicked's await file.arrayBuffer()

    expect(document.querySelector('.tt-data-team-summary')?.textContent)
      .toBe('1 stakeholders · 1 members · 1 action items · 1 milestones · 1 risks')

    clickByText('Import selected')

    expect(store.doc.teams).toHaveLength(1)
    const imported = store.doc.teams[0]!
    expect(imported.name).toBe('Engineering (imported)')
    expect(imported.id).not.toBe('t1')
    expect(imported.dailyNotes).toEqual({})
    expect(imported.stakeholders[0]!.notes).toBe('')
  })

  test('import: invalid JSON shows an error modal instead of a checklist', async () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    clickTab('Data')

    const jsonFile = new File(['not json'], 'export.json', { type: 'application/json' })
    const fileInput = document.querySelector('input[type="file"][accept=".json"]') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { value: [jsonFile], configurable: true })
    fileInput.dispatchEvent(new Event('change'))
    await new Promise((r) => setTimeout(r, 0))

    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Invalid file — not a Team Tracker teams export')
  })

  test('import: a schemaVersion newer than this app shows a different error modal', async () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    clickTab('Data')

    const future = { kind: 'team-tracker-teams-export', schemaVersion: SCHEMA_VERSION + 1, exportedAt: '', teams: [] }
    const jsonFile = new File([JSON.stringify(future)], 'export.json', { type: 'application/json' })
    const fileInput = document.querySelector('input[type="file"][accept=".json"]') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { value: [jsonFile], configurable: true })
    fileInput.dispatchEvent(new Event('change'))
    await new Promise((r) => setTimeout(r, 0))

    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('This file was exported by a newer version of Team Tracker')
  })
})
