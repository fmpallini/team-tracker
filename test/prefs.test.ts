import { openPrefs, onLocaleChanged, type PrefsAppCtl } from '../src/ui/prefs'
import { createShell, type Shell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { builtinTemplates } from '../src/core/templates'
import { SCHEMA_VERSION } from '../src/core/document'
import { buildExport } from '../src/core/team-export'
import { downloadFallback } from '../src/core/fs'
import type { Template, Team } from '../src/core/types'

const fsMocks = vi.hoisted(() => ({ pickCreateBackup: vi.fn() }))
vi.mock('../src/core/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fs')>()
  return { ...actual, downloadFallback: vi.fn(), pickCreateBackup: fsMocks.pickCreateBackup }
})
const idbMocks = vi.hoisted(() => ({ idbSet: vi.fn(async () => {}) }))
vi.mock('../src/core/idb', () => idbMocks)

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
  currentPassword: ReturnType<typeof vi.fn<() => string | null>>
}

function setup(): Setup {
  document.body.innerHTML = ''
  stubMatchMedia()
  fsMocks.pickCreateBackup.mockReset()
  idbMocks.idbSet.mockReset().mockResolvedValue(undefined)
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
    hasFileHandle: () => true,
    fileHandle: () => null,
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
  expect(tabs).toEqual(['General', 'Advanced', 'Templates', 'Tags', 'Security', 'Data', 'About'])
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

test('size field offers 5 evenly-spaced steps and previews each label at its own px size', () => {
  const { store, shell, appCtl } = setup()
  const applySpy = vi.spyOn(shell, 'applyPrefs')
  openPrefs(store, shell, 'en-US', appCtl)

  const values = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="tt-prefs-size"]')).map((r) => r.value)
  expect(values).toEqual(['XS', 'S', 'M', 'L', 'XL'])

  radio('tt-prefs-size', 'XL').click()
  expect(store.doc.prefs.fontSize).toBe('XL')
  expect(applySpy).toHaveBeenCalledWith(store.doc.prefs)

  // Absolute px, not a relative unit: the modal itself renders at the current
  // preference's root size, so relative previews would all look the same.
  const previewOf = (value: string): string =>
    (radio('tt-prefs-size', value).closest('label')?.querySelector('.tt-prefs-radio-preview') as HTMLElement).style.fontSize
  expect(['XS', 'S', 'M', 'L', 'XL'].map(previewOf)).toEqual(['12px', '13.5px', '15px', '16.5px', '18px'])
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
  clickTab('Advanced')

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

test('due-soon-days number input clamps to 1..30 and updates store.prefs', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)

  const input = document.querySelector('.tt-prefs-due-soon-input') as HTMLInputElement
  input.value = '5'
  input.dispatchEvent(new Event('change'))
  expect(store.doc.prefs.dueSoonDays).toBe(5)

  input.value = '999'
  input.dispatchEvent(new Event('change'))
  expect(store.doc.prefs.dueSoonDays).toBe(30)
  expect(input.value).toBe('30')

  input.value = '0'
  input.dispatchEvent(new Event('change'))
  expect(store.doc.prefs.dueSoonDays).toBe(1)
})

test('the "open refs in secondary pane" checkbox reflects and updates the pref', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)

  const checkbox = document.querySelector('.tt-prefs-open-refs-secondary-checkbox') as HTMLInputElement
  expect(checkbox).not.toBeNull()
  expect(checkbox.checked).toBe(false)

  checkbox.checked = true
  checkbox.dispatchEvent(new Event('change', { bubbles: true }))

  expect(store.doc.prefs.openRefsInSecondaryPane).toBe(true)
})

