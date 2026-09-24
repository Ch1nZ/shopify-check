import { createAccountSession, sha256Hex, ensureBrowserSession } from './credits';
import { validateDiagnosticModels, modelCapabilities } from '@mclab/openrouter-adapter';
export const SELF_HOST_ACCOUNT = '00000000-0000-4000-8000-000000000001';
export function isSelfHosted(env: Env) { return env.SELF_HOSTED === 'true'; }
export async function selfHostRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === '/api/v1/self-host/config' && request.method === 'GET') {
    let configured = false;
    try { validateDiagnosticModels(); configured = true; } catch { /* Public status excludes key names/values. */ }
    return Response.json({ self_hosted: isSelfHosted(env), configured, models: isSelfHosted(env) ? modelCapabilities() : [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!isSelfHosted(env)) return null;
  if (path.startsWith('/api/v1/billing/paddle') || path.startsWith('/api/v1/account/signup') || path.startsWith('/api/v1/account/recover') || path.startsWith('/owner/') || path.startsWith('/api/v1/owner/')) return Response.json({ error: { message: 'This feature is disabled on self-hosted deployments.' } }, { status: 404 });
  if (path === '/api/v1/analytics/events') return new Response(null, { status: 204 });
  if (path === '/api/v1/self-host/session' && request.method === 'GET') {
    const session = await ensureBrowserSession(request, env);
    return Response.json({ operator: session.accountId === SELF_HOST_ACCOUNT }, { headers: { 'Cache-Control': 'no-store', ...(session.setCookie ? { 'Set-Cookie': session.setCookie } : {}) } });
  }
  if (path === '/api/v1/self-host/logout' && request.method === 'POST') {
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response(null,{status:403});
    const token = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('mclab_session='))?.slice('mclab_session='.length);
    if (token) await env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').bind(new Date().toISOString(), await sha256Hex(token)).run();
    return Response.json({ ok: true }, { headers: { 'Set-Cookie': 'mclab_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax', 'Cache-Control': 'no-store' } });
  }
  if (path !== '/api/v1/self-host/login') return null;
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (request.headers.get('origin') !== new URL(request.url).origin) return new Response(null, { status: 403 });
  if (!(await env.CHECKOUT_RATE_LIMITER.limit({ key: `operator:${request.headers.get('CF-Connecting-IP') ?? 'local'}` })).success) return new Response(null, { status: 429 });
  const configured = env.SELF_HOST_ACCESS_TOKEN;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!configured || configured.length < 24 || !supplied || supplied.length > 256 || await sha256Hex(supplied) !== await sha256Hex(configured)) return Response.json({ error: { message: 'Operator access token is missing or invalid.' } }, { status: 401 });
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO accounts (id,status,created_at,updated_at) VALUES (?,'active',?,?)").bind(SELF_HOST_ACCOUNT, now, now),
    env.DB.prepare("INSERT OR IGNORE INTO credit_operations (id,account_id,operation_type,external_idempotency_key,credits,status,external_operation_id,created_at,updated_at) VALUES (?,?,'grant',?,3000000,'completed',?,?,?)").bind(SELF_HOST_ACCOUNT,SELF_HOST_ACCOUNT,'self-host:operator','self-host:operator',now,now),
  ]);
  const session = await createAccountSession(SELF_HOST_ACCOUNT, env);
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': session.setCookie!, 'Cache-Control': 'no-store' } });
}
