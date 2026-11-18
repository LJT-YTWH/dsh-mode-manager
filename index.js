/**
 * Host half of the Mode manager bundle (`@local/dsh-mode-manager`).
 *
 * The browser half reaches this module through one authenticated Connection
 * Fetch route. Every operation lives here because only the Host can read the
 * preset registry, the Session corpus, the workspace registry, and the plugin
 * manager.
 *
 * Two mechanisms deserve a note up front, because they are the reason this
 * package exists:
 *
 *  - **A preset is a bundle patch.** The shipped Agent-preset registry has no
 *    write API: a preset is created by installing a bundle that inserts a
 *    `@deepseek-ai/dsh-agent-preset` row, changed by reinstalling that bundle,
 *    and removed by removing the bundle. This module generates such a bundle
 *    under `$DSH_HOME/preset-creator/<id>/` and installs it with
 *    `ctx.pluginManager.installBundle()`; the profile files stay owned by the
 *    plugin manager.
 *  - **Deleting a preset breaks the sessions that recorded it.** Recovery reads
 *    the current definition of the recorded preset id, so a missing definition
 *    refuses to resume. `repair()` therefore resumes a cold Session with its
 *    own setup that mounts the replacement preset and appends the ordinary
 *    `agent-preset/selected` event — the same committed event the shipped
 *    selection path writes — then disposes the temporary Agent immediately.
 *
 * The module has no runtime dependency: only `node:*` builtins are imported, so
 * the pure generator, validation, and analysis functions can be imported and
 * unit-tested outside DSH.
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

/** The one route the browser half calls. */
export const ROUTE = '/api/mode-manager.rpc'
/** Sidebar entry id, also the `main` panel key. */
export const PANEL_ID = 'mode-manager'
/** Preset ids shipped by `@deepseek-ai/dsh-web-app`; never deletable. */
export const OFFICIAL_PRESETS = Object.freeze(['standard', 'ptc', 'minimal', 'cordis'])
/** Loader row id prefix for a preset declaration. */
export const ROW_PREFIX = 'preset-'
/** Package-name prefix of a generated preset bundle. */
export const BUNDLE_PREFIX = '@local/dsh-preset-'

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const NAME_MAX = 40
const DESCRIPTION_MAX = 120
const ORDER_MIN = 0
const ORDER_MAX = 999
const DEFAULT_ORDER = 10
const BACKUP_KEEP = 20
const REPAIR_TIMEOUT_MS = 30_000
const ROSTER_WAIT_MS = 10_000

const DEFAULT_PERSONA_STANDARD = 'You are a coding agent powered by the {{model}} model.'
const DEFAULT_PERSONA_HELPFUL = 'You are a helpful software engineer assistant.'

/**
 * The shipped plan-mode instruction, copied verbatim from the official
 * `standard` preset so a generated plan-mode group behaves the same way.
 */
export const PLAN_MODE_SECTION = `You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`

/** Wrap a Loader `!!js` expression so the emitter writes it unquoted. */
const js = (expression) => ({ __js: expression })

/** The skill directory expression the official standard preset uses. */
const SKILL_DIRS_EXPRESSION = "process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')"

/* ------------------------------------------------------------------ */
/* Capability catalog                                                  */
/* ------------------------------------------------------------------ */

/**
 * The capability ids the wizard can tick, grouped for the picker. `danger`
 * marks a capability that can modify the machine.
 */
export const CAPABILITY_GROUPS = Object.freeze([
  {
    id: 'files',
    items: [
      { id: 'fileRead' },
      { id: 'fileWrite' },
      { id: 'fileEdit' },
      { id: 'fileImage' },
      { id: 'filePatch' },
      { id: 'fsSearch' },
    ],
  },
  { id: 'shell', items: [{ id: 'shell', danger: true }, { id: 'persistentShell', danger: true }] },
  { id: 'web', items: [{ id: 'webSearch' }, { id: 'webFetch' }] },
  {
    id: 'delegation',
    items: [
      { id: 'subagentControl' },
      { id: 'subagentSpawn' },
      { id: 'subagentFork' },
      { id: 'workflowPtc' },
      { id: 'workflowTool' },
    ],
  },
  { id: 'plan', items: [{ id: 'plan' }] },
  { id: 'skills', items: [{ id: 'skillFilesystem' }, { id: 'skillTool' }] },
  {
    id: 'assist',
    items: [
      { id: 'todo' },
      { id: 'jobs' },
      { id: 'schedule' },
      { id: 'commandGoal' },
      { id: 'toolGoal' },
      { id: 'askUser' },
      { id: 'present' },
      { id: 'office' },
    ],
  },
  { id: 'context', items: [{ id: 'timeContext' }, { id: 'agentInstructions' }] },
  {
    id: 'tools',
    items: [
      { id: 'pluginManagerTools' },
      { id: 'pluginMarketTools' },
      { id: 'cordisTool' },
      { id: 'ptcExecutor' },
    ],
  },
])

/**
 * Every valid capability id. The aggregate ids (`web`, `subagent`, `skills`,
 * `goal`, `pluginTools`) are retired from the picker but stay valid so presets
 * created by earlier versions keep loading and editing.
 */
export const CAPABILITY_IDS = Object.freeze([
  ...CAPABILITY_GROUPS.flatMap((group) => group.items.map((item) => item.id)),
  'web', 'subagent', 'skills', 'goal', 'pluginTools',
])

/** The three built-in starting points offered by the wizard. */
export const TEMPLATES = Object.freeze([
  {
    id: 'standard',
    capabilities: [
      'fileRead', 'fileWrite', 'fileEdit', 'fsSearch', 'shell', 'webSearch', 'webFetch',
      'subagentControl', 'subagentSpawn', 'subagentFork', 'workflowPtc', 'workflowTool', 'plan',
      'skillFilesystem', 'skillTool', 'todo', 'jobs', 'schedule', 'commandGoal', 'toolGoal',
      'askUser', 'present', 'office', 'pluginManagerTools', 'pluginMarketTools',
      'timeContext', 'agentInstructions',
    ],
    persona: DEFAULT_PERSONA_STANDARD,
  },
  {
    id: 'minimal',
    capabilities: ['fileImage', 'persistentShell'],
    persona: DEFAULT_PERSONA_HELPFUL,
  },
  {
    id: 'blank',
    capabilities: [],
    persona: DEFAULT_PERSONA_HELPFUL,
  },
])

/** The limits the browser half validates against before submitting. */
export const LIMITS = Object.freeze({
  idPattern: ID_RE.source,
  nameMax: NAME_MAX,
  descriptionMax: DESCRIPTION_MAX,
  orderMin: ORDER_MIN,
  orderMax: ORDER_MAX,
  capabilities: CAPABILITY_IDS,
})

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Wrap an installed-but-not-live plugin-manager outcome. The caller keeps the
 * installed bundle and its directory; only activation needs a restart.
 * @param id - preset id.
 * @param result - the plugin manager's ChangeResult.
 * @returns the tagged RpcError carrying `keepBundle` and `application`.
 */
function installedButNotLive(id, result) {
  const restart = result.application === 'restart-required'
  const error = new RpcError(
    'plugin/restart-required',
    restart
      ? 'the mode bundle installed but DSH must restart before it is live'
      : 'a higher-priority profile layer overrides the mode bundle; it is installed but not active',
    { details: { application: result.application, presetId: id } },
  )
  error.keepBundle = true
  error.application = result.application
  return error
}

/** An RPC failure carrying a stable machine-readable code. */
export class RpcError extends Error {
  /**
   * @param code - stable failure code the browser localizes.
   * @param message - English diagnostic for logs and unknown-code fallback.
   * @param options - optional field name, structured details, suggested status.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    if (options.field !== undefined) this.field = options.field
    if (options.details !== undefined) this.details = options.details
    if (options.status !== undefined) this.suggestedStatus = options.status
  }
}

const STATUS_OF = {
  'validation': 400,
  'preset/not-found': 404,
  'preset/id-conflict': 409,
  'preset/name-conflict': 409,
  'preset/default-in-use': 409,
  'preset/not-managed': 409,
  'preset/broken-target': 409,
  'preset/create-broken': 500,
  'plugin/install-failed': 500,
  'plugin/remove-failed': 500,
  'plugin/restart-required': 409,
  'repair/job-not-found': 404,
  'repair/no-target': 400,
  'backup/not-found': 404,
  'internal/error': 500,
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

const pad = (spaces) => ' '.repeat(spaces)

const isScalar = (value) =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean' ||
  (typeof value === 'object' && typeof value.__js === 'string')

const plainKey = (key) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)

/**
 * Emit a Loader expression. A plain scalar is only safe when it cannot open with
 * a YAML indicator (the official patch quotes `!ctx.get(...)` for that reason)
 * and carries no comment or mapping punctuation; everything else is a quoted
 * scalar, which the Loader still evaluates as the same expression text.
 */
const jsScalar = (expression) => /^[A-Za-z0-9_$]/.test(expression) && !/:\s/.test(expression) && !/\s#/.test(expression)
  ? `!!js ${expression}`
  : `!!js ${JSON.stringify(expression)}`

const scalarText = (value) => {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot emit a non-finite number')
    return String(value)
  }
  if (typeof value === 'object' && typeof value.__js === 'string') return jsScalar(value.__js)
  // JSON string escaping is a valid YAML double-quoted scalar and keeps user
  // text (quotes, backslashes, newlines) out of the YAML grammar.
  return JSON.stringify(value)
}

/**
 * Emit one YAML document from plain JavaScript values.
 *
 * Supported: mappings, sequences, strings (always double-quoted), finite
 * numbers, booleans, null, and `{ __js }` Loader expressions. Duplicate keys are
 * impossible because object identity supplies them.
 * @param value - the document root.
 * @param indent - current indentation width.
 * @returns YAML text.
 */
export function emitYaml(value, indent = 0) {
  if (isScalar(value)) return pad(indent) + scalarText(value) + '\n'
  if (Array.isArray(value)) return emitYamlArray(value, indent)
  return emitYamlObject(value, indent)
}

function emitYamlObject(object, indent) {
  let out = ''
  for (const [key, value] of Object.entries(object)) {
    const label = plainKey(key) ? key : JSON.stringify(key)
    if (isScalar(value)) {
      out += pad(indent) + label + ': ' + scalarText(value) + '\n'
    } else if (Array.isArray(value)) {
      out += value.length === 0
        ? pad(indent) + label + ': []\n'
        : pad(indent) + label + ':\n' + emitYamlArray(value, indent + 2)
    } else {
      out += Object.keys(value).length === 0
        ? pad(indent) + label + ': {}\n'
        : pad(indent) + label + ':\n' + emitYamlObject(value, indent + 2)
    }
  }
  return out
}