test('advanced tab: enabling daily backup with no existing handle opens the save picker, persists the handle id', async () => {
  const { store, shell, appCtl } = setup()
  fsMocks.pickCreateBackup.mockResolvedValue({ handle: {} as unknown as FileSystemFileHandle, name: 'team-tracker.bck', lastModified: 1 })
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Advanced')

  const checkbox = document.querySelector('input[type="checkbox"].tt-prefs-backup-checkbox') as HTMLInputElement
  checkbox.checked = true
  checkbox.dispatchEvent(new Event('change'))
  await Promise.resolve()
  await Promise.resolve()

  expect(fsMocks.pickCreateBackup).toHaveBeenCalledWith('team-tracker.bck', undefined)
  expect(idbMocks.idbSet).toHaveBeenCalledTimes(1)
  expect(store.doc.prefs.dailyBackupEnabled).toBe(true)
  expect(store.doc.prefs.backupHandleId).not.toBeNull()
})

test('advanced tab: enabling daily backup opens the picker in the primary file\'s folder (startIn)', async () => {
  const { store, shell, appCtl } = setup()
  const primaryHandle = {} as unknown as FileSystemFileHandle
  appCtl.fileHandle = () => primaryHandle
  fsMocks.pickCreateBackup.mockResolvedValue({ handle: {} as unknown as FileSystemFileHandle, name: 'team-tracker.bck', lastModified: 1 })
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Advanced')

  const checkbox = document.querySelector('input[type="checkbox"].tt-prefs-backup-checkbox') as HTMLInputElement
  checkbox.checked = true
  checkbox.dispatchEvent(new Event('change'))
  await Promise.resolve()
  await Promise.resolve()

  expect(fsMocks.pickCreateBackup).toHaveBeenCalledWith('team-tracker.bck', primaryHandle)
})

test('advanced tab: canceling the save picker leaves the pref off', async () => {
  const { store, shell, appCtl } = setup()
  fsMocks.pickCreateBackup.mockResolvedValue(null)
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Advanced')

  const checkbox = document.querySelector('input[type="checkbox"].tt-prefs-backup-checkbox') as HTMLInputElement
  checkbox.checked = true
  checkbox.dispatchEvent(new Event('change'))
  await Promise.resolve()
  await Promise.resolve()

  expect(store.doc.prefs.dailyBackupEnabled).toBe(false)
})

test('advanced tab: a rejecting save picker (e.g. permission denied) leaves the pref off, same as a cancel', async () => {
  const { store, shell, appCtl } = setup()
  fsMocks.pickCreateBackup.mockRejectedValue(new Error('not allowed'))
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Advanced')

  const checkbox = document.querySelector('input[type="checkbox"].tt-prefs-backup-checkbox') as HTMLInputElement
  checkbox.checked = true
  checkbox.dispatchEvent(new Event('change'))
  // One extra tick versus the plain-cancel test: the rejection has to pass
  // through pickAndStoreBackupTarget's own `.catch` before the checkbox's
  // outer `.then` sees `picked === false`.
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(store.doc.prefs.dailyBackupEnabled).toBe(false)
  expect(store.doc.prefs.backupHandleId).toBeNull()
  expect(checkbox.checked).toBe(false)
  expect(consoleErrorSpy).toHaveBeenCalled()
  consoleErrorSpy.mockRestore()
})

test('advanced tab: re-enabling with an existing backupHandleId skips the picker', async () => {
  const { store, shell, appCtl } = setup()
  store.update((d) => { d.prefs.backupHandleId = 'already-set' })
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Advanced')

  const checkbox = document.querySelector('input[type="checkbox"].tt-prefs-backup-checkbox') as HTMLInputElement
  checkbox.checked = true
  checkbox.dispatchEvent(new Event('change'))
  await Promise.resolve()

  expect(fsMocks.pickCreateBackup).not.toHaveBeenCalled()
  expect(store.doc.prefs.dailyBackupEnabled).toBe(true)
})

test('advanced tab: no "Change backup location" button when no backup target exists yet', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Advanced')

  expect(document.querySelector('.tt-prefs-backup-change-btn')).toBeNull()
})

