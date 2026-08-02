// Diagnose ChatGPT Codex /models responses using the locally stored credential.
// Prints HTTP status, payload shape, and model counts for several
// client_version values. NEVER prints tokens or header values.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const home = process.env.CLOUD_CODE_HOME ?? join(homedir(), '.cloud-code');
const credPath = join(home, 'credentials', 'chatgpt-codex.json');
const cred = JSON.parse(readFileSync(credPath, 'utf8'));
const accessToken = cred.accessToken ?? cred.access_token;
const idToken = cred.idToken ?? cred.id_token;
const accountId = cred.accountId ?? cred.account_id;

function jwtClaims(jwt) {
  try {
    const payload = jwt.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

if (!accessToken) {
  console.error('no access token in', credPath);
  process.exit(1);
}
if (idToken) {
  const claims = jwtClaims(idToken);
  const auth = claims?.['https://api.openai.com/auth'] ?? {};
  console.log('id_token claims: plan=%s accountId=%s userId=%s',
    auth.chatgpt_plan_type, auth.chatgpt_account_id ?? claims?.chatgpt_account_id,
    (auth.chatgpt_user_id ?? '').slice(0, 8) + '…');
}
console.log('credential file: %s (accountId %s)', credPath, accountId ? 'present' : 'MISSING');

const versions = ['0.28.1', '0.0.0', '0.55.0', '0.20.0'];
for (const v of versions) {
  const url = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(v)}`;
  const headers = {
    originator: 'codex_cli_rs',
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
  if (accountId) headers['ChatGPT-Account-ID'] = accountId;
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    let shape = 'non-json';
    let count = -1;
    let firstKeys = '';
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json?.models)) {
        shape = `{models:[…]} (+${Object.keys(json).filter((k) => k !== 'models').length} keys)`;
        count = json.models.length;
        if (count > 0) firstKeys = Object.keys(json.models[0]).join(',');
      } else {
        shape = `{${Object.keys(json).slice(0, 6).join(',')}}`;
      }
    } catch { shape = `text(${text.length}b): ${text.slice(0, 120).replace(/\s+/g, ' ')}`; }
    console.log('v=%s → HTTP %d, shape=%s, models=%d %s', v, res.status, shape, count, firstKeys ? `firstKeys=[${firstKeys}]` : '');
  } catch (err) {
    console.log('v=%s → fetch failed: %s', v, err?.message ?? err);
  }
}
