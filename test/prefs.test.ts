import { openPrefs, onLocaleChanged, notifyLocaleChanged, type PrefsAppCtl } from '../src/ui/prefs'
import { createShell, type Shell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { t } from '../src/core/i18n'
import type { ChangeScope } from '../src/core/scope'
import { createEmptyDocument } from '../src/core/document'
import { builtinTemplates } from '../src/core/templates'
import { SCHEMA_VERSION } from '../src/core/document'
import { buildExport } from '../src/core/team-export'
import { setReadOnlyLock } from '../src/ui/readonly-lock'
import { downloadFallback } from '../src/core/fs'
import type { Template, Team } from '../src/core/types'

// `fsApi` overrides `supportsFsApi` (always false under jsdom) for the few
// tests that need the FS-API branch; setup() resets it to jsdom's real value.
const fsMocks = vi.hoisted(() => ({ fsApi: false }))
vi.mock('../src/core/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fs')>()
  return {
    ...actual,
    get supportsFsApi() { return fsMocks.fsApi },
    downloadFallback: vi.fn(),
  }
})

const persistMocks = vi.hoisted(() => ({ getPersistStatus: vi.fn(async () => null as boolean | null) }))
vi.mock('../src/core/storage-persist', () => persistMocks)

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
  fsMocks.fsApi = false
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

