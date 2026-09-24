import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbiddenPaths = /(^|\/)(\.env[^/]*|\.dev\.vars[^/]*|operations|deliverables|sources|\.npmrc|\.DS_Store)(\/|$)|\.(pem|key|sqlite|db)$/i;
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bsk-(?:or-v1-)?[A-Za-z0-9_-]{24,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /(?:\/Users\/|\/home\/)[A-Za-z0-9_.-]+\//,
];
let failed = false;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if ((forbiddenPaths.test(file) && !file.endsWith('.dev.vars.example')) || patterns.some(pattern => pattern.test(text))) {
    console.error(`Review required: ${file}`); failed = true;
  }
}
if (failed) process.exit(1);
console.log(`Checked ${files.length} tracked files for common secrets, personal filesystem paths and private-file patterns. Manual review is still required before publication.`);
