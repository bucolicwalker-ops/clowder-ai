/**
 * #1542: launch-plan builder for the managed Claude compaction carrier.
 *
 * One immutable plan drives BOTH the spawn (`--settings` injection in
 * ClaudeAgentService) and the compaction readiness decision (invoke-single-cat
 * consumes the exact plan it handed to the adapter — never a guessed project
 * root). The canonical carrier is the Node script (successor of the #1456
 * portable carrier, credited to @amazing-fish); the shell script stays a
 * bounded legacy compatibility, never a parallel standard.
 *
 * Contract (maintainer direction on #1542):
 * - resolves assets from the API/install root, NEVER from workingDirectory;
 * - reads no target-project `.claude/settings*.json` and writes nothing;
 * - the single-session settings document registers PreCompact + SessionStart
 *   with the same canonical Node handler shape and never sets
 *   `disableAllHooks: false`;
 * - ready means "this exact carrier will be handed to the CLI", which still
 *   cannot substitute for the current-invocation authenticated attestation.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLAUDE_COMPACTION_CARRIER_IDENTITY = 'f296-node-v1';

const CARRIER_SCRIPT_NAME = 'f24-compaction.mjs';
const REQUIRED_NODE_CARRIER_MARKERS = [
  '/api/sessions/seal',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'X-Invocation-Id',
  'X-Callback-Token',
  'X-Clowder-Compaction-Carrier',
] as const;

export interface ClaudeCompactionLaunchPlan {
  readonly ready: true;
  /** Absolute path of the Node runtime that will execute the carrier. */
  readonly nodePath: string;
  /** Absolute path of the canonical Node carrier script (install-root resolved). */
  readonly carrierScriptPath: string;
  readonly carrierIdentity: typeof CLAUDE_COMPACTION_CARRIER_IDENTITY;
  readonly preCompactCommand: string;
  readonly sessionStartCommand: string;
  /** Single-session `--settings` document registering the canonical handlers. */
  readonly settingsDocument: string;
  /** Secret-free identity for logging/tests; never contains credentials. */
  readonly planIdentity: string;
}

export type ClaudeCompactionLaunchPlanResult =
  | ClaudeCompactionLaunchPlan
  | { readonly ready: false; readonly reason: 'carrier_script_unresolved' | 'carrier_script_invalid' };

export interface ClaudeCompactionLaunchPlanOptions {
  /** Install root for carrier asset resolution — never the invocation workingDirectory. */
  readonly installRoot?: string;
}

/**
 * Trusted install-root anchor (#1542 review P1-2): derive candidate roots from
 * THIS MODULE's own location, never from process.cwd(). The packaged API may be
 * launched from any directory (Windows Apps/apps spellings, junctions, service
 * managers); the compiled module always lives at a fixed depth under the
 * install root, so walking up from `import.meta.url` establishes the promised
 * install-root authority boundary regardless of the process CWD.
 */
function resolveInstallRootCandidates(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  // dist/domains/cats/services/agents/providers/ → walk up to the package root
  // and the install root that contains it (repo checkout, desktop {app}, etc.).
  return [
    resolve(moduleDir, '.'), // packages/api/dist/.../providers (dev transpile layouts)
    resolve(moduleDir, '../../../..'), // package root
    resolve(moduleDir, '../../../../../..'), // install root containing the package
  ];
}