test('renders 6 tabs, defaulting to Geral/General', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  const tabs = Array.from(document.querySelectorAll('.tt-prefs-tab-btn')).map((b) => b.textContent)
  expect(tabs).toEqual(['General', 'Saving', 'Templates', 'Security', 'Data', 'About'])
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

/**
 * Scope guards. An unscoped `store.update` means "everything changed", which
 * makes every mounted module tear down and rebuild — rich-editor bundles and
 * all. Preference and template writes touch nothing any module renders, so
 * they are scoped; `locale` is the deliberate exception, since it changes
 * every string every module already drew. e2e/hotpath.spec.ts measures the
 * rebuild these prevent.
 */
describe('change scopes', () => {
  /** The `scope` argument of every `store.update()` made while `fn` runs. */
  function scopesDuring(store: Store, fn: () => void): (ChangeScope | null | undefined)[] {
    const seen: (ChangeScope | null | undefined)[] = []
    const original = store.update.bind(store)
    const spy = vi.spyOn(store, 'update').mockImplementation((mutate, scope) => {
      seen.push(scope)
      original(mutate, scope)
    })
    try { fn() } finally { spy.mockRestore() }
    return seen
  }

  test('a theme change is scoped to prefs, so no module rebuilds', () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    const scopes = scopesDuring(store, () => radio('tt-prefs-theme', 'dark').click())
    expect(scopes).toEqual([{ sections: ['prefs'] }])
  })

  test('font, size, palette and the secondary-pane toggle are all prefs-scoped', () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    const secondary = document.querySelector<HTMLInputElement>('.tt-prefs-open-refs-secondary-checkbox')!
    const scopes = scopesDuring(store, () => {
      radio('tt-prefs-font', 'mono').click()
      radio('tt-prefs-size', 'L').click()
      radio('tt-prefs-palette', 'forest').click()
      secondary.checked = !secondary.checked
      secondary.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(scopes).toHaveLength(4)
    for (const s of scopes) expect(s).toEqual({ sections: ['prefs'] })
  })

  test('a locale change stays unscoped — it changes every string every module rendered', () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    const scopes = scopesDuring(store, () => radio('tt-prefs-locale', 'pt-BR').click())
    expect(scopes).toEqual([undefined])
  })
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

test('font field offers 7 options (including classic/rounded/segoe/legible) and each label previews its own font stack', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)

  expect(radio('tt-prefs-font', 'classic')).not.toBeNull()
  expect(radio('tt-prefs-font', 'rounded')).not.toBeNull()
  expect(radio('tt-prefs-font', 'segoe')).not.toBeNull()
  expect(radio('tt-prefs-font', 'legible')).not.toBeNull()

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

test('palette field defaults to ledger, offers 12 swatched options, and updates store.prefs + shell on change', () => {
  const { store, shell, appCtl } = setup()
  const applySpy = vi.spyOn(shell, 'applyPrefs')
  openPrefs(store, shell, 'en-US', appCtl)

  expect(radio('tt-prefs-palette', 'ledger').checked).toBe(true)
  for (const value of ['signal', 'blueprint', 'forest', 'desert', 'cosmic', 'synthwave', 'verdant', 'ember', 'graphite', 'rose', 'citrus']) {
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

test('the file-write interval is edited in hours (1..24) and stored as minutes', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Saving')

  const input = document.querySelector('.tt-prefs-autosave-input') as HTMLInputElement
  expect(input.value).toBe('1') // the default, 60 minutes, shown as hours
  input.value = '3'
  input.dispatchEvent(new Event('change'))
  expect(store.doc.prefs.autoSaveMin).toBe(180)

  input.value = '99'
  input.dispatchEvent(new Event('change'))
  expect(store.doc.prefs.autoSaveMin).toBe(1440)
  expect(input.value).toBe('24')

  input.value = '0'
  input.dispatchEvent(new Event('change'))
  expect(store.doc.prefs.autoSaveMin).toBe(60)
  expect(input.value).toBe('1')
})

test('an interval that is not a whole number of hours is shown rounded, and the field says what it controls', () => {
  const { store, shell, appCtl } = setup()
  store.doc.prefs.autoSaveMin = 150
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Saving')
  expect((document.querySelector('.tt-prefs-autosave-input') as HTMLInputElement).value).toBe('3')
  expect(document.body.textContent).toContain('Write the file every (hours)')
  expect(document.body.textContent).toContain('The browser copy is saved continuously')
})

describe('browser storage status line', () => {
  async function statusText(status: boolean | null, locale: 'en-US' | 'pt-BR' = 'en-US'): Promise<string> {
    persistMocks.getPersistStatus.mockResolvedValue(status)
    const { store, shell, appCtl } = setup()
    store.doc.prefs.locale = locale
    openPrefs(store, shell, locale, appCtl)
    clickTab(locale === 'en-US' ? 'Saving' : 'Salvamento')
    await new Promise((r) => setTimeout(r, 0))
    return document.querySelector('.tt-prefs-storage-status')!.textContent!
  }

  test('protected, in both locales', async () => {
    expect(await statusText(true)).toBe(t('en-US', 'prefs_storage_protected'))
    expect(await statusText(true, 'pt-BR')).toBe(t('pt-BR', 'prefs_storage_protected'))
  })

  test('not guaranteed warns that clearing site data loses what the file does not have yet', async () => {
    const text = await statusText(false)
    expect(text).toBe(t('en-US', 'prefs_storage_not_guaranteed'))
    expect(text).toContain('clearing site data')
    expect(await statusText(false, 'pt-BR')).toBe(t('pt-BR', 'prefs_storage_not_guaranteed'))
  })

  test('unknown when the browser does not say', async () => {
    expect(await statusText(null)).toBe(t('en-US', 'prefs_storage_unknown'))
    expect(await statusText(null, 'pt-BR')).toBe(t('pt-BR', 'prefs_storage_unknown'))
  })

  test('a tab closed before the answer arrives is not written to', async () => {
    let resolve!: (v: boolean) => void
    persistMocks.getPersistStatus.mockReturnValue(new Promise<boolean>((r) => { resolve = r }))
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    clickTab('Saving')
    clickTab('Templates')
    expect(() => resolve(true)).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(document.querySelector('.tt-prefs-storage-status')).toBeNull()
  })
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

test('the "Ctrl+wheel adjusts font size" checkbox reflects and updates the pref', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)

  const checkbox = document.querySelector('.tt-prefs-ctrl-wheel-font-checkbox') as HTMLInputElement
  expect(checkbox).not.toBeNull()
  expect(checkbox.checked).toBe(true)

  checkbox.checked = false
  checkbox.dispatchEvent(new Event('change', { bubbles: true }))

  expect(store.doc.prefs.ctrlWheelFontSize).toBe(false)
})

test('the "edge-scroll to nearest day with a note" checkbox reflects and updates the pref', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)

  const checkbox = document.querySelector('.tt-prefs-daily-edge-scroll-checkbox') as HTMLInputElement
  expect(checkbox).not.toBeNull()
  expect(checkbox.checked).toBe(true)

  checkbox.checked = false
  checkbox.dispatchEvent(new Event('change', { bubbles: true }))

  expect(store.doc.prefs.dailyEdgeScroll).toBe(false)
})

test('the two new General-tab toggles are prefs-scoped', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  const seen: unknown[] = []
  const original = store.update.bind(store)
  vi.spyOn(store, 'update').mockImplementation((mutate, scope) => {
    seen.push(scope)
    original(mutate, scope)
  })
  for (const cls of ['.tt-prefs-ctrl-wheel-font-checkbox', '.tt-prefs-daily-edge-scroll-checkbox']) {
    const cb = document.querySelector(cls) as HTMLInputElement
    cb.checked = !cb.checked
    cb.dispatchEvent(new Event('change', { bubbles: true }))
  }
  expect(seen).toEqual([{ sections: ['prefs'] }, { sections: ['prefs'] }])
})

test('an initialTab argument opens directly on that tab instead of defaulting to General', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl, 'saving')

  expect(document.querySelector('.tt-prefs-autosave-input')).not.toBeNull()
  const activeBtn = Array.from(document.querySelectorAll('.tt-prefs-tab-btn')).find((b) => b.classList.contains('active'))
  expect(activeBtn?.textContent).toBe('Saving')
})

