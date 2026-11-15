import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const options = {};
let write = false;
while (args.length) {
  const flag = args.shift();
  if (flag === '--write') write = true;
  else {
    assert.ok(['--work', '--club'].includes(flag), `Unknown option: ${flag}`);
    const value = args.shift();
    assert.ok(value && !value.startsWith('--'), `Missing path for ${flag}`);
    assert.ok(!options[flag], `Duplicate option: ${flag}`);
    options[flag] = resolve(value);
  }
}
assert.ok(options['--work'] && options['--club'], 'Usage: node sync-products.mjs --work <Work root> --club <Club root> [--write]');
const source = dirname(fileURLToPath(import.meta.url));
const files = ['schemas.json', 'openapi.json', 'policy.json', 'fixtures.json', 'validator-profile.json', 'validate.ts'];
execFileSync(process.execPath, [resolve(source, 'generate.ts'), '--check'], { stdio: 'inherit' });
const contents = new Map(files.map(name => [name, readFileSync(resolve(source, name))]));
const hashes = Object.fromEntries([...contents].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));
const version = JSON.parse(contents.get('policy.json').toString()).contractVersion;
const targets = [
  { name: 'Work', root: options['--work'], directory: 'horizontal/account/src/upstream', manifest: 'provenance.json', hashes: 'sha256', version: 'version', generator: 'horizontal/account/scripts/check-contracts.mjs' },
  { name: 'Club', root: options['--club'], directory: 'lib/account/contracts', manifest: 'snapshot.json', hashes: 'files', version: 'contractVersion', generator: 'scripts/account-contracts.mjs' },
].map(target => ({ ...target, metadata: JSON.parse(readFileSync(resolve(target.root, target.directory, target.manifest), 'utf8')) }));

// Read and verify Auth completely before changing either consumer.
for (const target of targets) {
  const directory = resolve(target.root, target.directory);
  if (write) {
    mkdirSync(directory, { recursive: true });
    for (const [name, bytes] of contents) writeFileSync(resolve(directory, name), bytes);
    target.metadata[target.hashes] = hashes;
    target.metadata[target.version] = version;
    writeFileSync(resolve(directory, target.manifest), JSON.stringify(target.metadata, null, 2) + '\n');
    execFileSync(process.execPath, [resolve(target.root, target.generator), ...(target.name === 'Work' ? ['--write'] : [])], { stdio: 'inherit' });
  }
  for (const [name, bytes] of contents) {
    assert.ok(readFileSync(resolve(directory, name)).equals(bytes), `${target.name}/${name} differs from Auth; sync from Auth with --write`);
    assert.equal(target.metadata[target.hashes][name], hashes[name], `${target.name}/${name} source digest is stale`);
  }
  assert.equal(target.metadata[target.version], version, `${target.name} contract version differs from Auth`);
  execFileSync(process.execPath, [resolve(target.root, target.generator), ...(target.name === 'Club' ? ['--check'] : [])], { stdio: 'inherit' });
  console.log(`${target.name}: all six contract files match Auth; generated types verified`);
}
