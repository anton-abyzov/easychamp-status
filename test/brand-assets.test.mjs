import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
test('vendored EasyChamp assets match their reviewed provenance digests',async()=>{
 const manifest=JSON.parse(await readFile('docs/brand-assets.json','utf8'));
 assert.ok(manifest.assets.length>=12);
 for(const asset of manifest.assets){assert.match(asset.file,/^public\/(?:assets\/|favicon\.svg$)/);assert.equal(createHash('sha256').update(await readFile(asset.file)).digest('hex'),asset.sha256,asset.file);assert.ok(asset.commit||asset.package);}
});
test('the status shell uses real branding and self-hosted UIKit typography',async()=>{
 const html=await readFile('public/index.html','utf8'),css=await readFile('public/style.css','utf8');
 assert.ok(html.includes('assets/brand/easychamp-light.svg'));assert.ok(html.includes('assets/brand/easychamp-dark.svg'));assert.ok(html.includes('assets/brand/uikit-tokens.css'));
 assert.ok(!html.includes('class="brand-mark"'));assert.ok(css.includes('var(--font-body)'));assert.ok(css.includes('var(--font-display)'));assert.ok(css.includes('var(--color-brand)'));assert.ok(!css.includes('fonts.googleapis.com'));
});