test('there is no backup control anywhere in the Saving tab', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Saving')

  expect(document.querySelector('[class*="backup"]')).toBeNull()
  expect(document.body.textContent).not.toMatch(/backup/i)
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
  expect(tabs).toEqual(['Geral', 'Salvamento', 'Templates', 'Segurança', 'Dados', 'Sobre'])
})

test('notifyLocaleChanged is a plain document event: dispatching with zero listeners registered never throws (ui/prefs.ts has no direct PaneManager dependency)', () => {
  expect(() => notifyLocaleChanged()).not.toThrow()
})

test('onLocaleChanged\'s returned unsubscribe stops that listener without affecting others', () => {
  const a = vi.fn()
  const b = vi.fn()
  const unsubA = onLocaleChanged(a)
  onLocaleChanged(b)

  notifyLocaleChanged()
  expect(a).toHaveBeenCalledTimes(1)
  expect(b).toHaveBeenCalledTimes(1)

  unsubA()
  notifyLocaleChanged()
  expect(a).toHaveBeenCalledTimes(1) // unsubscribed — no second call
  expect(b).toHaveBeenCalledTimes(2)
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
  bodyTextarea.value = 'body {date}'
  bodyTextarea.dispatchEvent(new Event('input'))
  clickByText('OK')

  expect(store.doc.templates).toHaveLength(6)
  const added = store.doc.templates.find((tp) => tp.name === 'Custom')
  expect(added).toBeDefined()
  expect(added?.scope).toBe('daily')
  expect(added?.body).toBe('body {date}')
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

test('delete confirmation warns that a deleted template cannot be brought back', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Templates')

  const delBtn = document.querySelector('.tt-prefs-template-delete-btn') as HTMLButtonElement
  delBtn.click()

  // Every other delete in the app either offers an undo toast or says it
  // cannot; templates are the one site with no undo, so the dialog has to
  // say so rather than leave the user to infer it from a missing button.
  expect(document.querySelector('.tt-modal-warning')?.textContent).toBe(
    'Unlike deleting a task, milestone or risk, a deleted template cannot be brought back.'
  )
  const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Delete')!
  expect(confirmBtn.className).toContain('tt-btn-danger')

  clickByText('Delete')
  expect(document.querySelector('.tt-toast-action')).toBeNull()
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
      'Create at least two teams to use this.',
      'Removes done/cancelled tasks and closed risks, plus completed milestones and daily notes dated older than the chosen number of days, and favorites that point to a deleted team or person or to a day older than that — across every team in this file. This cannot be undone.',
    ])
  })

  test('export team checkboxes still toggle in a read-only tab (export only reads); import and cleanup stay locked', () => {
    const { store, shell, appCtl } = setup()
    store.update((d) => { d.teams.push(sampleTeam()) })
    openPrefs(store, shell, 'en-US', appCtl)
    clickTab('Data')
    setReadOnlyLock(true, () => 'en-US')
    try {
      const cb = exportCheckboxes()[0] as HTMLInputElement
      cb.click()
      expect(cb.checked).toBe(true)
      const other = document.createElement('input')
      other.type = 'checkbox'
      document.body.appendChild(other)
      other.click()
      expect(other.checked).toBe(false)
    } finally {
      setReadOnlyLock(false, () => 'en-US')
    }
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

  test('import: a structurally malformed team (missing member list) shows the invalid-file modal, no checklist and nothing imported', async () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    clickTab('Data')

    const bad = { kind: 'team-tracker-teams-export', schemaVersion: SCHEMA_VERSION, exportedAt: '', teams: [{ name: 'X', emoji: '', stakeholders: [] }] }
    const jsonFile = new File([JSON.stringify(bad)], 'export.json', { type: 'application/json' })
    const fileInput = document.querySelector('input[type="file"][accept=".json"]') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { value: [jsonFile], configurable: true })
    fileInput.dispatchEvent(new Event('change'))
    await new Promise((r) => setTimeout(r, 0))

    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Invalid file — not a Team Tracker teams export')
    expect(document.querySelector('.tt-data-team-summary')).toBeNull()
    expect(store.doc.teams).toHaveLength(0)
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

  test('cleanup: a document whose only garbage is a dead favorite still gets a confirm and is purged', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20))
    try {
      const { store, shell, appCtl } = setup()
      store.update((d) => {
        d.teams.push(sampleTeam())
        d.favorites.push({ teamId: 'deleted-team', ref: { kind: 'risks' } })
      })
      openPrefs(store, shell, 'en-US', appCtl)
      clickTab('Data')

      clickByText('Clean up data')

      const titles = document.querySelectorAll('.tt-modal-title')
      expect(titles[titles.length - 1]?.textContent).toBe('Confirm cleanup')
      const messages = document.querySelectorAll('.tt-modal-message')
      expect(messages[messages.length - 1]?.textContent).toContain('1 broken favorites')

      clickByText('Clean up data')
      expect(store.doc.favorites).toEqual([])
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
        teamA.milestones.push({ id: 'm2', date: '2026-05-01', title: 'Old launch', done: true, followup: '' }) // done + well over the default 60-day window
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
        '2 tasks, 1 milestones, 1 risks, 1 daily notes, and 0 broken favorites across all teams will be permanently deleted.'
      )
      // Every other delete in the app offers an undo toast; this one does not,
      // so the dialog has to say so rather than let the user infer it.
      const warnings = document.querySelectorAll('.tt-modal-warning')
      expect(warnings[warnings.length - 1]?.textContent).toBe(
        'Unlike deleting a single task, milestone or risk, this cleanup offers no undo. There is no way back.'
      )

      clickByText('Clean up data')

      // Data cleanup deliberately offers no undo (the warning above says so
      // instead) — this locks that decision in against a future "helpful"
      // re-addition of an undo button for cleanup.
      expect(document.querySelector('.tt-toast-action')).toBeNull()

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

describe('Data tab: picture usage line', () => {
  const MB = 1024 * 1024
  const idN = (n: number) => String(n).repeat(32).slice(0, 32)

  /** A doc whose daily note references one picture per entry, with the stated byte sizes. */
  function withPictures(sizes: number[]) {
    const { store, shell, appCtl } = setup()
    store.update((d) => {
      const team = sampleTeam()
      team.dailyNotes = { '2026-07-16': sizes.map((_, i) => `![p](img:${idN(i)})`).join('\n\n') }
      d.teams.push(team)
      sizes.forEach((bytes, i) => { d.images[idN(i)] = { mime: 'image/webp', w: 10, h: 10, bytes } })
    })
    openPrefs(store, shell, 'en-US', appCtl)
    clickTab('Data')
    return document.querySelector('.tt-data-images-usage') as HTMLElement
  }

  test('shows the picture count and the megabytes used out of the budget', () => {
    const line = withPictures([MB, MB / 2])
    expect(line.textContent).toBe('2 pictures · 1.5 MB of 150 MB')
    expect(line.classList.contains('tt-data-images-warn')).toBe(false)
    expect(line.classList.contains('tt-data-images-full')).toBe(false)
  })

  test('says "picture" for exactly one, and shows zero for a file with none', () => {
    expect(withPictures([MB]).textContent).toBe('1 picture · 1.0 MB of 150 MB')
    expect(withPictures([]).textContent).toBe('0 pictures · 0.0 MB of 150 MB')
  })

  test('counts only the pictures a note still references', () => {
    const { store, shell, appCtl } = setup()
    store.update((d) => { d.images[idN(1)] = { mime: 'image/webp', w: 1, h: 1, bytes: 5 * MB } })
    openPrefs(store, shell, 'en-US', appCtl)
    clickTab('Data')
    expect(document.querySelector('.tt-data-images-usage')!.textContent).toBe('0 pictures · 0.0 MB of 150 MB')
  })

  test('warns from 100 MB up', () => {
    const line = withPictures([100 * MB])
    expect(line.classList.contains('tt-data-images-warn')).toBe(true)
    expect(line.classList.contains('tt-data-images-full')).toBe(false)
  })

  test('turns to the error look at the 150 MB budget', () => {
    const line = withPictures([150 * MB])
    expect(line.classList.contains('tt-data-images-full')).toBe(true)
  })

  test('is translated', () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'pt-BR', appCtl)
    clickTab(t('pt-BR', 'prefs_tab_data'))
    expect(document.querySelector('.tt-data-images-usage')!.textContent).toBe(t('pt-BR', 'data_images_usage_other', { n: '0', used: '0.0', cap: '150' }))
  })
})

