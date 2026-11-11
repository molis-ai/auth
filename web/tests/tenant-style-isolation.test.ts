import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parse, compileStyle } = require('vue/compiler-sfc');

test('tenant member styles stay scoped after Vue compilation, including override rules', () => {
  const { descriptor } = parse(readFileSync(new URL('../src/TenantMembers.vue', import.meta.url), 'utf8'));
  for (const style of descriptor.styles) {
    assert.equal(style.scoped, true);
    const result = compileStyle({ source: style.content, filename: 'TenantMembers.vue', id: 'data-v-isolation', scoped: true });
    assert.deepEqual(result.errors, []);
    // Vue :global(.v2-console) followed by descendants compiled to the shell alone.
    // Check compiled CSS, not just the intended selector in the source.
    const selectors = [...result.code.matchAll(/([^{}]+)\{/g)].map(match => match[1].trim()).filter(selector => !selector.startsWith('@'));
    for (const selector of selectors) {
      for (const part of selector.split(',')) assert.ok(part.includes('[data-v-isolation]'), part);
    }
  }
});
