'use strict';
/**
 * Unit tests for Trae model catalog filtering.
 * Trae 的 get_detail_param 会混入 custom_model_* / 内部 agent / __dev/__max 变体，
 * 只应暴露 display_config.display_name 非空的用户模型。
 */
const assert = require('assert');
const trae = require('../src/providers/trae');
const isUserFacing = trae.__testing.isUserFacingConfig;

function cfg(config_name, display_name, extra = {}) {
  return { config_name, display_config: { display_name, ...extra } };
}

const cases = [
  ['real glm', cfg('glm-5.3', 'GLM-5.3'), true],
  ['real doubao', cfg('Doubao-Seed-2.1-Turbo', 'Seed-2.1-Turbo'), true],
  ['real aliased config', cfg('seed-code-pro-0430', 'Doubao-Seed-2.1-Pro'), true],
  ['custom placeholder', cfg('custom_model_gpt-6', null), false],
  ['custom with display', cfg('custom_model_gemini', 'Gemini-3.1-Pro-Preview'), false],
  ['internal subagent', cfg('computer_use_subagent', 'computer_use_subagent'), false],
  ['internal agent v2', cfg('explore_sub_agent_v2', null), false],
  ['summary', cfg('summary', null), false],
  ['dash display', cfg('sagitta', '-'), false],
  ['dev variant', cfg('glm-5.3__dev', 'GLM-5.3'), false],
  ['max variant', cfg('glm-5.3__max', 'GLM-5.3'), false],
];

let failed = 0;
for (const [name, input, expected] of cases) {
  try {
    assert.equal(isUserFacing(input), expected, name);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}
if (failed) {
  process.exitCode = 1;
} else {
  console.log('trae catalog unit tests passed');
}