test('advanced tab: "Change backup location" button appears once a backup target exists, even while disabled', () => {
  const { store, shell, appCtl } = setup()
  store.update((d) => { d.prefs.dailyBackupEnabled = false; d.prefs.backupHandleId = 'existing' })
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Advanced')

  expect(document.querySelector('.tt-prefs-backup-change-btn')).not.toBeNull()
})

test('advanced tab: "Change backup location" re-opens the picker without a disable/enable round trip, and re-enables the pref', async () => {
  const { store, shell, appCtl } = setup()
  store.update((d) => { d.prefs.dailyBackupEnabled = false; d.prefs.backupHandleId = 'old-id' })
  const primaryHandle = {} as unknown as FileSystemFileHandle
  appCtl.fileHandle = () => primaryHandle
  fsMocks.pickCreateBackup.mockResolvedValue({ handle: {} as unknown as FileSystemFileHandle, name: 'team-tracker.bck', lastModified: 1 })
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Advanced')

  // `.click()` is a no-op on a genuinely `disabled` element (matches real
  // browser behavior) — dispatchEvent bypasses that, same workaround the
  // checkbox tests above use, since `supportsFsApi` (and so `backupAvailable`)
  // is false under jsdom regardless of what `hasFileHandle()` returns.
  const changeBtn = document.querySelector('.tt-prefs-backup-change-btn') as HTMLButtonElement
  changeBtn.dispatchEvent(new Event('click'))
  // Flush the whole microtask queue (not just N `Promise.resolve()` ticks) —
  // `backupCheckbox.checked = true` runs in an extra `.then()` layered on
  // top of `pickAndStoreBackupTarget`'s own picker→idbSet→store.update
  // chain, and its exact tick depth isn't worth pinning down by hand.
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(fsMocks.pickCreateBackup).toHaveBeenCalledWith('team-tracker.bck', primaryHandle)
  expect(idbMocks.idbSet).toHaveBeenCalledTimes(1)
  expect(store.doc.prefs.backupHandleId).not.toBe('old-id')
  expect(store.doc.prefs.dailyBackupEnabled).toBe(true)
  const checkbox = document.querySelector('input[type="checkbox"].tt-prefs-backup-checkbox') as HTMLInputElement
  expect(checkbox.checked).toBe(true)
})

test('advanced tab: canceling "Change backup location" leaves the existing target and pref state untouched', async () => {
  const { store, shell, appCtl } = setup()
  store.update((d) => { d.prefs.dailyBackupEnabled = true; d.prefs.backupHandleId = 'old-id' })
  fsMocks.pickCreateBackup.mockResolvedValue(null)
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Advanced')

  const changeBtn = document.querySelector('.tt-prefs-backup-change-btn') as HTMLButtonElement
  changeBtn.dispatchEvent(new Event('click'))
  await Promise.resolve()
  await Promise.resolve()

  expect(store.doc.prefs.backupHandleId).toBe('old-id')
  expect(store.doc.prefs.dailyBackupEnabled).toBe(true)
})

test('advanced tab: disabling the pref does not clear the stored handle id', () => {
  const { store, shell, appCtl } = setup()
  store.update((d) => { d.prefs.dailyBackupEnabled = true; d.prefs.backupHandleId = 'existing' })
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Advanced')

  const checkbox = document.querySelector('input[type="checkbox"].tt-prefs-backup-checkbox') as HTMLInputElement
  checkbox.checked = false
  checkbox.dispatchEvent(new Event('change'))

  expect(store.doc.prefs.dailyBackupEnabled).toBe(false)
  expect(store.doc.prefs.backupHandleId).toBe('existing')
})

test('advanced tab: checkbox is disabled with a hint when hasFileHandle() is false', () => {
  const { store, shell, appCtl } = setup()
  appCtl.hasFileHandle = () => false
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Advanced')

  const checkbox = document.querySelector('input[type="checkbox"].tt-prefs-backup-checkbox') as HTMLInputElement
  expect(checkbox.disabled).toBe(true)
  expect(document.querySelector('.tt-prefs-backup-disabled-hint')?.textContent).toBe(
    'Unavailable: this browser has no direct file access, or this file has not been saved to disk yet.'
  )
})