describe('Data tab: cross-team tags section', () => {
  test('shows a hint instead of the form when there are fewer than 2 teams', () => {
    const { store, shell, appCtl } = setup()
    store.update((d) => { d.teams.push(team('t1', 'Solo')) })
    openPrefs(store, shell, 'en-US', appCtl)
    openTab('Data')
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
    openTab('Data')

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

test('cleanup days field clamps to a whole number of days in 1..3650; empty or garbage reads as 1', () => {
  const { store, shell, appCtl } = setup()
  openPrefs(store, shell, 'en-US', appCtl)
  clickTab('Data')
  const input = document.querySelector('.tt-data-cleanup-days-input') as HTMLInputElement
  const commit = (v: string): string => { input.value = v; input.dispatchEvent(new Event('change')); return input.value }
  expect(commit('12.6')).toBe('13')
  expect(commit('9999')).toBe('3650')
  expect(commit('-5')).toBe('1')
  expect(commit('')).toBe('1')
})

// A read-only tab's store.update() is blocked, so the Data tab's writes must
// neither be offered (disabled at render) nor announce success when the lock
// is lost while the tab is already open.
describe('Data tab in a read-only tab', () => {
  const toastTexts = (): string[] => Array.from(document.querySelectorAll('.tt-toast')).map((n) => n.textContent ?? '')
  const buttonByText = (text: string): HTMLButtonElement =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-prefs-content button')).find((b) => b.textContent === text)!
  function twoTeams(store: Store): void {
    store.update((d) => {
      const a = sampleTeam()
      a.actionTagNames = { rust: 'Urgent' }
      a.actionItems.push({ id: 'done1', summary: 'x', notes: '', status: 'done', dueDate: null, assignee: '', color: 'ledger', order: 1 })
      const b = sampleTeam()
      b.id = 't2'
      b.name = 'Beta'
      b.actionTagNames = { rust: 'Old' }
      d.teams.push(a, b)
    })
  }

  test('import, cleanup and tag cross-apply are disabled, with the read-only notice as their tooltip', () => {
    const { store, shell, appCtl } = setup()
    twoTeams(store)
    openPrefs(store, shell, 'en-US', { ...appCtl, isReadOnly: () => true })
    clickTab('Data')
    for (const key of ['data_import_pick_btn', 'data_cleanup_btn', 'tags_cross_apply_btn'] as const) {
      const btn = buttonByText(t('en-US', key))
      expect(btn.disabled).toBe(true)
      expect(btn.title).toBe(t('en-US', 'readonly_blocked_toast'))
    }
  })

  test('lock lost while open: tag cross-apply changes nothing and claims no success', () => {
    const { store, shell, appCtl } = setup()
    twoTeams(store)
    openPrefs(store, shell, 'en-US', appCtl)
    clickTab('Data')
    store.setReadOnly(true)
    buttonByText(t('en-US', 'tags_cross_apply_btn')).click()
    clickByText(t('en-US', 'tags_cross_apply_btn'))
    expect(store.doc.teams[1]!.actionTagNames).toEqual({ rust: 'Old' })
    expect(toastTexts()).not.toContain(t('en-US', 'tags_cross_apply_success_toast'))
  })

  test('lock lost while open: cleanup removes nothing and claims no success', () => {
    const { store, shell, appCtl } = setup()
    twoTeams(store)
    openPrefs(store, shell, 'en-US', appCtl)
    clickTab('Data')
    store.setReadOnly(true)
    clickByText(t('en-US', 'data_cleanup_btn'))
    clickByText(t('en-US', 'data_cleanup_btn'))
    expect(store.doc.teams[0]!.actionItems.some((a) => a.id === 'done1')).toBe(true)
    expect(toastTexts()).not.toContain(t('en-US', 'data_cleanup_success_toast'))
  })

  test('lock lost while open: import adds nothing, claims no success, and keeps the checklist', async () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    clickTab('Data')
    const jsonFile = new File([JSON.stringify(buildExport([sampleTeam()]))], 'export.json', { type: 'application/json' })
    const fileInput = document.querySelector('input[type="file"][accept=".json"]') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { value: [jsonFile], configurable: true })
    fileInput.dispatchEvent(new Event('change'))
    await new Promise((r) => setTimeout(r, 0))
    store.setReadOnly(true)
    clickByText(t('en-US', 'data_import_btn'))
    expect(store.doc.teams).toHaveLength(0)
    expect(toastTexts()).not.toContain(t('en-US', 'data_import_success_toast'))
    expect(document.querySelector('.tt-data-team-summary')).not.toBeNull()
  })
})

// --- Layout / accessibility / scroll behaviour (preferences window refactor) ---

/** jsdom does no layout, so scrollTop is a no-op stub; back it with a plain variable to observe what the modal sets. */
function trackScroll(content: HTMLElement): { value: number } {
  const state = { value: 0 }
  Object.defineProperty(content, 'scrollTop', { configurable: true, get: () => state.value, set: (v: number) => { state.value = v } })
  return state
}

describe('preferences layout', () => {
  test('General groups Interface and Behavior, with Ctrl+wheel directly after Text size', () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    const titles = Array.from(document.querySelectorAll('.tt-prefs-section-title')).map((n) => n.textContent)
    expect(titles).toEqual(['Interface', 'Behavior'])

    // Nothing sits between the Text size row and the wheel toggle.
    const sizeField = radio('tt-prefs-size', 'M').closest('.tt-prefs-field')!
    expect(sizeField.nextElementSibling?.querySelector('.tt-prefs-ctrl-wheel-font-checkbox')).not.toBeNull()
  })

  test('auto-save moved out of General into the Saving tab', () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    expect(document.querySelector('.tt-prefs-autosave-input')).toBeNull()
    clickTab('Saving')
    expect(document.querySelector('.tt-prefs-autosave-input')).not.toBeNull()
    const titles = Array.from(document.querySelectorAll('.tt-prefs-section-title')).map((n) => n.textContent)
    expect(titles).toEqual(['File writes', 'Browser storage'])
  })

  test('cross-team tags live in the Data tab, before the destructive cleanup section', () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    const tabs = Array.from(document.querySelectorAll('.tt-prefs-tab-btn')).map((b) => b.textContent)
    expect(tabs).not.toContain('Tags')
    clickTab('Data')
    const titles = Array.from(document.querySelectorAll('.tt-prefs-section-title')).map((n) => n.textContent)
    expect(titles).toEqual(['Export teams', 'Import teams', 'Apply tags across teams', 'Pictures', 'Data cleanup'])
  })
})

