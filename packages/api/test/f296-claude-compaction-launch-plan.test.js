import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

const { buildClaudeCompactionLaunchPlan, composeManagedSettingsDocument, CLAUDE_COMPACTION_CARRIER_IDENTITY } =
  await import('../dist/domains/cats/services/agents/providers/claude-compaction-launch-plan.js');

const roots = [];

function carrierRoot({ valid = true, linked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'f296-launch-plan-'));
  roots.push(root);
  mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
  const scriptPath = join(root, '.claude', 'hooks', 'f24-compaction.mjs');
  const source = valid
    ? [
        '// fixture canonical Node carrier',
        'fetch("/api/sessions/seal"',
        'CAT_CAFE_INVOCATION_ID CAT_CAFE_CALLBACK_TOKEN',
        'X-Invocation-Id X-Callback-Token X-Clowder-Compaction-Carrier',
      ].join('\n')
    : '// stale carrier without callback contract markers';
  writeFileSync(scriptPath, source);
  if (linked) {
    const target = `${scriptPath}.real`;
    rmSync(scriptPath);
    writeFileSync(target, source);
    symlinkSync(target, scriptPath);
  }
  return root;
}

function emptyRoot() {
  const root = mkdtempSync(join(tmpdir(), 'f296-launch-plan-empty-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.CAT_CAFE_COMPACTION_CARRIER_ROOT;
});

describe('F296 #1542 claude compaction launch plan', () => {
  test('resolves the canonical Node carrier from the install root with exact handler shapes', () => {
    const plan = buildClaudeCompactionLaunchPlan({ installRoot: carrierRoot() });
    assert.equal(plan.ready, true);
    assert.equal(plan.carrierIdentity, CLAUDE_COMPACTION_CARRIER_IDENTITY);
    assert.equal(plan.nodePath, process.execPath);
    assert.ok(plan.carrierScriptPath.endsWith('f24-compaction.mjs'));
    assert.ok(plan.carrierScriptPath.startsWith('/'), 'carrier script must be an absolute install-root path');
    assert.equal(plan.preCompactCommand, `"${plan.nodePath}" "${plan.carrierScriptPath}" pre`);
    assert.equal(plan.sessionStartCommand, `"${plan.nodePath}" "${plan.carrierScriptPath}" post`);

    const settings = JSON.parse(plan.settingsDocument);
    assert.equal(settings.hooks.PreCompact[0].matcher, 'manual|auto');
    assert.equal(settings.hooks.PreCompact[0].hooks[0].command, plan.preCompactCommand);
    assert.equal(settings.hooks.SessionStart[0].matcher, 'compact');
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, plan.sessionStartCommand);
    assert.equal(settings.disableAllHooks, undefined, 'must never force disableAllHooks: false');
    assert.ok(plan.planIdentity.length > 0);
  });

  test('CAT_CAFE_COMPACTION_CARRIER_ROOT overrides the install root', () => {
    const root = carrierRoot();
    process.env.CAT_CAFE_COMPACTION_CARRIER_ROOT = root;
    const plan = buildClaudeCompactionLaunchPlan();
    assert.equal(plan.ready, true);
    assert.equal(plan.carrierScriptPath, join(root, '.claude', 'hooks', 'f24-compaction.mjs'));
  });

  test('fails closed on missing, marker-less, or symlinked carrier assets', () => {
    assert.deepEqual(buildClaudeCompactionLaunchPlan({ installRoot: emptyRoot() }), {
      ready: false,
      reason: 'carrier_script_unresolved',
    });
    assert.equal(
      buildClaudeCompactionLaunchPlan({ installRoot: carrierRoot({ valid: false }) }).reason,
      'carrier_script_invalid',
    );
    assert.equal(
      buildClaudeCompactionLaunchPlan({ installRoot: carrierRoot({ linked: true }) }).reason,
      'carrier_script_unresolved',
    );
  });

  test('composeManagedSettingsDocument preserves user settings and appends managed handlers', () => {
    const plan = buildClaudeCompactionLaunchPlan({ installRoot: carrierRoot() });
    assert.equal(composeManagedSettingsDocument(plan), plan.settingsDocument);

    const userDoc = {
      spinnerTipsEnabled: true,
      disableAllHooks: true,
      hooks: { PreCompact: [{ matcher: 'manual', hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
    };
    const merged = JSON.parse(composeManagedSettingsDocument(plan, JSON.stringify(userDoc)));
    assert.equal(merged.spinnerTipsEnabled, true, 'user non-hook settings survive');
    assert.equal(merged.disableAllHooks, true, 'user opt-out semantics survive (fail closed downstream)');
    assert.equal(merged.hooks.PreCompact.length, 2, 'user entry + managed entry');
    assert.equal(merged.hooks.PreCompact[0].hooks[0].command, 'echo user-hook');
    assert.equal(merged.hooks.PreCompact[1].hooks[0].command, plan.preCompactCommand);
    assert.equal(merged.hooks.SessionStart.length, 1, 'managed SessionStart appended');
    assert.equal(merged.hooks.SessionStart[0].hooks[0].command, plan.sessionStartCommand);

    const userFile = join(emptyRoot(), 'user-settings.json');
    writeFileSync(userFile, JSON.stringify({ env: { FOO: 'bar' } }));
    const fromFile = JSON.parse(composeManagedSettingsDocument(plan, userFile));
    assert.equal(fromFile.env.FOO, 'bar');
    assert.equal(fromFile.hooks.PreCompact[0].hooks[0].command, plan.preCompactCommand);

    assert.throws(
      () => composeManagedSettingsDocument(plan, '/nonexistent-settings.json'),
      /cli_config_args_settings_invalid/,
    );
    assert.throws(() => composeManagedSettingsDocument(plan, '{not json'), /cli_config_args_settings_invalid/);
  });
});
