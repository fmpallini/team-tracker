// src/ui/prefs.ts — Task 24: preferences modal (general prefs, templates
// admin, change password, about). A single `showModal` whose body is a small
// tab strip + content area that this module mutates in place as the user
// switches tabs — simpler than tearing down/rebuilding the whole dialog, and
// it keeps a single overlay/Escape-handler alive for the whole session.
import type { Store } from '../core/store'
import type { Shell } from './shell'
import type { Prefs, Template } from '../core/types'
import { t, type Locale, type MsgKey } from '../core/i18n'
import { el } from './dom'
import { showModal, showErrorModal, toast, type ModalButton, type ModalHandle } from './modal'
import { builtinTemplates } from '../core/templates'
import { SCHEMA_VERSION, migrateTeams } from '../core/document'
import { notifyNavChanged } from './sidebar'
import { buildExport, parseImportFile, remapForImport, InvalidExportFileError, ExportTooNewError, type ExportedTeam } from '../core/team-export'
import { supportsFsApi, pickSaveJson, downloadFallback } from '../core/fs'

export interface PrefsAppCtl {
  changePassword(newPw: string): Promise<void>
  currentPassword(): string
  /**
   * Task 25 re-review item #2 (UX bonus): lets the Security tab disable its
   * submit button and show an explanatory hint when this tab has lost the
   * cross-tab write lock, instead of only surfacing the rejection after the
   * fact via the generic failure toast. `changePassword` itself still throws
   * if called while read-only — this is purely a cheaper, clearer front door
   * to that same guard.
   */
  isReadOnly(): boolean
  fileName: string
  fileSchemaVersion: number
}

/**
 * Dispatched after the locale preference changes, so main.ts (which owns the
 * `PaneManager` — not available in this module per the Task 24 contract) can
 * re-render pane bars/bodies in the new locale. Sidebar highlight/labels are
 * covered by the existing `store.subscribe` wiring (any `store.update` call
 * already re-renders the sidebar) plus `notifyNavChanged()` below; per-module
 * pane content that captured its locale string at mount time is not fully
 * re-translated until the user navigates away and back — acceptable per the
 * Task 24 brief, which explicitly defers full-fidelity re-render.
 */
const LOCALE_CHANGED_EVENT = 'tt-locale-changed'

export function notifyLocaleChanged(): void {
  document.dispatchEvent(new CustomEvent(LOCALE_CHANGED_EVENT))
}

/** Returns an unsubscribe function (mirrors sidebar.ts's onNavChanged) so per-document listeners can be torn down on close-file instead of leaking across sessions. */
export function onLocaleChanged(cb: () => void): () => void {
  document.addEventListener(LOCALE_CHANGED_EVENT, cb)
  return () => {
    document.removeEventListener(LOCALE_CHANGED_EVENT, cb)
  }
}

type TabId = 'general' | 'templates' | 'security' | 'data' | 'about'

const TABS: readonly { id: TabId; key: MsgKey }[] = [
  { id: 'general', key: 'prefs_tab_general' },
  { id: 'templates', key: 'prefs_tab_templates' },
  { id: 'security', key: 'prefs_tab_security' },
  { id: 'data', key: 'prefs_tab_data' },
  { id: 'about', key: 'prefs_tab_about' },
]

const THEME_OPTIONS: readonly { value: 'light' | 'dark' | 'system'; key: MsgKey }[] = [
  { value: 'light', key: 'prefs_theme_light' },
  { value: 'dark', key: 'prefs_theme_dark' },
  { value: 'system', key: 'prefs_theme_system' },
]

// `swatch` previews each palette with its own accent color (see
// styles.css's [data-palette=...] blocks) — same "show, don't describe"
// idea as FONT_OPTIONS's per-option font stack below.
const PALETTE_OPTIONS: readonly { value: Prefs['palette']; key: MsgKey; swatch: string }[] = [
  { value: 'ledger', key: 'prefs_palette_ledger', swatch: '#3b5a6b' },
  { value: 'signal', key: 'prefs_palette_signal', swatch: '#0058a3' },
  { value: 'blueprint', key: 'prefs_palette_blueprint', swatch: '#0a6890' },
  { value: 'muster', key: 'prefs_palette_muster', swatch: '#8f4b10' },
  { value: 'forest', key: 'prefs_palette_forest', swatch: '#8f5814' },
  { value: 'desert', key: 'prefs_palette_desert', swatch: '#14706c' },
  { value: 'cosmic', key: 'prefs_palette_cosmic', swatch: '#5b4bc4' },
  { value: 'synthwave', key: 'prefs_palette_synthwave', swatch: '#22d3ee' },
]