describe('preferences tabs accessibility', () => {
  test('tab strip is a tablist; the active tab is selected and tabbable, the content is its labelled tabpanel', () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    expect(document.querySelector('.tt-prefs-tabs')?.getAttribute('role')).toBe('tablist')
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-prefs-tab-btn'))
    expect(buttons.every((b) => b.getAttribute('role') === 'tab')).toBe(true)
    expect(buttons.map((b) => b.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false'])
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1, -1])
    const panel = document.querySelector('.tt-prefs-content')!
    expect(panel.getAttribute('role')).toBe('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe(buttons[0]!.id)

    clickTab('Data')
    expect(panel.getAttribute('aria-labelledby')).toBe('tt-prefs-tab-data')
    expect(document.getElementById('tt-prefs-tab-data')!.getAttribute('aria-selected')).toBe('true')
  })

  test('arrow keys, Home and End move focus between tabs (wrapping) without switching the tab', () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-prefs-tab-btn'))
    const strip = document.querySelector('.tt-prefs-tabs')!
    const press = (key: string) => strip.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    buttons[0]!.focus()

    press('ArrowRight')
    expect(document.activeElement).toBe(buttons[1])
    press('End')
    expect(document.activeElement).toBe(buttons[5])
    press('ArrowRight')
    expect(document.activeElement).toBe(buttons[0])
    press('ArrowLeft')
    expect(document.activeElement).toBe(buttons[5])
    press('Home')
    expect(document.activeElement).toBe(buttons[0])
    // Focus moved, but nothing was activated.
    expect(document.querySelector('.tt-prefs-tab-btn.active')?.textContent).toBe('General')
  })
})

describe('preferences scroll behaviour', () => {
  test('switching tab resets the scroll position to the top', () => {
    const { store, shell, appCtl } = setup()
    openPrefs(store, shell, 'en-US', appCtl)
    const scroll = trackScroll(document.querySelector('.tt-prefs-content') as HTMLElement)
    scroll.value = 240
    clickTab('Data')
    expect(scroll.value).toBe(0)
  })

  test('rebuilding the tab already on screen keeps the scroll position', async () => {
    const { store, shell, appCtl } = setup()
    appCtl.currentPassword = () => null
    openPrefs(store, shell, 'en-US', appCtl, 'security')
    const scroll = trackScroll(document.querySelector('.tt-prefs-content') as HTMLElement)
    scroll.value = 180
    // Setting a password rebuilds the Security tab in place (plain → encrypted UI).
    ;(document.querySelector('input[name="tt-prefs-new-password"]') as HTMLInputElement).value = 'brandnewpw'
    ;(document.querySelector('input[name="tt-prefs-new-password-confirm"]') as HTMLInputElement).value = 'brandnewpw'
    clickByText('Set password')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(scroll.value).toBe(180)
  })
})
