import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const vars = resolve(root,'apps/worker/.dev.vars');
if (!existsSync(vars)) {
  const template = readFileSync(resolve(root,'apps/worker/.dev.vars.example'),'utf8').replace('SELF_HOST_ACCESS_TOKEN=', `SELF_HOST_ACCESS_TOKEN=${randomBytes(32).toString('hex')}`);
  writeFileSync(vars,template,{mode:0o600});
}
if (!existsSync(resolve(root,'models.local.json'))) writeFileSync(resolve(root,'models.local.json'),readFileSync(resolve(root,'config/models.example.json')));
console.log('Local configuration prepared. Your operator token is in apps/worker/.dev.vars (not printed here).\nFor AI diagnostics, edit models.local.json and add your own provider keys to .dev.vars, then run npm run configure.\nFor the free product-data checker, run npm run db:migrate and npm run dev.');