const LOCALE_OPTIONS: readonly { value: Locale; key: MsgKey }[] = [
  { value: 'pt-BR', key: 'prefs_locale_pt' },
  { value: 'en-US', key: 'prefs_locale_en' },
]

// `preview` is the same font stack the option applies to the whole app (see
// styles.css's html[data-font=...] rules) — rendering each label in its own
// stack lets the option show itself instead of describing itself.
const FONT_OPTIONS: readonly { value: Prefs['font']; key: MsgKey; preview: string }[] = [
  { value: 'system', key: 'prefs_font_system', preview: 'Bahnschrift, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { value: 'serif', key: 'prefs_font_serif', preview: 'Georgia, "Times New Roman", serif' },
  { value: 'mono', key: 'prefs_font_mono', preview: 'Consolas, "Cascadia Mono", monospace' },
  { value: 'classic', key: 'prefs_font_classic', preview: 'Constantia, Cambria, "Times New Roman", serif' },
  { value: 'rounded', key: 'prefs_font_rounded', preview: 'Candara, Corbel, sans-serif' },
]

const SIZE_OPTIONS: readonly { value: 'S' | 'M' | 'L'; key: MsgKey }[] = [
  { value: 'S', key: 'prefs_size_s' },
  { value: 'M', key: 'prefs_size_m' },
  { value: 'L', key: 'prefs_size_l' },
]

const SCOPE_OPTIONS: readonly { value: Template['scope']; key: MsgKey }[] = [
  { value: 'personal', key: 'prefs_templates_scope_personal' },
  { value: 'daily', key: 'prefs_templates_scope_daily' },
  { value: 'any', key: 'prefs_templates_scope_any' },
]

function scopeLabel(locale: Locale, scope: Template['scope']): string {
  const opt = SCOPE_OPTIONS.find((o) => o.value === scope)
  return opt ? t(locale, opt.key) : scope
}

export function openPrefs(store: Store, shell: Shell, locale: Locale, appCtl: PrefsAppCtl): void {
  let activeTab: TabId = 'general'

  function radioField(
    name: string,
    labelKey: MsgKey,
    options: readonly { value: string; key: MsgKey; preview?: string; swatch?: string }[],
    current: string,
    onChange: (value: string) => void
  ): HTMLElement {
    const row = el(
      'div',
      { class: 'tt-prefs-radio-row' },
      ...options.map((opt) => {
        const input = el('input', {
          type: 'radio',
          name,
          value: opt.value,
          checked: opt.value === current,
          onchange: () => onChange(opt.value),
        })
        const text = opt.preview
          ? el('span', { class: 'tt-prefs-radio-preview', style: `font-family:${opt.preview}` }, t(locale, opt.key))
          : t(locale, opt.key)
        const swatch = opt.swatch ? el('span', { class: 'tt-prefs-radio-swatch', style: `background:${opt.swatch}` }) : null
        return el('label', { class: 'tt-prefs-radio' }, input, swatch, text)
      })
    )
    return el('div', { class: 'tt-prefs-field' }, el('div', { class: 'tt-prefs-field-label' }, t(locale, labelKey)), row)
  }

  // --- Tab 1: Geral -----------------------------------------------------
  function renderGeneral(container: HTMLElement): void {
    container.innerHTML = ''
    const prefs = store.doc.prefs

    const themeField = radioField('tt-prefs-theme', 'prefs_theme_label', THEME_OPTIONS, prefs.theme, (value) => {
      store.update((d) => {
        d.prefs.theme = value as 'light' | 'dark' | 'system'
      })
      shell.applyPrefs(store.doc.prefs)
    })

    const paletteField = radioField('tt-prefs-palette', 'prefs_palette_label', PALETTE_OPTIONS, prefs.palette, (value) => {
      store.update((d) => {
        d.prefs.palette = value as Prefs['palette']
      })
      shell.applyPrefs(store.doc.prefs)
    })

    const localeField = radioField('tt-prefs-locale', 'prefs_locale_label', LOCALE_OPTIONS, prefs.locale, (value) => {
      const newLocale = value as Locale
      store.update((d) => {
        d.prefs.locale = newLocale
      })
      shell.applyPrefs(store.doc.prefs)
      notifyNavChanged()
      notifyLocaleChanged()
      handle.close()
      openPrefs(store, shell, newLocale, appCtl)
    })

    const fontField = radioField('tt-prefs-font', 'prefs_font_label', FONT_OPTIONS, prefs.font, (value) => {
      store.update((d) => {
        d.prefs.font = value as Prefs['font']
      })
      shell.applyPrefs(store.doc.prefs)
    })

    const sizeField = radioField('tt-prefs-size', 'prefs_size_label', SIZE_OPTIONS, prefs.fontSize, (value) => {
      store.update((d) => {
        d.prefs.fontSize = value as 'S' | 'M' | 'L'
      })
      shell.applyPrefs(store.doc.prefs)
    })

    const autoSaveInput = el('input', {
      type: 'number',
      class: 'tt-input tt-prefs-autosave-input',
      min: '1',
      max: '60',
      value: String(prefs.autoSaveMin),
      onchange: (e: Event) => {
        const raw = Number((e.target as HTMLInputElement).value)
        const clamped = Math.min(60, Math.max(1, Number.isFinite(raw) ? Math.round(raw) : prefs.autoSaveMin))
        ;(e.target as HTMLInputElement).value = String(clamped)
        store.update((d) => {
          d.prefs.autoSaveMin = clamped
        })
      },
    })
    const autoSaveField = el(
      'div',
      { class: 'tt-prefs-field' },
      el('label', { class: 'tt-prefs-field-label' }, t(locale, 'prefs_autosave_label'), autoSaveInput)
    )

    const dueSoonInput = el('input', {
      type: 'number',
      class: 'tt-input tt-prefs-due-soon-input',
      min: '1',
      max: '30',
      value: String(prefs.dueSoonDays),
      onchange: (e: Event) => {
        const raw = Number((e.target as HTMLInputElement).value)
        const clamped = Math.min(30, Math.max(1, Number.isFinite(raw) ? Math.round(raw) : prefs.dueSoonDays))
        ;(e.target as HTMLInputElement).value = String(clamped)
        store.update((d) => {
          d.prefs.dueSoonDays = clamped
        })
      },
    })
    const dueSoonField = el(
      'div',
      { class: 'tt-prefs-field' },
      el('label', { class: 'tt-prefs-field-label' }, t(locale, 'prefs_due_soon_days_label'), dueSoonInput)
    )

    container.append(themeField, paletteField, localeField, fontField, sizeField, autoSaveField, dueSoonField)
  }

  // --- Tab 2: Templates ---------------------------------------------------
  function renderTemplates(container: HTMLElement): void {
    container.innerHTML = ''

    const listEl = el('div', { class: 'tt-prefs-template-list' })

    function refreshList(): void {
      listEl.innerHTML = ''
      const templates = store.doc.templates
      if (templates.length === 0) {
        listEl.appendChild(el('div', { class: 'tt-prefs-template-empty' }, t(locale, 'prefs_templates_empty')))
      }
      templates.forEach((tpl, index) => {
        listEl.appendChild(renderRow(tpl, index, templates.length))
      })
    }

    function moveTemplate(index: number, dir: -1 | 1): void {
      const target = index + dir
      store.update((d) => {
        if (target < 0 || target >= d.templates.length) return
        const [moved] = d.templates.splice(index, 1)
        if (!moved) return
        d.templates.splice(target, 0, moved)
      })
      refreshList()
    }

    function duplicateTemplate(index: number): void {
      store.update((d) => {
        const src = d.templates[index]
        if (!src) return
        const copy: Template = { id: crypto.randomUUID(), name: src.name, scope: src.scope, body: src.body }
        d.templates.splice(index + 1, 0, copy)
      })
      refreshList()
    }

    function removeTemplate(id: string): void {
      store.update((d) => {
        d.templates = d.templates.filter((tp) => tp.id !== id)
      })
      refreshList()
    }

    function openDeleteConfirm(tpl: Template): void {
      const body = el('p', { class: 'tt-modal-message' }, t(locale, 'prefs_templates_delete_confirm', { name: tpl.name }))
      const cancelBtn: ModalButton = { label: t(locale, 'cancel'), onClick: () => inner.close() }
      const confirmBtn: ModalButton = {
        label: t(locale, 'prefs_templates_delete_btn'),
        primary: true,
        onClick: () => {
          removeTemplate(tpl.id)
          inner.close()
        },
      }
      const inner: ModalHandle = showModal({ title: t(locale, 'prefs_templates_delete_title'), body, buttons: [cancelBtn, confirmBtn] })
    }

    function openEditModal(tpl: Template | null): void {
      const nameInput = el('input', { type: 'text', class: 'tt-input', name: 'tt-prefs-template-name' })
      nameInput.value = tpl?.name ?? ''
      const scopeSelect = el('select', { class: 'tt-input' })
      for (const opt of SCOPE_OPTIONS) {
        scopeSelect.appendChild(el('option', { value: opt.value }, t(locale, opt.key)))
      }
      scopeSelect.value = tpl?.scope ?? 'any'
      const bodyTextarea = el('textarea', { class: 'tt-input tt-prefs-template-textarea', rows: '10' })
      bodyTextarea.value = tpl?.body ?? ''
      const errorEl = el('div', { class: 'tt-field-error' })

      const body = el(
        'div',
        { class: 'tt-prefs-template-form' },
        el('label', { class: 'tt-field' }, t(locale, 'prefs_templates_name_label'), nameInput),
        el('label', { class: 'tt-field' }, t(locale, 'prefs_templates_scope_label'), scopeSelect),
        el('label', { class: 'tt-field' }, t(locale, 'prefs_templates_body_label'), bodyTextarea),
        errorEl,
        el('div', { class: 'tt-prefs-template-hint' }, t(locale, 'prefs_templates_placeholders_hint'))
      )

      const cancelBtn: ModalButton = { label: t(locale, 'cancel'), onClick: () => inner.close() }
      const saveBtn: ModalButton = {
        label: t(locale, 'ok'),
        primary: true,
        onClick: () => {
          const name = nameInput.value.trim()
          if (!name) {
            errorEl.textContent = t(locale, 'prefs_templates_name_required')
            return
          }
          const scope = scopeSelect.value as Template['scope']
          const newBody = bodyTextarea.value
          if (tpl) {
            store.update((d) => {
              const found = d.templates.find((tp) => tp.id === tpl.id)
              if (!found) return
              found.name = name
              found.scope = scope
              found.body = newBody
            })
          } else {
            store.update((d) => {
              d.templates.push({ id: crypto.randomUUID(), name, scope, body: newBody })
            })
          }
          inner.close()
          refreshList()
        },
      }
      const inner: ModalHandle = showModal({
        title: t(locale, tpl ? 'prefs_templates_edit_title' : 'prefs_templates_add_title'),
        body,
        buttons: [cancelBtn, saveBtn],
      })
      nameInput.focus()
    }

    function restoreDefaults(): void {
      store.update((d) => {
        const existingNames = new Set(d.templates.map((tp) => tp.name))
        for (const tpl of builtinTemplates(d.prefs.locale)) {
          if (!existingNames.has(tpl.name)) d.templates.push(tpl)
        }
      })
      refreshList()
    }

    function renderRow(tpl: Template, index: number, count: number): HTMLElement {
      const nameEl = el('span', { class: 'tt-prefs-template-name' }, tpl.name)
      const scopeEl = el('span', { class: 'tt-prefs-template-scope-badge' }, scopeLabel(locale, tpl.scope))
      const upBtn = el(
        'button',
        {
          class: 'tt-btn tt-prefs-template-up-btn',
          type: 'button',
          title: t(locale, 'prefs_templates_up_title'),
          disabled: index === 0,
          onclick: () => moveTemplate(index, -1),
        },
        '▲'
      )
      const downBtn = el(
        'button',
        {
          class: 'tt-btn tt-prefs-template-down-btn',
          type: 'button',
          title: t(locale, 'prefs_templates_down_title'),
          disabled: index === count - 1,
          onclick: () => moveTemplate(index, 1),
        },
        '▼'
      )
      const editBtn = el(
        'button',
        {
          class: 'tt-btn tt-prefs-template-edit-btn',
          type: 'button',
          title: t(locale, 'prefs_templates_edit_btn_title'),
          onclick: () => openEditModal(tpl),
        },
        '✎'
      )
      const dupBtn = el(
        'button',
        {
          class: 'tt-btn tt-prefs-template-dup-btn',
          type: 'button',
          title: t(locale, 'prefs_templates_duplicate_title'),
          onclick: () => duplicateTemplate(index),
        },
        '⎘'
      )
      const delBtn = el(
        'button',
        {
          class: 'tt-btn tt-prefs-template-delete-btn',
          type: 'button',
          title: t(locale, 'prefs_templates_delete_btn_title'),
          onclick: () => openDeleteConfirm(tpl),
        },
        '🗑'
      )
      return el(
        'div',
        { class: 'tt-prefs-template-row' },
        nameEl,
        scopeEl,
        el('div', { class: 'tt-prefs-template-actions' }, upBtn, downBtn, editBtn, dupBtn, delBtn)
      )
    }

    const newBtn = el(
      'button',
      { class: 'tt-btn tt-prefs-templates-new-btn', type: 'button', onclick: () => openEditModal(null) },
      t(locale, 'prefs_templates_new_btn')
    )
    const restoreBtn = el(
      'button',
      { class: 'tt-btn tt-prefs-templates-restore-btn', type: 'button', onclick: () => restoreDefaults() },
      t(locale, 'prefs_templates_restore_btn')
    )
    const toolbar = el('div', { class: 'tt-prefs-template-toolbar' }, newBtn, restoreBtn)

    refreshList()
    container.append(toolbar, listEl)
  }

  // --- Tab 3: Segurança ----------------------------------------------------
  function renderSecurity(container: HTMLElement): void {
    container.innerHTML = ''
    const readOnly = appCtl.isReadOnly()

    const currentInput = el('input', { type: 'password', class: 'tt-input', name: 'tt-prefs-current-password', autocomplete: 'current-password', disabled: readOnly })
    const newInput = el('input', { type: 'password', class: 'tt-input', name: 'tt-prefs-new-password', autocomplete: 'new-password', minlength: 4, disabled: readOnly })
    const confirmInput = el('input', { type: 'password', class: 'tt-input', name: 'tt-prefs-new-password-confirm', autocomplete: 'new-password', minlength: 4, disabled: readOnly })
    const errorEl = el('div', { class: 'tt-field-error' })
    // Task 25 re-review item #2 (UX bonus): static at render time — this tab
    // is rebuilt from scratch every time it's selected (see `renderActiveTab`
    // switch above), which is enough to reflect a read-only state acquired
    // before the modal was opened without adding a live subscription here.
    if (readOnly) {
      errorEl.textContent = t(locale, 'prefs_security_readonly_hint')
    }

    function submit(): void {
      const current = currentInput.value
      const next = newInput.value
      const confirm = confirmInput.value
      if (current === '' || next === '' || confirm === '') {
        errorEl.textContent = t(locale, 'prefs_security_password_required')
        return
      }
      if (current !== appCtl.currentPassword()) {
        errorEl.textContent = t(locale, 'prefs_security_wrong_current')
        return
      }
      if (next.length < 4) {
        errorEl.textContent = t(locale, 'password_too_short')
        return
      }
      if (next !== confirm) {
        errorEl.textContent = t(locale, 'password_mismatch')
        return
      }
      errorEl.textContent = ''
      appCtl
        .changePassword(next)
        .then(() => {
          currentInput.value = ''
          newInput.value = ''
          confirmInput.value = ''
          toast(t(locale, 'prefs_security_success_toast'))
        })
        .catch(() => {
          toast(t(locale, 'prefs_security_failure_toast'), { sticky: true })
        })
    }

    const submitBtn = el(
      'button',
      { class: 'tt-btn tt-btn-primary', type: 'button', disabled: readOnly, onclick: () => submit() },
      t(locale, 'prefs_security_submit_btn')
    )

    container.append(
      el(
        'div',
        { class: 'tt-prefs-security-form' },
        el('label', { class: 'tt-field' }, t(locale, 'prefs_security_current_label'), currentInput),
        el('label', { class: 'tt-field' }, t(locale, 'prefs_security_new_label'), newInput),
        el('label', { class: 'tt-field' }, t(locale, 'prefs_security_confirm_label'), confirmInput),
        errorEl,
        submitBtn
      )
    )
  }

  // --- Tab 4: Dados (export/import) ---------------------------------------
  function renderData(container: HTMLElement): void {
    container.innerHTML = ''

    function teamCountsLine(team: ExportedTeam): string {
      return t(locale, 'data_import_summary', {
        stakeholders: String(team.stakeholders.length),
        members: String(team.members.length),
        actionItems: String(team.actionItems.length),
        milestones: String(team.milestones.length),
        risks: String(team.risks.length),
      })
    }

    // Shared row shape for both checklists below — the import row additionally
    // carries a counts-summary line the export row has no use for (its teams
    // are already fully known, not something just parsed from a file).
    function teamRow(cb: HTMLInputElement, emoji: string, name: string, summary?: string): HTMLElement {
      const nameEl = summary
        ? el(
            'span',
            { class: 'tt-data-team-info' },
            el('span', { class: 'tt-data-team-name' }, name),
            el('span', { class: 'tt-data-team-summary' }, summary)
          )
        : el('span', { class: 'tt-data-team-name' }, name)
      return el('label', { class: 'tt-data-team-row' }, cb, el('span', { class: 'tt-data-team-emoji' }, emoji), nameEl)
    }

    // --- Export ---
    const exportChecks = new Map<string, HTMLInputElement>()
    const exportListEl = el('div', { class: 'tt-data-team-list' })
    if (store.doc.teams.length === 0) {
      exportListEl.appendChild(el('div', { class: 'tt-data-empty' }, t(locale, 'data_export_empty')))
    } else {
      for (const team of store.doc.teams) {
        const cb = el('input', { type: 'checkbox' })
        exportChecks.set(team.id, cb)
        exportListEl.appendChild(teamRow(cb, team.emoji, team.name))
      }
    }

    async function doExport(): Promise<void> {
      const selected = store.doc.teams.filter((tm) => exportChecks.get(tm.id)?.checked)
      if (selected.length === 0) return
      const file = buildExport(selected)
      const bytes = new TextEncoder().encode(JSON.stringify(file, null, 2))
      const name = `team-tracker-export-${new Date().toISOString().slice(0, 10)}.json`
      if (supportsFsApi) {
        const saved = await pickSaveJson(name, bytes)
        if (!saved) return
      } else {
        downloadFallback(name, bytes)
      }
      toast(t(locale, 'data_export_success_toast'))
    }

    const exportBtn = el(
      'button',
      { class: 'tt-btn tt-btn-primary', type: 'button', disabled: store.doc.teams.length === 0, onclick: () => { doExport().catch((e: unknown) => console.error(e)) } },
      t(locale, 'data_export_btn')
    )

    const exportSection = el(
      'div',
      { class: 'tt-prefs-field' },
      el('div', { class: 'tt-prefs-field-label' }, t(locale, 'data_export_heading')),
      el('p', { class: 'tt-data-hint' }, t(locale, 'data_export_hint')),
      exportListEl,
      exportBtn
    )

    // --- Import ---
    let importTeams: ExportedTeam[] | null = null
    const importChecks: HTMLInputElement[] = []
    const importListEl = el('div', { class: 'tt-data-team-list' })
    const importActionsEl = el('div', { class: 'tt-data-import-actions' })

    function renderImportChecklist(): void {
      importListEl.innerHTML = ''
      importChecks.length = 0
      importActionsEl.innerHTML = ''
      if (!importTeams) return
      for (const team of importTeams) {
        const cb = el('input', { type: 'checkbox', checked: true })
        importChecks.push(cb)
        importListEl.appendChild(teamRow(cb, team.emoji, team.name, teamCountsLine(team)))
      }
      importActionsEl.appendChild(
        el('button', { class: 'tt-btn tt-btn-primary', type: 'button', onclick: () => doImport() }, t(locale, 'data_import_btn'))
      )
    }

    function doImport(): void {
      if (!importTeams) return
      const selected = importTeams.filter((_, i) => importChecks[i]?.checked)
      const newTeams = remapForImport(selected, locale)
      store.update((d) => {
        d.teams.push(...newTeams)
      })
      importTeams = null
      renderImportChecklist()
      notifyNavChanged()
      toast(t(locale, 'data_import_success_toast'))
    }

    const fileInput = el('input', {
      type: 'file',
      accept: '.json',
      class: 'tt-hidden-input',
      onchange: () => {
        const file = fileInput.files?.[0]
        if (!file) return
        handleFilePicked(file)
          .catch((e: unknown) => console.error(e))
          .finally(() => {
            fileInput.value = ''
          })
      },
    })

    async function handleFilePicked(file: File): Promise<void> {
      const buf = await file.arrayBuffer()
      let parsed
      try {
        parsed = parseImportFile(new Uint8Array(buf))
      } catch (e) {
        if (e instanceof InvalidExportFileError) {
          showErrorModal(locale, t(locale, 'err_export_invalid_file'))
          return
        }
        if (e instanceof ExportTooNewError) {
          showErrorModal(locale, t(locale, 'err_export_too_new'))
          return
        }
        throw e
      }
      importTeams = parsed.schemaVersion < SCHEMA_VERSION ? migrateTeams(parsed.teams, parsed.schemaVersion) : parsed.teams
      renderImportChecklist()
    }

    const pickBtn = el(
      'button',
      { class: 'tt-btn', type: 'button', onclick: () => fileInput.click() },
      t(locale, 'data_import_pick_btn')
    )

    const importSection = el(
      'div',
      { class: 'tt-prefs-field' },
      el('div', { class: 'tt-prefs-field-label' }, t(locale, 'data_import_heading')),
      el('p', { class: 'tt-data-hint' }, t(locale, 'data_import_hint')),
      pickBtn,
      fileInput,
      importListEl,
      importActionsEl
    )

    container.append(exportSection, importSection)
  }

  // --- Tab 5: Sobre ----------------------------------------------------
  function renderAbout(container: HTMLElement): void {
    container.innerHTML = ''
    const rows: readonly (readonly [string, string])[] = [
      [t(locale, 'prefs_about_version_label'), __APP_VERSION__],
      [t(locale, 'prefs_about_schema_supported_label'), String(SCHEMA_VERSION)],
      [t(locale, 'prefs_about_schema_file_label'), String(appCtl.fileSchemaVersion)],
      [t(locale, 'prefs_about_filename_label'), appCtl.fileName],
    ]
    const table = el(
      'table',
      { class: 'tt-help-table' },
      el('tbody', {}, ...rows.map(([label, value]) => el('tr', {}, el('td', {}, label), el('td', {}, value))))
    )
    const githubLink = el(
      'a',
      { class: 'tt-about-github', href: 'https://github.com/fmpallini/team-tracker', target: '_blank', rel: 'noopener' },
      t(locale, 'about_github_link')
    )
    container.append(el('h3', { class: 'tt-help-heading' }, t(locale, 'app_name')), table, githubLink)
  }

  // --- Tab strip / dispatch ----------------------------------------------
  const contentEl = el('div', { class: 'tt-prefs-content' })
  const tabButtons = new Map<TabId, HTMLButtonElement>()

  function renderActiveTab(): void {
    for (const [id, btn] of tabButtons) btn.classList.toggle('active', id === activeTab)
    switch (activeTab) {
      case 'general':
        renderGeneral(contentEl)
        return
      case 'templates':
        renderTemplates(contentEl)
        return
      case 'security':
        renderSecurity(contentEl)
        return
      case 'data':
        renderData(contentEl)
        return
      case 'about':
        renderAbout(contentEl)
        return
    }
  }

  const tabStrip = el(
    'div',
    { class: 'tt-prefs-tabs' },
    ...TABS.map(({ id, key }) => {
      const btn = el(
        'button',
        {
          class: 'tt-btn tt-prefs-tab-btn',
          type: 'button',
          onclick: () => {
            activeTab = id
            renderActiveTab()
          },
        },
        t(locale, key)
      )
      tabButtons.set(id, btn)
      return btn
    })
  )

  const dialogBody = el('div', { class: 'tt-prefs-dialog' }, tabStrip, contentEl)

  const handle: ModalHandle = showModal({
    title: t(locale, 'prefs_title'),
    body: dialogBody,
    buttons: [{ label: t(locale, 'ok'), primary: true, onClick: () => handle.close() }],
    // Prefs apply live via store.update on every interaction (theme, locale,
    // font, autosave, templates), so nothing "commits" on close — but closing
    // is also the one moment nothing else guarantees a save happens next.
    // Reuses the same nav-changed → save hook main.ts wires up for module
    // navigation (see sidebar.ts's deleteTeam for the same pattern).
    onClose: () => notifyNavChanged(),
  })

  renderActiveTab()
}
