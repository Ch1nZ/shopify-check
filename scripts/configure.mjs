import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const models=JSON.parse(readFileSync(resolve(root,'models.local.json'),'utf8'));
const providers=['openai','google','anthropic','openrouter','openai-compatible'];
for(const role of ['planner','observer','synthesizer']) {
 const model=models[role];
 if(!model || !providers.includes(model.provider) || !model.model || model.model.includes('REPLACE_') || !/^[A-Z][A-Z0-9_]*$/.test(model.key_env)) throw new Error(`Configure your own provider, model and key_env for ${role}.`);
 if(role==='observer' && (!model.search || model.provider==='openai-compatible')) throw new Error('Observer needs native search: openai, google, anthropic or openrouter.');
}
const path=resolve(root,'apps/worker/.dev.vars');
const text=readFileSync(path,'utf8').replace(/^MODEL_CONFIG=.*\n?/m,'');
writeFileSync(path,`${text.trimEnd()}\nMODEL_CONFIG='${JSON.stringify(models)}'\n`,{mode:0o600});
console.log('Updated local model configuration. Credentials were not printed. Restart the local server to apply.');
