import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

test('LOGIN-P1-06: immutable source defeats forged consumer hashes, stale revisions, versions and types', () => {
  const root=mkdtempSync(join(tmpdir(),'auth-contract-pin-'));
  try {
    const source=join(root,'auth'), directory=join(source,'contracts/unified-account'), consumer=join(root,'club'), target=join(consumer,'lib/account/contracts');
    mkdirSync(directory,{recursive:true});mkdirSync(target,{recursive:true});mkdirSync(join(consumer,'scripts'));
    const files=['schemas.json','openapi.json','policy.json','fixtures.json','validator-profile.json','validate.ts'];
    for(const name of [...files,'generate.ts','verify-product.mjs'])copyFileSync(new URL(name,import.meta.url),join(directory,name));
    writeFileSync(join(source,'package.json'),'{"type":"module"}');
    const git=(...args)=>execFileSync('git',args,{cwd:source,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    git('init');git('add','.');git('-c','user.name=Contract test','-c','user.email=contract@example.test','commit','-m','Fixture');
    const revision=git('rev-parse','HEAD');
    for(const name of files)copyFileSync(join(directory,name),join(target,name));
    const manifest={sourceRepository:'https://github.com/molis-ai/auth',sourceDirectory:'contracts/unified-account',sourceRevision:revision,contractVersion:JSON.parse(readFileSync(join(directory,'policy.json'))).contractVersion,files:Object.fromEntries(files.map(name=>[name,createHash('sha256').update(readFileSync(join(directory,name))).digest('hex')]))};
    const save=()=>writeFileSync(join(target,'snapshot.json'),JSON.stringify(manifest));
    const run=()=>spawnSync(process.execPath,[join(directory,'verify-product.mjs'),'club',consumer],{encoding:'utf8'});
    writeFileSync(join(consumer,'scripts/account-contracts.mjs'),'process.exit(0)');save();
    assert.equal(run().status,0);
    manifest.sourceRevision='0'.repeat(40);save();assert.notEqual(run().status,0);manifest.sourceRevision=revision;
    manifest.contractVersion='0.0.0';save();assert.notEqual(run().status,0);manifest.contractVersion=JSON.parse(readFileSync(join(directory,'policy.json'))).contractVersion;
    const original=readFileSync(join(target,'policy.json'));
    writeFileSync(join(target,'policy.json'),Buffer.concat([original,Buffer.from('\n')]));manifest.files['policy.json']=createHash('sha256').update(readFileSync(join(target,'policy.json'))).digest('hex');save();
    assert.match(run().stderr,/Auth source mismatch/);
    writeFileSync(join(target,'policy.json'),original);manifest.files['policy.json']=createHash('sha256').update(original).digest('hex');save();
    writeFileSync(join(consumer,'scripts/account-contracts.mjs'),'process.exit(1)');assert.notEqual(run().status,0);
    writeFileSync(join(consumer,'scripts/account-contracts.mjs'),'process.exit(0)');
    writeFileSync(join(directory,'policy.json'),Buffer.concat([original,Buffer.from('\n')]));assert.match(run().stderr,/Dirty Auth source/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
