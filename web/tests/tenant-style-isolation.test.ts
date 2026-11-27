import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('vue/compiler-sfc');
const postcss = require('postcss');
const memberPage = new URL('../src/features/team/TenantMembers.vue', import.meta.url);

test('the team member layout scopes table and dialog rules to its own page', () => {
  const { descriptor } = parse(readFileSync(memberPage, 'utf8'));
  assert.equal(descriptor.styles.length, 1);
  const stylesheet = readFileSync(new URL(descriptor.styles[0].src, memberPage), 'utf8');
  const seen = new Set();
  postcss.parse(stylesheet).walkRules(rule => {
    if (rule.parent.type === 'atrule' && rule.parent.name.endsWith('keyframes')) return;
    for (const selector of rule.selectors) {
      assert.match(selector, /^\.tenant-members(?:\b|$)/);
      seen.add(selector);
    }
  });
  assert.ok([...seen].some(selector => selector.includes('.tm-dialog')));
  assert.ok([...seen].some(selector => selector.includes('.tm-table')));
});
