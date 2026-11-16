// Verify a consumer against this immutable Auth checkout, not against a moving branch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const [product, root, ...extra] = process.argv.slice(2);
assert.ok(['work', 'club'].includes(product) && root && !extra.length, 'Usage: verify-product.mjs work|club <consumer-root>');
const source = dirname(fileURLToPath(import.meta.url));
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: source, encoding: 'utf8'}).trim();
const work = product === 'work';
const directory = resolve(root, work ? 'horizontal/account/src/upstream' : 'lib/account/contracts');
const metadata = JSON.parse(readFileSync(resolve(directory, work ? 'provenance.json' : 'snapshot.json')));
const revision = metadata[work ? 'sourceBaseCommit' : 'sourceRevision'];
assert.match(revision, /^[a-f0-9]{40}$/);
assert.equal(revision, sourceRevision, 'Auth checkout must be the pinned commit');
assert.equal(metadata.sourceRepository, 'https://github.com/molis-ai/auth');
assert.equal(metadata.sourceDirectory, 'contracts/unified-account');
if (work) assert.equal(metadata.sourceIncludesUncommittedContract, false);
const files = ['schemas.json', 'openapi.json', 'policy.json', 'fixtures.json', 'validator-profile.json', 'validate.ts'];
const hashes = metadata[work ? 'sha256' : 'files'];
assert.deepEqual(Object.keys(hashes).sort(), [...files].sort());
for (const name of files) {
  const bytes = readFileSync(resolve(source, name));
  assert.ok(bytes.equals(execFileSync('git', ['show', `${revision}:contracts/unified-account/${name}`], {cwd: source})), 'Dirty Auth source: ' + name);
  assert.ok(bytes.equals(readFileSync(resolve(directory, name))), 'Auth source mismatch: ' + name);
  assert.equal(hashes[name], createHash('sha256').update(bytes).digest('hex'), 'Stale digest: ' + name);
}
assert.equal(metadata[work ? 'version' : 'contractVersion'], JSON.parse(readFileSync(resolve(source, 'policy.json'))).contractVersion);
execFileSync(process.execPath, [resolve(source, 'generate.ts'), '--check'], {stdio:'inherit'});
execFileSync(process.execPath, [resolve(root, work ? 'horizontal/account/scripts/check-contracts.mjs' : 'scripts/account-contracts.mjs'), ...(work ? [] : ['--check'])], {stdio:'inherit'});
console.log(`${product}: contract bytes, version, source commit and generated types verified`);