test('advanced tab: backup frequency defaults to Daily and updates the pref when changed to Hourly', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Advanced')

  expect(radio('tt-prefs-backup-frequency', 'daily').checked).toBe(true)
  // `.click()` is a no-op here: `backupAvailable` (and so the radios'
  // `disabled` state) is always false under jsdom (no File System Access
  // API), same reason the backup-checkbox tests above dispatch 'change'
  // directly instead of clicking.
  const hourly = radio('tt-prefs-backup-frequency', 'hourly')
  hourly.checked = true
  hourly.dispatchEvent(new Event('change'))
  expect(store.doc.prefs.backupFrequency).toBe('hourly')
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
  expect(tabs).toEqual(['Geral', 'Avançado', 'Templates', 'Tags', 'Segurança', 'Dados', 'Sobre'])
})

test('locale radio re-seeds untouched builtin templates and leaves an edited one alone', () => {
  const { store, shell, appCtl } = setup()
  // setup() creates the doc with 'en-US', so store.doc.templates start out English.
  const beforeIds = store.doc.templates.map(t => t.id)
  store.update((d) => {
    d.templates[1]!.body = 'hand-edited body' // Feedback (SBI) template, left untouched by the switch
  })
  openPrefs(store, shell, 'en-US', appCtl)

  radio('tt-prefs-locale', 'pt-BR').click()

  expect(store.doc.templates.map(t => t.id)).toEqual(beforeIds) // same ids/order
  expect(store.doc.templates[0]!.name).toBe('1:1') // untouched builtin, now Portuguese wording
  expect(store.doc.templates[0]!.body).toContain('Como está / energia')
  expect(store.doc.templates[1]!.body).toBe('hand-edited body') // edited one, skipped
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

test('security tab: encrypted file shows a "Migrate to password-less" button', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Security')
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Migrate to password-less')
  expect(btn).toBeDefined()
})

test('security tab: migrate-to-plain asks for the current password, calls changePassword(null) on success', async () => {
  const { store, shell, appCtl, changePassword } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Security')
  clickByText('Migrate to password-less')

  // Two overlays are now stacked (the Preferences modal underneath, the
  // confirm sub-modal on top), both with a `.tt-modal-title` — grab the last
  // one in document order, same pattern the cleanup tests below use.
  const titles = document.querySelectorAll('.tt-modal-title')
  expect(titles[titles.length - 1]?.textContent).toBe('Migrate to a password-less file?')
  // The confirm sub-modal is now the topmost overlay — the existing
  // clickByText helper already scopes its lookup to the last
  // .tt-modal-overlay (see its definition below), so calling it again with
  // the same label correctly hits the sub-modal's confirm button, not the
  // Security tab's original button underneath it.
  const pwInput = document.querySelectorAll('.tt-modal-dialog')[1]!.querySelector('input') as HTMLInputElement
  pwInput.value = 'wrongpw'
  clickByText('Migrate to password-less')

  expect(changePassword).not.toHaveBeenCalled()

  pwInput.value = 'oldpw'
  clickByText('Migrate to password-less')
  await Promise.resolve()
  await Promise.resolve()

  expect(changePassword).toHaveBeenCalledWith(null)
})

test('security tab: plain file shows no current-password field, submit label is "Set password", calls changePassword(newPw)', async () => {
  const { store, shell, appCtl, changePassword } = setup()
  appCtl.currentPassword = () => null
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Security')

  expect(document.querySelector('input[name="tt-prefs-current-password"]')).toBeNull()
  expect(document.querySelector('.tt-prefs-security-form')?.textContent).toContain('This file is not password-protected')

  const next = document.querySelector('input[name="tt-prefs-new-password"]') as HTMLInputElement
  const confirm = document.querySelector('input[name="tt-prefs-new-password-confirm"]') as HTMLInputElement
  next.value = 'brandnewpw'
  confirm.value = 'brandnewpw'
  clickByText('Set password')

  expect(changePassword).toHaveBeenCalledWith('brandnewpw')
})

// `isPlain` is captured once at render time; "Set password" invalidates it. If
// the tab isn't rebuilt, a second change in the same modal session takes the
// plain-file branch — no current-password field, and the `if (!isPlain)`
// verification block skipped entirely, silently bypassing the check that is
// supposed to gate every password change on an already-encrypted file.
test('security tab: after "Set password" succeeds the tab re-renders as an encrypted file (no stale plain state)', async () => {
  const { store, shell, appCtl } = setup()
  let pw: string | null = null
  appCtl.currentPassword = () => pw
  // Mirrors main.ts: the in-memory password flips before changePassword resolves.
  const changePassword = vi.fn(async (newPw: string | null) => {
    pw = newPw
  })
  appCtl.changePassword = changePassword
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Security')

  const next = document.querySelector('input[name="tt-prefs-new-password"]') as HTMLInputElement
  const confirm = document.querySelector('input[name="tt-prefs-new-password-confirm"]') as HTMLInputElement
  next.value = 'brandnewpw'
  confirm.value = 'brandnewpw'
  clickByText('Set password')
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(changePassword).toHaveBeenCalledWith('brandnewpw')
  // Tab rebuilt with the encrypted-file UI.
  const current = document.querySelector('input[name="tt-prefs-current-password"]') as HTMLInputElement | null
  expect(current).not.toBeNull()
  expect(document.querySelector('.tt-prefs-security-form')?.textContent).not.toContain('This file is not password-protected')
  expect(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Migrate to password-less')).toBeDefined()

  // And the current-password check really gates a second change now.
  const next2 = document.querySelector('input[name="tt-prefs-new-password"]') as HTMLInputElement
  const confirm2 = document.querySelector('input[name="tt-prefs-new-password-confirm"]') as HTMLInputElement
  current!.value = 'not-the-password'
  next2.value = 'thirdpassword'
  confirm2.value = 'thirdpassword'
  clickByText('Change password')

  expect(document.querySelector('.tt-field-error')?.textContent).toBe('Current password is incorrect')
  expect(changePassword).toHaveBeenCalledTimes(1)
})

test('security tab: plain file has no "migrate to password-less" button', () => {
  const { store, shell, appCtl } = setup()
  appCtl.currentPassword = () => null
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Security')
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Migrate to password-less')
  expect(btn).toBeUndefined()
})

test('security tab: new-password field renders a strength meter for both encrypted and plain files', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Security')
  expect(document.querySelector('.tt-pwmeter')).not.toBeNull()
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
      'Includes only the team/member/stakeholder structure (names, roles, and hierarchy) — no content is exported (no notes, tasks, milestones, or risks). The generated file is NOT encrypted. Meant for teammates on the same team to import and skip initial setup.',
      'A team/member/stakeholder structure file (no content) exported by another user — only import from sources you trust.',
      'Removes done/cancelled tasks, completed milestones, and closed risks, plus old daily notes — across every team in this file. This cannot be undone.',
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
    expect(team.actionItems).toBeUndefined() // no work content is exported, only org structure
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
      .toBe('1 stakeholders · 1 members')

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

  test('cleanup: shows "nothing to clean up" when no team has any matching data', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20)) // sampleTeam's daily note (2026-07-16) is only 4 days old
    try {
      const { store, shell, appCtl } = setup()
      store.update((d) => { d.teams.push(sampleTeam()) })
      openPrefs(store, shell, 'en-US', appCtl)
      clickTab('Data')

      clickByText('Clean up data')

      const titles = document.querySelectorAll('.tt-modal-title')
      expect(titles[titles.length - 1]?.textContent).toBe('Nothing to clean up')
    } finally {
      vi.useRealTimers()
    }
  })

  test('cleanup: counts done/cancelled actions, completed milestones, closed risks, and old daily notes across teams, then removes them on confirm', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20))
    try {
      const { store, shell, appCtl } = setup()
      store.update((d) => {
        const teamA = sampleTeam()
        teamA.actionItems.push({ id: 'done1', summary: 'x', notes: '', status: 'done', dueDate: null, assignee: '', color: 'ledger', order: 1 })
        teamA.milestones.push({ id: 'm2', date: '2026-07-01', title: 'Old launch', done: true, followup: '' })
        teamA.risks.push({ id: 'r2', title: 'Stale risk', chance: 1, impact: 1, plan: 'accept', followup: '', order: 1, closed: true })
        teamA.dailyNotes['2000-01-01'] = 'ancient note'
        const teamB: Team = { id: 't2', name: 'Support', emoji: '🛟', stakeholders: [], members: [],
          actionItems: [{ id: 'cancelled1', summary: 'y', notes: '', status: 'cancelled', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
          milestones: [], risks: [], dailyNotes: {} }
        d.teams.push(teamA, teamB)
      })
      openPrefs(store, shell, 'en-US', appCtl)
      clickTab('Data')

      clickByText('Clean up data')

      const titles = document.querySelectorAll('.tt-modal-title')
      const messages = document.querySelectorAll('.tt-modal-message')
      expect(titles[titles.length - 1]?.textContent).toBe('Confirm cleanup')
      expect(messages[messages.length - 1]?.textContent).toBe(
        '2 tasks, 1 milestones, 1 risks, and 1 daily notes across all teams will be permanently deleted. This cannot be undone.'
      )

      clickByText('Clean up data')

      const teams = store.doc.teams
      expect(teams[0]!.actionItems.map((a) => a.id)).toEqual(['a1'])
      expect(teams[0]!.dailyNotes).toEqual({ '2026-07-16': 'private daily note' })
      expect(teams[0]!.milestones.map((m) => m.id)).toEqual(['m1'])
      expect(teams[0]!.risks.map((r) => r.id)).toEqual(['r1'])
      expect(teams[1]!.actionItems).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

function openTab(label: string): void {
  Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-prefs-tab-btn')).find((b) => b.textContent === label)!.click()
}

function team(id: string, name: string, actionTagNames: Team['actionTagNames'] = {}): Team {
  return { id, name, emoji: '🚀', stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {}, actionTagNames }
}

describe('Tags tab', () => {
  test('shows a hint instead of the form when there are fewer than 2 teams', () => {
    const { store, shell, appCtl } = setup()
    store.update((d) => { d.teams.push(team('t1', 'Solo')) })
    openPrefs(store, shell, 'en-US', appCtl)
    openTab('Tags')
    expect(document.querySelector('.tt-prefs-content')!.textContent).toContain('Create at least two teams to use this.')
  })

  test('applying copies the source team\'s actionTagNames onto every other team, leaves the source untouched', () => {
    const { store, shell, appCtl } = setup()
    store.update((d) => {
      d.teams.push(team('t1', 'Alpha', { rust: 'Urgent' }))
      d.teams.push(team('t2', 'Beta', { rust: 'Old name' }))
      d.teams.push(team('t3', 'Gamma'))
    })
    openPrefs(store, shell, 'en-US', appCtl)
    openTab('Tags')

    const select = document.querySelector('select') as HTMLSelectElement
    select.value = 't1'
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Apply to all teams')!.click()
    // confirm modal — scoped to the topmost overlay via clickByText, since the
    // confirm button reuses the same label as the tab's own apply button and
    // an unscoped lookup would match the (still-present) one behind it.
    clickByText('Apply to all teams')

    expect(store.doc.teams.find((t) => t.id === 't1')!.actionTagNames).toEqual({ rust: 'Urgent' })
    expect(store.doc.teams.find((t) => t.id === 't2')!.actionTagNames).toEqual({ rust: 'Urgent' })
    expect(store.doc.teams.find((t) => t.id === 't3')!.actionTagNames).toEqual({ rust: 'Urgent' })
  })
})
