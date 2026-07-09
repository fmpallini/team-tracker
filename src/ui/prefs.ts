// src/ui/prefs.ts — Task 24: preferences modal (general prefs, templates
// admin, change password, about). A single `showModal` whose body is a small
// tab strip + content area that this module mutates in place as the user
// switches tabs — simpler than tearing down/rebuilding the whole dialog, and
// it keeps a single overlay/Escape-handler alive for the whole session.
import type { Store } from '../core/store'
import type { Shell } from './shell'
import type { Template } from '../core/types'
import { t, type Locale, type MsgKey } from '../core/i18n'
import { el } from './dom'
import { showModal, toast, type ModalButton, type ModalHandle } from './modal'
import { builtinTemplates } from '../core/templates'
import { SCHEMA_VERSION } from '../core/document'
import { notifyNavChanged } from './sidebar'

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

export function onLocaleChanged(cb: () => void): void {
  document.addEventListener(LOCALE_CHANGED_EVENT, cb)
}

type TabId = 'general' | 'templates' | 'security' | 'about'

const TABS: readonly { id: TabId; key: MsgKey }[] = [
  { id: 'general', key: 'prefs_tab_general' },
  { id: 'templates', key: 'prefs_tab_templates' },
  { id: 'security', key: 'prefs_tab_security' },
  { id: 'about', key: 'prefs_tab_about' },
]

const THEME_OPTIONS: readonly { value: 'light' | 'dark' | 'system'; key: MsgKey }[] = [
  { value: 'light', key: 'prefs_theme_light' },
  { value: 'dark', key: 'prefs_theme_dark' },
  { value: 'system', key: 'prefs_theme_system' },
]

const LOCALE_OPTIONS: readonly { value: Locale; key: MsgKey }[] = [
  { value: 'pt-BR', key: 'prefs_locale_pt' },
  { value: 'en-US', key: 'prefs_locale_en' },
]

const FONT_OPTIONS: readonly { value: 'system' | 'serif' | 'mono'; key: MsgKey }[] = [
  { value: 'system', key: 'prefs_font_system' },
  { value: 'serif', key: 'prefs_font_serif' },
  { value: 'mono', key: 'prefs_font_mono' },
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
  let handle: ModalHandle

  function radioField(
    name: string,
    labelKey: MsgKey,
    options: readonly { value: string; key: MsgKey }[],
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
        return el('label', { class: 'tt-prefs-radio' }, input, t(locale, opt.key))
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
        d.prefs.font = value as 'system' | 'serif' | 'mono'
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

    container.append(themeField, localeField, fontField, sizeField, autoSaveField)
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
      let inner: ModalHandle
      const cancelBtn: ModalButton = { label: t(locale, 'cancel'), onClick: () => inner.close() }
      const confirmBtn: ModalButton = {
        label: t(locale, 'prefs_templates_delete_btn'),
        primary: true,
        onClick: () => {
          removeTemplate(tpl.id)
          inner.close()
        },
      }
      inner = showModal({ title: t(locale, 'prefs_templates_delete_title'), body, buttons: [cancelBtn, confirmBtn] })
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

      let inner: ModalHandle
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
      inner = showModal({
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

    const currentInput = el('input', { type: 'password', class: 'tt-input', name: 'tt-prefs-current-password', disabled: readOnly })
    const newInput = el('input', { type: 'password', class: 'tt-input', name: 'tt-prefs-new-password', disabled: readOnly })
    const confirmInput = el('input', { type: 'password', class: 'tt-input', name: 'tt-prefs-new-password-confirm', disabled: readOnly })
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

  // --- Tab 4: Sobre ----------------------------------------------------
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

  handle = showModal({
    title: t(locale, 'prefs_title'),
    body: dialogBody,
    buttons: [{ label: t(locale, 'ok'), primary: true, onClick: () => handle.close() }],
  })

  renderActiveTab()
}