function emitYamlArray(array, indent) {
  let out = ''
  for (const item of array) {
    if (isScalar(item)) {
      out += pad(indent) + '- ' + scalarText(item) + '\n'
    } else if (Array.isArray(item)) {
      out += pad(indent) + '-\n' + emitYamlArray(item, indent + 2)
    } else {
      const rendered = emitYamlObject(item, indent + 2)
      out += pad(indent) + '- ' + rendered.slice(indent + 2)
    }
  }
  return out
}

/**
 * Turn a display name into a preset id candidate.
 *
 * Non-ASCII names keep a stable short hash suffix, because preset ids must match
 * `[a-z0-9-]`; the user can still edit the generated value before creation.
 * @param name - the display name.
 * @returns a valid id candidate, bounded to 32 characters.
 */
export function slugifyPresetId(name) {
  const ascii = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  if (ascii.length > 0) return ascii
  // Deterministic fallback so the field is never empty for a non-Latin name.
  const compact = String(name ?? '').replace(/\s+/g, '')
  let hash = 0
  for (const char of compact) hash = (hash * 31 + char.codePointAt(0)) >>> 0
  return 'mode-' + hash.toString(36).slice(0, 6)
}

/**
 * Build the declaration's child plugin list from a capability set.
 *
 * The order is fixed: persona, prompt context, files, shell, network,
 * delegation, planning, skills, assistance, plugin tooling, then the mandatory
 * compaction group last.
 * @param draft - normalized draft.
 * @returns Cordis entry list for the preset's `config.plugins`.
 */
