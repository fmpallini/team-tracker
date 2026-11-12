// src/ui/prefs.ts — preferences modal (general prefs, templates
// admin, change password, about). A single `showModal` whose body is a small
// tab strip + content area that this module mutates in place as the user
// switches tabs — simpler than tearing down/rebuilding the whole dialog, and
// it keeps a single overlay/Escape-handler alive for the whole session.
import type { Store } from '../core/store'
import type { Shell } from './shell'
import type { Prefs, Template } from '../core/types'
import { t, todayIso, type Locale, type MsgKey } from '../core/i18n'
import { el } from './dom'
import { createTabRail } from './tab-rail'
import { showModal, showErrorModal, toast, confirmDelete, type ModalButton, type ModalHandle } from './modal'
import { builtinTemplates, reseedBuiltinTemplates } from '../core/templates'
import { SCHEMA_VERSION, migrateTeams, findTeam as docFindTeam, teamLabel } from '../core/document'
import { buildExport, parseImportFile, remapForImport, InvalidExportFileError, ExportTooNewError, type ExportedTeam } from '../core/team-export'
import { supportsFsApi, pickSaveJson, downloadFallback } from '../core/fs'
import { countCleanupTargets, applyCleanup } from '../core/cleanup'
import { createPasswordMeter } from './password-meter'
import type { Section } from '../core/scope'
import { currentThemeAttr, prefsSection, prefsHint, prefsRadioField, prefsCheckboxField, prefsNumberField, clampInt } from './prefs-fields'
import { updateCheckEnabled, setUpdateCheckEnabled, type ManualUpdateCheck, type UpdateCheckResult } from '../core/update-check'
import { icon, iconButton } from './icons'
import { collectImageRefs, referencedBytes } from '../core/image-ref'
import { IMAGE_LIMITS } from '../core/image-import'

const MB = 1024 * 1024

/**
 * Every write in this file that only moves a preference. No module renders
 * anything from `prefs` (theme/palette/font/size land on
 * `document.documentElement`'s dataset via ui/shell.ts's `applyPrefs`;
 * `dueSoonDays` is read by core/due.ts for the sidebar; `autoSaveMin` by
 * main.ts's own scope-blind subscriber; `openRefsInSecondaryPane` by
 * ui/atref.ts at click time, not render time), so narrowing these keeps
 * ui/sidebar.ts — which watches 'prefs' — correct while sparing both panes a
 * full module teardown and rebuild.
 *
 * `locale` is deliberately NOT in this set: it changes every string every
 * module rendered, so its write stays unscoped. Neither are the three
 * content-level writes (cross-team tag copy, team import, data cleanup).
 * e2e/hotpath.spec.ts pins the theme case.
 */
const PREFS_ONLY: { sections: readonly Section[] } = { sections: ['prefs'] }

/** Template CRUD touches `doc.templates` and nothing else — no module watches 'templates' (they read templates lazily, when the '/' picker opens). */
const TEMPLATES_ONLY: { sections: readonly Section[] } = { sections: ['templates'] }

export interface PrefsAppCtl {
  changePassword(newPw: string | null): Promise<void>
  currentPassword(): string | null
  /**
   * Lets the Security tab disable its
   * submit button and show an explanatory hint when this tab has lost the
   * cross-tab write lock, instead of only surfacing the rejection after the
   * fact via the generic failure toast. `changePassword` itself still throws
   * if called while read-only — this is purely a cheaper, clearer front door
   * to that same guard.
   */
  isReadOnly(): boolean
  fileName: string
  fileSchemaVersion: number
  /** The About tab's "Check now": one per page (main.ts), so its cooldown and last result outlive this window. */
  updateCheck: ManualUpdateCheck
  /** Save, then reload into the new version; set in the PWA build only. Lets About offer the reload the banner cannot while this window is open. */
  reloadForUpdate?: () => Promise<void>
}

/**
 * Dispatched after the locale preference changes, so main.ts (which owns the
 * `PaneManager` — deliberately not passed to this module) can
 * re-render pane bars/bodies in the new locale. Sidebar highlight/labels are
 * covered by the existing `store.subscribe` wiring (any `store.update` call
 * already re-renders the sidebar, and nav-only changes are covered by
 * `store.onMutate`); per-module pane content that captured its locale string
 * at mount time is not fully re-translated until the user navigates away and
 * back — an accepted trade-off: full-fidelity re-render is deliberately
 * deferred.
 */
const LOCALE_CHANGED_EVENT = 'tt-locale-changed'

export function notifyLocaleChanged(): void {
  document.dispatchEvent(new CustomEvent(LOCALE_CHANGED_EVENT))
}