function resolveInstallRoot(explicit?: string): string {
  if (explicit) return explicit;
  const envRoot = process.env.CAT_CAFE_COMPACTION_CARRIER_ROOT?.trim();
  if (envRoot) return envRoot;
  for (const candidate of resolveInstallRootCandidates()) {
    if (existsSync(join(candidate, '.claude', 'hooks', CARRIER_SCRIPT_NAME))) return candidate;
  }
  // Fall back to the nearest package-level ancestor; buildClaudeCompactionLaunchPlan
  // still scans its upward candidates, so an unmatched root yields a ready:false
  // plan rather than a wrong-file match.
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function managedPreCompactHookEntry(
  plan: Pick<ClaudeCompactionLaunchPlan, 'preCompactCommand'>,
): Record<string, unknown> {
  return {
    matcher: 'manual|auto',
    hooks: [{ type: 'command', command: plan.preCompactCommand, statusMessage: 'F24: Saving session state...' }],
  };
}

function managedSessionStartHookEntry(
  plan: Pick<ClaudeCompactionLaunchPlan, 'sessionStartCommand'>,
): Record<string, unknown> {
  return {
    matcher: 'compact',
    hooks: [{ type: 'command', command: plan.sessionStartCommand, statusMessage: 'F296: Restoring context...' }],
  };
}

/**
 * Compose the final single `--settings` document for one spawn.
 *
 * P1 guard (#1542 review): a user-supplied `--settings` must never silently
 * replace or drop the managed carrier, and two `--settings` flags must never
 * both reach the CLI. The user document (inline JSON or a file path) is merged
 * with the managed handlers into ONE document: user settings survive verbatim
 * (including `disableAllHooks: true`, which keeps its fail-closed semantics),
 * and the managed PreCompact/SessionStart entries are appended.
 *
 * P1-3 (#1542 re-review): a RELATIVE file path keeps its CLI meaning — the
 * claude child resolves it against the spawn workingDirectory, so this side
 * must resolve it against the same directory, never the API process CWD.
 */
export function composeManagedSettingsDocument(
  plan: ClaudeCompactionLaunchPlan,
  userSettings?: string,
  workingDirectory?: string,
): string {
  if (userSettings === undefined) return plan.settingsDocument;
  let userDoc: Record<string, unknown>;
  try {
    const raw = userSettings.trimStart().startsWith('{')
      ? userSettings
      : readFileSync(resolveUserSettingsPath(userSettings, workingDirectory), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecordLike(parsed)) throw new Error('not_an_object');
    userDoc = parsed;
  } catch {
    throw new Error('cli_config_args_settings_invalid');
  }
  const userHooks = isRecordLike(userDoc.hooks) ? userDoc.hooks : {};
  const merged: Record<string, unknown> = {
    ...userDoc,
    hooks: {
      ...userHooks,
      PreCompact: [...asArray(userHooks.PreCompact), managedPreCompactHookEntry(plan)],
      SessionStart: [...asArray(userHooks.SessionStart), managedSessionStartHookEntry(plan)],
    },
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

function resolveUserSettingsPath(userSettings: string, workingDirectory?: string): string {
  if (isAbsolute(userSettings)) return userSettings;
  // Mirror the CLI: relative --settings paths resolve from the child's cwd.
  return resolve(workingDirectory ?? process.cwd(), userSettings);
}

function resolveCarrierScriptCandidates(installRoot: string): string[] {
  return [
    resolve(installRoot, '.claude/hooks', CARRIER_SCRIPT_NAME),
    resolve(installRoot, '../.claude/hooks', CARRIER_SCRIPT_NAME),
    resolve(installRoot, '../../.claude/hooks', CARRIER_SCRIPT_NAME),
    resolve(installRoot, '../../../.claude/hooks', CARRIER_SCRIPT_NAME),
  ];
}

/**
 * Build the launch plan for one managed Claude spawn. Pure: touches no temp
 * files and reads no project settings, so readiness may build it freely.
 */
export function buildClaudeCompactionLaunchPlan(
  options: ClaudeCompactionLaunchPlanOptions = {},
): ClaudeCompactionLaunchPlanResult {
  const installRoot = resolveInstallRoot(options.installRoot);
  let sawInvalidScript = false;
  for (const carrierScriptPath of resolveCarrierScriptCandidates(installRoot)) {
    let source: string;
    try {
      const stat = lstatSync(carrierScriptPath);
      // Plain file only — the canonical carrier is packaged, not linked.
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      source = readFileSync(carrierScriptPath, 'utf8');
    } catch {
      continue;
    }
    if (!REQUIRED_NODE_CARRIER_MARKERS.every((marker) => source.includes(marker))) {
      sawInvalidScript = true;
      continue;
    }
    const nodePath = process.execPath;
    const preCompactCommand = `"${nodePath}" "${carrierScriptPath}" pre`;
    const sessionStartCommand = `"${nodePath}" "${carrierScriptPath}" post`;
    const partialPlan: Omit<ClaudeCompactionLaunchPlan, 'settingsDocument' | 'planIdentity'> = {
      ready: true,
      nodePath,
      carrierScriptPath,
      carrierIdentity: CLAUDE_COMPACTION_CARRIER_IDENTITY,
      preCompactCommand,
      sessionStartCommand,
    };
    const settingsDocument = `${JSON.stringify(
      {
        hooks: {
          PreCompact: [managedPreCompactHookEntry(partialPlan)],
          SessionStart: [managedSessionStartHookEntry(partialPlan)],
        },
      },
      null,
      2,
    )}\n`;
    const sourceDigest = createHash('sha256').update(source).digest('hex');
    const planIdentity = createHash('sha256')
      .update(`${nodePath}|${carrierScriptPath}|${sourceDigest}`)
      .digest('hex')
      .slice(0, 16);
    return {
      ready: true,
      nodePath,
      carrierScriptPath,
      carrierIdentity: CLAUDE_COMPACTION_CARRIER_IDENTITY,
      preCompactCommand,
      sessionStartCommand,
      settingsDocument,
      planIdentity,
    };
  }
  return { ready: false, reason: sawInvalidScript ? 'carrier_script_invalid' : 'carrier_script_unresolved' };
}