export function buildPresetRows(draft) {
  const caps = new Set(Array.isArray(draft.capabilities) ? draft.capabilities : [])
  const has = (...ids) => ids.some((id) => caps.has(id))
  const persona = typeof draft.persona === 'string' && draft.persona.trim() !== ''
    ? draft.persona.trim()
    : DEFAULT_PERSONA_HELPFUL
  const rows = [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: persona } }]

  if (caps.has('agentInstructions')) {
    rows.push({ id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } })
  }
  if (caps.has('timeContext')) rows.push({ id: 'time-context', name: '@deepseek-ai/dsh-time-context' })

  if (has('fileRead', 'fileWrite', 'fileEdit', 'fileImage', 'filePatch')) {
    rows.push({
      id: 'tool-fs',
      name: '@deepseek-ai/dsh-tool-fs',
      config: {
        read: caps.has('fileRead'),
        // Reading text has always implied image reading for presets created by
        // earlier versions; `fileImage` enables it alone (the minimal layout).
        readImage: caps.has('fileRead') || caps.has('fileImage'),
        write: caps.has('fileWrite'),
        edit: caps.has('fileEdit'),
        applyPatch: caps.has('filePatch'),
      },
    })
  }
  if (caps.has('fsSearch')) {
    rows.push({ id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } })
  }
  if (caps.has('shell')) {
    rows.push(
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: js("process.platform === 'win32'") },
      { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: js("process.platform !== 'win32'") },
    )
  }
  if (caps.has('persistentShell')) {
    rows.push({
      id: 'persistent-shell',
      name: 'cordis:group',
      group: true,
      isolate: { terminals: true },
      config: [
        { id: 'pty', name: '@deepseek-ai/dsh-terminal' },
        {
          id: 'terminal-bash',
          name: '@deepseek-ai/dsh-terminal-bash',
          disabled: js("process.platform === 'win32'"),
          config: { timeoutMs: 300000 },
        },
        {
          id: 'persistent-bash',
          name: '@deepseek-ai/dsh-tool-bash-persistent',
          disabled: js("process.platform === 'win32'"),
          config: { timeoutMs: 300000 },
        },
        {
          id: 'terminal-pwsh',
          name: '@deepseek-ai/dsh-terminal-bash',
          disabled: js("process.platform !== 'win32'"),
          config: { shellDialect: 'pwsh', timeoutMs: 300000 },
        },
        {
          id: 'persistent-pwsh',
          name: '@deepseek-ai/dsh-tool-pwsh-persistent',
          disabled: js("process.platform !== 'win32'"),
          config: { timeoutMs: 300000 },
        },
      ],
    })
  }
  const wantSearch = caps.has('web') || caps.has('webSearch')
  const wantFetch = caps.has('web') || caps.has('webFetch')
  if (wantSearch || wantFetch) {
    rows.push({
      id: 'tool-web',
      name: '@deepseek-ai/dsh-tool-web',
      config: {
        search: wantSearch,
        fetch: wantFetch,
        ...(wantSearch ? { searchTimeoutMs: 60000 } : {}),
      },
    })
  }
  const legacySubagent = caps.has('subagent')
  if (legacySubagent || has('subagentControl', 'subagentSpawn', 'subagentFork', 'workflowPtc', 'workflowTool')) {
    const delegation = []
    if (legacySubagent || caps.has('subagentControl')) {
      delegation.push({ id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control', config: { interrupt: false } })
    }
    if (legacySubagent || caps.has('subagentSpawn')) {
      delegation.push({
        id: 'tool-subagent',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true },
      })
    }
    if (legacySubagent || caps.has('subagentFork')) {
      delegation.push({
        id: 'tool-subagent-fork',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'fork', toolName: 'subagent_fork' },
      })
    }
    if (legacySubagent || caps.has('workflowPtc')) {
      delegation.push({ id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } })
    }
    if (legacySubagent || caps.has('workflowTool')) {
      delegation.push({ id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' })
    }
    rows.push({ id: 'delegation', name: 'cordis:group', group: true, isolate: { workflowEngine: true }, config: delegation })
  }
  if (caps.has('plan')) {
    rows.push({
      id: 'planning',
      name: 'cordis:group',
      group: true,
      isolate: { planMode: true },
      config: [{ id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', config: { section: PLAN_MODE_SECTION } }],
    })
  }
  const legacySkills = caps.has('skills')
  if (legacySkills || caps.has('skillFilesystem')) {
    rows.push({ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: { customSkillDirs: [js(SKILL_DIRS_EXPRESSION)] } })
  }
  if (legacySkills || caps.has('skillTool')) rows.push({ id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' })
  if (caps.has('todo')) rows.push({ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } })
  if (caps.has('jobs')) rows.push({ id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' })
  if (caps.has('schedule')) rows.push({ id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' })
  if (caps.has('goal') || caps.has('commandGoal')) rows.push({ id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' })
  if (caps.has('goal') || caps.has('toolGoal')) rows.push({ id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' })
  if (caps.has('askUser')) rows.push({ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' })
  if (caps.has('present')) rows.push({ id: 'present', name: '@deepseek-ai/dsh-tool-present' })
  if (caps.has('office')) rows.push({ id: 'tool-office', name: '@deepseek-ai/dsh-tool-office' })
  const legacyPluginTools = caps.has('pluginTools')
  if (legacyPluginTools || caps.has('pluginManagerTools')) {
    rows.push({
      id: 'tool-plugin-manager',
      name: '@deepseek-ai/dsh-plugin-manager/tools',
      disabled: js("!ctx.get('profileContext')"),
    })
  }
  if (legacyPluginTools || caps.has('pluginMarketTools')) {
    rows.push({ id: 'tool-plugin-market', name: '@deepseek-ai/dsh-plugin-market/tools', disabled: true })
  }
  if (caps.has('cordisTool')) rows.push({ id: 'tool-cordis', name: '@deepseek-ai/dsh-tool-cordis' })
  if (caps.has('ptcExecutor')) rows.push({ id: 'tool-executor-ptc', name: '@deepseek-ai/dsh-tool-executor-ptc' })
  // Compaction is mandatory: a long session without it overflows its context.
  rows.push({
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      {
        id: 'tool-result-pruner',
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      },
    ],
  })
  return rows
}

/** The bundle package name for one preset id. */
export function packageNameOf(id) {
  return BUNDLE_PREFIX + id
}

/**
 * Render the generated bundle patch.
 * @param draft - normalized draft (id/name/description/order/capabilities/persona).
 * @returns YAML text for `cordis.patch.yml`.
 */
export function renderBundlePatch(draft) {
  const config = { id: draft.id }
  if (draft.name !== undefined && draft.name !== '') config.name = draft.name
  if (draft.description !== undefined && draft.description !== '') config.description = draft.description
  if (draft.order !== undefined) config.order = draft.order
  config.plugins = buildPresetRows(draft)
  const document = [{
    insert: [{ id: ROW_PREFIX + draft.id, name: '@deepseek-ai/dsh-agent-preset', config }],
  }]
  return '# Generated by @local/dsh-mode-manager. Use the Mode manager page; hand edits are replaced on the next save.\n'
    + emitYaml(document, 0)
}

/**
 * Render a bundle patch whose `config.plugins` is a source declaration's entry
 * list copied verbatim. Used by "import an existing mode as a template": the
 * official rows (including `!!js` conditions and groups) are re-indented into
 * this generated declaration, so the clone composes exactly like the source.
 * @param draft - normalized draft (id/name/description/order).
 * @param rowsYaml - the source preset's plugins entry list, as `readDocument` returns it.
 * @returns YAML text for `cordis.patch.yml`.
 */
export function renderBundlePatchImported(draft, rowsYaml) {
  const lines = ['# Generated by @local/dsh-mode-manager. Composition imported from an existing mode; hand edits are replaced on the next save.']
  lines.push('- insert:')
  lines.push('    - id: ' + JSON.stringify(ROW_PREFIX + draft.id))
  lines.push('      name: "@deepseek-ai/dsh-agent-preset"')
  lines.push('      config:')
  lines.push('        id: ' + JSON.stringify(draft.id))
  if (draft.name !== undefined && draft.name !== '') lines.push('        name: ' + JSON.stringify(draft.name))
  if (draft.description !== undefined && draft.description !== '') lines.push('        description: ' + JSON.stringify(draft.description))
  if (draft.order !== undefined) lines.push('        order: ' + String(draft.order))
  lines.push('        plugins:')
  const body = String(rowsYaml).replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  for (const line of body.split('\n')) lines.push(line === '' ? '' : '          ' + line)
  return lines.join('\n') + '\n'
}

/**
 * Render the generated bundle manifest.
 * @param id - preset id (also the dependency name suffix).
 * @param version - semantic version string.
 * @returns JSON text for `package.json`.
 */
export function renderBundlePackageJson(id, version = '1.0.0') {
  return JSON.stringify({
    name: packageNameOf(id),
    version,
    private: true,
    type: 'module',
    description: `Agent preset "${id}" generated by @local/dsh-mode-manager.`,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n'
}

/**
 * The metadata sidecar that makes an edit round-trip lossless. It never affects
 * the Loader: it lives beside the two files the bundle patch needs.
 * @param draft - normalized draft.
 * @param template - template id that produced it, when any.
 * @returns JSON text for `mode-manager.json`.
 */
export function renderBundleMetadata(draft, template = 'custom', extra = undefined) {
  const now = Date.now()
  const override = extra !== null && typeof extra === 'object' ? extra : {}
  return JSON.stringify({
    format: 1,
    id: draft.id,
    name: draft.name,
    description: draft.description ?? '',
    order: draft.order ?? DEFAULT_ORDER,
    capabilities: Array.isArray(override.capabilities) ? override.capabilities : (draft.capabilities ?? []),
    persona: typeof override.persona === 'string' ? override.persona : (draft.persona ?? ''),
    ...(override.fidelity === 'raw' ? { fidelity: 'raw' } : {}),
    ...(typeof override.importedFrom === 'string' ? { importedFrom: override.importedFrom } : {}),
    template,
    createdAt: now,
    updatedAt: now,
  }, null, 2) + '\n'
}

/**
 * Normalize and validate a draft without touching the filesystem.
 * @param input - untrusted draft object.
 * @param options.existingIds - preset ids already declared.
 * @param options.existingBundleNames - bundle package names already declared.
 * @param options.lockId - when editing, the id that must not change.
 * @returns `{ ok: true, draft }` or `{ ok: false, error }` where error is an RpcError.
 */
export function validateDraft(input, options = {}) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  const name = typeof source.name === 'string' ? source.name.trim() : ''
  const description = typeof source.description === 'string' ? source.description.trim() : ''
  const persona = typeof source.persona === 'string' ? source.persona : ''
  const rawOrder = source.order
  const capabilities = Array.isArray(source.capabilities)
    ? [...new Set(source.capabilities.filter((value) => typeof value === 'string'))]
    : []

  if (options.lockId !== undefined && id !== options.lockId) {
    return { ok: false, error: new RpcError('validation', 'the preset id cannot change while editing', { field: 'id' }) }
  }
  if (!ID_RE.test(id)) {
    return {
      ok: false,
      error: new RpcError('validation', 'id must match ^[a-z0-9][a-z0-9-]{0,31}$', { field: 'id' }),
    }
  }
  if (name.length < 1 || name.length > NAME_MAX) {
    return { ok: false, error: new RpcError('validation', `name must be 1-${NAME_MAX} characters`, { field: 'name' }) }
  }
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, error: new RpcError('validation', `description must be at most ${DESCRIPTION_MAX} characters`, { field: 'description' }) }
  }
  let order = DEFAULT_ORDER
  if (rawOrder !== undefined && rawOrder !== null && rawOrder !== '') {
    const parsed = typeof rawOrder === 'number' ? rawOrder : Number(String(rawOrder).trim())
    if (!Number.isInteger(parsed) || parsed < ORDER_MIN || parsed > ORDER_MAX) {
      return {
        ok: false,
        error: new RpcError('validation', `order must be an integer in ${ORDER_MIN}-${ORDER_MAX}`, { field: 'order' }),
      }
    }
    order = parsed
  }
  const unknown = capabilities.filter((capability) => !CAPABILITY_IDS.includes(capability))
  if (unknown.length > 0) {
    return {
      ok: false,
      error: new RpcError('validation', `unknown capabilities: ${unknown.join(', ')}`, { field: 'capabilities' }),
    }
  }
  if (options.existingIds !== undefined && options.existingIds.has(id)) {
    return { ok: false, error: new RpcError('preset/id-conflict', `a preset already uses the id "${id}"`, { field: 'id' }) }
  }
  if (options.existingBundleNames !== undefined && options.existingBundleNames.has(packageNameOf(id))) {
    return {
      ok: false,
      error: new RpcError('preset/name-conflict', `the bundle "${packageNameOf(id)}" is already installed`, { field: 'id' }),
    }
  }
  return {
    ok: true,
    draft: {
      id,
      name,
      description,
      order,
      capabilities,
      persona,
    },
  }
}

/**
 * Recover the ticked capabilities and persona text from a preset's declaration
 * YAML, so "copy an existing preset" works for official presets that carry no
 * sidecar metadata.
 * @param content - the YAML `agentPresets.read` returned.
 * @returns { capabilities, persona }.
 */
export function analyzePresetDocument(content) {
  const text = typeof content === 'string' ? content : ''
  const capabilities = new Set()
  const has = (needle) => text.includes(needle)
  const blockOfId = (id) => blockOf(text, id)
  const offIn = (block, key) => new RegExp('(^|\\n)\\s*' + key + ':\\s*false\\b').test(block)

  const fsBlock = blockOfId('tool-fs')
  if (fsBlock !== '') {
    if (!offIn(fsBlock, 'read')) capabilities.add('fileRead')
    if (!offIn(fsBlock, 'write')) capabilities.add('fileWrite')
    if (!offIn(fsBlock, 'edit')) capabilities.add('fileEdit')
    if (!offIn(fsBlock, 'readImage')) capabilities.add('fileImage')
    if (!offIn(fsBlock, 'applyPatch')) capabilities.add('filePatch')
  }
  if (has('@deepseek-ai/dsh-tool-fs-search')) capabilities.add('fsSearch')
  if (blockOfId('tool-bash') !== '') capabilities.add('shell')
  if (has('@deepseek-ai/dsh-tool-bash-persistent') || has('@deepseek-ai/dsh-tool-pwsh-persistent')
    || has('@deepseek-ai/dsh-terminal-bash')) capabilities.add('persistentShell')
  const webBlock = blockOfId('tool-web')
  if (webBlock !== '') {
    if (!offIn(webBlock, 'search')) capabilities.add('webSearch')
    if (!offIn(webBlock, 'fetch')) capabilities.add('webFetch')
  }
  if (has('@deepseek-ai/dsh-tool-subagent-control')) capabilities.add('subagentControl')
  const spawnBlock = blockOfId('tool-subagent')
  if (spawnBlock.includes('subagent_fork') || has('subagent_fork')) capabilities.add('subagentFork')
  if (/provider:\s*["']?spawn["']?/.test(spawnBlock) || /toolName:\s*["']?subagent["']?(\s|$)/.test(spawnBlock)) {
    capabilities.add('subagentSpawn')
  }
  if (has('@deepseek-ai/dsh-workflow-ptc')) capabilities.add('workflowPtc')
  if (has('@deepseek-ai/dsh-tool-workflow')) capabilities.add('workflowTool')
  if (has('@deepseek-ai/dsh-plan-mode')) capabilities.add('plan')
  if (has('@deepseek-ai/dsh-skill-filesystem')) capabilities.add('skillFilesystem')
  if (has('@deepseek-ai/dsh-tool-skill')) capabilities.add('skillTool')
  if (has('@deepseek-ai/dsh-tool-todo')) capabilities.add('todo')
  if (has('@deepseek-ai/dsh-tool-jobs')) capabilities.add('jobs')
  if (has('@deepseek-ai/dsh-tool-schedule')) capabilities.add('schedule')
  if (has('@deepseek-ai/dsh-command-goal')) capabilities.add('commandGoal')
  if (has('@deepseek-ai/dsh-tool-goal')) capabilities.add('toolGoal')
  if (has('@deepseek-ai/dsh-tool-ask-user')) capabilities.add('askUser')
  if (has('@deepseek-ai/dsh-tool-present')) capabilities.add('present')
  if (has('@deepseek-ai/dsh-tool-office')) capabilities.add('office')
  if (has('@deepseek-ai/dsh-time-context')) capabilities.add('timeContext')
  if (has('@deepseek-ai/dsh-agent-instructions')) capabilities.add('agentInstructions')
  if (has('@deepseek-ai/dsh-plugin-manager/tools')) capabilities.add('pluginManagerTools')
  if (has('@deepseek-ai/dsh-plugin-market/tools')) capabilities.add('pluginMarketTools')
  if (has('@deepseek-ai/dsh-tool-cordis')) capabilities.add('cordisTool')
  if (has('@deepseek-ai/dsh-tool-executor-ptc')) capabilities.add('ptcExecutor')
  return { capabilities: [...capabilities], persona: extractPersona(text) }
}

/** The text of one `- id: <id>` entry block, up to the next sibling entry. */
function blockOf(text, id) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => new RegExp('^\\s*-\\s+id:\\s*["\']?' + id + '["\']?\\s*$').test(line))
  if (start === -1) return ''
  const startIndent = lines[start].search(/\S/)
  const out = [lines[start]]
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') { out.push(line); continue }
    const indent = line.search(/\S/)
    if (indent <= startIndent && /^\s*-\s+/.test(line)) break
    if (indent < startIndent) break
    out.push(line)
  }
  return out.join('\n')
}

/** Extract `persona.config.prefix` from declaration YAML (plain, quoted, or block). */
function extractPersona(text) {
  const block = blockOf(text, 'persona')
  if (block === '') return ''
  const lines = block.split('\n')
  const start = lines.findIndex((line) => /^\s*prefix:\s*/.test(line))
  if (start === -1) return ''
  const first = lines[start].replace(/^\s*prefix:\s*/, '')
  if (first.startsWith('"') && first.endsWith('"') && first.length > 1) {
    try { return JSON.parse(first) } catch { return first.slice(1, -1) }
  }
  if (first.startsWith("'") && first.endsWith("'") && first.length > 1) {
    return first.slice(1, -1).replace(/''/g, "'")
  }
  if (/^[|>][+-]?$/.test(first)) {
    const prefixIndent = lines[start].search(/\S/)
    const body = []
    let contentIndent
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() === '') { body.push(''); continue }
      const indent = line.search(/\S/)
      if (indent <= prefixIndent) break
      if (contentIndent === undefined) contentIndent = indent
      body.push(line.slice(Math.min(contentIndent, indent)))
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    return body.join('\n')
  }
  return first.trim()
}

/* ------------------------------------------------------------------ */
/* Host service                                                        */
/* ------------------------------------------------------------------ */

/**
 * Everything the route can do, bound to one Host context.
 *
 * Instances are cheap; the route creates one when the plugin activates. Every
 * public method returns a plain JSON value or throws an {@link RpcError}.
 */
export class ModeManagerHost {
  /** @type {Map<string, object>} */
  jobs = new Map()
  /** Tail of the profile-mutating operation chain. */
  writeChain = Promise.resolve()
  disposed = false

  /**
   * @param ctx - Host context carrying the registries this feature coordinates.
   */
  constructor(ctx) {
    this.ctx = ctx
    this.dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
    this.profileDir = process.env.DSH_PROFILE_DIR !== undefined && process.env.DSH_PROFILE_DIR !== ''
      ? process.env.DSH_PROFILE_DIR
      : ''
    this.creatorRoot = path.join(this.dshHome, 'preset-creator')
    this.backupsRoot = path.join(this.dshHome, 'preset-backups')
    this.auditPath = path.join(this.creatorRoot, 'audit.jsonl')
    ctx.effect(() => () => { this.disposed = true }, 'mode-manager: host dispose')
  }

  get logger() {
    return this.ctx.logger
  }

  /* ---------------- service accessors ---------------- */

  get presets() { return this.ctx.get('agentPresets') }
  get plugins() { return this.ctx.get('pluginManager') }
  get agents() { return this.ctx.get('agents') }
  get sessions() { return this.ctx.get('sessions') }
  get query() { return this.ctx.get('sessionQuery') }
  get workspaces() { return this.ctx.get('workspaceRegistry') }
  get settings() { return this.ctx.get('settings') }
  get projectionCache() { return this.ctx.get('sessionProjectionCache') }

  /* ---------------- public RPC surface ---------------- */

  /**
   * Dispatch one browser action.
   * @param action - the action name from the contract.
   * @param payload - the request body.
   * @returns the action's data.
   */
  async dispatch(action, payload) {
    const body = payload !== null && typeof payload === 'object' ? payload : {}
    switch (action) {
      case 'state': return await this.state()
      case 'document': return await this.document(body.id)
      case 'preview': return await this.preview(body.draft)
      case 'create': return await this.serializeWrite(() => this.create(body.draft))
      case 'update': return await this.serializeWrite(() => this.update(body.draft))
      case 'delete': return await this.serializeWrite(() => this.delete(body.id))
      case 'setDefault': return await this.setDefault(body.id)
      case 'scan': return { scan: await this.scan(body.id) }
      case 'repairStart': return await this.repairStart(body)
      case 'repairStatus': return { job: this.repairStatus(body.jobId) }
      case 'repairCancel': return this.repairCancel(body.jobId)
      case 'repairOne': return await this.repairSingle(body.sessionId, body.targetPreset)
      case 'sessionInfo': return await this.sessionInfo(body.sessionId)
      case 'fork': return await this.fork(body.sessionId, body.targetPreset)
      case 'backups': return { backups: await this.listBackups() }
      case 'restore': return await this.restore(body.name)
      case 'deleteBackup': return await this.deleteBackup(body.name)
      case 'cleanupBackups': return await this.cleanupBackups(body.keep)
      default: throw new RpcError('validation', `unknown action: ${String(action)}`)
    }
  }

  /**
   * Run one profile-mutating operation after every earlier one settles. Two
   * browser windows cannot interleave two installs of the same bundle.
   * @param operation - create/update/delete to run exclusively.
   */
  async serializeWrite(operation) {
    const run = this.writeChain.then(operation, operation)
    this.writeChain = run.then(() => undefined, () => undefined)
    return await run
  }

  /**
   * The full page snapshot: presets with their source, backups, diagnostics,
   * the capability catalog, and the templates.
   * @returns the state payload.
   */
  async state() {
    const [presets, backups] = await Promise.all([this.listPresets(), this.listBackups()])
    return {
      presets,
      backups,
      diagnostics: await this.diagnostics(),
      capabilities: { groups: CAPABILITY_GROUPS },
      templates: TEMPLATES,
      limits: LIMITS,
    }
  }

  /** Read one preset declaration for the read-only viewer. */
  async document(id) {
    if (typeof id !== 'string' || id === '') throw new RpcError('validation', 'id is required', { field: 'id' })
    const presets = this.presets
    if (presets === undefined) throw new RpcError('internal/error', 'the agent-preset registry is unavailable')
    try {
      const document = await presets.readDocument(id)
      return {
        agentPreset: document.agentPreset,
        content: document.content,
        ...(document.name === undefined ? {} : { name: document.name }),
        ...(document.description === undefined ? {} : { description: document.description }),
      }
    } catch (error) {
      if (isRpcCode(error, 'agent-preset/not-found')) {
        throw new RpcError('preset/not-found', `unknown agent preset: ${id}`)
      }
      throw error
    }
  }

  /** Validate a draft and render the exact files `create` would write. */
  async preview(input) {
    // Preview must work for an id that already exists (the edit flow) and must
    // not touch the profile, so only the shape rules run here.
    const validated = validateDraft(input, {})
    if (!validated.ok) throw validated.error
    const draft = await this.withImportSource(validated.draft, input)
    const dir = path.join(this.creatorRoot, draft.id)
    const imported = draft.importFrom === undefined ? undefined : await this.importedSource(draft.importFrom)
    return {
      presetId: draft.id,
      presetIdOk: true,
      packageName: packageNameOf(draft.id),
      dir,
      ...(draft.importFrom === undefined ? {} : { importedFrom: draft.importFrom }),
      yaml: imported === undefined ? renderBundlePatch(draft) : renderBundlePatchImported(draft, imported.content),
    }
  }

  /**
   * Create a preset: validate, write the bundle, install it, and wait until it
   * appears on the roster. Any failure rolls the profile and the directory back
   * so no half-installed preset is left behind.
   */
  async create(input) {
    const normalized = await this.normalizeCreateDraft(input)
    const draft = normalized.draft
    const dir = path.join(this.creatorRoot, draft.id)
    if (await exists(dir)) {
      const bundle = await this.findPresetBundle(draft.id)
      if (bundle !== undefined) throw new RpcError('preset/id-conflict', `a preset already uses the id "${draft.id}"`)
      // A leftover directory with no installed bundle is a previous failed
      // attempt; it is safe to replace.
      await fsp.rm(dir, { recursive: true, force: true })
    }
    await this.ensureRoots()
    let imported
    try {
      if (draft.importFrom !== undefined) imported = await this.importedSource(draft.importFrom)
    } catch (error) {
      throw error instanceof RpcError ? error : new RpcError('preset/not-found', messageOf(error))
    }
    const staging = path.join(this.creatorRoot, `.staging-${draft.id}-${Date.now()}`)
    try {
      await writeBundleFiles(staging, draft, imported)
      await fsp.rename(staging, dir)
    } catch (error) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw new RpcError('internal/error', `could not write the preset bundle: ${messageOf(error)}`)
    }
    let installed = false
    try {
      const result = await this.installBundle(dir)
      installed = true
      if (result.application !== 'applied') throw installedButNotLive(draft.id, result)
      const preset = await this.waitForPreset(draft.id)
      if (preset === undefined) {
        throw new RpcError('preset/create-broken', 'the bundle installed but the preset did not activate', {
          details: { roster: await this.rosterIds() },
        })
      }
      if (preset.broken !== undefined && preset.broken !== '') {
        throw new RpcError('preset/create-broken', preset.broken, { details: { roster: await this.rosterIds() } })
      }
      await this.audit({ action: 'create', id: draft.id, ok: true, application: result.application })
      return {
        presetId: draft.id,
        bundleName: packageNameOf(draft.id),
        dir,
        application: result.application,
        ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
      }
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.keepBundle === true) {
        // The dependency is saved and its directory is valid; only activation
        // waits for a restart (or loses to a higher profile layer). Keep both.
        await this.audit({ action: 'create', id: draft.id, ok: false, error: messageOf(error), application: error.application })
        throw error
      }
      // Roll back in an order that never leaves a dependency pointing at a
      // deleted directory: keep the bundle directory when its removal failed.
      let removable = !installed
      if (installed) {
        try {
          await this.removeBundle(packageNameOf(draft.id))
          removable = true
        } catch (removeError) {
          this.logger?.warn?.(`mode-manager: rolling back the new bundle "${draft.id}" failed: ${messageOf(removeError)}`)
        }
      }
      if (removable) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      await this.audit({ action: 'create', id: draft.id, ok: false, error: messageOf(error) })
      throw error instanceof RpcError
        ? error
        : new RpcError('plugin/install-failed', messageOf(error), { details: { application: 'failed' } })
    }
  }

  /**
   * Update a managed preset by replacing its bundle. The old bundle is backed up
   * first and reinstalled if the replacement does not activate, so a failed save
   * never leaves a default preset pointing at a missing definition.
   */
  async update(input) {
    const source = input !== null && typeof input === 'object' ? input : {}
    const id = typeof source.id === 'string' ? source.id.trim() : ''
    if (!ID_RE.test(id)) throw new RpcError('validation', 'id is required', { field: 'id' })
    const info = await this.presetInfo(id)
    if (info === undefined) throw new RpcError('preset/not-found', `unknown agent preset: ${id}`)
    if (info.imported === true) {
      throw new RpcError('preset/not-managed', 'imported modes keep their source composition and cannot be edited here; create a new import to change it')
    }
    if (!info.editable) throw new RpcError('preset/not-managed', 'only presets created by Mode manager can be edited')
    const normalized = await this.normalizeCreateDraft(source, { lockId: id })
    if (normalized.draft.importFrom !== undefined) {
      throw new RpcError('validation', 'importFrom is only valid when creating a new mode', { field: 'importFrom' })
    }
    const draft = normalized.draft
    const dir = path.join(this.creatorRoot, id)
    if (!(await exists(dir))) {
      throw new RpcError('preset/not-managed', 'the preset bundle directory is missing; delete and recreate the preset')
    }
    const staging = path.join(this.creatorRoot, `.staging-${id}-${Date.now()}`)
    await this.ensureRoots()
    try {
      await writeBundleFiles(staging, draft)
    } catch (error) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw new RpcError('internal/error', `could not write the preset bundle: ${messageOf(error)}`)
    }
    const backupPath = await this.backupPreset(info, 'update')
    try {
      await this.removeBundle(info.bundleName)
    } catch (error) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      await this.audit({ action: 'update', id, ok: false, error: messageOf(error) })
      throw error instanceof RpcError
        ? error
        : new RpcError('plugin/remove-failed', messageOf(error))
    }
    try {
      await fsp.rm(dir, { recursive: true, force: true })
      await fsp.rename(staging, dir)
      const result = await this.installBundle(dir)
      if (result.application !== 'applied') throw installedButNotLive(id, result)
      const preset = await this.waitForPreset(id)
      if (preset === undefined || (preset.broken !== undefined && preset.broken !== '')) {
        throw new RpcError('preset/create-broken', preset?.broken ?? 'the updated preset did not activate', {
          details: { roster: await this.rosterIds() },
        })
      }
      await this.audit({ action: 'update', id, ok: true, application: result.application, backupPath })
      return {
        presetId: id,
        bundleName: packageNameOf(id),
        dir,
        application: result.application,
        backupPath,
        ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
      }
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.keepBundle === true) {
        // The replacement is installed and its directory is valid; it becomes
        // live on the next start. Do not swap the files back.
        await this.audit({ action: 'update', id, ok: false, error: messageOf(error), backupPath, application: error.application })
        throw error
      }
      // Roll back to the backed-up bundle so the preset (possibly the default)
      // keeps working.
      try {
        await fsp.rm(dir, { recursive: true, force: true })
        if (backupPath !== '') await fsp.cp(backupPath, dir, { recursive: true })
        await this.installBundle(dir)
      } catch (rollbackError) {
        this.logger?.warn?.(`mode-manager: rolling back preset "${id}" failed: ${messageOf(rollbackError)}`)
      }
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      await this.audit({ action: 'update', id, ok: false, error: messageOf(error), backupPath })
      throw error instanceof RpcError
        ? error
        : new RpcError('plugin/install-failed', messageOf(error))
    }
  }

  /**
   * Delete a managed preset: refuse the current default, back the bundle up,
   * remove it, then scan for the sessions that recorded it.
   */
  async delete(id) {
    const info = await this.presetInfo(id)
    if (info === undefined) throw new RpcError('preset/not-found', `unknown agent preset: ${id}`)
    if (info.isDefault) {
      throw new RpcError('preset/default-in-use', 'the preset is the current default; choose another default first')
    }
    if (!info.deletable) throw new RpcError('preset/not-managed', 'only presets created by Mode manager can be deleted')
    const backupPath = await this.backupPreset(info, 'delete')
    if (backupPath === '') {
      throw new RpcError('internal/error', 'the preset bundle directory is missing, so it cannot be backed up before deletion')
    }
    try {
      await this.removeBundle(info.bundleName)
    } catch (error) {
      await this.audit({ action: 'delete', id, ok: false, error: messageOf(error), backupPath })
      throw error instanceof RpcError ? error : new RpcError('plugin/remove-failed', messageOf(error))
    }
    const remaining = await this.waitForPresetGone(id)
    if (!remaining) {
      await this.audit({ action: 'delete', id, ok: false, error: 'preset still present after removal', backupPath })
      throw new RpcError('plugin/remove-failed', 'the preset is still declared after removing its bundle')
    }
    await fsp.rm(path.join(this.creatorRoot, id), { recursive: true, force: true }).catch(() => undefined)
    await this.pruneBackups(BACKUP_KEEP)
    await this.audit({ action: 'delete', id, ok: true, backupPath })
    const scan = await this.scan(id)
    return { backupPath, scan }
  }

  /** Persist the default preset through the same settings field the shipped UI writes. */
  async setDefault(id) {
    const info = await this.presetInfo(id)
    if (info === undefined) throw new RpcError('preset/not-found', `unknown agent preset: ${id}`)
    if (info.broken !== undefined && info.broken !== '') {
      throw new RpcError('preset/broken-target', 'a broken preset cannot be the default')
    }
    const settings = this.settings
    if (settings === undefined) throw new RpcError('internal/error', 'the settings service is unavailable')
    try {
      await settings.update('agent-preset-registry', { selectedDefault: id })
    } catch (error) {
      throw new RpcError('internal/error', `could not save the default preset: ${messageOf(error)}`)
    }
    const roster = await this.roster()
    const row = roster.find((preset) => preset.id === id)
    if (row === undefined || row.isDefault !== true) {
      throw new RpcError('internal/error', 'the default preset was saved but the registry did not report it')
    }
    await this.audit({ action: 'setDefault', id, ok: true })
    return { id }
  }

  /* ---------------- scanning ---------------- */

  /**
   * Find every non-hidden session whose current preset is `presetId`, grouped by
   * workspace. This is a cheap listing read: the projection cache answers the
   * current preset without opening any log.
   */
  async scan(presetId) {
    if (typeof presetId !== 'string' || presetId === '') throw new RpcError('validation', 'id is required', { field: 'id' })
    const records = await this.listSessions()
    const workspaces = this.workspaces?.list?.() ?? []
    const workspaceOf = new Map()
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds ?? []) workspaceOf.set(sessionId, workspace)
    }
    const archived = new Set(this.workspaces?.archivedSessionIds ?? [])
    const pinned = new Set(this.workspaces?.pinnedSessionIds ?? [])
    const matched = []
    for (const record of records) {
      const current = this.currentPresetOf(record.header)
      if (current !== presetId) continue
      const id = record.header.id
      const workspace = workspaceOf.get(id)
      const live = record.live === true || this.agents?.get(id) !== undefined || this.sessions?.get(id) !== undefined
      matched.push({
        sessionId: id,
        title: undefined,
        cwd: record.header.cwd,
        archived: archived.has(id),
        live,
        pinned: pinned.has(id),
        subagent: record.header.origin === 'subagent',
        currentPreset: current,
        workspace,
        createdAt: record.header.createdAt ?? 0,
      })
    }
    const titles = await this.readTitles(matched.map((item) => item.sessionId))
    const createdAtOf = new Map(matched.map((item) => [item.sessionId, item.createdAt]))
    const byNewest = (left, right) => (createdAtOf.get(right.sessionId) ?? 0) - (createdAtOf.get(left.sessionId) ?? 0)
    const groups = new Map()
    for (const item of matched) {
      const key = item.workspace === undefined ? '__ungrouped__' : item.workspace.id
      let group = groups.get(key)
      if (group === undefined) {
        group = {
          workspaceId: item.workspace === undefined ? null : item.workspace.id,
          workspaceTitle: item.workspace === undefined ? 'Ungrouped' : item.workspace.title,
          ...(item.workspace === undefined ? {} : { workspacePath: item.workspace.path }),
          sessions: [],
        }
        groups.set(key, group)
      }
      group.sessions.push({
        sessionId: item.sessionId,
        ...(titles.get(item.sessionId) === undefined ? {} : { title: titles.get(item.sessionId) }),
        ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
        archived: item.archived,
        live: item.live,
        pinned: item.pinned,
        subagent: item.subagent,
        currentPreset: item.currentPreset,
      })
    }
    const ordered = []
    for (const workspace of workspaces) {
      const group = groups.get(workspace.id)
      if (group !== undefined) {
        group.sessions.sort(byNewest)
        ordered.push(group)
      }
    }
    const ungrouped = groups.get('__ungrouped__')
    if (ungrouped !== undefined) {
      ungrouped.sessions.sort(byNewest)
      ordered.push(ungrouped)
    }
    const total = matched.length
    const live = matched.filter((item) => item.live).length
    const subagent = matched.filter((item) => item.subagent).length
    return {
      presetId,
      totals: {
        total,
        live,
        archived: matched.filter((item) => item.archived).length,
        subagent,
        // A live subagent session is both live and a subagent; subtracting the
        // two counts would double-count it and hide repairable sessions.
        repairable: matched.filter((item) => !item.live && !item.subagent).length,
      },
      groups: ordered,
    }
  }

  /**
   * What the on-open dialog needs to know about one session.
   * @param sessionId - session identity.
   */
  async sessionInfo(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new RpcError('validation', 'sessionId is required', { field: 'sessionId' })
    const records = await this.listSessions()
    const record = records.find((item) => item.header.id === sessionId)
    if (record === undefined) {
      return {
        sessionId, exists: false, preset: null, missing: false, live: false, subagent: false, started: false,
      }
    }
    const preset = this.currentPresetOf(record.header)
    const roster = await this.roster()
    const ids = new Set(roster.map((item) => item.id))
    const live = record.live === true || this.agents?.get(sessionId) !== undefined || this.sessions?.get(sessionId) !== undefined
    const titles = await this.readTitles([sessionId])
    return {
      sessionId,
      exists: true,
      preset,
      missing: preset !== null && !ids.has(preset),
      live,
      subagent: record.header.origin === 'subagent',
      started: await this.sessionStarted(sessionId, record.header),
      ...(titles.get(sessionId) === undefined ? {} : { title: titles.get(sessionId) }),
      ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
    }
  }

  /* ---------------- repair ---------------- */

  /**
   * Repair one cold Session: resume it with a setup that mounts the replacement
   * preset and appends the ordinary selection event, then release the temporary
   * Agent immediately.
   * @param sessionId - the session to repair.
   * @param targetPreset - replacement preset id.
   * @returns `{ sessionId, status, error? }`.
   */
  async repairSingle(sessionId, targetPreset) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    const target = typeof targetPreset === 'string' ? targetPreset.trim() : ''
    if (id === '') throw new RpcError('validation', 'sessionId is required', { field: 'sessionId' })
    if (target === '') throw new RpcError('validation', 'targetPreset is required', { field: 'targetPreset' })
    const agents = this.agents
    const presets = this.presets
    const sessions = this.sessions
    if (agents === undefined || presets === undefined || sessions === undefined) {
      throw new RpcError('internal/error', 'the repair channel is unavailable in this Host composition')
    }
    let resolved
    try {
      resolved = await presets.resolve(target)
    } catch (error) {
      throw new RpcError('preset/broken-target', `the target preset cannot be resolved: ${messageOf(error)}`)
    }
    if (resolved.broken !== undefined && resolved.broken !== '') {
      throw new RpcError('preset/broken-target', resolved.broken)
    }
    if (agents.get(id) !== undefined || sessions.get(id) !== undefined) return { sessionId: id, status: 'skipped-live' }
    const record = (await this.listSessions()).find((item) => item.header.id === id)
    if (record === undefined) return { sessionId: id, status: 'skipped-missing' }
    if (record.header.origin === 'subagent') return { sessionId: id, status: 'skipped-subagent' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('repair timed out')), REPAIR_TIMEOUT_MS)
    let handle
    try {
      handle = await agents.resume({
        resumeSessionId: id,
        signal: controller.signal,
        setup: async (agentCtx, agent) => {
          await presets.mount(agentCtx, target)
          agent.session.append('agent-preset/selected', { agentPreset: target })
        },
      })
      try {
        await sessions.flush(handle.agent.session)
      } catch (flushError) {
        this.logger?.warn?.(`mode-manager: flushing repaired session "${id}" failed: ${messageOf(flushError)}`)
      }
      return { sessionId: id, status: 'repaired' }
    } catch (error) {
      return { sessionId: id, status: 'failed', error: messageOf(error) }
    } finally {
      clearTimeout(timer)
      if (handle !== undefined) {
        try { await handle.dispose() } catch (disposeError) {
          this.logger?.warn?.(`mode-manager: disposing the temporary agent for "${id}" failed: ${messageOf(disposeError)}`)
        }
      }
    }
  }

  /** Start a serial repair job and return its id. */
  async repairStart(payload) {
    const source = payload !== null && typeof payload === 'object' ? payload : {}
    const targetPreset = typeof source.targetPreset === 'string' ? source.targetPreset.trim() : ''
    const presetId = typeof source.presetId === 'string' ? source.presetId.trim() : ''
    const sessionIds = Array.isArray(source.sessionIds)
      ? [...new Set(source.sessionIds.filter((id) => typeof id === 'string' && id !== ''))]
      : []
    if (targetPreset === '') throw new RpcError('repair/no-target', 'a target preset is required')
    if (sessionIds.length === 0) throw new RpcError('validation', 'at least one session must be selected', { field: 'sessionIds' })
    if (this.presets === undefined) throw new RpcError('internal/error', 'the agent-preset registry is unavailable')
    try {
      const resolved = await this.presets.resolve(targetPreset)
      if (resolved.broken !== undefined && resolved.broken !== '') {
        throw new RpcError('preset/broken-target', resolved.broken)
      }
    } catch (error) {
      if (error instanceof RpcError) throw error
      throw new RpcError('preset/broken-target', `the target preset cannot be resolved: ${messageOf(error)}`)
    }
    this.pruneJobs()
    const jobId = `job-${randomUUID()}`
    const job = {
      jobId,
      presetId,
      targetPreset,
      sessionIds,
      total: sessionIds.length,
      done: 0,
      repaired: 0,
      failed: 0,
      skipped: 0,
      cancelled: false,
      finished: false,
      current: null,
      startedAt: Date.now(),
      results: [],
      titles: new Map(),
    }
    this.jobs.set(jobId, job)
    void this.runRepairJob(job)
    return { jobId }
  }

  /** Drop finished jobs older than an hour, and keep at most 20. */
  pruneJobs() {
    const now = Date.now()
    const finished = [...this.jobs.values()].filter((job) => job.finished === true)
    finished.sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0))
    for (const job of finished.slice(20)) this.jobs.delete(job.jobId)
    for (const job of finished) {
      if (now - (job.finishedAt ?? now) > 3_600_000) this.jobs.delete(job.jobId)
    }
  }

  /** Read one job's progress. */
  repairStatus(jobId) {
    const job = typeof jobId === 'string' ? this.jobs.get(jobId) : undefined
    if (job === undefined) throw new RpcError('repair/job-not-found', `unknown repair job: ${String(jobId)}`)
    return {
      jobId: job.jobId,
      total: job.total,
      done: job.done,
      repaired: job.repaired,
      failed: job.failed,
      skipped: job.skipped,
      cancelled: job.cancelled,
      finished: job.finished,
      current: job.current,
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      results: job.results.map((item) => ({
        sessionId: item.sessionId,
        ...(item.title === undefined ? {} : { title: item.title }),
        status: item.status,
        ...(item.error === undefined ? {} : { error: item.error }),
      })),
    }
  }

  /** Ask a running job to stop after the current session. */
  repairCancel(jobId) {
    const job = typeof jobId === 'string' ? this.jobs.get(jobId) : undefined
    if (job === undefined) throw new RpcError('repair/job-not-found', `unknown repair job: ${String(jobId)}`)
    job.cancelled = true
    return { cancelled: true }
  }

  /** Serial job runner; never rejects (failures land in the job). */
  async runRepairJob(job) {
    const titles = await this.readTitles(job.sessionIds)
    job.titles = titles
    for (const sessionId of job.sessionIds) {
      if (job.cancelled || this.disposed) break
      job.current = sessionId
      let result
      try {
        result = await this.repairSingle(sessionId, job.targetPreset)
      } catch (error) {
        result = { sessionId, status: 'failed', error: messageOf(error) }
      }
      job.done += 1
      if (result.status === 'repaired') job.repaired += 1
      else if (result.status === 'failed') job.failed += 1
      else job.skipped += 1
      job.results.push({
        sessionId,
        ...(titles.get(sessionId) === undefined ? {} : { title: titles.get(sessionId) }),
        status: result.status,
        ...(result.error === undefined ? {} : { error: result.error }),
      })
    }
    job.current = null
    job.finished = true
    job.finishedAt = Date.now()
    job.titles = new Map()
    await this.audit({
      action: 'repair',
      presetId: job.presetId,
      targetPreset: job.targetPreset,
      ok: job.failed === 0,
      repaired: job.repaired,
      failed: job.failed,
      skipped: job.skipped,
      cancelled: job.cancelled,
      total: job.total,
    })
  }

  /**
   * Last-resort fallback: fork the session's log into a brand-new Session bound
   * to the replacement preset when the original cannot be resumed.
   */
  async fork(sessionId, targetPreset) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    const target = typeof targetPreset === 'string' ? targetPreset.trim() : ''
    if (id === '' || target === '') throw new RpcError('validation', 'sessionId and targetPreset are required')
    const query = this.query
    const agents = this.agents
    const presets = this.presets
    if (query === undefined || agents === undefined || presets === undefined) {
      throw new RpcError('internal/error', 'the fork fallback is unavailable in this Host composition')
    }
    try {
      const resolved = await presets.resolve(target)
      if (resolved.broken !== undefined && resolved.broken !== '') {
        throw new RpcError('preset/broken-target', resolved.broken)
      }
      const snapshot = await query.readSession(id)
      const header = snapshot.session
      if (header.origin === 'subagent') {
        throw new RpcError('internal/error', 'a subagent session cannot be forked independently')
      }
      if (header.cwd === undefined) throw new RpcError('internal/error', 'the session has no working directory')
      const newId = `session-${randomUUID()}`
      const handle = await agents.create({
        sessionId: newId,
        seed: snapshot.events,
        // The copied log is the fork's inherited prefix: the seed marker for the
        // new session's own history is appended at that exact cut.
        inheritedEventCount: snapshot.events.length,
        meta: {
          cwd: header.cwd,
          parentSession: id,
          isSeeded: true,
          agentPreset: target,
        },
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, target)
        },
      })
      try {
        await this.sessions?.flush(handle.agent.session)
      } catch (flushError) {
        this.logger?.warn?.(`mode-manager: flushing forked session "${newId}" failed: ${messageOf(flushError)}`)
      }
      await handle.dispose().catch(() => undefined)
      await this.audit({ action: 'fork', id, ok: true, sessionId: newId })
      return { sessionId: newId }
    } catch (error) {
      await this.audit({ action: 'fork', id, ok: false, error: messageOf(error) })
      if (error instanceof RpcError) throw error
      throw new RpcError('internal/error', `could not fork the session: ${messageOf(error)}`)
    }
  }

  /* ---------------- backups ---------------- */

  /** List the bundles this plugin backed up before update/delete. */
  async listBackups() {
    await this.ensureRoots()
    let entries = []
    try {
      entries = await fsp.readdir(this.backupsRoot, { withFileTypes: true })
    } catch {
      return []
    }
    const backups = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.backupsRoot, entry.name)
      const metadata = await readJson(path.join(dir, 'mode-manager.json'))
      // Ownership witness: only bundles this plugin backed up carry the sidecar.
      if (metadata === null || typeof metadata.id !== 'string') continue
      const manifest = await readJson(path.join(dir, 'package.json'))
      const bytes = await directorySize(dir)
      const createdAt = (await fsp.stat(dir).catch(() => undefined))?.mtimeMs ?? Date.now()
      backups.push({
        name: entry.name,
        presetId: typeof metadata?.id === 'string' ? metadata.id : entry.name.replace(/-[0-9]+$/, ''),
        ...(typeof manifest?.version === 'string' ? { version: manifest.version } : {}),
        createdAt,
        bytes,
      })
    }
    backups.sort((left, right) => right.createdAt - left.createdAt)
    return backups
  }

  /** Reinstall a backed-up preset bundle. */
  async restore(name) {
    if (typeof name !== 'string' || name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      throw new RpcError('validation', 'a backup name is required', { field: 'name' })
    }
    const dir = path.join(this.backupsRoot, name)
    if (!(await exists(dir))) throw new RpcError('backup/not-found', `unknown backup: ${name}`)
    const metadata = await readJson(path.join(dir, 'mode-manager.json'))
    const presetId = typeof metadata?.id === 'string' ? metadata.id : name.replace(/-[0-9]+$/, '')
    const existing = await this.findPresetBundle(presetId)
    if (existing !== undefined) {
      throw new RpcError('preset/id-conflict', `a preset with id "${presetId}" is already installed`)
    }
    const managedDir = path.join(this.creatorRoot, presetId)
    if (await exists(managedDir)) {
      throw new RpcError('preset/id-conflict', `a managed directory for "${presetId}" already exists`)
    }
    await this.ensureRoots()
    await fsp.cp(dir, managedDir, { recursive: true })
    try {
      const result = await this.installBundle(managedDir)
      await this.audit({ action: 'restore', id: presetId, ok: true, backup: name })
      return { presetId, bundleName: packageNameOf(presetId), application: result.application }
    } catch (error) {
      await fsp.rm(managedDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  /** Keep only the newest `keep` backups. */
  async cleanupBackups(keep) {
    const limit = Number.isInteger(keep) && keep >= 0 ? keep : BACKUP_KEEP
    return await this.pruneBackups(limit)
  }

  /**
   * Delete one saved backup. Only a directory this plugin created (it carries
   * the sidecar) inside the backups root can be removed; the installed preset
   * is not touched.
   * @param name - backup directory name, as `listBackups` returns it.
   * @returns the removed backup's identity.
   */
  async deleteBackup(name) {
    const safe = typeof name === 'string' ? name.trim() : ''
    if (safe === '' || safe === '.' || safe === '..' || safe.includes('/') || safe.includes('\\')) {
      throw new RpcError('validation', 'a backup name is required', { field: 'name' })
    }
    const dir = path.join(this.backupsRoot, safe)
    if (!(await exists(dir))) throw new RpcError('backup/not-found', `unknown backup: ${safe}`)
    const metadata = await readJson(path.join(dir, 'mode-manager.json'))
    if (metadata === null || typeof metadata.id !== 'string') {
      throw new RpcError('backup/not-found', 'the directory is not a backup created by this plugin')
    }
    await fsp.rm(dir, { recursive: true, force: true })
    await this.audit({ action: 'deleteBackup', id: metadata.id, ok: true, backup: safe })
    return { name: safe, presetId: metadata.id, removed: true }
  }

  /* ---------------- diagnostics ---------------- */

  /** Facts the page shows in its diagnostics section. */
  async diagnostics() {
    return {
      dshVersion: await this.readDshVersion(),
      profileDir: await this.resolveProfileDir(),
      dshHome: this.dshHome,
      route: ROUTE,
      creatorRoot: this.creatorRoot,
      backupsRoot: this.backupsRoot,
      hmr: this.ctx.get('hmr') !== undefined,
      pluginManagerAvailable: this.plugins !== undefined,
      agentPresetsAvailable: this.presets !== undefined,
      repairAvailable: this.agents !== undefined && this.presets !== undefined && this.sessions !== undefined && this.query !== undefined,
    }
  }

  /* ---------------- preset introspection ---------------- */

  /**
   * One preset with its source classification, capability analysis, and usage.
   * @param id - preset identity.
   * @returns the info record, or undefined when unknown.
   */
  async presetInfo(id) {
    const all = await this.listPresets()
    return all.find((preset) => preset.id === id)
  }

  /** The roster rows as the Host reports them. */
  async roster() {
    const presets = this.presets
    if (presets === undefined) return []
    try {
      return await presets.remoteExportList().then((roster) => roster.presets)
    } catch {
      return []
    }
  }

  async rosterIds() {
    return (await this.roster()).map((preset) => preset.id)
  }

  /**
   * Every declared preset with source, deletability, usage, and recovered
   * capability metadata.
   */
  async listPresets() {
    const roster = await this.roster()
    if (roster.length === 0) return []
    // `remoteExportList()` carries the client-safe display fields; the internal
    // roster additionally carries `order`, which the picker and this page use.
    const orders = new Map()
    try {
      for (const preset of await this.presets.list()) {
        if (typeof preset.order === 'number') orders.set(preset.id, preset.order)
      }
    } catch {
      // Order is cosmetic; the roster without it still lists every preset.
    }
    const [bundles, profileIds, usage, managedDirectories] = await Promise.all([
      this.pluginManagerBundles(),
      this.profilePatchIds(),
      this.sessionUsage(),
      this.managedDirectories(),
    ])
    const bundleOfRow = new Map()
    for (const bundle of bundles) {
      for (const row of bundle.rows ?? []) {
        if (row.moduleName !== '@deepseek-ai/dsh-agent-preset') continue
        if (!bundleOfRow.has(row.rowId)) bundleOfRow.set(row.rowId, bundle)
      }
    }
    return await Promise.all(roster.map(async (row) => {
      const rowId = ROW_PREFIX + row.id
      const bundle = bundleOfRow.get(rowId)
      const managed = managedDirectories.has(row.id)
      let kind
      if (OFFICIAL_PRESETS.includes(row.id)) {
        kind = profileIds.has(rowId) ? 'overridden-official' : 'official'
      } else if (bundle !== undefined) {
        kind = bundle.availability === 'profile' && bundle.installed === true ? 'custom' : 'installation'
      } else if (profileIds.has(rowId)) {
        kind = 'unmanaged'
      } else {
        kind = 'unknown'
      }
      const isCustom = kind === 'custom'
      const analysis = managed
        ? await this.readManagedAnalysis(row.id)
        : await this.readDocumentAnalysis(row.id)
      return {
        id: row.id,
        ...(row.name === undefined ? {} : { name: row.name }),
        ...(row.description === undefined ? {} : { description: row.description }),
        ...(row.isDefault === true ? { isDefault: true } : { isDefault: false }),
        ...(row.broken === undefined ? {} : { broken: row.broken }),
        ...(orders.has(row.id) ? { order: orders.get(row.id) } : {}),
        kind,
        managed,
        deletable: isCustom && managed && row.isDefault !== true,
        editable: isCustom && managed && analysis.imported !== true,
        ...(analysis.imported === true ? { imported: true } : { imported: false }),
        ...(analysis.importedFrom === undefined ? {} : { importedFrom: analysis.importedFrom }),
        ...(bundle?.name === undefined ? {} : { bundleName: bundle.name }),
        ...(bundle?.version === undefined ? {} : { bundleVersion: bundle.version }),
        sessionCount: usage.get(row.id) ?? 0,
        capabilities: analysis.capabilities,
        persona: analysis.persona,
      }
    }))
  }

  /** Read the managed sidecar; an analysis fallback keeps a hand-edited bundle editable. */
  async readManagedAnalysis(id) {
    const metadata = await readJson(path.join(this.creatorRoot, id, 'mode-manager.json'))
    if (metadata !== null && Array.isArray(metadata.capabilities)) {
      return {
        capabilities: metadata.capabilities.filter((capability) => CAPABILITY_IDS.includes(capability)),
        persona: typeof metadata.persona === 'string' ? metadata.persona : '',
        imported: metadata.fidelity === 'raw',
        ...(typeof metadata.importedFrom === 'string' ? { importedFrom: metadata.importedFrom } : {}),
      }
    }
    return await this.readDocumentAnalysis(id)
  }

  /** Analyze a declaration from its rendered document. */
  async readDocumentAnalysis(id) {
    try {
      const document = await this.document(id)
      return analyzePresetDocument(document.content)
    } catch {
      return { capabilities: [], persona: '' }
    }
  }

  /**
   * Locate the running profile directory. A profile-launched Harness usually
   * exports `DSH_PROFILE_DIR`, but the packaged Desktop app does not always
   * forward it; the settings service knows the patch file it edits, which is the
   * most reliable witness, and the profile name is the last fallback.
   * @returns the profile directory, or '' when it cannot be located.
   */
  async resolveProfileDir() {
    if (this.profileDir !== '') return this.profileDir
    const settings = this.settings
    if (settings !== undefined && typeof settings.prepareDocument === 'function') {
      try {
        const patchPath = await settings.prepareDocument()
        if (typeof patchPath === 'string' && patchPath !== '') {
          this.profileDir = path.dirname(patchPath)
          return this.profileDir
        }
      } catch {
        // Fall through to the profile-name guess.
      }
    }
    const profileName = process.env.DSH_PROFILE
    if (profileName !== undefined && profileName !== '') {
      const guess = path.join(this.dshHome, 'profiles', profileName)
      try {
        await fsp.access(path.join(guess, 'cordis.patch.yml'))
        this.profileDir = guess
        return guess
      } catch {
        // Not a configured profile directory.
      }
    }
    return ''
  }

  /** Preset ids targeted by the profile patch layer (top-level `- id:` rows). */
  async profilePatchIds() {
    const ids = new Set()
    const profileDir = await this.resolveProfileDir()
    if (profileDir === '') return ids
    let text
    try {
      text = await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
    } catch {
      return ids
    }
    for (const line of text.split('\n')) {
      const match = /^- id:\s*(.+?)\s*$/.exec(line)
      if (match === null) continue
      ids.add(match[1].replace(/^["']|["']$/g, ''))
    }
    return ids
  }

  /** Preset ids whose generated directory exists under the creator root. */
  async managedDirectories() {
    const ids = new Set()
    let entries = []
    try {
      entries = await fsp.readdir(this.creatorRoot, { withFileTypes: true })
    } catch {
      return ids
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (!ID_RE.test(entry.name)) continue
      const manifest = await readJson(path.join(this.creatorRoot, entry.name, 'package.json'))
      if (manifest?.name === packageNameOf(entry.name)) ids.add(entry.name)
    }
    return ids
  }

  /** Sessions per preset id, from the zero-I/O projection snapshot. */
  async sessionUsage() {
    const usage = new Map()
    for (const record of await this.listSessions()) {
      // Child agents inherit their creator's preset; counting them would
      // inflate the number of user-visible sessions using one mode.
      if (record.header.origin === 'subagent') continue
      const preset = this.currentPresetOf(record.header)
      if (preset === null) continue
      usage.set(preset, (usage.get(preset) ?? 0) + 1)
    }
    return usage
  }

  /* ---------------- session helpers ---------------- */

  /**
   * Every logical session header this process can see. `sessionQuery` is the
   * live-preferred corpus; the persistence listing is the fallback.
   */
  async listSessions() {
    const query = this.query
    if (query !== undefined) {
      try {
        const records = await query.listSessions()
        return records.map((record) => ({ header: record.header, live: record.live === true }))
      } catch (error) {
        this.logger?.warn?.(`mode-manager: listing sessions through sessionQuery failed: ${messageOf(error)}`)
      }
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      try {
        return (await persistence.list()).map((snapshot) => ({ header: snapshot.header, live: false }))
      } catch (error) {
        this.logger?.warn?.(`mode-manager: listing sessions through persistence failed: ${messageOf(error)}`)
      }
    }
    return []
  }

  /** The preset a session currently records, preferring a live Agent projection. */
  currentPresetOf(header) {
    const liveSession = this.sessions?.get?.(header.id)
    if (liveSession !== undefined && this.presets !== undefined) {
      try {
        const preset = this.presets.presetForSession(liveSession)
        if (preset !== null && preset !== undefined) return preset
      } catch {
        // Fall through to the cached and header values.
      }
    }
    const cache = this.projectionCache
    if (cache !== undefined) {
      try {
        const snapshot = cache.cachedSnapshot(header, ['agentPreset'])
        if (snapshot !== undefined && snapshot.values !== undefined && 'agentPreset' in snapshot.values) {
          return snapshot.values.agentPreset ?? null
        }
      } catch {
        // The cached row is stale, missing, or from another lifecycle.
      }
    }
    return header.agentPreset ?? null
  }

  /** Whether any turn has started in the session (blank sessions can be reused). */
  async sessionStarted(sessionId, header) {
    const live = this.sessions?.get?.(sessionId)
    if (live !== undefined && this.agents !== undefined) {
      try {
        const boundary = this.agents.turnBoundaryOf(live)
        return boundary.openTurnStartSeq !== null || boundary.lastTurn > 0
      } catch {
        return true
      }
    }
    const query = this.query
    if (query === undefined) return true
    try {
      const events = await query.listEvents(sessionId)
      return events.some((event) => event.type === 'turn/start')
    } catch {
      return true
    }
  }

  /** Best-effort titles for a set of session ids. */
  async readTitles(sessionIds) {
    const titles = new Map()
    if (sessionIds.length === 0 || this.query === undefined) return titles
    try {
      const observations = await this.query.readTitleSnapshots(sessionIds)
      for (const observation of observations) {
        if (observation.status !== 'fulfilled') continue
        const title = observation.value?.title?.title
        if (typeof title === 'string' && title !== '') titles.set(observation.sessionId, title)
      }
    } catch (error) {
      this.logger?.warn?.(`mode-manager: reading session titles failed: ${messageOf(error)}`)
    }
    return titles
  }

  /* ---------------- plugin manager helpers ---------------- */

  async pluginManagerBundles() {
    const plugins = this.plugins
    if (plugins === undefined) return []
    try {
      return await plugins.listBundles()
    } catch (error) {
      this.logger?.warn?.(`mode-manager: listing bundles failed: ${messageOf(error)}`)
      return []
    }
  }

  /** The bundle that declares one preset row, when any does. */
  async findPresetBundle(id) {
    const rowId = ROW_PREFIX + id
    const bundles = await this.pluginManagerBundles()
    return bundles.find((bundle) => (bundle.rows ?? []).some((row) =>
      row.rowId === rowId && row.moduleName === '@deepseek-ai/dsh-agent-preset'))
  }

  /** Install a bundle directory and normalize the failure surface. */
  async installBundle(dir) {
    const plugins = this.plugins
    if (plugins === undefined) throw new RpcError('internal/error', 'the plugin manager is unavailable')
    let result
    try {
      result = await plugins.installBundle(dir, { enabled: true })
    } catch (error) {
      throw new RpcError('plugin/install-failed', messageOf(error))
    }
    if (result === undefined || result.application === 'failed' || result.application === 'cancelled') {
      const diagnostic = result?.error?.diagnostic ?? result?.error?.code ?? 'unknown installation failure'
      throw new RpcError('plugin/install-failed', String(diagnostic), { details: { application: result?.application } })
    }
    // `restart-required` and `overridden` are installed-but-not-live outcomes:
    // the dependency and its directory exist, so the caller must keep them
    // rather than rolling back into a dangling link.
    return result
  }

  /** Remove a bundle and normalize the failure surface. */
  async removeBundle(name) {
    const plugins = this.plugins
    if (plugins === undefined) throw new RpcError('internal/error', 'the plugin manager is unavailable')
    let result
    try {
      result = await plugins.removeBundle(name)
    } catch (error) {
      throw new RpcError('plugin/remove-failed', messageOf(error))
    }
    if (result === undefined || result.application === 'failed' || result.application === 'cancelled') {
      const diagnostic = result?.error?.diagnostic ?? result?.error?.code ?? 'unknown removal failure'
      throw new RpcError('plugin/remove-failed', String(diagnostic))
    }
    if (result.application === 'restart-required') {
      throw new RpcError('plugin/restart-required', 'the bundle was removed but DSH must restart before it is gone')
    }
    return result
  }

  async removeBundleQuietly(name) {
    try {
      await this.removeBundle(name)
    } catch (error) {
      this.logger?.warn?.(`mode-manager: rolling back bundle "${name}" failed: ${messageOf(error)}`)
    }
  }

  /** Poll the roster until the new definition activates. */
  async waitForPreset(id, timeoutMs = ROSTER_WAIT_MS) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const roster = await this.roster()
      const preset = roster.find((row) => row.id === id)
      if (preset !== undefined) return preset
      if (Date.now() >= deadline) return undefined
      await delay(200)
    }
  }

  /** Poll the roster until a removed definition disappears. */
  async waitForPresetGone(id, timeoutMs = ROSTER_WAIT_MS) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const roster = await this.roster()
      if (roster.every((row) => row.id !== id)) return true
      if (Date.now() >= deadline) return false
      await delay(200)
    }
  }

  /* ---------------- validation helpers ---------------- */

  /** Validate a create/edit draft against the live profile. */
  async normalizeCreateDraft(input, options = {}) {
    const [bundleNames, existingIds] = await Promise.all([
      this.installedBundleNames(),
      this.rosterIds().then((ids) => new Set(ids)),
    ])
    const result = validateDraft(input, {
      existingIds: options.lockId === undefined ? existingIds : undefined,
      existingBundleNames: options.lockId === undefined ? bundleNames : undefined,
      ...(options.lockId === undefined ? {} : { lockId: options.lockId }),
    })
    if (!result.ok) throw result.error
    const draft = await this.withImportSource(result.draft, input)
    return { ok: true, draft }
  }

  /**
   * Validate an optional `importFrom` source and attach it to the draft. Exact
   * imports are only allowed into a new id, and the source must be healthy.
   * @param draft - validated draft.
   * @param input - the original request body (carries importFrom).
   * @returns the draft, possibly with `importFrom`.
   */
  async withImportSource(draft, input) {
    const source = input !== null && typeof input === 'object' && typeof input.importFrom === 'string'
      ? input.importFrom.trim()
      : ''
    if (source === '') return draft
    if (source === draft.id) {
      throw new RpcError('validation', 'the imported source must be a different mode', { field: 'importFrom' })
    }
    const row = (await this.roster()).find((item) => item.id === source)
    if (row === undefined) throw new RpcError('preset/not-found', `unknown source mode: ${source}`)
    if (row.broken !== undefined && row.broken !== '') {
      throw new RpcError('preset/broken-target', `the source mode is broken: ${row.broken}`)
    }
    return { ...draft, importFrom: source }
  }

  /**
   * Read an existing declaration's entry list for a verbatim import.
   * @param id - source preset id.
   * @returns the entry-list YAML and its analyzed display metadata.
   */
  async importedSource(id) {
    const presets = this.presets
    if (presets === undefined) throw new RpcError('internal/error', 'the agent-preset registry is unavailable')
    let resolved
    try {
      resolved = await presets.resolve(id)
    } catch (error) {
      throw new RpcError('preset/not-found', `unknown source mode: ${id}`)
    }
    if (resolved.broken !== undefined && resolved.broken !== '') {
      throw new RpcError('preset/broken-target', resolved.broken)
    }
    let document
    try {
      document = await presets.readDocument(id)
    } catch (error) {
      throw new RpcError('preset/not-found', `could not read the source mode: ${messageOf(error)}`)
    }
    const content = String(document.content ?? '')
    const first = content.split('\n').find((line) => line.trim() !== '')
    if (first === undefined || !/^-\s/.test(first)) {
      throw new RpcError('preset/not-found', 'the source declaration is not an entry list')
    }
    const analysis = analyzePresetDocument(content)
    return {
      id,
      content,
      capabilities: analysis.capabilities,
      persona: analysis.persona,
      ...(document.name === undefined ? {} : { name: document.name }),
      ...(document.description === undefined ? {} : { description: document.description }),
    }
  }

  /** Every dependency name and bundle name the plugin manager currently knows. */
  async installedBundleNames() {
    const names = new Set()
    for (const bundle of await this.pluginManagerBundles()) names.add(bundle.name)
    return names
  }

  /* ---------------- filesystem helpers ---------------- */

  async ensureRoots() {
    await fsp.mkdir(this.creatorRoot, { recursive: true })
    await fsp.mkdir(this.backupsRoot, { recursive: true })
  }

  /** Copy a managed preset bundle to `backupsRoot` and return the backup path. */
  async backupPreset(info, reason) {
    const source = path.join(this.creatorRoot, info.id)
    if (!(await exists(source))) return ''
    await this.ensureRoots()
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
    let name = `${info.id}-${stamp}`
    let target = path.join(this.backupsRoot, name)
    for (let suffix = 2; await exists(target); suffix += 1) {
      name = `${info.id}-${stamp}-${suffix}`
      target = path.join(this.backupsRoot, name)
    }
    await fsp.cp(source, target, { recursive: true })
    await this.audit({ action: 'backup', id: info.id, ok: true, reason, backupPath: target })
    await this.pruneBackups(BACKUP_KEEP)
    return target
  }

  /** Delete the oldest backups beyond `keep`. */
  async pruneBackups(keep) {
    let entries = []
    try {
      entries = await fsp.readdir(this.backupsRoot, { withFileTypes: true })
    } catch {
      return { removed: 0, kept: 0 }
    }
    const dirs = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.backupsRoot, entry.name)
      const metadata = await readJson(path.join(dir, 'mode-manager.json'))
      if (metadata === null || typeof metadata.id !== 'string') continue
      const stat = await fsp.stat(dir).catch(() => undefined)
      if (stat !== undefined) dirs.push({ name: entry.name, dir, mtime: stat.mtimeMs })
    }
    dirs.sort((left, right) => right.mtime - left.mtime)
    let removed = 0
    for (const item of dirs.slice(Math.max(0, keep))) {
      await fsp.rm(item.dir, { recursive: true, force: true }).catch(() => undefined)
      removed += 1
    }
    return { removed, kept: Math.min(dirs.length, keep) }
  }

  /** Read the CLI package version for diagnostics. */
  async readDshVersion() {
    const candidates = []
    const installDir = process.env.DSH_INSTALL_DIR
    if (installDir !== undefined && installDir !== '') candidates.push(installDir)
    // Packaged Desktop keeps the CLI package inside app.asar; Electron's fs can
    // read it. A development launch may instead point resourcesPath at the dist.
    if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
      candidates.push(path.join(process.resourcesPath, 'app.asar', 'dsh'))
      candidates.push(path.join(process.resourcesPath, 'app', 'dsh'))
      candidates.push(path.join(process.resourcesPath, 'dsh'))
    }
    for (const dir of candidates) {
      const manifest = await readJson(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
      if (typeof manifest?.version === 'string') return manifest.version
      const direct = await readJson(path.join(dir, 'package.json'))
      if (direct?.name === '@deepseek-ai/dsh' && typeof direct.version === 'string') return direct.version
    }
    return 'unknown'
  }

  /** Append one audit record; failure is a warning, never an operation failure. */
  async audit(record) {
    try {
      await this.ensureRoots()
      await fsp.appendFile(this.auditPath, JSON.stringify({ time: Date.now(), ...record }) + '\n', 'utf8')
    } catch (error) {
      this.logger?.warn?.(`mode-manager: writing the audit log failed: ${messageOf(error)}`)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Filesystem and small utilities                                      */
/* ------------------------------------------------------------------ */

async function exists(target) {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function writeBundleFiles(dir, draft, imported = undefined) {
  await fsp.mkdir(dir, { recursive: true })
  const patch = imported === undefined ? renderBundlePatch(draft) : renderBundlePatchImported(draft, imported.content)
  const metadata = imported === undefined
    ? renderBundleMetadata(draft, 'custom')
    : renderBundleMetadata(draft, 'import', {
      fidelity: 'raw',
      importedFrom: imported.id,
      capabilities: imported.capabilities,
      persona: imported.persona,
    })
  await fsp.writeFile(path.join(dir, 'package.json'), renderBundlePackageJson(draft.id), 'utf8')
  await fsp.writeFile(path.join(dir, 'cordis.patch.yml'), patch, 'utf8')
  await fsp.writeFile(path.join(dir, 'mode-manager.json'), metadata, 'utf8')
}

async function directorySize(dir) {
  let total = 0
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await directorySize(target)
    else {
      const stat = await fsp.stat(target).catch(() => undefined)
      if (stat !== undefined) total += stat.size
    }
  }
  return total
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function isRpcCode(error, code) {
  return error !== null && typeof error === 'object' && error.code === code
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ------------------------------------------------------------------ */
/* Route registration                                                  */
/* ------------------------------------------------------------------ */

const JSON_HEADERS = { 'cache-control': 'no-store' }

const respond = (value, status = 200) => Response.json(value, { status, headers: JSON_HEADERS })

/**
 * Serve one RPC request.
 * @param host - the service instance.
 * @param request - the browser request.
 */
export async function handleRequest(host, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return respond({ ok: false, error: { code: 'validation', message: 'invalid JSON body' } }, 400)
  }
  const action = body !== null && typeof body === 'object' ? body.action : undefined
  try {
    const data = await host.dispatch(action, body)
    return respond({ ok: true, data })
  } catch (error) {
    const code = error instanceof RpcError ? error.code : (typeof error?.code === 'string' ? error.code : 'internal/error')
    const status = error instanceof RpcError
      ? (error.suggestedStatus ?? STATUS_OF[error.code] ?? 500)
      : 500
    if (status >= 500) {
      host.logger?.warn?.(`mode-manager: action "${String(action)}" failed: ${messageOf(error)}`)
    }
    return respond({
      ok: false,
      error: {
        code,
        message: messageOf(error),
        ...(error instanceof RpcError && error.field !== undefined ? { field: error.field } : {}),
        ...(error instanceof RpcError && error.details !== undefined ? { details: error.details } : {}),
      },
    }, status)
  }
}

/**
 * Host plugin entry: register the RPC route on the Connection.
 * @param ctx - Host context.
 */
export function apply(ctx) {
  const host = new ModeManagerHost(ctx)
  ctx.inject(['connection'], (child) => {
    child.effect(() => child.connection.fetch.register({
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRequest(host, request),
    }), 'mode-manager: rpc route')
  })
}

export default { apply }