/** Returns an unsubscribe function so per-document listeners can be torn down on close-file instead of leaking across sessions. */
export function onLocaleChanged(cb: () => void): () => void {
  document.addEventListener(LOCALE_CHANGED_EVENT, cb)
  return () => {
    document.removeEventListener(LOCALE_CHANGED_EVENT, cb)
  }
}

export type TabId = 'general' | 'saving' | 'templates' | 'security' | 'data' | 'about'

const TABS: readonly { id: TabId; key: MsgKey }[] = [
  { id: 'general', key: 'prefs_tab_general' },
  { id: 'saving', key: 'prefs_tab_saving' },
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

// `palette` renders each option as a miniature of that palette, drawn from
// styles.css's [data-palette=...] blocks — the same "show, don't describe"
// idea as FONT_OPTIONS's per-option font stack below.
const PALETTE_OPTIONS: readonly { value: Prefs['palette']; key: MsgKey; palette: string }[] = [
  { value: 'ledger', key: 'prefs_palette_ledger', palette: 'ledger' },
  { value: 'signal', key: 'prefs_palette_signal', palette: 'signal' },
  { value: 'forest', key: 'prefs_palette_forest', palette: 'forest' },
  { value: 'cosmic', key: 'prefs_palette_cosmic', palette: 'cosmic' },
  { value: 'synthwave', key: 'prefs_palette_synthwave', palette: 'synthwave' },
  { value: 'verdant', key: 'prefs_palette_verdant', palette: 'verdant' },
  { value: 'ember', key: 'prefs_palette_ember', palette: 'ember' },
  { value: 'graphite', key: 'prefs_palette_graphite', palette: 'graphite' },
  { value: 'rose', key: 'prefs_palette_rose', palette: 'rose' },
  { value: 'citrus', key: 'prefs_palette_citrus', palette: 'citrus' },
  // Last, as a pair: the two built for a need rather than a mood.
  { value: 'contrast', key: 'prefs_palette_contrast', palette: 'contrast' },
  { value: 'colorsafe', key: 'prefs_palette_colorsafe', palette: 'colorsafe' },
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
  { value: 'segoe', key: 'prefs_font_segoe', preview: "'Segoe UI', Calibri, Roboto, sans-serif" },
  { value: 'legible', key: 'prefs_font_legible', preview: "Verdana, Tahoma, 'DejaVu Sans', sans-serif" },
]

// Five evenly-spaced steps, 12px → 18px (styles.css html[data-size=…] holds
// the same values). `sizePreview` renders each label at its own size — the
// same "show, don't describe" approach FONT_OPTIONS uses for font stacks.
const SIZE_OPTIONS: readonly { value: Prefs['fontSize']; key: MsgKey; sizePreview: string }[] = [
  { value: 'XS', key: 'prefs_size_xs', sizePreview: '12px' },
  { value: 'S', key: 'prefs_size_s', sizePreview: '13.5px' },
  { value: 'M', key: 'prefs_size_m', sizePreview: '15px' },
  { value: 'L', key: 'prefs_size_l', sizePreview: '16.5px' },
  { value: 'XL', key: 'prefs_size_xl', sizePreview: '18px' },
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

export function openPrefs(store: Store, shell: Shell, locale: Locale, appCtl: PrefsAppCtl, initialTab: TabId = 'general'): void {
  function radioField(
    name: string,
    labelKey: MsgKey,
    options: readonly { value: string; key: MsgKey; preview?: string; swatch?: string; palette?: string; sizePreview?: string }[],
    current: string,
    onChange: (value: string) => void,
    disabled = false
  ): HTMLElement {
    return prefsRadioField({
      name,
      label: t(locale, labelKey),
      options: options.map(({ key, ...rest }) => ({ ...rest, label: t(locale, key) })),
      current,
      onChange,
      disabled,
    })
  }

  // --- Tab 1: Geral -----------------------------------------------------
  function renderGeneral(container: HTMLElement): void {
    container.innerHTML = ''
    const prefs = store.doc.prefs

    const themeField = radioField('tt-prefs-theme', 'prefs_theme_label', THEME_OPTIONS, prefs.theme, (value) => {
      store.update((d) => {
        d.prefs.theme = value as 'light' | 'dark' | 'system'
      }, PREFS_ONLY)
      shell.applyPrefs(store.doc.prefs)
      // The palette miniatures draw in the theme the app is showing, so follow it.
      container.querySelectorAll<HTMLElement>('.tt-palette-preview').forEach((m) => { m.dataset.theme = currentThemeAttr() })
    })

    const paletteField = radioField('tt-prefs-palette', 'prefs_palette_label', PALETTE_OPTIONS, prefs.palette, (value) => {
      store.update((d) => {
        d.prefs.palette = value as Prefs['palette']
      }, PREFS_ONLY)
      shell.applyPrefs(store.doc.prefs)
    })

    const localeField = radioField('tt-prefs-locale', 'prefs_locale_label', LOCALE_OPTIONS, prefs.locale, (value) => {
      const newLocale = value as Locale
      const oldLocale = store.doc.prefs.locale
      store.update((d) => {
        d.prefs.locale = newLocale
        d.templates = reseedBuiltinTemplates(d.templates, oldLocale, newLocale)
      })
      shell.applyPrefs(store.doc.prefs)
      notifyLocaleChanged()
      handle.close()
      openPrefs(store, shell, newLocale, appCtl)
    })

    const fontField = radioField('tt-prefs-font', 'prefs_font_label', FONT_OPTIONS, prefs.font, (value) => {
      store.update((d) => {
        d.prefs.font = value as Prefs['font']
      }, PREFS_ONLY)
      shell.applyPrefs(store.doc.prefs)
    })

    const sizeField = radioField('tt-prefs-size', 'prefs_size_label', SIZE_OPTIONS, prefs.fontSize, (value) => {
      store.update((d) => {
        d.prefs.fontSize = value as Prefs['fontSize']
      }, PREFS_ONLY)
      shell.applyPrefs(store.doc.prefs)
    })

    // Both toggles are read live by their handlers — main.ts's wheel listener
    // for Ctrl+wheel, daily-notes.ts's onWheel for edge-scroll — so neither
    // needs an applyPrefs() or a re-render here; flipping the pref is enough.
    const ctrlWheelFontField = prefsCheckboxField({
      inputClass: 'tt-prefs-ctrl-wheel-font-checkbox',
      label: t(locale, 'prefs_ctrl_wheel_font_label'),
      hint: t(locale, 'prefs_ctrl_wheel_font_hint'),
      checked: prefs.ctrlWheelFontSize,
      onChange: (checked) => {
        store.update((d) => {
          d.prefs.ctrlWheelFontSize = checked
        }, PREFS_ONLY)
      },
    })

    const dailyEdgeScrollField = prefsCheckboxField({
      inputClass: 'tt-prefs-daily-edge-scroll-checkbox',
      label: t(locale, 'prefs_daily_edge_scroll_label'),
      checked: prefs.dailyEdgeScroll,
      onChange: (checked) => {
        store.update((d) => {
          d.prefs.dailyEdgeScroll = checked
        }, PREFS_ONLY)
      },
    })

    const openRefsSecondaryField = prefsCheckboxField({
      inputClass: 'tt-prefs-open-refs-secondary-checkbox',
      label: t(locale, 'prefs_open_refs_secondary_label'),
      checked: prefs.openRefsInSecondaryPane,
      onChange: (checked) => {
        store.update((d) => {
          d.prefs.openRefsInSecondaryPane = checked
        }, PREFS_ONLY)
      },
    })

    const dueSoonField = prefsNumberField({
      inputClass: 'tt-prefs-due-soon-input',
      label: t(locale, 'prefs_due_soon_days_label'),
      min: 1,
      max: 30,
      value: prefs.dueSoonDays,
      onCommit: (days) => {
        store.update((d) => {
          d.prefs.dueSoonDays = days
        }, PREFS_ONLY)
      },
    })

    // Ctrl+wheel sits directly under Text size: it is a text-size control, and
    // used to be two unrelated fields further down.
    container.append(
      prefsSection(t(locale, 'prefs_group_interface'), localeField, themeField, paletteField, fontField, sizeField, ctrlWheelFontField),
      prefsSection(t(locale, 'prefs_group_behavior'), openRefsSecondaryField, dailyEdgeScrollField, dueSoonField)
    )
  }

  // --- Tab 1b: Saving -----------------------------------------------------
  function renderSaving(container: HTMLElement): void {
    container.innerHTML = ''
    const prefs = store.doc.prefs

    // Hours in the field, minutes in the document (the snapshot controller measures in minutes): 60..1440 <-> 1..24.
    const hoursOf = (min: number): number => Math.min(24, Math.max(1, Math.round(min / 60)))
    // The window of work not yet in the file is the write interval, so the note quotes the value chosen above.
    const clearNote = prefsHint(t(locale, 'prefs_storage_clear_note', { hours: String(hoursOf(prefs.autoSaveMin)) }), 'tt-prefs-storage-note')
    const autoSaveField = prefsNumberField({
      inputClass: 'tt-prefs-autosave-input',
      label: t(locale, 'prefs_autosave_label'),
      hint: t(locale, 'prefs_autosave_hint'),
      min: 1,
      max: 24,
      value: hoursOf(prefs.autoSaveMin),
      onCommit: (hours) => {
        store.update((d) => {
          d.prefs.autoSaveMin = hours * 60
        }, PREFS_ONLY)
        clearNote.textContent = t(locale, 'prefs_storage_clear_note', { hours: String(hours) })
      },
    })

    container.append(
      prefsSection(t(locale, 'prefs_group_autosave'), autoSaveField),
      prefsSection(t(locale, 'prefs_group_storage'), prefsHint(t(locale, 'prefs_storage_rule'), 'tt-prefs-storage-rule'), clearNote)
    )
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
      }, TEMPLATES_ONLY)
      refreshList()
    }

    function duplicateTemplate(index: number): void {
      store.update((d) => {
        const src = d.templates[index]
        if (!src) return
        const copy: Template = { id: crypto.randomUUID(), name: src.name, scope: src.scope, body: src.body }
        d.templates.splice(index + 1, 0, copy)
      }, TEMPLATES_ONLY)
      refreshList()
    }

    function removeTemplate(id: string): void {
      store.update((d) => {
        d.templates = d.templates.filter((tp) => tp.id !== id)
      }, TEMPLATES_ONLY)
      refreshList()
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

      const cancelBtn: ModalButton = { label: t(locale, 'cancel'), icon: 'close', onClick: () => inner.close() }
      const saveBtn: ModalButton = {
        label: t(locale, 'save'),
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
            }, TEMPLATES_ONLY)
          } else {
            store.update((d) => {
              d.templates.push({ id: crypto.randomUUID(), name, scope, body: newBody })
            }, TEMPLATES_ONLY)
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
      }, TEMPLATES_ONLY)
      refreshList()
    }

    function renderRow(tpl: Template, index: number, count: number): HTMLElement {
      const nameEl = el('span', { class: 'tt-prefs-template-name' }, tpl.name)
      const scopeEl = el('span', { class: 'tt-prefs-template-scope-badge' }, scopeLabel(locale, tpl.scope))
      const upBtn = iconButton({
        class: 'tt-prefs-template-up-btn',
        title: t(locale, 'prefs_templates_up_title'),
        icon: 'up',
        disabled: index === 0,
        onclick: () => moveTemplate(index, -1),
      })
      const downBtn = iconButton({
        class: 'tt-prefs-template-down-btn',
        title: t(locale, 'prefs_templates_down_title'),
        icon: 'down',
        disabled: index === count - 1,
        onclick: () => moveTemplate(index, 1),
      })
      const editBtn = iconButton({
        class: 'tt-prefs-template-edit-btn',
        title: t(locale, 'prefs_templates_edit_btn_title'),
        icon: 'edit',
        onclick: () => openEditModal(tpl),
      })
      const dupBtn = iconButton({
        class: 'tt-prefs-template-dup-btn',
        title: t(locale, 'prefs_templates_duplicate_title'),
        icon: 'copy',
        onclick: () => duplicateTemplate(index),
      })
      const delBtn = el(
        'button',
        {
          class: 'tt-btn tt-prefs-template-delete-btn',
          type: 'button',
          title: t(locale, 'prefs_templates_delete_btn_title'),
          onclick: () => confirmDelete(locale, {
            title: t(locale, 'prefs_templates_delete_title'),
            message: t(locale, 'prefs_templates_delete_confirm', { name: tpl.name }),
            // Templates are the one delete in the app with no undo offer:
            // there is no containing team to capture, and a template is a
            // snippet the user typed rather than something other records
            // point at. Say so, rather than leave the missing Undo button to
            // speak for itself.
            warning: t(locale, 'prefs_templates_delete_no_undo_warning'),
            confirmLabel: t(locale, 'prefs_templates_delete_btn'),
            onConfirm: () => removeTemplate(tpl.id),
          }),
        },
        icon('trash')
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

  /**
   * The Data tab's writing buttons in a read-only tab (it lost the cross-tab
   * write lock): disabled, with the standard read-only notice as tooltip.
   * Static at render time, like the Security tab; a lock lost while the tab
   * is open is caught at click time by each action's `store.readOnly` check.
   */
  function readOnlyButtonProps(): { disabled?: boolean; title?: string } {
    return appCtl.isReadOnly() ? { disabled: true, title: t(locale, 'readonly_blocked_toast') } : {}
  }

  // --- Data tab section: Tags (cross-apply across teams) -------------------
  function buildTagsSection(): HTMLElement {
    const teams = store.doc.teams
    const title = t(locale, 'tags_cross_apply_heading')

    if (teams.length < 2) {
      return prefsSection(title, prefsHint(t(locale, 'tags_cross_apply_need_two_teams')))
    }

    const sourceSelect = el('select', { class: 'tt-input' }) as HTMLSelectElement
    for (const team of teams) {
      sourceSelect.appendChild(el('option', { value: team.id }, teamLabel(team)))
    }

    function applyClick(): void {
      const source = docFindTeam(store.doc, sourceSelect.value)
      if (!source) return
      const body = el('p', { class: 'tt-modal-message' }, t(locale, 'tags_cross_apply_confirm_body', { source: source.name }))
      const cancelBtn: ModalButton = { label: t(locale, 'cancel'), icon: 'close', onClick: () => inner.close() }
      const confirmBtn: ModalButton = {
        label: t(locale, 'tags_cross_apply_btn'),
        primary: true,
        onClick: () => {
          const sourceId = source.id
          store.update((d) => {
            const src = docFindTeam(d, sourceId)
            if (!src) return
            const tags = { ...src.actionTagNames }
            for (const tm of d.teams) {
              if (tm.id === sourceId) continue
              tm.actionTagNames = { ...tags }
            }
          })
          inner.close()
          // The lock may have gone since this tab rendered: a blocked update changed nothing.
          if (!store.readOnly) toast(t(locale, 'tags_cross_apply_success_toast'), { kind: 'success' })
        },
      }
      const inner: ModalHandle = showModal({ title: t(locale, 'tags_cross_apply_confirm_title'), body, buttons: [cancelBtn, confirmBtn] })
    }

    const applyBtn = el(
      'button',
      { class: 'tt-btn tt-btn-primary', type: 'button', ...readOnlyButtonProps(), onclick: () => applyClick() },
      t(locale, 'tags_cross_apply_btn')
    )

    return prefsSection(
      title,
      prefsHint(t(locale, 'tags_cross_apply_hint')),
      el('label', { class: 'tt-field' }, t(locale, 'tags_cross_apply_source_label'), sourceSelect),
      applyBtn
    )
  }

  // --- Tab 4: Segurança ----------------------------------------------------
  function renderSecurity(container: HTMLElement): void {
    container.innerHTML = ''
    const readOnly = appCtl.isReadOnly()
    const isPlain = appCtl.currentPassword() === null

    const newInput = el('input', { type: 'password', class: 'tt-input', name: 'tt-prefs-new-password', autocomplete: 'new-password', minlength: 4, disabled: readOnly })
    const confirmInput = el('input', { type: 'password', class: 'tt-input', name: 'tt-prefs-new-password-confirm', autocomplete: 'new-password', minlength: 4, disabled: readOnly })
    const errorEl = el('div', { class: 'tt-field-error' })
    const meter = createPasswordMeter(locale)
    newInput.addEventListener('input', () => meter.update(newInput.value))

    const currentInput = isPlain
      ? null
      : el('input', { type: 'password', class: 'tt-input', name: 'tt-prefs-current-password', autocomplete: 'current-password', disabled: readOnly })

    // Static at render time — this tab
    // is rebuilt from scratch every time it's selected (see `renderActiveTab`
    // switch above), which is enough to reflect a read-only state acquired
    // before the modal was opened without adding a live subscription here.
    if (readOnly) {
      errorEl.textContent = t(locale, 'prefs_security_readonly_hint')
    }

    function submitChangeOrSet(): void {
      const next = newInput.value
      const confirm = confirmInput.value
      if (next === '' || confirm === '') {
        errorEl.textContent = t(locale, 'prefs_security_password_required')
        return
      }
      if (!isPlain) {
        const current = currentInput!.value
        if (current === '') {
          errorEl.textContent = t(locale, 'prefs_security_password_required')
          return
        }
        if (current !== appCtl.currentPassword()) {
          errorEl.textContent = t(locale, 'prefs_security_wrong_current')
          return
        }
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
          if (currentInput) currentInput.value = ''
          newInput.value = ''
          confirmInput.value = ''
          meter.update('')
          toast(t(locale, 'prefs_security_success_toast'), { kind: 'success' })
          // `isPlain` was captured at render time; "Set password" on a plain
          // file just invalidated it. Rebuild the tab (same as the
          // migrate-to-plain path below) so a second change in this same modal
          // session goes through the current-password check instead of the
          // now-stale plain-file branch that skips it.
          renderActiveTab()
        })
        .catch(() => {
          toast(t(locale, 'prefs_security_failure_toast'), { kind: 'error', sticky: true })
        })
    }

    const submitBtn = el(
      'button',
      { class: 'tt-btn tt-btn-primary', type: 'button', disabled: readOnly, onclick: () => submitChangeOrSet() },
      t(locale, isPlain ? 'prefs_security_set_password_btn' : 'prefs_security_submit_btn')
    )

    const formChildren: (Node | string | null)[] = [
      isPlain ? el('p', { class: 'tt-data-hint' }, t(locale, 'prefs_security_plain_notice')) : null,
      currentInput ? el('label', { class: 'tt-field' }, t(locale, 'prefs_security_current_label'), currentInput) : null,
      el('label', { class: 'tt-field' }, t(locale, isPlain ? 'prefs_security_set_password_label' : 'prefs_security_new_label'), newInput),
      meter.el,
      el('label', { class: 'tt-field' }, t(locale, 'prefs_security_confirm_label'), confirmInput),
      errorEl,
      submitBtn,
    ]
    container.append(el('div', { class: 'tt-prefs-security-form' }, ...formChildren))

    if (!isPlain) {
      const migrateBtn = el(
        'button',
        {
          class: 'tt-btn',
          type: 'button',
          disabled: readOnly,
          onclick: () => openMigrateToPlainConfirm(),
        },
        t(locale, 'prefs_security_migrate_plain_btn')
      )
      container.append(migrateBtn)
    }

    function openMigrateToPlainConfirm(): void {
      const confirmInputEl = el('input', { type: 'password', class: 'tt-input', autocomplete: 'current-password' })
      const confirmErrorEl = el('div', { class: 'tt-field-error' })
      const body = el(
        'div',
        {},
        el('p', { class: 'tt-modal-message' }, t(locale, 'create_plain_hint')),
        el('label', { class: 'tt-field' }, t(locale, 'prefs_security_current_label'), confirmInputEl),
        confirmErrorEl
      )
      const cancelBtn: ModalButton = { label: t(locale, 'cancel'), icon: 'close', onClick: () => inner.close() }
      const confirmBtn: ModalButton = {
        label: t(locale, 'prefs_security_migrate_plain_btn'),
        primary: true,
        onClick: () => {
          if (confirmInputEl.value !== appCtl.currentPassword()) {
            confirmErrorEl.textContent = t(locale, 'prefs_security_wrong_current')
            return
          }
          appCtl
            .changePassword(null)
            .then(() => {
              inner.close()
              toast(t(locale, 'prefs_security_success_toast'), { kind: 'success' })
              renderActiveTab()
            })
            .catch(() => {
              toast(t(locale, 'prefs_security_failure_toast'), { kind: 'error', sticky: true })
            })
        },
      }
      const inner: ModalHandle = showModal({ title: t(locale, 'prefs_security_migrate_plain_confirm_title'), body, buttons: [cancelBtn, confirmBtn] })
    }
  }

  // --- Tab 5: Dados (export/import) ---------------------------------------
  function renderData(container: HTMLElement): void {
    container.innerHTML = ''

    function teamCountsLine(team: ExportedTeam): string {
      return t(locale, 'data_import_summary', {
        stakeholders: String(team.stakeholders.length),
        members: String(team.members.length),
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
    // Exempt from the read-only lock: exporting only reads, so its team checkboxes must toggle.
    const exportListEl = el('div', { class: 'tt-data-team-list', 'data-readonly-exempt': '' })
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
      toast(t(locale, 'data_export_success_toast'), { kind: 'success' })
    }

    const exportBtn = el(
      'button',
      { class: 'tt-btn tt-btn-primary', type: 'button', disabled: store.doc.teams.length === 0, onclick: () => { doExport().catch((e: unknown) => console.error(e)) } },
      t(locale, 'data_export_btn')
    )

    const exportSection = prefsSection(t(locale, 'data_export_heading'), prefsHint(t(locale, 'data_export_hint')), exportListEl, exportBtn)

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
      // Blocked (the lock went while this tab was open): keep the checklist, claim nothing.
      if (store.readOnly) return
      importTeams = null
      renderImportChecklist()
      toast(t(locale, 'data_import_success_toast'), { kind: 'success' })
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
      { class: 'tt-btn', type: 'button', ...readOnlyButtonProps(), onclick: () => fileInput.click() },
      t(locale, 'data_import_pick_btn')
    )

    const importSection = prefsSection(
      t(locale, 'data_import_heading'),
      prefsHint(t(locale, 'data_import_hint')),
      pickBtn,
      fileInput,
      importListEl,
      importActionsEl
    )

    // --- Cleanup (cross-team) ---
    const cleanupDaysInput = el('input', {
      type: 'number',
      class: 'tt-input tt-data-cleanup-days-input',
      min: '1',
      max: '3650',
      value: '60',
    }) as HTMLInputElement
    cleanupDaysInput.addEventListener('change', () => {
      const raw = Number(cleanupDaysInput.value)
      const clamped = clampInt(raw, 1, 3650, 1)
      cleanupDaysInput.value = String(clamped)
    })

    function doCleanup(): void {
      const days = clampInt(Number(cleanupDaysInput.value), 1, 3650, 1)
      const today = todayIso()
      const counts = countCleanupTargets(store.doc, days, today)
      if (counts.actions === 0 && counts.milestones === 0 && counts.risks === 0 && counts.dailyNotes === 0 && counts.favorites === 0 && counts.images === 0) {
        const nothingHandle: ModalHandle = showModal({
          title: t(locale, 'data_cleanup_nothing_title'),
          body: el('p', { class: 'tt-modal-message' }, t(locale, 'data_cleanup_nothing_body')),
          buttons: [{ label: t(locale, 'ok'), primary: true, onClick: () => nothingHandle.close() }],
        })
        return
      }
      confirmDelete(locale, {
        title: t(locale, 'data_cleanup_confirm_title'),
        message: t(locale, 'data_cleanup_confirm_body', {
          actions: String(counts.actions),
          milestones: String(counts.milestones),
          risks: String(counts.risks),
          dailyNotes: String(counts.dailyNotes),
          favorites: String(counts.favorites),
          images: String(counts.images),
        }),
        warning: t(locale, 'data_cleanup_no_undo_warning'),
        confirmLabel: t(locale, 'data_cleanup_btn'),
        onConfirm: () => {
          let dropped: string[] = []
          store.update((d) => { dropped = applyCleanup(d, days, today) })
          for (const id of dropped) store.images.discard(id)
          if (!store.readOnly) toast(t(locale, 'data_cleanup_success_toast'), { kind: 'success' })
        },
      })
    }

    const cleanupBtn = el(
      'button',
      { class: 'tt-btn tt-btn-danger', type: 'button', ...readOnlyButtonProps(), onclick: () => doCleanup() },
      t(locale, 'data_cleanup_btn')
    )

    const cleanupSection = prefsSection(
      t(locale, 'data_cleanup_heading'),
      prefsHint(t(locale, 'data_cleanup_hint')),
      el('label', { class: 'tt-field' }, t(locale, 'data_cleanup_days_label'), cleanupDaysInput),
      cleanupBtn
    )

    // --- Pictures: how much of the budget the notes use (read-only, so it needs no lock exemption) ---
    function buildImagesSection(): HTMLElement {
      const n = collectImageRefs(store.doc).size
      const used = referencedBytes(store.doc)
      const cls = used >= IMAGE_LIMITS.totalCapBytes ? ' tt-data-images-full' : used >= IMAGE_LIMITS.warnBytes ? ' tt-data-images-warn' : ''
      const line = t(locale, n === 1 ? 'data_images_usage_one' : 'data_images_usage_other', {
        n: String(n),
        used: (used / MB).toFixed(1),
        cap: String(IMAGE_LIMITS.totalCapBytes / MB),
      })
      return prefsSection(t(locale, 'data_images_heading'), el('p', { class: `tt-data-images-usage${cls}` }, line))
    }

    // Destructive cleanup stays last.
    container.append(exportSection, importSection, buildTagsSection(), buildImagesSection(), cleanupSection)
  }

  // --- Tab 6: Sobre ----------------------------------------------------
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
    const updateCheckField = prefsCheckboxField({
      inputClass: 'tt-prefs-update-check-checkbox',
      label: t(locale, 'prefs_update_check_label'),
      hint: t(locale, 'prefs_update_check_hint'),
      checked: updateCheckEnabled(),
      onChange: setUpdateCheckEnabled,
    })
    container.append(el('h3', { class: 'tt-help-heading' }, t(locale, 'app_name')), table, githubLink, updateCheckField, buildCheckNow())
  }

  /** Works whether or not the daily check is on: a click is the user asking. A newer version also raises the usual banner (main.ts). */
  function buildCheckNow(): HTMLElement {
    const check = appCtl.updateCheck
    const status = el('span', { class: 'tt-prefs-update-check-status', role: 'status' })
    const button = el('button', { class: 'tt-btn tt-prefs-update-check-now', type: 'button', onclick: () => void runCheck() }, t(locale, 'prefs_update_check_now'))
    const describe = (r: UpdateCheckResult | null): string =>
      r === null ? '' : r.status === 'newer' ? t(locale, 'prefs_update_check_newer', { version: r.version })
        : r.status === 'up-to-date' ? t(locale, 'prefs_update_check_latest') : t(locale, 'prefs_update_check_error')
    // The banner's "Reload now" sits behind this modal and is disabled while one is open, so a newer version offers
    // the same reload here (PWA build only: main.ts passes `reloadForUpdate` only there).
    const reload = appCtl.reloadForUpdate
    const reloadBtn = el('button', { class: 'tt-btn tt-prefs-update-check-reload', type: 'button' }, t(locale, 'update_notice_reload'))
    reloadBtn.hidden = true
    reloadBtn.addEventListener('click', () => {
      reloadBtn.disabled = true
      // Resolves without navigating only when the save failed and the caller aborted the reload.
      void reload?.().finally(() => { reloadBtn.disabled = false })
    })
    const showResult = (r: UpdateCheckResult | null): void => {
      status.textContent = describe(r)
      reloadBtn.hidden = !reload || r?.status !== 'newer'
    }
    // Off while a check runs and through the cooldown; it turns itself back on when the cooldown ends.
    const sync = (): void => {
      const wait = check.remainingMs()
      button.disabled = check.running || wait > 0
      button.title = wait > 0 ? t(locale, 'prefs_update_check_cooldown') : ''
      if (wait > 0 && !check.running) setTimeout(sync, wait)
    }
    async function runCheck(): Promise<void> {
      const pending = check.run()
      sync()
      status.textContent = t(locale, 'prefs_update_check_running')
      const result = await pending
      showResult(result ?? check.lastResult)
      sync()
    }
    showResult(check.lastResult)
    sync()
    return el('div', { class: 'tt-prefs-update-check-now-row' }, button, status, reloadBtn)
  }

  // --- Tab strip / dispatch ----------------------------------------------
  const rail = createTabRail<TabId>({
    idPrefix: 'tt-prefs',
    tabs: TABS.map(({ id, key }) => ({ id, label: t(locale, key) })),
    initial: initialTab,
    onSelect: (_id, changed) => renderActiveTab(changed),
  })
  const contentEl = rail.panel

  /**
   * Renders the rail's current tab into the shared content area. `resetScroll` is true
   * only when the user switched tabs — every other call is a rebuild of the
   * tab already on screen and
   * must leave the user where they were: emptying the container collapses the
   * scroll height, which would otherwise snap them back to the top.
   */
  function renderActiveTab(resetScroll = false): void {
    const scrollTop = contentEl.scrollTop
    switch (rail.active) {
      case 'general':
        renderGeneral(contentEl)
        break
      case 'saving':
        renderSaving(contentEl)
        break
      case 'templates':
        renderTemplates(contentEl)
        break
      case 'security':
        renderSecurity(contentEl)
        break
      case 'data':
        renderData(contentEl)
        break
      case 'about':
        renderAbout(contentEl)
        break
    }
    contentEl.scrollTop = resetScroll ? 0 : scrollTop
  }

  const dialogBody = el('div', { class: 'tt-prefs-dialog' }, rail.tabs, contentEl)

  // These prefs can also change from outside the dialog (Ctrl+wheel steps the text size), so their radios follow the store rather than only their own clicks.
  const RADIO_PREFS: readonly [string, 'fontSize' | 'theme' | 'palette' | 'font'][] = [
    ['tt-prefs-size', 'fontSize'], ['tt-prefs-theme', 'theme'], ['tt-prefs-palette', 'palette'], ['tt-prefs-font', 'font'],
  ]
  function syncRadiosToStore(): void {
    for (const [name, key] of RADIO_PREFS) {
      const current = store.doc.prefs[key]
      for (const radio of contentEl.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
        const on = radio.value === current
        if (radio.checked !== on) radio.checked = on
      }
    }
  }
  const unsubscribeRadios = store.subscribe(syncRadiosToStore)

  // Every control here applies the moment it changes, so there is nothing to confirm: one close mark in the header replaces the OK button.
  const closeBtn = el(
    'button',
    { class: 'tt-btn tt-modal-close', type: 'button', title: t(locale, 'close'), 'aria-label': t(locale, 'close'), onclick: () => handle.close() },
    icon('close', 14)
  )
  const handle: ModalHandle = showModal({
    title: t(locale, 'prefs_title'),
    body: dialogBody,
    buttons: [],
    headerExtra: closeBtn,
    onClose: unsubscribeRadios,
  })

  renderActiveTab()
  // The close mark comes first in the DOM, so the dialog's default initial focus would land on it.
  rail.focusActive()
}
