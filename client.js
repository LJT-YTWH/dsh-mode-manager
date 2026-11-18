/**
 * Client half of the mode-manager bundle.
 *
 * One left-sidebar entry addresses one root-scoped `main` panel that manages
 * agent presets (modes): it lists them, shows their YAML, creates and edits
 * custom ones through a four-step wizard, deletes them with a backup and then
 * offers to repair the sessions that referenced them. A `shell.overlay` entry
 * hosts every dialog, the toasts, and the check for a session whose mode was
 * deleted while it was open.
 *
 * Only the platform seed words `react` and `react-dom` are imported. No
 * Harness Client package is required: a plain-JS plugin cannot be type-checked
 * against those packages, and a throwing component blanks the whole slot. The
 * inlined controls use the same `--dsw-alias-*` theme tokens as the host, so
 * light/dark themes keep working. All durable writes are done by the Host half
 * over its authenticated Connection Fetch route `/api/mode-manager.rpc`.
 */

globalThis.__ModuleLoader__.load({
  id: '@local/dsh-mode-manager',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    /** The single RPC route registered by the Host half (see CONTRACT §3). */
    const ENDPOINT = '/api/mode-manager.rpc'
    /** Panel id: the sidebar entry and the `main` panel share this key. */
    const PANEL_ID = 'mode-manager'
    /** Overlay slot id. */
    const OVERLAY_ID = 'mode-manager-overlay'
    /** Translation namespace. */
    const NS = 'mode-manager'
    /** Wizard draft key required by CONTRACT §6.3. */
    const DRAFT_KEY = 'mode-manager.wizard-draft'

    const POLL_SESSION_MS = 1500
    const POLL_REPAIR_MS = 800
    const STARTUP_GRACE_MS = 2500
    const TOAST_MS = 4500
    const TOAST_ERROR_MS = 8000
    const HIGHLIGHT_MS = 4000
    const REPAIR_SECONDS_PER_ITEM = 2
    const KEEP_BACKUPS = 20

    const DEFAULT_LIMITS = {
      idPattern: '^[a-z0-9][a-z0-9-]{0,31}$',
      nameMax: 40,
      descriptionMax: 120,
      orderMin: 0,
      orderMax: 999,
      capabilities: [],
    }

    /** CONTRACT §4 catalog, used only when `state` arrived without it. */
    const FALLBACK_CATALOG = [
      {
        id: 'files',
        items: [
          { id: 'fileRead' }, { id: 'fileWrite' }, { id: 'fileEdit' },
          { id: 'fileImage' }, { id: 'filePatch' }, { id: 'fsSearch' },
        ],
      },
      { id: 'shell', items: [{ id: 'shell', danger: true }, { id: 'persistentShell', danger: true }] },
      { id: 'web', items: [{ id: 'webSearch' }, { id: 'webFetch' }] },
      {
        id: 'delegation',
        items: [
          { id: 'subagentControl' }, { id: 'subagentSpawn' }, { id: 'subagentFork' },
          { id: 'workflowPtc' }, { id: 'workflowTool' },
        ],
      },
      { id: 'plan', items: [{ id: 'plan' }] },
      { id: 'skills', items: [{ id: 'skillFilesystem' }, { id: 'skillTool' }] },
      {
        id: 'assist',
        items: [
          { id: 'todo' }, { id: 'jobs' }, { id: 'schedule' }, { id: 'commandGoal' },
          { id: 'toolGoal' }, { id: 'askUser' }, { id: 'present' }, { id: 'office' },
        ],
      },
      { id: 'context', items: [{ id: 'timeContext' }, { id: 'agentInstructions' }] },
      {
        id: 'tools',
        items: [
          { id: 'pluginManagerTools' }, { id: 'pluginMarketTools' },
          { id: 'cordisTool' }, { id: 'ptcExecutor' },
        ],
      },
    ]

    const FALLBACK_TEMPLATES = [
      {
        id: 'standard',
        capabilities: ['fileRead', 'fileWrite', 'fileEdit', 'fsSearch', 'shell', 'webSearch', 'webFetch', 'subagentControl', 'subagentSpawn', 'subagentFork', 'workflowPtc', 'workflowTool', 'plan', 'skillFilesystem', 'skillTool', 'todo', 'jobs', 'schedule', 'commandGoal', 'toolGoal', 'askUser', 'present', 'office', 'pluginManagerTools', 'pluginMarketTools', 'timeContext', 'agentInstructions'],
        persona: 'You are a coding agent powered by the {{model}} model.',
      },
      {
        id: 'minimal',
        capabilities: ['fileImage', 'persistentShell'],
        persona: 'You are a helpful software engineer assistant.',
      },
      {
        id: 'blank',
        capabilities: [],
        persona: 'You are a helpful software engineer assistant.',
      },
    ]

    const GROUP_LABELS = new Set(['files', 'shell', 'web', 'delegation', 'plan', 'skills', 'assist', 'context', 'tools'])
    const ITEM_LABELS = new Set([
      'fileRead', 'fileWrite', 'fileEdit', 'fsSearch', 'shell', 'web', 'subagent', 'plan', 'skills',
      'todo', 'jobs', 'schedule', 'goal', 'askUser', 'present', 'office', 'timeContext',
      'agentInstructions', 'pluginTools',
    ])

    /** Error codes from CONTRACT §3.3 mapped to localized copy. */
    const ERROR_KEYS = {
      validation: 'err.validation',
      'preset/not-found': 'err.presetNotFound',
      'preset/id-conflict': 'err.presetIdConflict',
      'preset/name-conflict': 'err.presetNameConflict',
      'preset/default-in-use': 'err.presetDefaultInUse',
      'preset/not-managed': 'err.presetNotManaged',
      'preset/broken-target': 'err.presetBrokenTarget',
      'preset/create-broken': 'err.presetCreateBroken',
      'plugin/install-failed': 'err.pluginInstallFailed',
      'plugin/remove-failed': 'err.pluginRemoveFailed',
      'plugin/restart-required': 'err.pluginRestartRequired',
      'repair/job-not-found': 'err.repairJobNotFound',
      'repair/no-target': 'err.repairNoTarget',
      'backup/not-found': 'err.backupNotFound',
      'internal/error': 'err.internal',
      network: 'err.network',
      'bad-response': 'err.badResponse',
    }

    const FIELD_KEYS = {
      name: 'validation.name',
      id: 'validation.id',
      description: 'validation.description',
      order: 'validation.order',
      capabilities: 'validation.capabilities',
    }

    const STATUS_KEYS = {
      repaired: 'status.repaired',
      failed: 'status.failed',
      'skipped-live': 'status.skippedLive',
      'skipped-subagent': 'status.skippedSubagent',
      'skipped-missing': 'status.skippedMissing',
    }

    const en = {
      nav: 'Mode manager',
      'page.title': 'Mode manager',
      'page.intro': 'Manage agent presets: inspect their composition, create, edit and delete them. Built-in modes can never be edited or deleted.',
      'page.refresh': 'Refresh',
      'page.refreshing': 'Refreshing…',
      'page.create': 'Create mode',
      'page.back': 'Back to conversation',
      'filter.all': 'All',
      'filter.official': 'Built-in',
      'filter.custom': 'Custom',
      'filter.broken': 'Broken',
      'search.label': 'Search modes',
      'search.placeholder': 'Search by name or id',
      'state.loading': 'Loading modes…',
      'state.error': 'The modes could not be loaded.',
      'state.empty.title': 'No modes yet',
      'state.empty.desc': 'Create your first mode, or start from one of the built-in modes.',
      'state.noMatch': 'No modes match the current filter.',
      'state.crashTitle': 'This page crashed',
      'state.crashDesc': 'The mode manager page hit an unexpected error. Other parts of the app are unaffected.',
      'action.view': 'View',
      'action.edit': 'Edit',
      'action.setDefault': 'Set default',
      'action.delete': 'Delete',
      'action.close': 'Close',
      'action.cancel': 'Cancel',
      'action.confirm': 'Confirm',
      'action.save': 'Save',
      'action.copy': 'Copy',
      'action.copied': 'Copied',
      'action.copyFailed': 'Copy failed',
      'action.retry': 'Try again',
      'action.back': 'Back',
      'action.next': 'Next',
      'action.create': 'Create',
      'action.creating': 'Creating…',
      'action.saving': 'Saving…',
      'action.refresh': 'Refresh',
      'badge.official': 'Built-in',
      'badge.installed': 'Installed',
      'badge.custom': 'Custom',
      'badge.overridden': 'Customized',
      'badge.unmanaged': 'Unmanaged',
      'badge.unknown': 'Unknown',
      'badge.broken': 'Broken',
      'badge.default': 'Default',
      'badge.imported': 'Imported',
      'builtin.standard.name': 'Standard mode',
      'builtin.standard.desc': 'Handles code, files and reference material; suitable for most tasks. The agent uses search, editing and terminal tools as needed.',
      'builtin.ptc.name': 'PTC mode',
      'builtin.ptc.desc': 'Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.',
      'builtin.minimal.name': 'Minimal mode',
      'builtin.minimal.desc': 'The agent uses the terminal and image reading tools, with context compaction, for testing and comparing its basic behavior.',
      'builtin.cordis.name': 'Creator mode',
      'builtin.cordis.desc': 'Customize DSH through conversation: have the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.',
      'card.noDescription': 'No description',
      'card.sessions': '{count} sessions',
      'card.defaultBroken': 'A broken mode cannot be the default mode.',
      'card.diagnostic': 'Diagnostic',
      'card.importedFrom': 'Imported from',
      'card.importedHint': 'Imported modes keep the source composition and cannot be edited here.',
      'card.bundle': 'Bundle',
      'card.version': 'Version',
      'card.dir': 'Directory',
      'view.title': 'View mode “{name}”',
      'view.loading': 'Loading YAML…',
      'view.error': 'The mode YAML could not be loaded.',
      'view.bundle': 'Bundle',
      'view.source': 'Source',
      'view.dir': 'Directory',
      'view.version': 'Version',
      'view.empty': 'This mode has no readable YAML content.',
      'wizard.title.create': 'Create mode',
      'wizard.title.edit': 'Edit mode “{name}”',
      'wizard.stepLabel': 'Step {current} of {total}',
      'wizard.step.template': 'Starting point',
      'wizard.step.basics': 'Basics',
      'wizard.step.capabilities': 'Capabilities',
      'wizard.step.preview': 'Preview',
      'wizard.template.standard': 'Standard',
      'wizard.template.standardDesc': 'Everyday coding: files, shell, web, delegation, planning, skills and common tools.',
      'wizard.template.minimal': 'Minimal',
      'wizard.template.minimalDesc': 'Image reading, a persistent terminal and compaction; closest to the shipped Minimal mode.',
      'wizard.template.blank': 'Blank',
      'wizard.template.blankDesc': 'Only the persona and compaction. Add exactly the capabilities you need.',
      'wizard.template.copy': 'Copy an existing mode',
      'wizard.template.copyDesc': 'Start from the capabilities and persona of any existing mode.',
      'wizard.template.import': 'Import an official mode',
      'wizard.template.importDesc': 'Copy an official mode’s exact plugin composition; the import stays read-only here.',
      'wizard.import.from': 'Official mode',
      'wizard.import.select': 'Choose an official mode',
      'wizard.import.hint': 'The new bundle copies that mode’s plugin rows verbatim. Only the name, id, description and order belong to the new mode.',
      'wizard.import.source': 'Source mode: {name}',
      'wizard.import.note': 'This mode will be created as an exact copy of the official composition. Imported modes can be viewed, copied, used and deleted here, but their composition cannot be edited.',
      'wizard.template.count': '{count} capabilities',
      'wizard.copy.from': 'Copy from',
      'wizard.copy.select': 'Choose a mode',
      'wizard.copy.hint': 'The selected mode’s capabilities and persona are copied; everything stays editable afterwards.',
      'wizard.field.name': 'Display name',
      'wizard.field.nameHint': 'Shown in the mode picker. 1–{max} characters.',
      'wizard.field.id': 'Mode id',
      'wizard.field.idHint': 'Lowercase letters, digits and dashes. The bundle name and the session’s agentPreset use it.',
      'wizard.field.idLocked': 'The id cannot be changed while editing.',
      'wizard.field.idOk': 'Available',
      'wizard.field.idEmpty': 'Enter an id.',
      'wizard.field.idInvalid': 'Use 1–32 lowercase letters, digits or dashes, starting with a letter or digit.',
      'wizard.field.idConflict': 'This id is already used by another mode.',
      'wizard.field.description': 'Description',
      'wizard.field.descriptionHint': 'Optional. Up to {max} characters.',
      'wizard.field.order': 'Order',
      'wizard.field.orderHint': 'Optional. 0–999; lower comes first. Default 10.',
      'wizard.field.persona': 'Persona',
      'wizard.field.personaHint': 'Optional system-prompt prefix.',
      'wizard.field.personaPlaceholder': 'You are a helpful software engineer assistant.',
      'wizard.field.personaCount': '{count} characters',
      'wizard.capabilities.hint': 'Pick the capabilities this mode grants. The persona and compaction are always included.',
      'wizard.capabilities.empty': 'No capabilities selected. The mode will only have a persona and compaction.',
      'wizard.capabilities.danger': 'dangerous',
      'wizard.capabilities.dangerWarn': 'A dangerous capability is selected. It can run commands or change files on this machine.',
      'wizard.edit.notice': 'Saving only affects new sessions. Open sessions keep their current setup until they are restarted.',
      'wizard.edit.sessions': 'This mode is used by {count} sessions.',
      'wizard.preview.title': 'Preview',
      'wizard.preview.package': 'Package name',
      'wizard.preview.dir': 'Install directory',
      'wizard.preview.presetId': 'Mode id',
      'wizard.preview.impact': '{count} sessions currently use this mode.',
      'wizard.preview.impactLabel': 'Current impact',
      'wizard.preview.loading': 'Generating preview…',
      'wizard.preview.error': 'The preview could not be generated.',
      'wizard.draft.restored': 'Your previous draft was restored.',
      'wizard.draft.clear': 'Discard draft',
      'wizard.created': 'Created “{name}”.',
      'wizard.saved': 'Saved “{name}”.',
      'wizard.warnings': 'The host reported {count} warning(s). Check the plugin log.',
      'validation.name': 'Enter a display name.',
      'validation.id': 'Enter a valid, unused id.',
      'validation.description': 'The description is too long.',
      'validation.order': 'Enter an order between 0 and 999.',
      'validation.capabilities': 'Choose valid capabilities.',
      'validation.general': 'Some fields are invalid.',
      'delete.title': 'Delete mode “{name}”?',
      'delete.intro': 'This cannot be undone. The mode bundle and its generated files are removed after a backup is written.',
      'delete.irreversible': 'Sessions that still use this mode may fail to open until they are repaired.',
      'delete.ack': 'I understand that old sessions may no longer open after deletion.',
      'delete.defaultBlocked': 'This is the default mode. Choose another default mode first, then delete it.',
      'delete.affected': '{count} sessions use this mode.',
      'delete.noSessions': 'No sessions use this mode.',
      'delete.groupTotal': '{count} sessions',
      'delete.loading': 'Scanning affected sessions…',
      'delete.scanError': 'Affected sessions could not be scanned.',
      'delete.deleting': 'Deleting…',
      'delete.success': 'Deleted “{name}”. Backup: {path}',
      'delete.successNoAffected': 'Deleted. No affected sessions were found.',
      'delete.noneRepairable': 'Deleted. {count} affected sessions are still running; stop them before repairing.',
      'delete.backupNote': 'A backup of the mode bundle is written before deletion.',
      'scan.archived': 'Archived',
      'scan.live': 'Running',
      'scan.subagent': 'Subagent',
      'scan.archivedCount': 'Archived {count}',
      'scan.liveCount': 'Running {count}',
      'scan.subagentCount': 'Subagent {count}',
      'repair.title': 'Repair {count} affected sessions',
      'repair.subtitle': 'Choose a target mode and the sessions to rewrite. Sessions are repaired one at a time.',
      'repair.experimental': 'Experimental',
      'repair.experimentalNote': 'Repair resumes each old session internally, rewrites its mode, then closes it again. History is kept, but older tool calls are re-rendered with the new mode.',
      'repair.target': 'Target mode',
      'repair.targetBrokenOption': '{name} (broken, unavailable)',
      'repair.targetNone': 'No usable target mode is available.',
      'repair.selectAll': 'Select all',
      'repair.selectNone': 'Select none',
      'repair.confirmAllText': 'Select all {count} repairable sessions? This takes about {seconds} seconds and rewrites each session.',
      'repair.selected': '{count} selected · about {seconds} seconds',
      'repair.noneSelected': 'Select at least one session to repair.',
      'repair.start': 'Start repair',
      'repair.starting': 'Starting…',
      'repair.later': 'Not now',
      'repair.progress': 'Repairing {done}/{total}…',
      'repair.current': 'Current: {name}',
      'repair.cancel': 'Cancel',
      'repair.cancelling': 'Cancelling…',
      'repair.cancelClose': 'Cancel and close',
      'repair.failedCount': '{failed} failed',
      'repair.cancelled': 'Cancelled. Sessions already repaired stay repaired.',
      'repair.summary': 'Repair finished',
      'repair.stat.repaired': 'Repaired',
      'repair.stat.failed': 'Failed',
      'repair.stat.skipped': 'Skipped',
      'repair.failedTitle': 'Sessions that failed',
      'repair.retry': 'Retry',
      'repair.fork': 'Fork to a new session',
      'repair.skip': 'Skip',
      'repair.export': 'Copy results',
      'repair.exportDone': 'Repair results copied.',
      'repair.exportFailed': 'The results could not be copied.',
      'repair.forked': 'Forked into a new session. Open it from the session list.',
      'repair.noRepairable': 'None of the affected sessions can be repaired right now.',
      'repair.liveHint': 'Running, cannot repair yet',
      'repair.subagentHint': 'Restored together with its parent session',
      'status.repaired': 'Repaired',
      'status.failed': 'Failed',
      'status.skippedLive': 'Skipped (running)',
      'status.skippedSubagent': 'Skipped (subagent)',
      'status.skippedMissing': 'Skipped (missing)',
      'onopen.title': 'This session’s mode was deleted',
      'onopen.desc': 'Session “{title}” used the mode “{preset}”, which was deleted. Choose a new mode to repair this session.',
      'onopen.liveOnly': 'This session is currently running, so its mode cannot be changed. Stop it, then reopen it to repair.',
      'onopen.note': 'Repair rewrites the mode recorded for this session. History is kept, but older tool calls are re-rendered with the new mode.',
      'onopen.later': 'Not now',
      'onopen.fix': 'Repair this session',
      'onopen.fixing': 'Repairing…',
      'onopen.fixed': 'Repaired. Reopen this session to continue.',
      'onopen.target': 'Target mode',
      'backups.title': 'Backups',
      'backups.empty': 'No backups yet.',
      'backups.restore': 'Restore',
      'backups.restoring': 'Restoring…',
      'backups.delete': 'Delete',
      'backups.deleteTitle': 'Delete backup “{name}”?',
      'backups.deleteDesc': 'This removes the saved copy of mode “{preset}”. The installed mode itself is not affected, but you will no longer be able to restore it from this backup.',
      'backups.deleting': 'Deleting…',
      'backups.deleted': 'Backup deleted.',
      'backups.restored': 'Restored “{preset}”. Refresh the page if it does not appear.',
      'backups.cleanup': 'Clean old backups',
      'backups.cleaning': 'Cleaning…',
      'backups.cleaned': 'Removed {removed} backup(s), kept {kept}.',
      'backups.createdAt': 'Created',
      'backups.size': 'Size',
      'backups.preset': 'Mode',
      'diag.title': 'Diagnostics',
      'diag.dshVersion': 'DSH version',
      'diag.route': 'RPC route',
      'diag.profileDir': 'Profile directory',
      'diag.dshHome': 'DSH home',
      'diag.creatorRoot': 'Generated modes',
      'diag.backupsRoot': 'Backups directory',
      'diag.hmr': 'HMR',
      'diag.pluginManager': 'Plugin manager',
      'diag.agentPresets': 'Agent presets',
      'diag.repair': 'Internal repair',
      'diag.copy': 'Copy diagnostics',
      'diag.copied': 'Diagnostics copied',
      'common.yes': 'Yes',
      'common.no': 'No',
      'common.ungrouped': 'Ungrouped',
      'toast.defaultSet': '“{name}” is now the default mode.',
      'toast.warnings': 'The host reported {count} warning(s). Check the plugin log.',
      'err.validation': 'Some fields are invalid. Check the highlighted input.',
      'err.presetNotFound': 'The mode was not found. Refresh the page.',
      'err.presetIdConflict': 'A mode with this id already exists. Choose another id.',
      'err.presetNameConflict': 'Another mode already uses this name.',
      'err.presetDefaultInUse': 'This mode is the default mode. Choose another default first.',
      'err.presetNotManaged': 'This mode was not created by the mode manager, so it cannot be changed here.',
      'err.presetBrokenTarget': 'The target mode is broken and cannot be used.',
      'err.presetCreateBroken': 'The mode was installed but reports as broken. Check the plugin log.',
      'err.pluginInstallFailed': 'The mode bundle could not be installed.',
      'err.pluginRemoveFailed': 'The mode bundle could not be removed.',
      'err.pluginRestartRequired': 'A restart is required before the change takes effect.',
      'err.repairJobNotFound': 'The repair job no longer exists.',
      'err.repairNoTarget': 'A usable target mode is required.',
      'err.backupNotFound': 'The backup was not found.',
      'err.internal': 'The host reported an internal error.',
      'err.network': 'The host could not be reached. Check that the app is running.',
      'err.badResponse': 'The host returned an unreadable response.',
      'err.http': 'The service answered HTTP {status}.',
      'err.unknown': 'Something went wrong. Try again.',
      'cap.group.files': 'Files',
      'cap.group.shell': 'Shell',
      'cap.group.web': 'Web',
      'cap.group.delegation': 'Delegation',
      'cap.group.plan': 'Plan',
      'cap.group.skills': 'Skills',
      'cap.group.assist': 'Assist',
      'cap.group.context': 'Context',
      'cap.group.tools': 'Tools',
      'cap.item.fileRead': 'Read files',
      'cap.item.fileWrite': 'Write files',
      'cap.item.fileEdit': 'Edit files',
      'cap.item.fsSearch': 'Search files',
      'cap.item.shell': 'Run commands',
      'cap.item.web': 'Web search and fetch',
      'cap.item.webSearch': 'Web search',
      'cap.item.webFetch': 'Web fetch',
      'cap.item.fileImage': 'Image reading',
      'cap.item.filePatch': 'Apply patch',
      'cap.item.persistentShell': 'Persistent terminal',
      'cap.item.subagentControl': 'Subagent control',
      'cap.item.subagentSpawn': 'Subagent delegation',
      'cap.item.subagentFork': 'Subagent fork',
      'cap.item.workflowPtc': 'PTC workflow',
      'cap.item.workflowTool': 'Workflow tool',
      'cap.item.skillFilesystem': 'Skill directories',
      'cap.item.skillTool': 'Skill loading',
      'cap.item.commandGoal': 'Goal command',
      'cap.item.toolGoal': 'Goal tools',
      'cap.item.pluginManagerTools': 'Plugin manager tools',
      'cap.item.pluginMarketTools': 'Plugin market tools',
      'cap.item.cordisTool': 'Cordis tools',
      'cap.item.ptcExecutor': 'PTC executor',
      'cap.desc.fileRead': 'Read file contents, with line-based paging and truncation.',
      'cap.desc.fileWrite': 'Create a file or replace its whole content.',
      'cap.desc.fileEdit': 'Replace an exact string in a file, requiring a unique match.',
      'cap.desc.fileImage': 'Read PNG/JPEG/WebP/GIF images for the model to look at.',
      'cap.desc.filePatch': 'Apply multiple file patches in one apply_patch call.',
      'cap.desc.fsSearch': 'Find files by name or content (glob / grep).',
      'cap.desc.shell': 'Run one-off bash or PowerShell commands, chosen by platform.',
      'cap.desc.persistentShell': 'An interactive terminal whose state survives across commands (pty + persistent bash/pwsh).',
      'cap.desc.webSearch': 'Search the web and return a summary answer with source links (web_search).',
      'cap.desc.webFetch': 'Fetch a page and read it as text or Markdown (web_fetch).',
      'cap.desc.subagentControl': 'Inspect and manage spawned subagents (interrupt defaults to off).',
      'cap.desc.subagentSpawn': 'Spawn a new subagent to work on an independent task in parallel.',
      'cap.desc.subagentFork': 'Fork the current session into a subagent that continues from it.',
      'cap.desc.workflowPtc': 'Run multi-step workflows through PTC tool calls and merge the results.',
      'cap.desc.workflowTool': 'Let the model write and run workflow scripts that orchestrate subtasks.',
      'cap.desc.plan': 'Plan mode: research and submit a plan, then implement after approval.',
      'cap.desc.skillFilesystem': 'Scan project, user and bundled skill directories for available skills.',
      'cap.desc.skillTool': 'Load the full instructions of one skill on demand.',
      'cap.desc.todo': 'Track multi-step work with a todo list (todo_write).',
      'cap.desc.jobs': 'Manage background jobs: start, read output and cancel.',
      'cap.desc.schedule': 'Create and manage scheduled reminders and tasks.',
      'cap.desc.commandGoal': 'Add the /goal command for setting a long-lived session goal.',
      'cap.desc.toolGoal': 'Read and update the session goal with a tool.',
      'cap.desc.askUser': 'Ask the user a single- or multi-choice question and wait for the answer.',
      'cap.desc.present': 'Present deliverables such as images, documents or file cards.',
      'cap.desc.office': 'Read, convert and render Word, Excel and PowerPoint documents.',
      'cap.desc.timeContext': 'Inject the current time and other runtime context into the prompt.',
      'cap.desc.agentInstructions': 'Read and inject the project AGENTS.md instructions.',
      'cap.desc.pluginManagerTools': 'List, install, enable and disable plugins; disabled when no profile context exists.',
      'cap.desc.pluginMarketTools': 'Plugin market tools; disabled by default and needs the market bundle.',
      'cap.desc.cordisTool': 'Cordis plugin authoring tools: define, run and stop plugins (Creator mode).',
      'cap.desc.ptcExecutor': 'PTC tool executor, handing tool results to programmatic code.',
      'cap.item.subagent': 'Delegate subagents',
      'cap.item.plan': 'Plan mode',
      'cap.item.skills': 'Load skills',
      'cap.item.todo': 'To-do list',
      'cap.item.jobs': 'Background jobs',
      'cap.item.schedule': 'Scheduled tasks',
      'cap.item.goal': 'Goals',
      'cap.item.askUser': 'Ask the user',
      'cap.item.present': 'Present files',
      'cap.item.office': 'Office documents',
      'cap.item.timeContext': 'Time context',
      'cap.item.agentInstructions': 'AGENTS.md instructions',
      'cap.item.pluginTools': 'Plugin tools',
    }

    const zh = {
      nav: '模式管理',
      'page.title': '模式管理',
      'page.intro': '管理 Agent 预设：查看组成、创建、编辑与删除。官方模式永远不可编辑或删除。',
      'page.refresh': '刷新',
      'page.refreshing': '正在刷新…',
      'page.create': '创建模式',
      'page.back': '返回会话',
      'filter.all': '全部',
      'filter.official': '官方',
      'filter.custom': '自建',
      'filter.broken': '已损坏',
      'search.label': '搜索模式',
      'search.placeholder': '按名称或 id 搜索',
      'state.loading': '正在加载模式…',
      'state.error': '无法加载模式列表。',
      'state.empty.title': '还没有模式',
      'state.empty.desc': '创建第一个模式，或从官方模式开始。',
      'state.noMatch': '没有符合当前筛选条件的模式。',
      'state.crashTitle': '此页面出错了',
      'state.crashDesc': '模式管理页面遇到意外错误，应用其它部分不受影响。',
      'action.view': '查看',
      'action.edit': '编辑',
      'action.setDefault': '设为默认',
      'action.delete': '删除',
      'action.close': '关闭',
      'action.cancel': '取消',
      'action.confirm': '确定',
      'action.save': '保存',
      'action.copy': '复制',
      'action.copied': '已复制',
      'action.copyFailed': '复制失败',
      'action.retry': '重试',
      'action.back': '上一步',
      'action.next': '下一步',
      'action.create': '创建',
      'action.creating': '正在创建…',
      'action.saving': '正在保存…',
      'action.refresh': '刷新',
      'badge.official': '官方',
      'badge.installed': '已安装',
      'badge.custom': '自建',
      'badge.overridden': '已自定义',
      'badge.unmanaged': '未托管',
      'badge.unknown': '未知',
      'badge.broken': '已损坏',
      'badge.default': '默认',
      'badge.imported': '导入',
      'builtin.standard.name': '标准模式',
      'builtin.standard.desc': '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
      'builtin.ptc.name': 'PTC 模式',
      'builtin.ptc.desc': '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
      'builtin.minimal.name': '极简模式',
      'builtin.minimal.desc': 'Agent 使用终端和图片读取工具，并支持上下文压缩，适合测试和对比其基础表现。',
      'builtin.cordis.name': '创造模式',
      'builtin.cordis.desc': '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',
      'card.noDescription': '暂无描述',
      'card.sessions': '{count} 个会话',
      'card.defaultBroken': '已损坏的模式不能设为默认模式。',
      'card.diagnostic': '诊断信息',
      'card.importedFrom': '导入自',
      'card.importedHint': '导入模式保留源组合，不能在本页编辑。',
      'card.bundle': '包名',
      'card.version': '版本',
      'card.dir': '目录',
      'view.title': '查看模式「{name}」',
      'view.loading': '正在加载 YAML…',
      'view.error': '无法加载模式 YAML。',
      'view.bundle': '包名',
      'view.source': '来源',
      'view.dir': '目录',
      'view.version': '版本',
      'view.empty': '此模式没有可读的 YAML 内容。',
      'wizard.title.create': '创建模式',
      'wizard.title.edit': '编辑模式「{name}」',
      'wizard.stepLabel': '第 {current} / {total} 步',
      'wizard.step.template': '起点',
      'wizard.step.basics': '基本信息',
      'wizard.step.capabilities': '能力',
      'wizard.step.preview': '预览',
      'wizard.template.standard': 'Standard 模板',
      'wizard.template.standardDesc': '日常编码：文件、命令、网络、子代理、计划、技能与常用工具。',
      'wizard.template.minimal': 'Minimal 模板',
      'wizard.template.minimalDesc': '图片读取、持久终端与上下文压缩，接近官方极简模式。',
      'wizard.template.blank': '空白',
      'wizard.template.blankDesc': '只有人设与压缩，自行勾选需要的能力。',
      'wizard.template.copy': '复制现有模式',
      'wizard.template.copyDesc': '从任意现有模式的能力与人设开始。',
      'wizard.template.import': '导入官方模式',
      'wizard.template.importDesc': '原样复制官方模式的插件组合；导入后在本页只读。',
      'wizard.import.from': '官方模式',
      'wizard.import.select': '选择一个官方模式',
      'wizard.import.hint': '新 bundle 会逐行复制该模式的插件声明；名称、id、描述与顺序属于新模式。',
      'wizard.import.source': '源模式：{name}',
      'wizard.import.note': '该模式将按官方组合原样创建。导入模式可查看、复制、使用和删除，但不能在本页编辑其组合。',
      'wizard.template.count': '{count} 项能力',
      'wizard.copy.from': '复制来源',
      'wizard.copy.select': '选择一个模式',
      'wizard.copy.hint': '会复制所选模式的能力与人设，之后仍可自由修改。',
      'wizard.field.name': '显示名',
      'wizard.field.nameHint': '显示在模式选择器中，1–{max} 个字符。',
      'wizard.field.id': '模式 id',
      'wizard.field.idHint': '小写字母、数字与短横线；用于包名与会话的 agentPreset。',
      'wizard.field.idLocked': '编辑时 id 不可修改。',
      'wizard.field.idOk': '可用',
      'wizard.field.idEmpty': '请输入 id。',
      'wizard.field.idInvalid': '使用 1–32 个小写字母、数字或短横线，且以字母或数字开头。',
      'wizard.field.idConflict': '该 id 已被其它模式使用。',
      'wizard.field.description': '描述',
      'wizard.field.descriptionHint': '可选，最多 {max} 个字符。',
      'wizard.field.order': '顺序',
      'wizard.field.orderHint': '可选，0–999，数值越小越靠前，默认 10。',
      'wizard.field.persona': '人设',
      'wizard.field.personaHint': '可选，作为系统提示词前缀。',
      'wizard.field.personaPlaceholder': 'You are a helpful software engineer assistant.',
      'wizard.field.personaCount': '{count} 个字符',
      'wizard.capabilities.hint': '勾选此模式授予的能力。人设与压缩始终包含。',
      'wizard.capabilities.empty': '未勾选任何能力，该模式只包含人设与压缩。',
      'wizard.capabilities.danger': '危险',
      'wizard.capabilities.dangerWarn': '已勾选危险能力：它可以在本机执行命令或修改文件。',
      'wizard.edit.notice': '保存只影响新会话；已打开的会话会继续使用当前组合，重启后按新定义恢复。',
      'wizard.edit.sessions': '当前有 {count} 个会话使用此模式。',
      'wizard.preview.title': '预览',
      'wizard.preview.package': '包名',
      'wizard.preview.dir': '安装目录',
      'wizard.preview.presetId': '模式 id',
      'wizard.preview.impact': '当前有 {count} 个会话使用此模式。',
      'wizard.preview.impactLabel': '当前影响',
      'wizard.preview.loading': '正在生成预览…',
      'wizard.preview.error': '无法生成预览。',
      'wizard.draft.restored': '已恢复上次未完成的草稿。',
      'wizard.draft.clear': '丢弃草稿',
      'wizard.created': '已创建「{name}」。',
      'wizard.saved': '已保存「{name}」。',
      'wizard.warnings': 'Host 返回了 {count} 条警告，请查看插件日志。',
      'validation.name': '请输入显示名。',
      'validation.id': '请输入有效且未被占用的 id。',
      'validation.description': '描述过长。',
      'validation.order': '顺序需在 0–999 之间。',
      'validation.capabilities': '能力选择无效。',
      'validation.general': '部分字段无效。',
      'delete.title': '删除模式「{name}」？',
      'delete.intro': '此操作不可撤销。系统会先备份，再移除模式 bundle 与其生成文件。',
      'delete.irreversible': '仍在使用此模式的会话可能无法打开，直到被修复。',
      'delete.ack': '我已了解删除后旧会话可能无法打开',
      'delete.defaultBlocked': '这是当前默认模式。请先切换默认模式，再删除它。',
      'delete.affected': '有 {count} 个会话使用此模式。',
      'delete.noSessions': '没有会话使用此模式。',
      'delete.groupTotal': '{count} 个会话',
      'delete.loading': '正在扫描受影响的会话…',
      'delete.scanError': '无法扫描受影响的会话。',
      'delete.deleting': '正在删除…',
      'delete.success': '已删除「{name}」。备份：{path}',
      'delete.successNoAffected': '已删除，无受影响会话。',
      'delete.noneRepairable': '已删除。仍有 {count} 个受影响会话在运行，请先停止再修复。',
      'delete.backupNote': '删除前会自动备份模式 bundle。',
      'scan.archived': '已归档',
      'scan.live': '运行中',
      'scan.subagent': '子代理',
      'scan.archivedCount': '已归档 {count}',
      'scan.liveCount': '运行中 {count}',
      'scan.subagentCount': '子代理 {count}',
      'repair.title': '修复 {count} 个受影响会话',
      'repair.subtitle': '选择目标模式与要改写的会话，修复会逐个串行执行。',
      'repair.experimental': '实验性',
      'repair.experimentalNote': '修复会在内部恢复每个旧会话、改写其模式后再关闭；历史消息保留，但旧工具调用会按新组合重新渲染。',
      'repair.target': '目标模式',
      'repair.targetBrokenOption': '{name}（已损坏，不可用）',
      'repair.targetNone': '没有可用的目标模式。',
      'repair.selectAll': '全选',
      'repair.selectNone': '全不选',
      'repair.confirmAllText': '全选 {count} 个可修复会话？预计约 {seconds} 秒，并会逐个改写会话。',
      'repair.selected': '已选 {count} 个 · 预计 {seconds} 秒',
      'repair.noneSelected': '请至少选择一个要修复的会话。',
      'repair.start': '开始修复',
      'repair.starting': '正在启动…',
      'repair.later': '暂不替换',
      'repair.progress': '修复中 {done}/{total}…',
      'repair.current': '当前：{name}',
      'repair.cancel': '取消',
      'repair.cancelling': '正在取消…',
      'repair.cancelClose': '取消并关闭',
      'repair.failedCount': '失败 {failed}',
      'repair.cancelled': '已取消，已修复的会话不会回滚。',
      'repair.summary': '修复完成',
      'repair.stat.repaired': '已修复',
      'repair.stat.failed': '失败',
      'repair.stat.skipped': '跳过',
      'repair.failedTitle': '修复失败的会话',
      'repair.retry': '重试',
      'repair.fork': 'Fork 到新会话',
      'repair.skip': '跳过',
      'repair.export': '复制结果',
      'repair.exportDone': '修复结果已复制。',
      'repair.exportFailed': '无法复制修复结果。',
      'repair.forked': '已 Fork 为新会话，请到会话列表打开。',
      'repair.noRepairable': '当前没有可修复的受影响会话。',
      'repair.liveHint': '运行中，暂不可修',
      'repair.subagentHint': '随父会话恢复',
      'status.repaired': '已修复',
      'status.failed': '失败',
      'status.skippedLive': '已跳过（运行中）',
      'status.skippedSubagent': '已跳过（子代理）',
      'status.skippedMissing': '已跳过（不存在）',
      'onopen.title': '此会话的模式已被删除',
      'onopen.desc': '会话「{title}」原本使用模式「{preset}」，该模式已被删除。选择一个新模式来修复此会话。',
      'onopen.liveOnly': '此会话正在运行，无法修改其模式。请先停止，再重新打开以修复。',
      'onopen.note': '修复会改写该会话记录的模式；历史消息保留，但旧工具调用会按新组合重新渲染。',
      'onopen.later': '暂不处理',
      'onopen.fix': '修复此会话',
      'onopen.fixing': '正在修复…',
      'onopen.fixed': '已修复，请重新打开该会话。',
      'onopen.target': '目标模式',
      'backups.title': '备份',
      'backups.empty': '暂无备份。',
      'backups.restore': '恢复',
      'backups.restoring': '正在恢复…',
      'backups.delete': '删除',
      'backups.deleteTitle': '删除备份「{name}」？',
      'backups.deleteDesc': '这会移除模式「{preset}」的这份备份副本。已安装的模式本身不受影响，但之后无法再从这份备份恢复它。',
      'backups.deleting': '正在删除…',
      'backups.deleted': '已删除备份。',
      'backups.restored': '已恢复「{preset}」。若未出现，请刷新页面。',
      'backups.cleanup': '清理旧备份',
      'backups.cleaning': '正在清理…',
      'backups.cleaned': '已移除 {removed} 份备份，保留 {kept} 份。',
      'backups.createdAt': '创建时间',
      'backups.size': '大小',
      'backups.preset': '模式',
      'diag.title': '诊断',
      'diag.dshVersion': 'DSH 版本',
      'diag.route': 'RPC 通道',
      'diag.profileDir': 'Profile 目录',
      'diag.dshHome': 'DSH 主目录',
      'diag.creatorRoot': '生成模式目录',
      'diag.backupsRoot': '备份目录',
      'diag.hmr': 'HMR',
      'diag.pluginManager': '插件管理',
      'diag.agentPresets': 'Agent 预设',
      'diag.repair': '内部修复',
      'diag.copy': '复制诊断信息',
      'diag.copied': '诊断信息已复制',
      'common.yes': '是',
      'common.no': '否',
      'common.ungrouped': '未归入项目',
      'toast.defaultSet': '「{name}」已设为默认模式。',
      'toast.warnings': 'Host 返回了 {count} 条警告，请查看插件日志。',
      'err.validation': '部分字段无效，请检查高亮的输入。',
      'err.presetNotFound': '找不到该模式，请刷新页面。',
      'err.presetIdConflict': '该 id 已被其它模式使用，请换一个。',
      'err.presetNameConflict': '已有其它模式使用此名称。',
      'err.presetDefaultInUse': '该模式是当前默认模式，请先切换默认模式。',
      'err.presetNotManaged': '该模式不是由模式管理创建的，无法在此修改。',
      'err.presetBrokenTarget': '目标模式已损坏，无法使用。',
      'err.presetCreateBroken': '模式已安装但报告为损坏，请查看插件日志。',
      'err.pluginInstallFailed': '模式 bundle 安装失败。',
      'err.pluginRemoveFailed': '模式 bundle 移除失败。',
      'err.pluginRestartRequired': '需要重启后改动才会生效。',
      'err.repairJobNotFound': '修复任务已不存在。',
      'err.repairNoTarget': '需要选择一个可用的目标模式。',
      'err.backupNotFound': '找不到该备份。',
      'err.internal': 'Host 报告内部错误。',
      'err.network': '无法连接 Host，请确认应用仍在运行。',
      'err.badResponse': 'Host 返回了无法解析的响应。',
      'err.http': '服务返回 HTTP {status}。',
      'err.unknown': '操作失败，请重试。',
      'cap.group.files': '文件',
      'cap.group.shell': '命令',
      'cap.group.web': '网络',
      'cap.group.delegation': '子代理',
      'cap.group.plan': '计划',
      'cap.group.skills': '技能',
      'cap.group.assist': '辅助',
      'cap.group.context': '上下文',
      'cap.group.tools': '工具',
      'cap.item.fileRead': '读取文件',
      'cap.item.fileWrite': '写入文件',
      'cap.item.fileEdit': '编辑文件',
      'cap.item.fsSearch': '搜索文件',
      'cap.item.shell': '执行命令',
      'cap.item.web': '网页搜索与抓取',
      'cap.item.webSearch': '网页搜索',
      'cap.item.webFetch': '网页抓取',
      'cap.item.fileImage': '图片读取',
      'cap.item.filePatch': '应用补丁',
      'cap.item.persistentShell': '持久终端',
      'cap.item.subagentControl': '子代理控制',
      'cap.item.subagentSpawn': '子代理委派',
      'cap.item.subagentFork': '子代理 Fork',
      'cap.item.workflowPtc': 'PTC 工作流',
      'cap.item.workflowTool': '工作流工具',
      'cap.item.skillFilesystem': '技能目录',
      'cap.item.skillTool': '技能加载',
      'cap.item.commandGoal': '目标命令',
      'cap.item.toolGoal': '目标工具',
      'cap.item.pluginManagerTools': '插件管理工具',
      'cap.item.pluginMarketTools': '插件市场工具',
      'cap.item.cordisTool': 'Cordis 工具',
      'cap.item.ptcExecutor': 'PTC 执行器',
      'cap.desc.fileRead': '读取文件内容，按行分页，超长时截断。',
      'cap.desc.fileWrite': '创建新文件或整体覆盖已有文件。',
      'cap.desc.fileEdit': '对文件做精确字符串替换，要求匹配唯一。',
      'cap.desc.fileImage': '读取 PNG/JPEG/WebP/GIF 图片供模型查看。',
      'cap.desc.filePatch': '用一次 apply_patch 调用提交多处文件补丁。',
      'cap.desc.fsSearch': '按文件名或文件内容搜索文件（glob / grep）。',
      'cap.desc.shell': '执行一次性的 bash 或 PowerShell 命令，按系统自动选择。',
      'cap.desc.persistentShell': '可交互、跨命令保持状态的持久终端（pty + persistent bash/pwsh）。',
      'cap.desc.webSearch': '联网搜索，返回摘要答案与来源链接（web_search）。',
      'cap.desc.webFetch': '抓取指定网页并转成文本或 Markdown 阅读（web_fetch）。',
      'cap.desc.subagentControl': '查看与管理已派生的子代理（中断能力默认关闭）。',
      'cap.desc.subagentSpawn': '派生新子代理并行处理独立任务（subagent）。',
      'cap.desc.subagentFork': '从当前会话 Fork 出子代理继续处理。',
      'cap.desc.workflowPtc': '通过 PTC 方式执行多步工作流，批量调用工具并汇总结果。',
      'cap.desc.workflowTool': '让模型编写并运行 workflow 脚本编排子任务。',
      'cap.desc.plan': '计划模式：先调研并提交计划，用户批准后再实施。',
      'cap.desc.skillFilesystem': '扫描项目、用户与内置技能目录，发现可用技能。',
      'cap.desc.skillTool': '让模型按需加载某个技能的完整说明。',
      'cap.desc.todo': '待办清单，用于跟踪多步任务的进度（todo_write）。',
      'cap.desc.jobs': '管理后台长任务：启动、查看输出、取消。',
      'cap.desc.schedule': '创建和管理定时提醒与定时任务。',
      'cap.desc.commandGoal': '提供 /goal 斜杠命令，为会话设置长期目标。',
      'cap.desc.toolGoal': '用工具读取和更新会话目标状态。',
      'cap.desc.askUser': '向用户发起单选或多选提问，并等待回答。',
      'cap.desc.present': '展示交付物，如图片、文档或文件卡片。',
      'cap.desc.office': '读写、转换与渲染 Word、Excel、PowerPoint 文档。',
      'cap.desc.timeContext': '在提示词中注入当前时间等运行时上下文。',
      'cap.desc.agentInstructions': '读取并注入项目的 AGENTS.md 说明。',
      'cap.desc.pluginManagerTools': '列出、安装、启停插件；无 profile 上下文时自动禁用。',
      'cap.desc.pluginMarketTools': '插件市场相关工具；默认禁用，需要市场 bundle 才可用。',
      'cap.desc.cordisTool': 'Cordis 插件开发工具：定义、运行、停止插件（创造模式使用）。',
      'cap.desc.ptcExecutor': 'PTC 工具执行器，把工具结果交给程序化代码处理。',
      'cap.item.subagent': '委派子代理',
      'cap.item.plan': '计划模式',
      'cap.item.skills': '加载技能',
      'cap.item.todo': '待办清单',
      'cap.item.jobs': '后台任务',
      'cap.item.schedule': '定时任务',
      'cap.item.goal': '目标',
      'cap.item.askUser': '询问用户',
      'cap.item.present': '展示文件',
      'cap.item.office': 'Office 文档',
      'cap.item.timeContext': '时间上下文',
      'cap.item.agentInstructions': 'AGENTS.md 项目指令',
      'cap.item.pluginTools': '插件管理工具',
    }

    const CSS = `
.dmm-page{min-height:100%;overflow:auto;box-sizing:border-box;padding:32px;padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;-webkit-font-smoothing:antialiased}
.dmm-inner{max-width:1180px;margin:0 auto;padding-bottom:48px}
.dmm-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:20px}
.dmm-header-text{min-width:0}
.dmm-title{margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.01em}
.dmm-intro{margin:0;max-width:760px;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.dmm-header-actions{display:flex;align-items:center;gap:8px;flex:none}
.dmm-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.dmm-tabs{display:inline-flex;align-items:center;gap:2px;padding:2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.dmm-tab{height:28px;padding:0 12px;border:none;border-radius:calc(var(--dsw-radius-md) - 2px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dmm-tab:hover{color:var(--dsw-alias-label-primary)}
.dmm-tab[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:500}
.dmm-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dmm-search{display:flex;align-items:center;min-width:200px;flex:1 1 200px;max-width:320px}
.dmm-search input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dmm-search input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.dmm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.dmm-card{display:flex;flex-direction:column;gap:10px;min-width:0;padding:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-1);transition:border-color .15s,box-shadow .15s}
.dmm-card:hover{border-color:var(--dsw-alias-border-l3)}
.dmm-card.is-highlight{border-color:var(--dsw-alias-brand-primary);animation:dmm-flash 1.2s ease-in-out 2}
@keyframes dmm-flash{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}}
.dmm-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-width:0}
.dmm-card-title{min-width:0;font-size:14px;line-height:1.4;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmm-card-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dmm-badges{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;flex:none}
.dmm-badge{display:inline-flex;align-items:center;height:20px;padding:0 7px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;white-space:nowrap}
.dmm-badge.is-default{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}
.dmm-badge.is-official{border-color:var(--dsw-alias-border-l2);background:transparent}
.dmm-badge.is-custom{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}
.dmm-badge.is-broken{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.dmm-badge.is-imported{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);background:transparent;color:var(--dsw-alias-label-secondary)}
.dmm-badge.is-live{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dmm-card-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;min-height:19px}
.dmm-card-meta{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dmm-card-broken{padding:8px 10px;border-radius:var(--dsw-radius-md);border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,var(--dsw-alias-bg-layer-1));font-size:11px;line-height:1.55;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.dmm-card-broken summary{cursor:pointer;font-weight:500}
.dmm-card-broken pre{margin:6px 0 0;max-height:140px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dmm-card-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;padding-top:2px}
.dmm-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:32px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.4;cursor:pointer;transition:background .15s,border-color .15s,opacity .15s;white-space:nowrap}
.dmm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dmm-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dmm-btn:disabled{opacity:.4;cursor:not-allowed}
.dmm-btn-sm{height:28px;padding:0 9px;font-size:12px}
.dmm-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dmm-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dmm-btn-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l3));color:var(--dsw-alias-state-error-primary)}
.dmm-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.dmm-btn-danger-solid{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
.dmm-state{padding:56px 0;text-align:center;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.dmm-state-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500}
.dmm-state-detail{margin-top:6px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.dmm-state .dmm-btn{margin-top:14px}
.dmm-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px;padding:11px 13px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,var(--dsw-alias-bg-base));font-size:12px;line-height:1.55;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.dmm-fold{margin-top:18px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.dmm-fold>summary{display:flex;align-items:center;gap:8px;padding:13px 16px;cursor:pointer;list-style:none;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);outline:none}
.dmm-fold>summary::-webkit-details-marker{display:none}
.dmm-fold>summary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px;border-radius:var(--dsw-radius-lg)}
.dmm-fold[open]>summary{border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dmm-fold-count{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.dmm-fold-body{padding:12px 16px 16px}
.dmm-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dmm-row:last-child{border-bottom:0;padding-bottom:0}
.dmm-row-main{min-width:0}
.dmm-row-title{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-all}
.dmm-row-meta{margin-top:3px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dmm-row-actions{display:flex;gap:6px;flex:none;flex-wrap:wrap}
.dmm-diag{display:grid;gap:6px}
.dmm-diag-row{display:flex;gap:12px;font-size:12px;line-height:1.6}
.dmm-diag-label{flex:none;width:150px;color:var(--dsw-alias-label-secondary)}
.dmm-diag-value{min-width:0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary)}
.dmm-overlay-root{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}
.dmm-overlay-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;backdrop-filter:var(--dsw-mask-blur)}
.dmm-overlay-mask::after{content:"";position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1)}
.dmm-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;width:min(560px,100%);max-height:100%;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary)}
.dmm-dialog:focus{outline:none}
.dmm-dialog-md{width:min(720px,100%)}
.dmm-dialog-lg{width:min(900px,100%)}
.dmm-dialog-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:20px 16px 10px 24px}
.dmm-dialog-title{margin:0;font-size:16px;line-height:1.4;font-weight:600;word-break:break-word}
.dmm-icon-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dmm-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dmm-icon-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dmm-dialog-body{display:flex;flex-direction:column;gap:14px;min-height:0;overflow-y:auto;padding:4px 24px 20px}
.dmm-dialog-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:14px 24px 20px;border-top:.5px solid var(--dsw-alias-border-l1)}
.dmm-footer-note{margin-right:auto;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dmm-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dmm-field-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dmm-field-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dmm-field-hint.is-ok{color:var(--dsw-alias-state-success-primary)}
.dmm-field-hint.is-bad{color:var(--dsw-alias-state-error-primary)}
.dmm-field-error{font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.dmm-field-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.dmm-input,.dmm-select,.dmm-textarea{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dmm-input,.dmm-select{height:34px;padding:0 10px}
.dmm-textarea{min-height:120px;padding:8px 10px;resize:vertical;line-height:1.6}
.dmm-input:focus,.dmm-select:focus,.dmm-textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.dmm-input:disabled,.dmm-select:disabled{opacity:.55;cursor:not-allowed}
.dmm-input.is-invalid{border-color:var(--dsw-alias-state-error-primary)}
.dmm-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary);cursor:pointer}
.dmm-check input{flex:none;width:15px;height:15px;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dmm-check.is-disabled{color:var(--dsw-alias-label-secondary);cursor:not-allowed}
.dmm-check.is-disabled input{cursor:not-allowed}
.dmm-check.is-danger{color:var(--dsw-alias-state-error-primary)}
.dmm-check.is-danger input{accent-color:var(--dsw-alias-state-error-primary)}
.dmm-steps{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dmm-step{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2)}
.dmm-step.is-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.dmm-step.is-done{color:var(--dsw-alias-label-primary)}
.dmm-template-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.dmm-template{display:flex;flex-direction:column;gap:5px;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);text-align:left;font:inherit;color:inherit;cursor:pointer}
.dmm-template:hover{border-color:var(--dsw-alias-border-l3)}
.dmm-template:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.dmm-template[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-1))}
.dmm-template-title{font-size:13px;font-weight:600}
.dmm-template-desc{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dmm-template-count{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dmm-cap-groups{display:flex;flex-direction:column;gap:10px}
.dmm-cap-group{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:10px 12px}
.dmm-cap-group-head{font-size:12px;font-weight:600;margin-bottom:6px}
.dmm-cap-items{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:6px 18px}
.dmm-cap-item-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.dmm-cap-item-label{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.dmm-cap-item-desc{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);font-weight:400}
.dmm-cap-danger{color:var(--dsw-alias-state-error-primary)}
.dmm-warn{display:flex;gap:7px;padding:9px 11px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);font-size:12px;line-height:1.55;color:var(--dsw-alias-state-warn-primary);word-break:break-word}
.dmm-error{display:flex;gap:7px;padding:9px 11px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent);font-size:12px;line-height:1.55;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.dmm-notice{padding:9px 11px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dmm-note{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dmm-preview{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:14px;align-items:start}
.dmm-yaml{margin:0;max-height:320px;overflow:auto;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dmm-summary{display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:1.6}
.dmm-summary-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dmm-summary-value{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-primary)}
.dmm-scan-group-list{display:flex;flex-direction:column;gap:8px}
.dmm-delete-group{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:8px 11px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.5}
.dmm-scan-group{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dmm-scan-head{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--dsw-alias-bg-layer-2)}
.dmm-scan-head-main{min-width:0;flex:1}
.dmm-scan-title{font-size:12px;font-weight:500;line-height:1.4;word-break:break-word}
.dmm-scan-path{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dmm-scan-sessions{padding:4px 12px}
.dmm-scan-row{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dmm-scan-row:last-child{border-bottom:0}
.dmm-scan-row-main{min-width:0;flex:1}
.dmm-scan-row-title{font-size:12px;line-height:1.5;word-break:break-word}
.dmm-scan-row-id{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dmm-scan-hint{color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:1.5}
.dmm-scan-tags{display:flex;gap:4px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.dmm-progress{display:flex;flex-direction:column;gap:6px}
.dmm-progress-track{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:.5px solid var(--dsw-alias-border-l1)}
.dmm-progress-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .2s}
.dmm-progress-meta{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dmm-current{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dmm-result-list{display:flex;flex-direction:column;gap:8px}
.dmm-result{border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-md);padding:9px 11px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,transparent)}
.dmm-result-head{display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:500;word-break:break-word}
.dmm-result-error{margin-top:4px;font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.dmm-result-actions{display:flex;gap:6px;margin-top:7px;flex-wrap:wrap}
.dmm-stats{display:flex;gap:10px;flex-wrap:wrap}
.dmm-stat{display:flex;flex-direction:column;gap:2px;min-width:86px;padding:9px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.dmm-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dmm-stat-value{font-size:18px;line-height:1.2;font-weight:600;font-variant-numeric:tabular-nums}
.dmm-stat.is-ok .dmm-stat-value{color:var(--dsw-alias-state-success-primary)}
.dmm-stat.is-bad .dmm-stat-value{color:var(--dsw-alias-state-error-primary)}
.dmm-toasts{position:fixed;top:40px;left:50%;z-index:1100;display:flex;flex-direction:column;align-items:center;gap:8px;max-width:min(640px,calc(100vw - 48px));transform:translateX(-50%);pointer-events:none}
.dmm-toast{display:flex;align-items:center;gap:9px;width:max-content;max-width:100%;padding:11px 15px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);font-size:13px;line-height:1.5;box-shadow:var(--dsw-shadow-lv3);pointer-events:auto}
.dmm-toast-icon{flex:none;display:grid;place-items:center;color:var(--dsw-alias-state-success-primary)}
.dmm-toast.is-error .dmm-toast-icon{color:var(--dsw-alias-state-error-primary)}
.dmm-toast-text{min-width:0;word-break:break-word}
@media (max-width:760px){
.dmm-page{padding:18px;padding-top:calc(18px + var(--dsh-frame-top-clearance,0px))}
.dmm-header{flex-direction:column;gap:14px}
.dmm-header-actions{width:100%}
.dmm-header-actions .dmm-btn{flex:1 1 auto}
.dmm-preview{grid-template-columns:1fr}
.dmm-field-row{grid-template-columns:1fr}
.dmm-dialog-body{padding-left:16px;padding-right:16px}
.dmm-dialog-header,.dmm-dialog-footer{padding-left:16px;padding-right:16px}
.dmm-diag-row{flex-direction:column;gap:0}
.dmm-diag-label{width:auto}
.dmm-row{flex-direction:column;align-items:stretch}
.dmm-row-actions{justify-content:flex-end}
.dmm-delete-group{flex-direction:column;align-items:flex-start;gap:2px}
}
`

    /** Inject the stylesheet once per document, tagged so HMR can replace it. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      const tagId = 'mode-manager/client.css'
      const selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']'
      if (document.querySelector(selector) !== null) return
      const tag = document.createElement('style')
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.append(tag)
    }

    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return '—'
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function formatTime(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return '—'
      try {
        return new Date(number).toLocaleString()
      } catch {
        return '—'
      }
    }

    /**
     * Candidate preset id for a display name. Latin names become a dash slug;
     * a name with no Latin letters gets the same deterministic `mode-<hash>`
     * fallback the Host uses, so the wizard's auto-generated id is valid for
     * Chinese and other non-Latin names too.
     */
    function slugify(value) {
      const ascii = String(value ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24)
      if (ascii.length > 0) return ascii
      const compact = String(value ?? '').replace(/\s+/g, '')
      let hash = 0
      for (const char of compact) hash = (hash * 31 + char.codePointAt(0)) >>> 0
      return 'mode-' + hash.toString(36).slice(0, 6)
    }

    const BUILTIN_PRESET_IDS = new Set(['standard', 'ptc', 'minimal', 'cordis'])

    /** Retired aggregate capability ids and the granular ids they represent. */
    const LEGACY_CAPABILITY_EXPANSIONS = {
      web: ['webSearch', 'webFetch'],
      subagent: ['subagentControl', 'subagentSpawn', 'subagentFork', 'workflowPtc', 'workflowTool'],
      skills: ['skillFilesystem', 'skillTool'],
      goal: ['commandGoal', 'toolGoal'],
      pluginTools: ['pluginManagerTools', 'pluginMarketTools'],
    }

    /** Whether a shipped preset gets its localized display metadata from this bundle. */
    function hasBuiltinMeta(preset) {
      return preset !== null && preset !== undefined
        && isOfficialKind(preset.kind)
        && BUILTIN_PRESET_IDS.has(String(preset.id ?? ''))
    }

    /**
     * Display name with three sources: the declaration's own name, the shipped
     * preset's localized metadata (the same labels the Settings picker shows),
     * then the bare id.
     */
    function presetDisplayName(t, preset) {
      const name = preset === null || preset === undefined ? '' : String(preset.name ?? '').trim()
      if (name !== '') return name
      if (hasBuiltinMeta(preset)) return t('builtin.' + String(preset.id) + '.name')
      return String(preset?.id ?? '')
    }

    /** Description with the same fallback chain; '' means the card shows its placeholder. */
    function presetDisplayDescription(t, preset) {
      const description = preset === null || preset === undefined ? '' : String(preset.description ?? '').trim()
      if (description !== '') return description
      if (hasBuiltinMeta(preset)) return t('builtin.' + String(preset.id) + '.desc')
      return ''
    }

    /** Dropdown label: localized name for shipped presets, otherwise name (id). */
    function presetDisplayLabel(t, preset) {
      const name = presetDisplayName(t, preset)
      const id = String(preset?.id ?? '')
      if (hasBuiltinMeta(preset) || name === id || id === '') return name
      return name + ' (' + id + ')'
    }

    function isOfficialKind(kind) {
      return kind === 'official' || kind === 'overridden-official'
    }

    function kindBadgeKey(kind) {
      switch (kind) {
        case 'official': return 'badge.official'
        case 'overridden-official': return 'badge.overridden'
        case 'custom': return 'badge.custom'
        case 'installation': return 'badge.installed'
        case 'unmanaged': return 'badge.unmanaged'
        default: return 'badge.unknown'
      }
    }

    function kindBadgeClass(kind) {
      if (isOfficialKind(kind)) return 'dmm-badge is-official'
      if (kind === 'custom') return 'dmm-badge is-custom'
      return 'dmm-badge'
    }

    /** Localized capability label with a graceful fallback for unknown ids. */
    function capGroupLabel(t, id) {
      return GROUP_LABELS.has(id) ? t('cap.group.' + id) : String(id)
    }

    function capItemLabel(t, id) {
      return ITEM_LABELS.has(id) ? t('cap.item.' + id) : String(id)
    }

    function capabilityUniverse(limits, groups) {
      const universe = new Set()
      const limitIds = Array.isArray(limits?.capabilities) ? limits.capabilities : []
      for (const id of limitIds) if (typeof id === 'string') universe.add(id)
      for (const group of Array.isArray(groups) ? groups : []) {
        const items = Array.isArray(group?.items) ? group.items : []
        for (const item of items) if (typeof item?.id === 'string') universe.add(item.id)
      }
      return universe
    }

    function normalizeCapabilities(list, universe) {
      const out = []
      for (const id of Array.isArray(list) ? list : []) {
        if (typeof id !== 'string') continue
        // Retired aggregate ids expand into the granular capabilities so older
        // presets and drafts open with every tool they actually had checked.
        const expanded = LEGACY_CAPABILITY_EXPANSIONS[id] ?? [id]
        for (const capability of expanded) {
          if (!universe.has(capability) || out.includes(capability)) continue
          out.push(capability)
        }
      }
      return out
    }

    function idPatternOf(limits) {
      const source = limits && typeof limits.idPattern === 'string' ? limits.idPattern : DEFAULT_LIMITS.idPattern
      try {
        return new RegExp(source)
      } catch {
        return new RegExp(DEFAULT_LIMITS.idPattern)
      }
    }

    function sortPresets(list) {
      return [...list].sort((left, right) => {
        const leftOrder = typeof left?.order === 'number' ? left.order : Number.POSITIVE_INFINITY
        const rightOrder = typeof right?.order === 'number' ? right.order : Number.POSITIVE_INFINITY
        if (leftOrder !== rightOrder) return leftOrder - rightOrder
        return String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
      })
    }

    function matchesTab(preset, tab) {
      if (tab === 'official') return isOfficialKind(preset?.kind)
      if (tab === 'custom') return !isOfficialKind(preset?.kind)
      if (tab === 'broken') return Boolean(preset?.broken)
      return true
    }

    function targetCandidates(presets, excludedId) {
      return (Array.isArray(presets) ? presets : []).filter((preset) =>
        preset !== null && preset !== undefined && typeof preset.id === 'string' && preset.id !== excludedId)
    }

    function pickDefaultTarget(presets, excludedId) {
      const candidates = targetCandidates(presets, excludedId).filter((preset) => !preset.broken)
      const standard = candidates.find((preset) => preset.id === 'standard')
      return standard ? 'standard' : (candidates.length > 0 ? candidates[0].id : '')
    }

    function sessionLabel(session) {
      const title = session === null || session === undefined ? '' : String(session.title ?? '').trim()
      return title === '' ? String(session?.sessionId ?? '') : title
    }

    function groupTitle(t, group) {
      if (group === null || group === undefined) return t('common.ungrouped')
      if (group.workspaceId === null || group.workspaceId === undefined) return t('common.ungrouped')
      const title = String(group.workspaceTitle ?? '').trim()
      return title === '' ? String(group.workspaceId) : title
    }

    function scanCountsText(t, sessions) {
      const list = Array.isArray(sessions) ? sessions : []
      const archived = list.filter((session) => session?.archived === true).length
      const live = list.filter((session) => session?.live === true).length
      const subagent = list.filter((session) => session?.subagent === true).length
      const parts = [t('delete.groupTotal', { count: list.length })]
      if (archived > 0) parts.push(t('scan.archivedCount', { count: archived }))
      if (live > 0) parts.push(t('scan.liveCount', { count: live }))
      if (subagent > 0) parts.push(t('scan.subagentCount', { count: subagent }))
      return parts.join(' · ')
    }

    function statusLabel(t, status) {
      const key = STATUS_KEYS[status]
      return key === undefined ? String(status ?? '') : t(key)
    }

    function yesNo(t, value) {
      return value === true ? t('common.yes') : t('common.no')
    }

    function diagnosticsRows(t, diagnostics) {
      const source = diagnostics ?? {}
      return [
        [t('diag.dshVersion'), source.dshVersion],
        [t('diag.route'), source.route],
        [t('diag.profileDir'), source.profileDir],
        [t('diag.dshHome'), source.dshHome],
        [t('diag.creatorRoot'), source.creatorRoot],
        [t('diag.backupsRoot'), source.backupsRoot],
        [t('diag.hmr'), yesNo(t, source.hmr)],
        [t('diag.pluginManager'), yesNo(t, source.pluginManagerAvailable)],
        [t('diag.agentPresets'), yesNo(t, source.agentPresetsAvailable)],
        [t('diag.repair'), yesNo(t, source.repairAvailable)],
      ]
    }

    function diagnosticsText(t, diagnostics) {
      return diagnosticsRows(t, diagnostics)
        .map((row) => row[0] + ': ' + (row[1] === undefined || row[1] === null || row[1] === '' ? '—' : String(row[1])))
        .join('\n')
    }

    // ---------------------------------------------------------------------
    // RPC and errors
    // ---------------------------------------------------------------------

    function rpcError(code, message, field, details) {
      const error = new Error(message === undefined || message === '' ? code : message)
      error.code = code
      if (field !== undefined) error.field = field
      if (details !== undefined) error.details = details
      return error
    }

    /**
     * POST one action to the Host route. Throws an Error carrying
     * `code`/`message`/`field`/`details` for every failure shape (CONTRACT §3).
     */
    async function rpc(action, payload) {
      const body = payload === undefined || payload === null ? { action } : { action, ...payload }
      let response
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
          cache: 'no-store',
        })
      } catch {
        throw rpcError('network', '')
      }
      let text
      try {
        text = await response.text()
      } catch {
        throw rpcError('bad-response', '')
      }
      let parsed = null
      if (text !== '') {
        try {
          parsed = JSON.parse(text)
        } catch {
          throw rpcError('bad-response', '')
        }
      }
      if (response.ok && parsed !== null && parsed.ok === true) return parsed.data
      const failure = parsed !== null && typeof parsed === 'object' && typeof parsed.error === 'object' && parsed.error !== null
        ? parsed.error
        : null
      const code = failure !== null && typeof failure.code === 'string'
        ? failure.code
        : (response.ok ? 'bad-response' : 'http/' + response.status)
      const message = failure !== null && typeof failure.message === 'string' ? failure.message : ''
      throw rpcError(code, message, failure?.field, failure?.details)
    }

    /** Localized text for one thrown RPC failure. */
    function describeError(t, error) {
      if (error === null || error === undefined) return t('err.unknown')
      const code = typeof error.code === 'string' ? error.code : ''
      const key = ERROR_KEYS[code]
      if (key !== undefined) return t(key)
      if (code.startsWith('http/')) return t('err.http', { status: code.slice(5) })
      if (typeof error.message === 'string' && error.message !== '') return error.message
      return t('err.unknown')
    }

    /** The inline validation message for one `validation` failure. */
    function fieldErrorMessage(t, error) {
      if (error === null || error === undefined) return ''
      const field = typeof error.field === 'string' ? error.field : ''
      const key = FIELD_KEYS[field]
      if (key !== undefined) return t(key)
      return t('err.validation')
    }

    async function writeClipboard(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // fall through to the legacy path
      }
      try {
        if (typeof document === 'undefined') return false
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        document.body.append(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok === true
      } catch {
        return false
      }
    }

    /**
     * The session currently open in the main panel, read exactly as the
     * verified `dsh-session-delete-cascade` client does (CONTRACT §0).
     */
    function readOpenSessionId(ctx) {
      let workspace
      try {
        workspace = ctx.get('uiWorkspace')
      } catch {
        return undefined
      }
      if (workspace === undefined || workspace === null) return undefined
      const main = workspace.mainReference?.sessionId
      if (typeof main === 'string' && main !== '') return main
      try {
        const selection = workspace.selection?.getSnapshot?.()?.sessionId
        return typeof selection === 'string' && selection !== '' ? selection : undefined
      } catch {
        return undefined
      }
    }

    // ---------------------------------------------------------------------
    // Tiny observable store shared by the page and the overlay host
    // ---------------------------------------------------------------------

    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot() {
          return snapshot
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        update(next) {
          snapshot = typeof next === 'function' ? next(snapshot) : { ...snapshot, ...next }
          for (const listener of [...listeners]) listener()
        },
      }
    }

    function useAppStore(store) {
      const [snapshot, setSnapshot] = useState(() => store.getSnapshot())
      useEffect(() => {
        const sync = () => setSnapshot(store.getSnapshot())
        sync()
        return store.subscribe(sync)
      }, [store])
      return snapshot
    }

    // ---------------------------------------------------------------------
    // Icons (currentColor only, so themes keep working)
    // ---------------------------------------------------------------------

    function PanelIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' && props.size > 0 ? props.size : 18
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { display: 'block' },
      },
      // Three stacked composition layers: a mode is a preset composition.
      h('path', { d: 'M12 2.8 21.2 7.4 12 12 2.8 7.4Z' }),
      h('path', { d: 'M2.8 12.1 12 16.7 21.2 12.1' }),
      h('path', { d: 'M2.8 16.8 12 21.4 21.2 16.8' }))
    }

    function CloseIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
      }, h('path', { d: 'M6 6l12 12' }), h('path', { d: 'M18 6L6 18' }))
    }

    function CheckIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M8.5 12.5l2.5 2.5 4.5-5' }))
    }

    function AlertIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, h('path', { d: 'M12 3.5 2.8 20h18.4L12 3.5Z' }), h('path', { d: 'M12 9.5v4.5' }), h('path', { d: 'M12 17.2h.01' }))
    }

    // ---------------------------------------------------------------------
    // Primitives
    // ---------------------------------------------------------------------

    function Btn(props) {
      const { children, variant, className, ...rest } = props
      let cls = 'dmm-btn'
      if (variant !== undefined && variant !== '') cls += ' dmm-btn-' + variant
      if (className !== undefined && className !== '') cls += ' ' + className
      return h('button', { type: 'button', className: cls, ...rest }, children)
    }

    function IconBtn(props) {
      return h('button', {
        type: 'button',
        className: 'dmm-icon-btn',
        'aria-label': props.label,
        onClick: props.onClick,
      }, props.children)
    }

    /**
     * The inlined modal: portal, mask click-to-close, Escape, focus entry and
     * return, and Tab containment — the behaviors a dialog user relies on.
     */
    function Modal(props) {
      const dialog = useRef(null)
      const restoreTo = useRef(null)
      const closeRef = useRef(props.onClose)
      closeRef.current = props.onClose

      useEffect(() => {
        const element = dialog.current
        if (element === null) return undefined
        restoreTo.current = document.activeElement
        const focusable = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'
        const initial = element.querySelector('[data-dmm-autofocus]') ?? element
        if (initial !== null && typeof initial.focus === 'function') initial.focus({ preventScroll: true })
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeRef.current()
            return
          }
          if (event.key !== 'Tab') return
          const items = [...element.querySelectorAll(focusable)]
          if (items.length === 0) return
          const first = items[0]
          const last = items[items.length - 1]
          const active = document.activeElement
          if (event.shiftKey && (active === first || active === element)) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && active === last) {
            event.preventDefault()
            first.focus()
          }
        }
        element.addEventListener('keydown', onKeyDown)
        return () => {
          element.removeEventListener('keydown', onKeyDown)
          const previous = restoreTo.current
          if (previous !== null && previous !== undefined && typeof previous.focus === 'function') {
            previous.focus({ preventScroll: true })
          }
        }
      }, [])

      if (typeof document === 'undefined') return null
      const size = props.size === 'lg' || props.size === 'md' ? ' dmm-dialog-' + props.size : ''
      return createPortal(
        h('div', { className: 'dmm-overlay-root', role: 'presentation' },
          h('div', { className: 'dmm-overlay-mask', 'aria-hidden': 'true', onClick: props.onClose }),
          h('div', {
            ref: dialog,
            tabIndex: -1,
            className: 'dmm-dialog' + size,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': props.title,
          },
          h('div', { className: 'dmm-dialog-header' },
            h('h2', { className: 'dmm-dialog-title' }, props.title),
            h(IconBtn, { label: props.closeLabel, onClick: props.onClose }, h(CloseIcon))),
          h('div', { className: 'dmm-dialog-body' }, props.children),
          props.footer === undefined ? null : h('div', { className: 'dmm-dialog-footer' }, props.footer))),
        document.body)
    }

    function ToastItem({ toast, store }) {
      useEffect(() => {
        const timer = setTimeout(() => store.dismissToast(toast.id), toast.kind === 'error' ? TOAST_ERROR_MS : TOAST_MS)
        return () => clearTimeout(timer)
      }, [toast.id, toast.kind, store])
      return h('div', {
        className: 'dmm-toast' + (toast.kind === 'error' ? ' is-error' : ''),
        role: toast.kind === 'error' ? 'alert' : undefined,
      },
      h('span', { className: 'dmm-toast-icon' }, toast.kind === 'error' ? h(AlertIcon) : h(CheckIcon)),
      h('span', { className: 'dmm-toast-text' }, toast.text))
    }

    function ToastHost({ store }) {
      const snapshot = useAppStore(store)
      if (typeof document === 'undefined') return null
      if (snapshot.toasts.length === 0) return null
      return createPortal(
        h('div', { className: 'dmm-toasts', role: 'status', 'aria-live': 'polite' },
          snapshot.toasts.map((toast) => h(ToastItem, { key: toast.id, toast, store }))),
        document.body)
    }

    /**
     * Repair polling shared by the repair dialog and the single-session path.
     * `onFinished` is called once per finished job; every timer is cleared on
     * unmount so a closed dialog never keeps polling.
     */
    function useRepairJob(onFinished) {
      const [state, setState] = useState({ phase: 'idle', job: null, error: null, cancelling: false })
      const alive = useRef(true)
      const jobId = useRef(null)
      const starting = useRef(false)
      const timers = useRef(new Set())
      const finished = useRef(new Set())
      const callback = useRef(onFinished)
      callback.current = onFinished

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
          for (const timer of [...timers.current]) clearTimeout(timer)
          timers.current.clear()
        }
      }, [])

      const poll = (currentId) => {
        const timer = setTimeout(async () => {
          timers.current.delete(timer)
          if (!alive.current) return
          try {
            const data = await rpc('repairStatus', { jobId: currentId })
            if (!alive.current) return
            const job = data?.job ?? null
            setState((previous) => ({ ...previous, job, error: null }))
            if (job !== null && job.finished === true) {
              jobId.current = null
              // Leave the running phase before notifying the dialog: the retry
              // and fork actions are gated on `running`, so staying in
              // 'running' would make the failure actions unreachable.
              setState((previous) => ({ ...previous, phase: 'done', job }))
              if (!finished.current.has(currentId)) {
                finished.current.add(currentId)
                if (typeof callback.current === 'function') callback.current(job)
              }
              return
            }
            poll(currentId)
          } catch (error) {
            if (!alive.current) return
            jobId.current = null
            setState((previous) => ({ ...previous, phase: 'error', error }))
          }
        }, POLL_REPAIR_MS)
        timers.current.add(timer)
      }

      const start = async (payload) => {
        if (starting.current) return
        starting.current = true
        jobId.current = null
        setState({ phase: 'starting', job: null, error: null, cancelling: false })
        try {
          const data = await rpc('repairStart', payload)
          if (!alive.current) return
          const total = Array.isArray(payload?.sessionIds) ? payload.sessionIds.length : 0
          jobId.current = data?.jobId ?? null
          setState({
            phase: 'running',
            job: { jobId: data?.jobId, total, done: 0, repaired: 0, failed: 0, skipped: 0, cancelled: false, finished: false, current: null, results: [] },
            error: null,
            cancelling: false,
          })
          if (jobId.current !== null) poll(jobId.current)
        } catch (error) {
          if (!alive.current) return
          setState({ phase: 'error', job: null, error, cancelling: false })
        } finally {
          starting.current = false
        }
      }

      const cancel = async () => {
        const currentId = jobId.current
        if (currentId === null) return
        setState((previous) => ({ ...previous, cancelling: true }))
        try {
          await rpc('repairCancel', { jobId: currentId })
        } catch (error) {
          if (!alive.current) return
          setState((previous) => ({ ...previous, cancelling: false, error }))
        }
      }

      return { ...state, start, cancel }
    }

    // ---------------------------------------------------------------------
    // Error boundaries
    // ---------------------------------------------------------------------

    class PageErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch() {
        // The page already shows a localized fallback; nothing to log here.
      }

      render() {
        if (this.state.failed) {
          const t = this.props.t
          return h('div', { className: 'dmm-page' },
            h('div', { className: 'dmm-inner' },
              h('div', { className: 'dmm-state' },
                h('div', { className: 'dmm-state-title' }, t('state.crashTitle')),
                h('div', null, t('state.crashDesc')),
                h(Btn, {
                  variant: 'primary',
                  onClick: () => {
                    this.setState({ failed: false })
                    if (typeof this.props.retry === 'function') this.props.retry()
                  },
                }, t('action.retry')))))
        }
        return this.props.children
      }
    }

    class SilentBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      render() {
        return this.state.failed ? null : this.props.children
      }
    }

    // ---------------------------------------------------------------------
    // Page
    // ---------------------------------------------------------------------

    function managedDir(data, id) {
      const root = data?.diagnostics?.creatorRoot
      if (typeof root !== 'string' || root === '') return ''
      return root.replace(/[\\/]+$/, '') + '/' + id
    }

    function firstLine(text) {
      const line = String(text ?? '').split(/\r?\n/)[0].trim()
      return line.length > 180 ? line.slice(0, 180) + '…' : line
    }

    function PresetCard(props) {
      const { t, preset, data, busy, highlighted } = props
      const official = isOfficialKind(preset.kind)
      const canEdit = !official && preset.editable === true
      const canDelete = !official && preset.deletable === true
      const defaultBlocked = !official && preset.kind === 'custom' && preset.isDefault === true
      const canDefault = preset.isDefault !== true && !preset.broken
      const description = presetDisplayDescription(t, preset)
      const title = presetDisplayName(t, preset)
      const directory = preset.managed === true ? managedDir(data, preset.id) : ''
      const importSource = preset.imported === true
        ? (() => {
          const source = (Array.isArray(data?.presets) ? data.presets : []).find((item) => item.id === preset.importedFrom)
          return source === undefined ? String(preset.importedFrom ?? '') : presetDisplayName(t, source)
        })()
        : ''
      const badges = [
        h('span', { key: 'kind', className: kindBadgeClass(preset.kind) }, t(kindBadgeKey(preset.kind))),
        preset.imported === true ? h('span', { key: 'imported', className: 'dmm-badge is-imported' }, t('badge.imported')) : null,
        preset.isDefault === true ? h('span', { key: 'default', className: 'dmm-badge is-default' }, t('badge.default')) : null,
        preset.broken ? h('span', { key: 'broken', className: 'dmm-badge is-broken' }, t('badge.broken')) : null,
      ]
      return h('article', {
        id: 'dmm-card-' + preset.id,
        className: 'dmm-card' + (highlighted ? ' is-highlight' : ''),
      },
      h('div', { className: 'dmm-card-head' },
        h('div', { className: 'dmm-card-title', title }, title),
        h('div', { className: 'dmm-badges' }, badges)),
      h('div', { className: 'dmm-card-id' }, preset.id),
      h('p', { className: 'dmm-card-desc' }, description === '' ? t('card.noDescription') : description),
      h('div', { className: 'dmm-card-meta' }, t('card.sessions', { count: Number(preset.sessionCount) || 0 })),
      preset.managed === true && preset.bundleName
        ? h('div', { className: 'dmm-card-meta' }, t('card.bundle') + ': ' + preset.bundleName)
        : null,
      importSource === ''
        ? null
        : h('div', { className: 'dmm-card-meta' }, t('card.importedFrom') + ': ' + importSource),
      directory === ''
        ? null
        : h('div', { className: 'dmm-card-meta', title: directory }, t('card.dir') + ': ' + directory),
      preset.broken
        ? h('div', { className: 'dmm-card-broken' },
          h('div', null, firstLine(preset.broken)),
          h('details', null,
            h('summary', null, t('card.diagnostic')),
            h('pre', null, String(preset.broken))))
        : null,
      h('div', { className: 'dmm-card-actions' },
        h(Btn, { className: 'dmm-btn-sm', disabled: busy, onClick: () => props.onView(preset) }, t('action.view')),
        canEdit
          ? h(Btn, { className: 'dmm-btn-sm', disabled: busy, onClick: () => props.onEdit(preset) }, t('action.edit'))
          : (preset.imported === true
            ? h(Btn, {
              className: 'dmm-btn-sm',
              disabled: true,
              title: t('card.importedHint'),
              'aria-label': t('card.importedHint'),
            }, t('action.edit'))
            : null),
        canDefault
          ? h(Btn, { className: 'dmm-btn-sm', disabled: busy, onClick: () => props.onSetDefault(preset) }, t('action.setDefault'))
          : (preset.isDefault !== true && preset.broken
            ? h(Btn, { className: 'dmm-btn-sm', disabled: true, title: t('card.defaultBroken'), 'aria-label': t('card.defaultBroken') }, t('action.setDefault'))
            : null),
        canDelete
          ? h(Btn, {
            className: 'dmm-btn-sm dmm-btn-danger',
            disabled: busy,
            onClick: () => props.onDelete(preset),
          }, t('action.delete'))
          : (defaultBlocked
            ? h(Btn, {
              className: 'dmm-btn-sm dmm-btn-danger',
              disabled: true,
              title: t('delete.defaultBlocked'),
              'aria-label': t('delete.defaultBlocked'),
            }, t('action.delete'))
            : null)))
    }

    const FILTER_TABS = [
      { id: 'all', key: 'filter.all' },
      { id: 'official', key: 'filter.official' },
      { id: 'custom', key: 'filter.custom' },
      { id: 'broken', key: 'filter.broken' },
    ]

    function PageView(props) {
      const { t, store, loadData, addToast, openOverlay, refreshBackups, setHighlight, onBack } = props
      const snapshot = useAppStore(store)
      const [tab, setTab] = useState('all')
      const [query, setQuery] = useState('')
      const [busyId, setBusyId] = useState(null)

      useEffect(() => {
        void loadData()
      }, [])

      useEffect(() => {
        if (typeof window === 'undefined') return undefined
        let last = Date.now()
        const maybeRefresh = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          if (Date.now() - last < 5_000) return
          last = Date.now()
          void loadData()
        }
        window.addEventListener('focus', maybeRefresh)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', maybeRefresh)
        return () => {
          window.removeEventListener('focus', maybeRefresh)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', maybeRefresh)
        }
      }, [loadData])

      useEffect(() => {
        if (snapshot.highlight === null || snapshot.highlight === undefined) return undefined
        const element = typeof document === 'undefined' ? null : document.getElementById('dmm-card-' + snapshot.highlight)
        if (element !== null && typeof element.scrollIntoView === 'function') {
          try {
            element.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
          } catch {
            // ignore unsupported scroll options
          }
        }
        const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS)
        return () => clearTimeout(timer)
      }, [snapshot.highlight])

      const data = snapshot.data
      const loading = snapshot.status === 'loading'
      const presets = sortPresets(Array.isArray(data?.presets) ? data.presets : [])
      const search = query.trim().toLowerCase()
      const filtered = presets.filter((preset) => {
        if (!matchesTab(preset, tab)) return false
        if (search === '') return true
        const haystack = [preset.id, presetDisplayName(t, preset), presetDisplayDescription(t, preset)]
          .filter((value) => typeof value === 'string').join(' ').toLowerCase()
        return haystack.includes(search)
      })

      const view = (preset) => openOverlay({ kind: 'view', id: preset.id, name: presetDisplayName(t, preset) })
      const edit = (preset) => openOverlay({ kind: 'wizard', mode: 'edit', preset })
      const remove = (preset) => openOverlay({ kind: 'delete', preset })
      const makeDefault = async (preset) => {
        if (busyId !== null) return
        setBusyId(preset.id)
        try {
          await rpc('setDefault', { id: preset.id })
          await loadData()
          addToast('success', t('toast.defaultSet', { name: presetDisplayName(t, preset) }))
        } catch (error) {
          addToast('error', describeError(t, error))
        } finally {
          setBusyId(null)
        }
      }

      const header = h('header', { className: 'dmm-header' },
        h('div', { className: 'dmm-header-text' },
          h('h1', { className: 'dmm-title' }, t('page.title')),
          h('p', { className: 'dmm-intro' }, t('page.intro'))),
        h('div', { className: 'dmm-header-actions' },
          typeof onBack === 'function'
            ? h(Btn, { onClick: () => onBack(), 'aria-label': t('page.back') }, t('page.back'))
            : null,
          h(Btn, { onClick: () => void loadData(), disabled: loading, 'aria-label': t('page.refresh') }, loading ? t('page.refreshing') : t('page.refresh')),
          h(Btn, {
            variant: 'primary',
            disabled: data === null || data === undefined,
            onClick: () => openOverlay({ kind: 'wizard', mode: 'create' }),
          }, '+ ' + t('page.create'))))

      if (data === null || data === undefined) {
        return h('div', { className: 'dmm-page' },
          h('div', { className: 'dmm-inner' }, header,
            snapshot.status === 'error'
              ? h('div', { className: 'dmm-state', role: 'alert' },
                h('div', { className: 'dmm-state-title' }, t('state.error')),
                h('div', { className: 'dmm-state-detail' }, describeError(t, snapshot.error)),
                h(Btn, { variant: 'primary', onClick: () => void loadData() }, t('action.retry')))
              : h('div', { className: 'dmm-state' }, t('state.loading'))))
      }

      const toolbar = h('div', { className: 'dmm-toolbar' },
        h('div', { className: 'dmm-tabs', role: 'group', 'aria-label': t('page.title') },
          FILTER_TABS.map((item) => h('button', {
            key: item.id,
            type: 'button',
            className: 'dmm-tab',
            'aria-pressed': tab === item.id,
            onClick: () => setTab(item.id),
          }, t(item.key)))),
        h('div', { className: 'dmm-search' },
          h('input', {
            type: 'search',
            value: query,
            placeholder: t('search.placeholder'),
            'aria-label': t('search.label'),
            onChange: (event) => setQuery(event.target.value),
          })))

      let body
      if (presets.length === 0) {
        body = h('div', { className: 'dmm-state' },
          h('div', { className: 'dmm-state-title' }, t('state.empty.title')),
          h('div', null, t('state.empty.desc')))
      } else if (filtered.length === 0) {
        body = h('div', { className: 'dmm-state' }, t('state.noMatch'))
      } else {
        body = h('div', { className: 'dmm-grid' },
          filtered.map((preset) => h(PresetCard, {
            key: preset.id,
            t,
            preset,
            data,
            busy: busyId === preset.id,
            highlighted: snapshot.highlight === preset.id,
            onView: view,
            onEdit: edit,
            onDelete: remove,
            onSetDefault: makeDefault,
          })))
      }

      return h('div', { className: 'dmm-page' },
        h('div', { className: 'dmm-inner' },
          header,
          snapshot.status === 'error'
            ? h('div', { className: 'dmm-banner', role: 'alert' },
              h('span', null, describeError(t, snapshot.error)),
              h(Btn, { className: 'dmm-btn-sm', onClick: () => void loadData() }, t('action.retry')))
            : null,
          toolbar,
          body,
          h(BackupSection, { t, data, store, loadData, refreshBackups, addToast }),
          h(DiagnosticsSection, { t, data, addToast })))
    }

    // ---------------------------------------------------------------------
    // Backups and diagnostics folds
    // ---------------------------------------------------------------------

    function BackupSection(props) {
      const { t, data, loadData, refreshBackups, addToast } = props
      const backups = Array.isArray(data?.backups) ? data.backups : []
      const [busy, setBusy] = useState('')
      const [pendingDelete, setPendingDelete] = useState(null)
      const [deleting, setDeleting] = useState('')
      const [error, setError] = useState(null)

      const restore = async (backup) => {
        if (busy !== '') return
        setBusy(backup.name)
        setError(null)
        try {
          await rpc('restore', { name: backup.name })
          await loadData()
          addToast('success', t('backups.restored', { preset: backup.presetId }))
        } catch (failure) {
          setError(failure)
        } finally {
          setBusy('')
        }
      }

      const removeBackup = async (backup) => {
        if (busy !== '' || deleting !== '') return
        setDeleting(backup.name)
        setError(null)
        try {
          await rpc('deleteBackup', { name: backup.name })
          setPendingDelete(null)
          await refreshBackups()
          addToast('success', t('backups.deleted'))
        } catch (failure) {
          setError(failure)
        } finally {
          setDeleting('')
        }
      }

      const cleanup = async () => {
        if (busy !== '') return
        setBusy('cleanup')
        setError(null)
        try {
          const result = await rpc('cleanupBackups', { keep: KEEP_BACKUPS })
          await refreshBackups()
          addToast('success', t('backups.cleaned', { removed: Number(result?.removed) || 0, kept: Number(result?.kept) || 0 }))
        } catch (failure) {
          setError(failure)
        } finally {
          setBusy('')
        }
      }

      return h(React.Fragment, null,
        h('details', { className: 'dmm-fold' },
          h('summary', null,
            h('span', null, t('backups.title')),
            h('span', { className: 'dmm-fold-count' }, String(backups.length))),
          h('div', { className: 'dmm-fold-body' },
            h('div', { className: 'dmm-row-actions', style: { justifyContent: 'flex-end', marginBottom: '6px' } },
              h(Btn, {
                className: 'dmm-btn-sm',
                disabled: busy !== '' || backups.length === 0,
                onClick: () => void cleanup(),
              }, busy === 'cleanup' ? t('backups.cleaning') : t('backups.cleanup'))),
            error !== null ? h('div', { className: 'dmm-error', role: 'alert' }, describeError(t, error)) : null,
            backups.length === 0
              ? h('div', { className: 'dmm-note' }, t('backups.empty'))
              : backups.map((backup) => h('div', { key: backup.name, className: 'dmm-row' },
                h('div', { className: 'dmm-row-main' },
                  h('div', { className: 'dmm-row-title' }, backup.name),
                  h('div', { className: 'dmm-row-meta' },
                    t('backups.preset') + ': ' + String(backup.presetId ?? '') + ' · ' +
                    formatTime(backup.createdAt) + ' · ' + formatBytes(backup.bytes))),
                h('div', { className: 'dmm-row-actions' },
                  h(Btn, {
                    className: 'dmm-btn-sm',
                    disabled: busy !== '' || deleting !== '',
                    onClick: () => void restore(backup),
                  }, busy === backup.name ? t('backups.restoring') : t('backups.restore')),
                  h(Btn, {
                    className: 'dmm-btn-sm dmm-btn-danger',
                    disabled: busy !== '' || deleting !== '',
                    onClick: () => setPendingDelete(backup),
                  }, t('backups.delete'))))))),
        pendingDelete === null
          ? null
          : h(Modal, {
            title: t('backups.deleteTitle', { name: pendingDelete.name }),
            closeLabel: t('action.close'),
            onClose: () => {
              if (deleting === '') setPendingDelete(null)
            },
            footer: [
              h(Btn, {
                key: 'cancel',
                disabled: deleting !== '',
                onClick: () => setPendingDelete(null),
              }, t('action.cancel')),
              h(Btn, {
                key: 'delete',
                variant: 'danger-solid',
                disabled: deleting !== '',
                onClick: () => void removeBackup(pendingDelete),
              }, deleting !== '' ? t('backups.deleting') : t('backups.delete')),
            ],
          },
          h('p', { className: 'dmm-note' }, t('backups.deleteDesc', {
            preset: String(pendingDelete.presetId ?? ''),
          })),
          h('p', { className: 'dmm-note' }, pendingDelete.name)))
    }
    function DiagnosticsSection({ t, data, addToast }) {
      const diagnostics = data?.diagnostics ?? null
      const rows = diagnosticsRows(t, diagnostics)
      const copy = async () => {
        const ok = await writeClipboard(diagnosticsText(t, diagnostics))
        if (ok) addToast('success', t('diag.copied'))
        else addToast('error', t('action.copyFailed'))
      }
      return h('details', { className: 'dmm-fold' },
        h('summary', null, h('span', null, t('diag.title'))),
        h('div', { className: 'dmm-fold-body' },
          h('div', { className: 'dmm-row-actions', style: { justifyContent: 'flex-end', marginBottom: '8px' } },
            h(Btn, { className: 'dmm-btn-sm', onClick: () => void copy() }, t('diag.copy'))),
          h('div', { className: 'dmm-diag' },
            rows.map((row, index) => h('div', { key: index, className: 'dmm-diag-row' },
              h('div', { className: 'dmm-diag-label' }, row[0]),
              h('div', { className: 'dmm-diag-value' }, row[1] === undefined || row[1] === null || row[1] === '' ? '—' : String(row[1])))))))
    }

    // ---------------------------------------------------------------------
    // Read-only YAML dialog
    // ---------------------------------------------------------------------

    function ViewDialog({ t, store, dialog, onClose, addToast }) {
      const snapshot = useAppStore(store)
      const [state, setState] = useState({ status: 'loading', document: null, error: null })
      const [copied, setCopied] = useState(false)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        rpc('document', { id: dialog.id })
          .then((document) => {
            if (alive.current) setState({ status: 'ready', document, error: null })
          })
          .catch((error) => {
            if (alive.current) setState({ status: 'error', document: null, error })
          })
        return () => {
          alive.current = false
        }
      }, [dialog.id])

      useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(false), 2000)
        return () => clearTimeout(timer)
      }, [copied])

      const presets = Array.isArray(snapshot.data?.presets) ? snapshot.data.presets : []
      const preset = presets.find((item) => item.id === dialog.id) ?? null
      const content = state.document !== null && typeof state.document.content === 'string' ? state.document.content : ''
      const dir = preset !== null && preset.managed === true ? managedDir(snapshot.data, preset.id) : ''

      const copy = async () => {
        if (content === '') return
        const ok = await writeClipboard(content)
        if (ok) setCopied(true)
        else addToast('error', t('action.copyFailed'))
      }

      const metaRows = []
      if (preset !== null) metaRows.push([t('view.source'), t(kindBadgeKey(preset.kind))])
      if (preset !== null && preset.imported === true) {
        const source = presets.find((item) => item.id === preset.importedFrom)
        metaRows.push([t('card.importedFrom'), source === undefined
          ? String(preset.importedFrom ?? '')
          : presetDisplayName(t, source)])
      }
      if (preset !== null && preset.bundleName) metaRows.push([t('view.bundle'), preset.bundleName])
      if (preset !== null && preset.bundleVersion) metaRows.push([t('view.version'), preset.bundleVersion])
      if (dir !== '') metaRows.push([t('view.dir'), dir])

      return h(Modal, {
        title: t('view.title', { name: dialog.name }),
        closeLabel: t('action.close'),
        size: 'md',
        onClose,
        footer: [
          h(Btn, { key: 'copy', disabled: content === '', onClick: () => void copy() }, copied ? t('action.copied') : t('action.copy')),
          h(Btn, { key: 'close', variant: 'primary', onClick: onClose }, t('action.close')),
        ],
      },
      metaRows.length === 0 ? null : h('div', { className: 'dmm-summary' },
        metaRows.map((row) => h('div', { key: row[0] },
          h('div', { className: 'dmm-summary-label' }, row[0]),
          h('div', { className: 'dmm-summary-value' }, String(row[1]))))),
      state.status === 'loading' ? h('div', { className: 'dmm-note' }, t('view.loading')) : null,
      state.status === 'error'
        ? h('div', { className: 'dmm-error', role: 'alert' }, describeError(t, state.error))
        : null,
      state.status === 'ready' && content === '' ? h('div', { className: 'dmm-note' }, t('view.empty')) : null,
      state.status === 'ready' && content !== ''
        ? h('pre', {
          className: 'dmm-yaml',
          tabIndex: 0,
          role: 'region',
          'aria-label': t('view.title', { name: dialog.name }),
        }, content)
        : null)
    }

    // ---------------------------------------------------------------------
    // Wizard
    // ---------------------------------------------------------------------

    function readWizardDraft() {
      try {
        const raw = localStorage.getItem(DRAFT_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return null
        const draft = parsed.draft
        if (draft === null || typeof draft !== 'object') return null
        const step = Number(parsed.step)
        if (!Number.isInteger(step) || step < 1 || step > 4) return null
        if (typeof draft.name !== 'string' || typeof draft.id !== 'string') return null
        return {
          step,
          template: typeof parsed.template === 'string' ? parsed.template : 'standard',
          copyFrom: typeof parsed.copyFrom === 'string' ? parsed.copyFrom : '',
          idTouched: parsed.idTouched === true,
          draft: {
            name: draft.name,
            id: draft.id,
            description: typeof draft.description === 'string' ? draft.description : '',
            order: typeof draft.order === 'string' ? draft.order : (typeof draft.order === 'number' ? String(draft.order) : '10'),
            capabilities: Array.isArray(draft.capabilities) ? draft.capabilities.filter((id) => typeof id === 'string') : [],
            persona: typeof draft.persona === 'string' ? draft.persona : '',
          },
        }
      } catch {
        return null
      }
    }

    function saveWizardDraft(value) {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(value))
      } catch {
        // A full or blocked storage must never break the wizard.
      }
    }

    function removeWizardDraft() {
      try {
        localStorage.removeItem(DRAFT_KEY)
      } catch {
        // ignore
      }
    }

    function CapabilityPicker({ t, groups, selected, onToggle }) {
      return h('div', { className: 'dmm-cap-groups' },
        groups.map((group) => h('div', { key: group.id, className: 'dmm-cap-group' },
          h('div', { className: 'dmm-cap-group-head' }, capGroupLabel(t, group.id)),
          h('div', { className: 'dmm-cap-items' },
            (Array.isArray(group.items) ? group.items : []).map((item) => h('label', {
              key: item.id,
              className: 'dmm-check' + (item.danger === true ? ' is-danger' : ''),
            },
            h('input', {
              type: 'checkbox',
              checked: selected.includes(item.id),
              onChange: () => onToggle(item.id),
            }),
            h('span', { className: 'dmm-cap-item-text' },
              h('span', { className: 'dmm-cap-item-label' },
                capItemLabel(t, item.id),
                item.danger === true ? h('span', { className: 'dmm-cap-danger' }, ' · ' + t('wizard.capabilities.danger')) : null),
              h('span', { className: 'dmm-cap-item-desc' }, t('cap.desc.' + item.id)))))))))
    }

    function Wizard(props) {
      const { t, store, dialog, onClose, loadData, addToast, setHighlight } = props
      const snapshot = useAppStore(store)
      const data = snapshot.data
      const editing = dialog.mode === 'edit'
      const editingPreset = editing ? dialog.preset : null
      const presets = Array.isArray(data?.presets) ? data.presets : []
      const groups = Array.isArray(data?.capabilities?.groups) && data.capabilities.groups.length > 0
        ? data.capabilities.groups
        : FALLBACK_CATALOG
      const templates = Array.isArray(data?.templates) && data.templates.length > 0 ? data.templates : FALLBACK_TEMPLATES
      const limits = data !== null && data !== undefined && data.limits !== undefined && data.limits !== null ? data.limits : DEFAULT_LIMITS
      const nameMax = Number(limits.nameMax) || DEFAULT_LIMITS.nameMax
      const descriptionMax = Number(limits.descriptionMax) || DEFAULT_LIMITS.descriptionMax
      const orderMin = Number.isFinite(Number(limits.orderMin)) ? Number(limits.orderMin) : DEFAULT_LIMITS.orderMin
      const orderMax = Number.isFinite(Number(limits.orderMax)) ? Number(limits.orderMax) : DEFAULT_LIMITS.orderMax
      const idRegex = idPatternOf(limits)
      const universe = capabilityUniverse(limits, groups)
      const standardTemplate = templates.find((item) => item.id === 'standard') ?? templates[0] ?? null

      const restored = useRef(null)
      const [initial] = useState(() => {
        if (editing) {
          return {
            step: 2,
            templateKind: 'standard',
            copyFrom: '',
            idTouched: true,
            draft: {
              name: String(editingPreset?.name ?? ''),
              id: String(editingPreset?.id ?? ''),
              description: String(editingPreset?.description ?? ''),
              order: editingPreset?.order === undefined || editingPreset?.order === null ? '' : String(editingPreset.order),
              capabilities: normalizeCapabilities(editingPreset?.capabilities, capabilityUniverse(limits, groups)),
              persona: String(editingPreset?.persona ?? ''),
            },
          }
        }
        const saved = readWizardDraft()
        if (saved !== null) {
          restored.current = saved
          return {
            step: saved.step,
            templateKind: saved.template,
            copyFrom: saved.copyFrom,
            idTouched: saved.idTouched,
            draft: {
              ...saved.draft,
              capabilities: normalizeCapabilities(saved.draft.capabilities, capabilityUniverse(limits, groups)),
            },
          }
        }
        return {
          step: 1,
          templateKind: standardTemplate?.id ?? 'standard',
          copyFrom: '',
          idTouched: false,
          draft: {
            name: '',
            id: '',
            description: '',
            order: '10',
            capabilities: normalizeCapabilities(standardTemplate?.capabilities, capabilityUniverse(limits, groups)),
            persona: String(standardTemplate?.persona ?? ''),
          },
        }
      })

      const [step, setStep] = useState(initial.step)
      const [templateKind, setTemplateKind] = useState(initial.templateKind)
      const [copyFrom, setCopyFrom] = useState(initial.copyFrom)
      const [draft, setDraft] = useState(initial.draft)
      const [idTouched, setIdTouched] = useState(initial.idTouched)
      const [restoredNotice, setRestoredNotice] = useState(restored.current !== null)
      const [fieldError, setFieldError] = useState(null)
      const [submitError, setSubmitError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [preview, setPreview] = useState({ status: 'idle', data: null, error: null })

      const importMode = !editing && templateKind === 'import'
      const stepOrder = editing ? [2, 3, 4] : (importMode ? [1, 2, 4] : [1, 2, 3, 4])
      const stepLabelOf = (number) => (number === 1 ? 'template' : number === 2 ? 'basics' : number === 3 ? 'capabilities' : 'preview')
      const stepIds = stepOrder.map(stepLabelOf)
      const firstStep = editing ? 2 : 1
      const lastStep = 4
      const displayStep = Math.max(1, stepOrder.indexOf(step) + 1)

      useEffect(() => {
        if (editing) return
        saveWizardDraft({ step, template: templateKind, copyFrom, draft, idTouched })
      }, [editing, step, templateKind, copyFrom, draft, idTouched])

      const buildDraft = () => {
        const name = draft.name.trim()
        const description = draft.description.trim()
        const persona = draft.persona.trim()
        return {
          id: draft.id.trim(),
          name,
          description: description === '' ? undefined : description,
          order: draft.order === '' ? undefined : Number(draft.order),
          capabilities: normalizeCapabilities(draft.capabilities, universe),
          persona: persona === '' ? undefined : draft.persona,
          ...(importMode && copyFrom !== '' ? { importFrom: copyFrom } : {}),
        }
      }

      const clearField = (field) => {
        setFieldError((previous) => (previous !== null && previous.field === field ? null : previous))
      }

      const update = (patch) => {
        setDraft((previous) => ({ ...previous, ...patch }))
        setSubmitError(null)
      }

      const idStatus = (() => {
        if (draft.id === '') return { kind: 'bad', text: t('wizard.field.idEmpty') }
        if (!idRegex.test(draft.id)) return { kind: 'bad', text: t('wizard.field.idInvalid') }
        const taken = presets.some((preset) => preset.id === draft.id && !(editing && preset.id === editingPreset?.id))
        if (taken) return { kind: 'bad', text: t('wizard.field.idConflict') }
        return { kind: 'ok', text: t('wizard.field.idOk') }
      })()

      const onNameChange = (value) => {
        setDraft((previous) => {
          const next = { ...previous, name: value }
          if (!editing && !idTouched) next.id = slugify(value)
          return next
        })
        setSubmitError(null)
        clearField('name')
        clearField('id')
      }

      const onIdChange = (value) => {
        setIdTouched(true)
        update({ id: value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) })
        clearField('id')
      }

      const validateBasics = () => {
        const name = draft.name.trim()
        if (name === '' || name.length > nameMax) return { field: 'name', message: t('validation.name') }
        if (!idRegex.test(draft.id)) return { field: 'id', message: t('validation.id') }
        const taken = presets.some((preset) => preset.id === draft.id && !(editing && preset.id === editingPreset?.id))
        if (taken) return { field: 'id', message: t('wizard.field.idConflict') }
        if (draft.description.trim().length > descriptionMax) return { field: 'description', message: t('validation.description') }
        if (draft.order !== '') {
          const order = Number(draft.order)
          if (!Number.isInteger(order) || order < orderMin || order > orderMax) return { field: 'order', message: t('validation.order') }
        }
        return null
      }

      const pickTemplate = (kind) => {
        const template = templates.find((item) => item.id === kind) ?? null
        setTemplateKind(kind)
        setCopyFrom('')
        setStep(2)
        setDraft((previous) => ({
          ...previous,
          capabilities: normalizeCapabilities(template?.capabilities, universe),
          persona: String(template?.persona ?? ''),
        }))
        setFieldError(null)
        setSubmitError(null)
      }

      const pickCopy = (id) => {
        setCopyFrom(id)
        if (id === '') return
        const preset = presets.find((item) => item.id === id)
        if (preset === undefined) return
        setDraft((previous) => ({
          ...previous,
          capabilities: normalizeCapabilities(preset.capabilities, universe),
          persona: String(preset.persona ?? ''),
        }))
      }

      /**
       * Choose the official mode to import verbatim. Only the basic identity
       * fields are prefilled from the source's localized display metadata; the
       * composition itself is copied by the Host.
       */
      const pickImport = (id) => {
        setCopyFrom(id)
        if (id === '') return
        const preset = presets.find((item) => item.id === id)
        if (preset === undefined) return
        const displayName = presetDisplayName(t, preset)
        const displayDescription = presetDisplayDescription(t, preset)
        // The source description can exceed this field's structural limit in
        // English; leave the field empty rather than prefilling an invalid value.
        const defaultDescription = displayDescription.length <= descriptionMax ? displayDescription : ''
        setDraft((previous) => ({
          ...previous,
          name: previous.name.trim() === '' ? displayName : previous.name,
          id: previous.id === '' && !idTouched ? slugify(displayName) : previous.id,
          description: previous.description.trim() === '' ? defaultDescription : previous.description,
        }))
        clearField('name')
        clearField('id')
        clearField('description')
      }

      const toggleCapability = (id) => {
        setDraft((previous) => {
          const capabilities = previous.capabilities.includes(id)
            ? previous.capabilities.filter((item) => item !== id)
            : previous.capabilities.concat(id)
          return { ...previous, capabilities }
        })
      }

      const clearDraftNow = () => {
        removeWizardDraft()
        setRestoredNotice(false)
        setStep(1)
        setTemplateKind(standardTemplate?.id ?? 'standard')
        setCopyFrom('')
        setIdTouched(false)
        setDraft({
          name: '',
          id: '',
          description: '',
          order: '10',
          capabilities: normalizeCapabilities(standardTemplate?.capabilities, universe),
          persona: String(standardTemplate?.persona ?? ''),
        })
        setFieldError(null)
        setSubmitError(null)
      }

      const goBack = () => {
        setFieldError(null)
        setSubmitError(null)
        if (step === 4) {
          setStep(importMode ? 2 : 3)
          return
        }
        setStep((previous) => Math.max(firstStep, previous - 1))
      }

      const goNext = () => {
        setSubmitError(null)
        if (step === 1) {
          if (templateKind === 'copy' && copyFrom === '') return
          if (templateKind === 'import' && copyFrom === '') return
          setStep(2)
          return
        }
        if (step === 2) {
          const failure = validateBasics()
          if (failure !== null) {
            setFieldError(failure)
            return
          }
          setFieldError(null)
          setStep(importMode ? 4 : 3)
          return
        }
        if (step === 3) {
          setFieldError(null)
          setStep(4)
        }
      }

      const loadPreview = () => {
        let alive = true
        setPreview({ status: 'loading', data: null, error: null })
        rpc('preview', { draft: buildDraft() })
          .then((result) => {
            if (alive) setPreview({ status: 'ready', data: result, error: null })
          })
          .catch((error) => {
            if (alive) setPreview({ status: 'error', data: null, error })
          })
        return () => {
          alive = false
        }
      }

      useEffect(() => {
        if (step !== lastStep) return undefined
        return loadPreview()
      }, [step])

      const submit = async () => {
        if (busy) return
        setBusy(true)
        setSubmitError(null)
        const payload = { draft: buildDraft() }
        try {
          const result = editing ? await rpc('update', payload) : await rpc('create', payload)
          if (!editing) removeWizardDraft()
          addToast('success', t(editing ? 'wizard.saved' : 'wizard.created', { name: payload.draft.name }))
          if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
            addToast('info', t('wizard.warnings', { count: result.warnings.length }))
          }
          const nextData = await loadData()
          if (nextData !== null && nextData !== undefined) {
            setHighlight(typeof result?.presetId === 'string' ? result.presetId : payload.draft.id)
          }
          onClose()
        } catch (error) {
          setBusy(false)
          if (error !== null && error !== undefined && error.code === 'validation') {
            setSubmitError(t('err.validation'))
            setFieldError({ field: typeof error.field === 'string' ? error.field : '', message: fieldErrorMessage(t, error) })
            if (error.field === 'importFrom') setStep(1)
            else if (error.field === 'capabilities' || error.field === 'persona') setStep(3)
            else setStep(2)
          } else {
            setSubmitError(describeError(t, error))
          }
        }
      }

      const dangerSelected = groups.some((group) =>
        (Array.isArray(group.items) ? group.items : []).some((item) => item.danger === true && draft.capabilities.includes(item.id)))
      const editNotice = editing
        ? h('div', { className: 'dmm-notice' },
          h('div', null, t('wizard.edit.notice')),
          h('div', null, t('wizard.edit.sessions', { count: Number(editingPreset?.sessionCount) || 0 })))
        : null

      const stepBar = h('div', { className: 'dmm-steps' },
        stepIds.map((id, index) => {
          const number = index + 1
          const current = number === displayStep
          const done = number < displayStep
          return h('span', {
            key: id,
            className: 'dmm-step' + (current ? ' is-active' : '') + (done ? ' is-done' : ''),
          },
          h('span', { className: 'dmm-step-num' }, String(number)),
          h('span', null, t('wizard.step.' + id)))
        }))

      let stepBody = null
      if (step === 1) {
        stepBody = h(React.Fragment, null,
          h('div', { className: 'dmm-template-grid' },
            ['standard', 'minimal', 'blank', 'copy', 'import'].map((kind) => {
              const isAdhoc = kind === 'copy' || kind === 'import'
              const template = templates.find((item) => item.id === kind)
              return h('button', {
                key: kind,
                type: 'button',
                className: 'dmm-template',
                'aria-pressed': templateKind === kind,
                'data-dmm-autofocus': kind === 'standard' ? true : undefined,
                onClick: () => {
                  if (kind === 'copy') setTemplateKind('copy')
                  else if (kind === 'import') {
                    setTemplateKind('import')
                    setCopyFrom('')
                  } else pickTemplate(kind)
                },
              },
              h('span', { className: 'dmm-template-title' }, t('wizard.template.' + kind)),
              h('span', { className: 'dmm-template-desc' }, t('wizard.template.' + kind + 'Desc')),
              isAdhoc ? null : h('span', { className: 'dmm-template-count' }, t('wizard.template.count', {
                count: Array.isArray(template?.capabilities) ? template.capabilities.length : 0,
              })))
            })),
          templateKind === 'copy'
            ? h('label', { className: 'dmm-field' },
              h('span', { className: 'dmm-field-label' }, t('wizard.copy.from')),
              h('select', {
                className: 'dmm-select',
                value: copyFrom,
                onChange: (event) => pickCopy(event.target.value),
              },
              h('option', { value: '' }, t('wizard.copy.select')),
              presets.map((preset) => h('option', { key: preset.id, value: preset.id }, presetDisplayLabel(t, preset)))),
              h('span', { className: 'dmm-field-hint' }, t('wizard.copy.hint')))
            : null,
          templateKind === 'import'
            ? h('label', { className: 'dmm-field' },
              h('span', { className: 'dmm-field-label' }, t('wizard.import.from')),
              h('select', {
                className: 'dmm-select',
                value: copyFrom,
                'data-dmm-autofocus': true,
                onChange: (event) => pickImport(event.target.value),
              },
              h('option', { value: '' }, t('wizard.import.select')),
              presets.filter((preset) => isOfficialKind(preset.kind)).map((preset) =>
                h('option', { key: preset.id, value: preset.id }, presetDisplayLabel(t, preset)))),
              h('span', { className: 'dmm-field-hint' }, t('wizard.import.hint')))
            : null)
      } else if (step === 2) {
        stepBody = h(React.Fragment, null,
          h('label', { className: 'dmm-field' },
            h('span', { className: 'dmm-field-label' }, t('wizard.field.name')),
            h('span', { className: 'dmm-field-hint' }, t('wizard.field.nameHint', { max: nameMax })),
            h('input', {
              className: 'dmm-input' + (fieldError !== null && fieldError.field === 'name' ? ' is-invalid' : ''),
              type: 'text',
              value: draft.name,
              maxLength: nameMax,
              'data-dmm-autofocus': true,
              'aria-invalid': fieldError !== null && fieldError.field === 'name',
              onChange: (event) => onNameChange(event.target.value),
            }),
            fieldError !== null && fieldError.field === 'name'
              ? h('span', { className: 'dmm-field-error', role: 'alert' }, fieldError.message)
              : null),
          h('label', { className: 'dmm-field' },
            h('span', { className: 'dmm-field-label' }, t('wizard.field.id')),
            h('span', { className: 'dmm-field-hint' }, editing ? t('wizard.field.idLocked') : t('wizard.field.idHint')),
            h('input', {
              className: 'dmm-input' + (fieldError !== null && fieldError.field === 'id' ? ' is-invalid' : ''),
              type: 'text',
              value: draft.id,
              maxLength: 32,
              disabled: editing,
              'aria-invalid': fieldError !== null && fieldError.field === 'id',
              onChange: (event) => onIdChange(event.target.value),
            }),
            !editing && draft.id !== ''
              ? h('span', { className: 'dmm-field-hint ' + (idStatus.kind === 'ok' ? 'is-ok' : 'is-bad') }, idStatus.text)
              : null,
            fieldError !== null && fieldError.field === 'id'
              ? h('span', { className: 'dmm-field-error', role: 'alert' }, fieldError.message)
              : null),
          h('div', { className: 'dmm-field-row' },
            h('label', { className: 'dmm-field' },
              h('span', { className: 'dmm-field-label' }, t('wizard.field.description')),
              h('span', { className: 'dmm-field-hint' }, t('wizard.field.descriptionHint', { max: descriptionMax })),
              h('input', {
                className: 'dmm-input' + (fieldError !== null && fieldError.field === 'description' ? ' is-invalid' : ''),
                type: 'text',
                value: draft.description,
                maxLength: descriptionMax,
                onChange: (event) => {
                  update({ description: event.target.value })
                  clearField('description')
                },
              }),
              fieldError !== null && fieldError.field === 'description'
                ? h('span', { className: 'dmm-field-error', role: 'alert' }, fieldError.message)
                : null),
            h('label', { className: 'dmm-field' },
              h('span', { className: 'dmm-field-label' }, t('wizard.field.order')),
              h('span', { className: 'dmm-field-hint' }, t('wizard.field.orderHint')),
              h('input', {
                className: 'dmm-input' + (fieldError !== null && fieldError.field === 'order' ? ' is-invalid' : ''),
                type: 'text',
                inputMode: 'numeric',
                value: draft.order,
                onChange: (event) => {
                  update({ order: event.target.value.replace(/[^0-9]/g, '') })
                  clearField('order')
                },
              }),
              fieldError !== null && fieldError.field === 'order'
                ? h('span', { className: 'dmm-field-error', role: 'alert' }, fieldError.message)
                : null)))
      } else if (step === 3) {
        stepBody = h(React.Fragment, null,
          h('p', { className: 'dmm-note' }, t('wizard.capabilities.hint')),
          h(CapabilityPicker, { t, groups, selected: draft.capabilities, onToggle: toggleCapability }),
          dangerSelected ? h('div', { className: 'dmm-warn' }, t('wizard.capabilities.dangerWarn')) : null,
          draft.capabilities.length === 0 ? h('div', { className: 'dmm-warn' }, t('wizard.capabilities.empty')) : null,
          h('label', { className: 'dmm-field' },
            h('span', { className: 'dmm-field-label' }, t('wizard.field.persona')),
            h('span', { className: 'dmm-field-hint' }, t('wizard.field.personaHint')),
            h('textarea', {
              className: 'dmm-textarea',
              value: draft.persona,
              placeholder: t('wizard.field.personaPlaceholder'),
              onChange: (event) => update({ persona: event.target.value }),
            }),
            h('span', { className: 'dmm-field-hint' }, t('wizard.field.personaCount', { count: draft.persona.length }))),
          editNotice)
      } else if (step === 4) {
        const previewData = preview.data
        stepBody = h(React.Fragment, null,
          editNotice,
          importMode
            ? h('div', { className: 'dmm-notice' },
              h('div', null, t('wizard.import.note')),
              h('div', null, t('wizard.import.source', {
                name: (() => {
                  const source = presets.find((preset) => preset.id === copyFrom)
                  return source === undefined ? copyFrom : presetDisplayName(t, source)
                })(),
              })))
            : null,
          h('div', { className: 'dmm-preview' },
            h('div', null,
              h('div', { className: 'dmm-field-label', style: { marginBottom: '5px' } }, t('wizard.preview.title')),
              preview.status === 'loading'
                ? h('div', { className: 'dmm-note' }, t('wizard.preview.loading'))
                : preview.status === 'error'
                  ? h('div', { className: 'dmm-error', role: 'alert' },
                    h('span', null, describeError(t, preview.error)),
                    h(Btn, { className: 'dmm-btn-sm', onClick: () => loadPreview() }, t('action.retry')))
                  : h('pre', {
                    className: 'dmm-yaml',
                    tabIndex: 0,
                    role: 'region',
                    'aria-label': t('wizard.preview.title'),
                  }, typeof previewData?.yaml === 'string' ? previewData.yaml : '')),
            h('div', { className: 'dmm-summary' },
              h('div', null,
                h('div', { className: 'dmm-summary-label' }, t('wizard.preview.package')),
                h('div', { className: 'dmm-summary-value' }, String(previewData?.packageName ?? '—'))),
              h('div', null,
                h('div', { className: 'dmm-summary-label' }, t('wizard.preview.dir')),
                h('div', { className: 'dmm-summary-value' }, String(previewData?.dir ?? '—'))),
              h('div', null,
                h('div', { className: 'dmm-summary-label' }, t('wizard.preview.presetId')),
                h('div', { className: 'dmm-summary-value' }, String(previewData?.presetId ?? '—'))),
              h('div', null,
                h('div', { className: 'dmm-summary-label' }, t('wizard.preview.impactLabel')),
                h('div', { className: 'dmm-summary-value' }, t('wizard.preview.impact', {
                  count: editing ? (Number(editingPreset?.sessionCount) || 0) : 0,
                }))))))
      }

      const footer = [
        h('span', { key: 'step', className: 'dmm-footer-note' }, t('wizard.stepLabel', {
          current: displayStep,
          total: stepIds.length,
        })),
        step > firstStep ? h(Btn, { key: 'back', onClick: goBack }, t('action.back')) : null,
        h(Btn, { key: 'cancel', onClick: () => { if (!busy) onClose() } }, t('action.cancel')),
        step === lastStep
          ? h(Btn, {
            key: 'submit',
            variant: 'primary',
            disabled: busy || preview.status !== 'ready',
            onClick: () => void submit(),
          }, busy ? t(editing ? 'action.saving' : 'action.creating') : t(editing ? 'action.save' : 'action.create'))
          : h(Btn, {
            key: 'next',
            variant: 'primary',
            disabled: step === 1 && templateKind === 'copy' && copyFrom === '',
            onClick: goNext,
          }, t('action.next')),
      ]

      return h(Modal, {
        title: editing ? t('wizard.title.edit', { name: presetDisplayName(t, editingPreset) }) : t('wizard.title.create'),
        closeLabel: t('action.close'),
        size: 'lg',
        onClose: () => {
          if (!busy) onClose()
        },
        footer,
      },
      stepBar,
      restoredNotice && !editing
        ? h('div', { className: 'dmm-notice' },
          h('span', null, t('wizard.draft.restored')),
          h('button', { type: 'button', className: 'dmm-btn dmm-btn-sm', onClick: clearDraftNow }, t('wizard.draft.clear')))
        : null,
      submitError !== null ? h('div', { className: 'dmm-error', role: 'alert' }, submitError) : null,
      stepBody)
    }

    // ---------------------------------------------------------------------
    // Delete confirmation
    // ---------------------------------------------------------------------

    function DeleteDialog({ t, dialog, onClose, loadData, addToast, openOverlay }) {
      const preset = dialog.preset
      const [scanState, setScanState] = useState({ status: 'loading', scan: null, error: null })
      const [ack, setAck] = useState(false)
      const [deleting, setDeleting] = useState(false)
      const [error, setError] = useState(null)
      const blocked = preset.isDefault === true

      const runScan = () => {
        let alive = true
        setScanState({ status: 'loading', scan: null, error: null })
        rpc('scan', { id: preset.id })
          .then((result) => {
            if (alive) setScanState({ status: 'ready', scan: result?.scan ?? null, error: null })
          })
          .catch((failure) => {
            if (alive) setScanState({ status: 'error', scan: null, error: failure })
          })
        return () => {
          alive = false
        }
      }

      useEffect(() => runScan(), [preset.id])

      const remove = async () => {
        if (deleting || blocked) return
        setDeleting(true)
        setError(null)
        try {
          const result = await rpc('delete', { id: preset.id })
          await loadData()
          const totals = result?.scan?.totals
          onClose()
          addToast('success', t('delete.success', {
            name: presetDisplayName(t, preset),
            path: typeof result?.backupPath === 'string' ? result.backupPath : '—',
          }))
          if (totals !== undefined && Number(totals?.repairable) > 0) {
            openOverlay({
              kind: 'repair',
              presetId: preset.id,
              presetName: presetDisplayName(t, preset),
              scan: result.scan,
            })
          } else if (totals !== undefined && Number(totals?.total) > 0) {
            addToast('info', t('delete.noneRepairable', { count: Number(totals.total) || 0 }))
          } else {
            addToast('info', t('delete.successNoAffected'))
          }
        } catch (failure) {
          setDeleting(false)
          setError(failure)
        }
      }

      const scan = scanState.scan
      const groups = Array.isArray(scan?.groups) ? scan.groups : []
      const totals = scan?.totals

      return h(Modal, {
        title: t('delete.title', { name: presetDisplayName(t, preset) }),
        closeLabel: t('action.close'),
        onClose: () => {
          if (!deleting) onClose()
        },
        footer: [
          h(Btn, { key: 'cancel', disabled: deleting, onClick: onClose }, t('action.cancel')),
          h(Btn, {
            key: 'delete',
            variant: 'danger-solid',
            disabled: deleting || blocked || !ack || scanState.status !== 'ready',
            onClick: () => void remove(),
          }, deleting ? t('delete.deleting') : t('action.delete')),
        ],
      },
      h('div', { className: 'dmm-card-id' }, preset.id),
      h('p', { className: 'dmm-note' }, t('delete.intro')),
      h('p', { className: 'dmm-note' }, t('delete.irreversible')),
      blocked ? h('div', { className: 'dmm-warn' }, t('delete.defaultBlocked')) : null,
      scanState.status === 'loading' ? h('div', { className: 'dmm-note' }, t('delete.loading')) : null,
      scanState.status === 'error'
        ? h('div', { className: 'dmm-error', role: 'alert' },
          h('div', { className: 'dmm-field-label' }, t('delete.scanError')),
          h('div', null, describeError(t, scanState.error)),
          h(Btn, { className: 'dmm-btn-sm', onClick: () => runScan() }, t('action.retry')))
        : null,
      scanState.status === 'ready'
        ? h(React.Fragment, null,
          h('div', { className: 'dmm-notice' },
            totals !== undefined && Number(totals.total) > 0
              ? t('delete.affected', { count: Number(totals.total) || 0 })
              : t('delete.noSessions')),
          groups.length > 0
            ? h('div', { className: 'dmm-scan-group-list' },
              groups.map((group, index) => h('div', { key: String(group.workspaceId) + ':' + String(index), className: 'dmm-delete-group' },
                h('span', null, groupTitle(t, group)),
                h('span', { className: 'dmm-card-meta' }, scanCountsText(t, group.sessions)))))
            : null)
        : null,
      error !== null ? h('div', { className: 'dmm-error', role: 'alert' }, describeError(t, error)) : null,
      h('p', { className: 'dmm-note' }, t('delete.backupNote')),
      h('label', { className: 'dmm-check' },
        h('input', {
          type: 'checkbox',
          checked: ack,
          disabled: deleting || blocked,
          onChange: (event) => setAck(event.target.checked),
        }),
        h('span', null, t('delete.ack'))))
    }

    // ---------------------------------------------------------------------
    // Repair dialog (after delete / for affected sessions)
    // ---------------------------------------------------------------------

    function TargetSelect({ t, presets, excludedId, value, onChange, disabled, label }) {
      const candidates = targetCandidates(presets, excludedId)
      return h('label', { className: 'dmm-field' },
        h('span', { className: 'dmm-field-label' }, label),
        h('select', {
          className: 'dmm-select',
          value,
          disabled,
          'aria-label': label,
          onChange: (event) => onChange(event.target.value),
        },
        candidates.length === 0
          ? h('option', { value: '' }, t('repair.targetNone'))
          : candidates.map((preset) => h('option', {
            key: preset.id,
            value: preset.id,
            disabled: Boolean(preset.broken),
          }, preset.broken
            ? t('repair.targetBrokenOption', { name: presetDisplayName(t, preset) })
            : presetDisplayLabel(t, preset)))),
        candidates.length === 0 ? h('span', { className: 'dmm-field-hint is-bad' }, t('repair.targetNone')) : null)
    }

    function RepairDialog({ t, store, dialog, onClose, addToast }) {
      const snapshot = useAppStore(store)
      const presets = Array.isArray(snapshot.data?.presets) ? snapshot.data.presets : []
      const presetId = dialog.presetId
      const scan = dialog.scan
      const groups = Array.isArray(scan?.groups) ? scan.groups : []

      const [target, setTarget] = useState(() => pickDefaultTarget(presets, presetId))
      const [selected, setSelected] = useState(() => new Set())
      const [confirmAll, setConfirmAll] = useState(false)
      const [results, setResults] = useState(null)
      const [retryFor, setRetryFor] = useState(null)
      const [forkFor, setForkFor] = useState(null)
      const [rowError, setRowError] = useState(null)
      const activeKind = useRef('main')
      const retryId = useRef(null)

      const sessionTitles = new Map()
      for (const group of groups) {
        for (const session of Array.isArray(group.sessions) ? group.sessions : []) {
          sessionTitles.set(session.sessionId, sessionLabel(session))
        }
      }

      const handleFinished = (job) => {
        if (activeKind.current === 'main') {
          setResults(Array.isArray(job?.results) ? job.results : [])
          setRetryFor(null)
          return
        }
        if (activeKind.current === 'retry') {
          const id = retryId.current
          retryId.current = null
          activeKind.current = 'main'
          const next = Array.isArray(job?.results) && job.results.length > 0
            ? job.results[0]
            : { sessionId: id, status: 'failed', error: '' }
          setResults((previous) => (previous ?? []).map((entry) => (entry.sessionId === id ? next : entry)))
          setRetryFor(null)
        }
      }

      const { phase, job, error, start, cancel, cancelling } = useRepairJob(handleFinished)

      useEffect(() => {
        if (phase === 'error') {
          setRetryFor(null)
          setForkFor(null)
        }
      }, [phase])

      useEffect(() => {
        const stillValid = target !== '' && targetCandidates(presets, presetId).some((preset) => preset.id === target && !preset.broken)
        if (stillValid) return
        const next = pickDefaultTarget(presets, presetId)
        if (next !== target) setTarget(next)
      }, [presets, presetId, target])

      const repairableIdsOf = (group) => (Array.isArray(group.sessions) ? group.sessions : [])
        .filter((session) => session.live !== true && session.subagent !== true)
        .map((session) => session.sessionId)

      const repairableTotal = groups.reduce((total, group) => total + repairableIdsOf(group).length, 0)
      const selectedCount = selected.size
      const running = phase === 'starting' || phase === 'running'
      const done = results !== null

      const toggleSession = (session) => {
        if (session.live === true || session.subagent === true) return
        setSelected((previous) => {
          const next = new Set(previous)
          if (next.has(session.sessionId)) next.delete(session.sessionId)
          else next.add(session.sessionId)
          return next
        })
      }

      const toggleGroup = (group) => {
        const ids = repairableIdsOf(group)
        setSelected((previous) => {
          const next = new Set(previous)
          const allSelected = ids.length > 0 && ids.every((id) => next.has(id))
          if (allSelected) for (const id of ids) next.delete(id)
          else for (const id of ids) next.add(id)
          return next
        })
      }

      const confirmAllSelection = () => {
        const next = new Set()
        for (const group of groups) for (const id of repairableIdsOf(group)) next.add(id)
        setSelected(next)
        setConfirmAll(false)
      }

      const startRepair = async () => {
        if (running || done || selectedCount === 0 || target === '') return
        activeKind.current = 'main'
        retryId.current = null
        setResults(null)
        setConfirmAll(false)
        setRowError(null)
        await start({ presetId, targetPreset: target, sessionIds: [...selected] })
      }

      const retryOne = async (entry) => {
        if (running || retryFor !== null || forkFor !== null) return
        setRetryFor(entry.sessionId)
        setRowError(null)
        retryId.current = entry.sessionId
        activeKind.current = 'retry'
        await start({ presetId, targetPreset: target, sessionIds: [entry.sessionId] })
      }

      const forkOne = async (entry) => {
        if (running || retryFor !== null || forkFor !== null) return
        setForkFor(entry.sessionId)
        setRowError(null)
        try {
          await rpc('fork', { sessionId: entry.sessionId, targetPreset: target })
          addToast('success', t('repair.forked'))
          setResults((previous) => (previous ?? []).filter((item) => item.sessionId !== entry.sessionId))
        } catch (failure) {
          setRowError({ id: entry.sessionId, message: describeError(t, failure) })
        } finally {
          setForkFor(null)
        }
      }

      const skipOne = (entry) => {
        setRowError(null)
        setResults((previous) => (previous ?? []).filter((item) => item.sessionId !== entry.sessionId))
      }

      /** FR-REPAIR-12: export the per-session outcome as a plain-text table. */
      const exportResults = async () => {
        const rows = [['sessionId', 'status', 'title', 'error'].join('\t')]
        for (const entry of results ?? []) {
          rows.push([
            entry.sessionId,
            entry.status,
            sessionTitles.get(entry.sessionId) ?? entry.title ?? '',
            entry.error ?? '',
          ].map((value) => String(value).replace(/[\t\r\n]+/g, ' ')).join('\t'))
        }
        const ok = await writeClipboard(rows.join('\n'))
        addToast(ok ? 'success' : 'error', t(ok ? 'repair.exportDone' : 'repair.exportFailed'))
      }

      const selectionBody = h(React.Fragment, null,
        h('div', { className: 'dmm-notice' },
          h('span', { className: 'dmm-badge' }, t('repair.experimental')),
          ' ',
          t('repair.experimentalNote')),
        h('p', { className: 'dmm-note' }, t('repair.subtitle')),
        h(TargetSelect, {
          t,
          presets,
          excludedId: presetId,
          value: target,
          onChange: setTarget,
          disabled: running,
          label: t('repair.target'),
        }),
        repairableTotal === 0
          ? h('div', { className: 'dmm-warn' }, t('repair.noRepairable'))
          : h(React.Fragment, null,
            h('div', { className: 'dmm-row-actions', style: { justifyContent: 'flex-start' } },
              h(Btn, { className: 'dmm-btn-sm', disabled: running, onClick: () => setConfirmAll(true) }, t('repair.selectAll')),
              h(Btn, { className: 'dmm-btn-sm', disabled: running || selectedCount === 0, onClick: () => setSelected(new Set()) }, t('repair.selectNone'))),
            confirmAll ? h('div', { className: 'dmm-notice' },
              h('div', null, t('repair.confirmAllText', {
                count: repairableTotal,
                seconds: repairableTotal * REPAIR_SECONDS_PER_ITEM,
              })),
              h('div', { className: 'dmm-row-actions', style: { marginTop: '6px' } },
                h(Btn, { className: 'dmm-btn-sm', variant: 'primary', onClick: confirmAllSelection }, t('action.confirm')),
                h(Btn, { className: 'dmm-btn-sm', onClick: () => setConfirmAll(false) }, t('action.cancel')))) : null,
            groups.map((group, index) => {
              const ids = repairableIdsOf(group)
              const allSelected = ids.length > 0 && ids.every((id) => selected.has(id))
              return h('div', { key: String(group.workspaceId) + ':' + String(index), className: 'dmm-scan-group' },
                h('div', { className: 'dmm-scan-head' },
                  h('input', {
                    type: 'checkbox',
                    checked: allSelected,
                    disabled: ids.length === 0 || running,
                    'aria-label': groupTitle(t, group),
                    onChange: () => toggleGroup(group),
                  }),
                  h('div', { className: 'dmm-scan-head-main' },
                    h('div', { className: 'dmm-scan-title' }, groupTitle(t, group)),
                    typeof group.workspacePath === 'string' && group.workspacePath !== ''
                      ? h('div', { className: 'dmm-scan-path' }, group.workspacePath)
                      : null),
                  h('span', { className: 'dmm-fold-count' }, scanCountsText(t, group.sessions))),
                h('div', { className: 'dmm-scan-sessions' },
                  (Array.isArray(group.sessions) ? group.sessions : []).map((session) => {
                    const disabled = session.live === true || session.subagent === true
                    return h('label', {
                      key: session.sessionId,
                      className: 'dmm-check dmm-scan-row' + (disabled ? ' is-disabled' : ''),
                    },
                    h('input', {
                      type: 'checkbox',
                      checked: selected.has(session.sessionId),
                      disabled,
                      onChange: () => toggleSession(session),
                    }),
                    h('div', { className: 'dmm-scan-row-main' },
                      h('div', { className: 'dmm-scan-row-title' }, sessionLabel(session)),
                      h('span', { className: 'dmm-scan-row-id' }, session.sessionId),
                      session.live === true
                        ? h('span', { className: 'dmm-scan-hint' }, t('repair.liveHint'))
                        : (session.subagent === true
                          ? h('span', { className: 'dmm-scan-hint' }, t('repair.subagentHint'))
                          : null)),
                    h('div', { className: 'dmm-scan-tags' },
                      session.archived === true ? h('span', { className: 'dmm-badge' }, t('scan.archived')) : null,
                      session.live === true ? h('span', { className: 'dmm-badge is-live' }, t('scan.live')) : null,
                      session.subagent === true ? h('span', { className: 'dmm-badge' }, t('scan.subagent')) : null))
                  })))
            }),
            selectedCount === 0
              ? h('div', { className: 'dmm-note' }, t('repair.noneSelected'))
              : h('div', { className: 'dmm-note' }, t('repair.selected', {
                count: selectedCount,
                seconds: selectedCount * REPAIR_SECONDS_PER_ITEM,
              }))))

      const progressBody = h(React.Fragment, null,
        h('div', { className: 'dmm-progress' },
          h('div', { className: 'dmm-progress-meta' },
            h('span', null, t('repair.progress', {
              done: Number(job?.done) || 0,
              total: Number(job?.total) || selectedCount,
            })),
            h('span', null,
              String(Number(job?.total) > 0 ? Math.round(((Number(job?.done) || 0) / Number(job.total)) * 100) : 0) + '%'
              + (Number(job?.failed) > 0 ? ' · ' + t('repair.failedCount', { failed: Number(job.failed) }) : ''))),
          h('div', {
            className: 'dmm-progress-track',
            role: 'progressbar',
            'aria-valuenow': Number(job?.done) || 0,
            'aria-valuemin': 0,
            'aria-valuemax': Number(job?.total) || selectedCount,
            'aria-label': t('repair.progress', {
              done: Number(job?.done) || 0,
              total: Number(job?.total) || selectedCount,
            }),
          },
          h('div', {
            className: 'dmm-progress-fill',
            style: {
              width: String(Number(job?.total) > 0
                ? Math.min(100, Math.round(((Number(job?.done) || 0) / Number(job.total)) * 100))
                : 0) + '%',
            },
          }))),
        job !== null && job !== undefined && typeof job.current === 'string' && job.current !== ''
          ? h('div', { className: 'dmm-current' }, t('repair.current', {
            name: sessionTitles.get(job.current) ?? job.current,
          }))
          : null,
        phase === 'starting' ? h('div', { className: 'dmm-note' }, t('repair.starting')) : null)

      const resultsList = Array.isArray(results) ? results : []
      const repairedCount = resultsList.filter((entry) => entry.status === 'repaired').length
      const failedRows = resultsList.filter((entry) => entry.status === 'failed')
      const skippedCount = resultsList.length - repairedCount - failedRows.length
      const resultsBody = h(React.Fragment, null,
        h('div', { className: 'dmm-row-actions', style: { justifyContent: 'flex-start', marginBottom: '8px' } },
          h(Btn, { className: 'dmm-btn-sm', onClick: () => void exportResults() }, t('repair.export'))),
        h('div', { className: 'dmm-field-label' }, t('repair.summary')),
        job !== null && job !== undefined && job.cancelled === true
          ? h('div', { className: 'dmm-notice' }, t('repair.cancelled'))
          : null,
        h('div', { className: 'dmm-stats' },
          h('div', { className: 'dmm-stat is-ok' },
            h('div', { className: 'dmm-stat-label' }, t('repair.stat.repaired')),
            h('div', { className: 'dmm-stat-value' }, String(repairedCount))),
          h('div', { className: 'dmm-stat' + (failedRows.length > 0 ? ' is-bad' : '') },
            h('div', { className: 'dmm-stat-label' }, t('repair.stat.failed')),
            h('div', { className: 'dmm-stat-value' }, String(failedRows.length))),
          h('div', { className: 'dmm-stat' },
            h('div', { className: 'dmm-stat-label' }, t('repair.stat.skipped')),
            h('div', { className: 'dmm-stat-value' }, String(skippedCount)))),
        failedRows.length === 0
          ? null
          : h(React.Fragment, null,
            h('div', { className: 'dmm-field-label' }, t('repair.failedTitle')),
            h('div', { className: 'dmm-result-list' },
              failedRows.map((entry) => h('div', { key: entry.sessionId, className: 'dmm-result' },
                h('div', { className: 'dmm-result-head' },
                  h('span', null, sessionTitles.get(entry.sessionId) ?? (entry.title !== undefined && entry.title !== '' ? entry.title : entry.sessionId)),
                  h('span', { className: 'dmm-card-id' }, entry.sessionId)),
                entry.error !== undefined && entry.error !== null && entry.error !== ''
                  ? h('div', { className: 'dmm-result-error' }, String(entry.error))
                  : null,
                rowError !== null && rowError.id === entry.sessionId
                  ? h('div', { className: 'dmm-result-error' }, rowError.message)
                  : null,
                h('div', { className: 'dmm-result-actions' },
                  h(Btn, {
                    className: 'dmm-btn-sm',
                    disabled: retryFor !== null || forkFor !== null,
                    onClick: () => void retryOne(entry),
                  }, retryFor === entry.sessionId ? t('repair.starting') : t('repair.retry')),
                  h(Btn, {
                    className: 'dmm-btn-sm',
                    disabled: retryFor !== null || forkFor !== null,
                    onClick: () => void forkOne(entry),
                  }, forkFor === entry.sessionId ? t('repair.starting') : t('repair.fork')),
                  h(Btn, {
                    className: 'dmm-btn-sm',
                    disabled: retryFor !== null || forkFor !== null,
                    onClick: () => skipOne(entry),
                  }, t('repair.skip'))))))))

      const retrying = running && retryFor !== null
      const body = retrying ? progressBody : (done ? resultsBody : (running ? progressBody : selectionBody))
      const requestClose = () => {
        if (running) {
          // Closing the only progress view must also stop the Host queue;
          // already-repaired sessions stay repaired.
          void cancel()
        }
        onClose()
      }
      const footer = done
        ? [h(Btn, { key: 'close', variant: 'primary', onClick: onClose }, t('action.close'))]
        : running
          ? [
            h(Btn, {
              key: 'cancel',
              disabled: cancelling || phase === 'starting',
              onClick: () => void cancel(),
            }, cancelling ? t('repair.cancelling') : t('repair.cancel')),
            h(Btn, { key: 'cancel-close', onClick: requestClose }, t('repair.cancelClose')),
          ]
          : [
            h(Btn, { key: 'later', onClick: onClose }, t('repair.later')),
            h(Btn, {
              key: 'start',
              variant: 'primary',
              disabled: selectedCount === 0 || target === '' || phase === 'starting',
              onClick: () => void startRepair(),
            }, phase === 'starting' ? t('repair.starting') : t('repair.start')),
          ]

      return h(Modal, {
        title: t('repair.title', { count: Number(scan?.totals?.total) || 0 }),
        closeLabel: t('action.close'),
        size: 'lg',
        onClose: requestClose,
        footer,
      },
      error !== null && error !== undefined ? h('div', { className: 'dmm-error', role: 'alert' }, describeError(t, error)) : null,
      body)
    }

    // ---------------------------------------------------------------------
    // Open-old-session dialog
    // ---------------------------------------------------------------------

    function OnOpenDialog({ t, store, dialog, onLater, addToast }) {
      const snapshot = useAppStore(store)
      const presets = Array.isArray(snapshot.data?.presets) ? snapshot.data.presets : []
      const info = dialog.info ?? {}
      const live = info.live === true
      const [target, setTarget] = useState(() => pickDefaultTarget(presets, info.preset))
      const [phase, setPhase] = useState('idle')
      const [error, setError] = useState(null)
      const running = phase === 'running'

      const fix = async () => {
        if (running || live || target === '') return
        setPhase('running')
        setError(null)
        try {
          const result = await rpc('repairOne', { sessionId: info.sessionId, targetPreset: target })
          if (result !== null && result !== undefined && result.status === 'repaired') {
            addToast('success', t('onopen.fixed'))
            onLater()
          } else {
            setPhase('error')
            const statusText = statusLabel(t, result?.status)
            setError(result !== null && result !== undefined && result.error !== undefined && result.error !== ''
              ? String(result.error)
              : (statusText === '' ? t('err.unknown') : statusText))
          }
        } catch (failure) {
          setPhase('error')
          setError(describeError(t, failure))
        }
      }

      return h(Modal, {
        title: t('onopen.title'),
        closeLabel: t('action.close'),
        onClose: onLater,
        footer: [
          h(Btn, { key: 'later', onClick: onLater }, t('onopen.later')),
          live
            ? null
            : h(Btn, {
              key: 'fix',
              variant: 'primary',
              disabled: running || target === '',
              onClick: () => void fix(),
            }, running ? t('onopen.fixing') : (phase === 'error' ? t('action.retry') : t('onopen.fix'))),
        ],
      },
      h('p', { className: 'dmm-note' }, t('onopen.desc', {
        title: info.title !== undefined && info.title !== '' ? String(info.title) : String(info.sessionId ?? ''),
        preset: String(info.preset ?? ''),
      })),
      live ? h('div', { className: 'dmm-warn' }, t('onopen.liveOnly')) : null,
      live
        ? null
        : h(TargetSelect, {
          t,
          presets,
          excludedId: info.preset,
          value: target,
          onChange: setTarget,
          disabled: running,
          label: t('onopen.target'),
        }),
      h('p', { className: 'dmm-note' }, t('onopen.note')),
      error !== null ? h('div', { className: 'dmm-error', role: 'alert' }, error) : null)
    }

    // ---------------------------------------------------------------------
    // Overlay host: dialogs, toasts, and the open-session watcher
    // ---------------------------------------------------------------------

    function OverlayHostView(props) {
      const { t, store, ctx, loadData, addToast, openOverlay, closeOverlay } = props
      const snapshot = useAppStore(store)
      const dismissed = useRef(null)

      useEffect(() => {
        let disposed = false
        let inFlight = false
        let lastSeen
        const mountedAt = Date.now()
        const tick = async () => {
          if (disposed || inFlight) return
          const sessionId = readOpenSessionId(ctx)
          if (typeof sessionId !== 'string') {
            // No session is open any more: the next open of the same session is
            // a new visit, so a previous "not now" must not silence it.
            lastSeen = undefined
            dismissed.current = null
            return
          }
          if (store.getSnapshot().overlay !== null) return
          if (sessionId === lastSeen) return
          lastSeen = sessionId
          if (dismissed.current !== null && dismissed.current !== sessionId) dismissed.current = null
          if (Date.now() - mountedAt < STARTUP_GRACE_MS) return
          if (dismissed.current === sessionId) return
          inFlight = true
          try {
            const info = await rpc('sessionInfo', { sessionId })
            if (disposed) return
            if (store.getSnapshot().overlay !== null) return
            if (info === null || info === undefined || info.exists === false) return
            if (info.missing !== true) return
            // A session that has not started its first turn can still be reused
            // by the shipped preset picker; only started sessions warrant this
            // dialog (CONTRACT §6, FR-ONOPEN detection rule).
            if (info.started === false) return
            if (store.getSnapshot().data === null) {
              try {
                await loadData()
              } catch {
                // the dialog still opens with an empty target list
              }
            }
            if (disposed) return
            if (store.getSnapshot().overlay !== null) return
            openOverlay({ kind: 'onopen', sessionId, info })
          } catch {
            // sessionInfo is advisory; a failure must never disturb the page.
          } finally {
            inFlight = false
          }
        }
        const timer = setInterval(() => {
          void tick()
        }, POLL_SESSION_MS)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [ctx, store, loadData, openOverlay])

      let node = null
      const overlay = snapshot.overlay
      if (overlay !== null && overlay !== undefined) {
        if (overlay.kind === 'view') {
          node = h(ViewDialog, { key: 'view', t, store, dialog: overlay, onClose: closeOverlay, addToast })
        } else if (overlay.kind === 'wizard') {
          node = h(Wizard, {
            key: 'wizard',
            t,
            store,
            dialog: overlay,
            onClose: closeOverlay,
            loadData,
            addToast,
            setHighlight: props.setHighlight,
          })
        } else if (overlay.kind === 'delete') {
          node = h(DeleteDialog, {
            key: 'delete',
            t,
            dialog: overlay,
            onClose: closeOverlay,
            loadData,
            addToast,
            openOverlay,
          })
        } else if (overlay.kind === 'repair') {
          node = h(RepairDialog, { key: 'repair', t, store, dialog: overlay, onClose: closeOverlay, addToast })
        } else if (overlay.kind === 'onopen') {
          node = h(OnOpenDialog, {
            key: 'onopen',
            t,
            store,
            dialog: overlay,
            addToast,
            onLater: () => {
              dismissed.current = overlay.sessionId
              closeOverlay()
            },
          })
        }
      }

      return h(React.Fragment, null, node, h(ToastHost, { store }))
    }

    // ---------------------------------------------------------------------
    // Slot roots
    // ---------------------------------------------------------------------

    function OverlayHostRoot(props) {
      return h(SilentBoundary, null, h(OverlayHostView, props))
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'mode-manager: dictionaries')
        const t = ctx.locale.bind(NS)
        ensureStyles()

        const store = createStore({
          status: 'idle',
          data: null,
          error: null,
          highlight: null,
          overlay: null,
          toasts: [],
        })

        let toastSeq = 0
        const addToast = (kind, text) => {
          if (typeof text !== 'string' || text === '') return
          const id = ++toastSeq
          store.update((snapshot) => ({ ...snapshot, toasts: snapshot.toasts.concat({ id, kind, text }) }))
        }
        store.dismissToast = (id) => {
          store.update((snapshot) => ({ ...snapshot, toasts: snapshot.toasts.filter((item) => item.id !== id) }))
        }
        const openOverlay = (overlay) => {
          store.update((snapshot) => ({ ...snapshot, overlay }))
        }
        const closeOverlay = () => {
          store.update((snapshot) => ({ ...snapshot, overlay: null }))
        }
        const setHighlight = (id) => {
          store.update((snapshot) => ({ ...snapshot, highlight: id }))
        }

        const loadData = async () => {
          store.update((snapshot) => ({ ...snapshot, status: 'loading', error: null }))
          try {
            const data = await rpc('state')
            store.update((snapshot) => ({ ...snapshot, status: 'ready', data, error: null }))
            return data
          } catch (error) {
            store.update((snapshot) => ({ ...snapshot, status: 'error', error }))
            return null
          }
        }

        const refreshBackups = async () => {
          try {
            const data = await rpc('backups')
            store.update((snapshot) => (snapshot.data === null
              ? snapshot
              : { ...snapshot, data: { ...snapshot.data, backups: Array.isArray(data?.backups) ? data.backups : [] } }))
            return data
          } catch {
            return null
          }
        }

        // The page is registered with a closure rather than `inject` so its
        // handlers cannot be lost if the slot stops forwarding injected props.
        const MainPage = (slotProps) => h(PageErrorBoundary, {
          t: slotProps.t ?? t,
          retry: loadData,
        }, h(PageView, {
          ...slotProps,
          t: slotProps.t ?? t,
          store,
          loadData,
          addToast,
          openOverlay,
          closeOverlay,
          refreshBackups,
          setHighlight,
          onBack: () => {
            // FR-UI-02: leave this global page and return to the conversation.
            try {
              ctx.get('layout')?.selectPanel?.(null)
            } catch {
              // The layout service is optional; the sidebar entries still work.
            }
          },
        }))

        const overlayInjected = () => ({
          store,
          ctx,
          t,
          loadData,
          addToast,
          openOverlay,
          closeOverlay,
          refreshBackups,
          setHighlight,
        })

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => t('nav'),
          locale: NS,
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, MainPage))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: OVERLAY_ID,
          order: 120,
          locale: NS,
          inject: overlayInjected,
        }, OverlayHostRoot))
      },
    }
  },
})
