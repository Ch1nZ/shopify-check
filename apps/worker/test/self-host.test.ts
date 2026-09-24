import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { withModelRuntime } from '@mclab/openrouter-adapter';
import { selfHostRoute, SELF_HOST_ACCOUNT } from '../src/self-host';
import { ensureBrowserSession } from '../src/credits';
import { routeRequest } from '../src/http';
const hosted = { ...env, SELF_HOSTED: 'true', SELF_HOST_ACCESS_TOKEN: 'fixture-operator-token-at-least-24-characters' } as Env;
const request = (path: string, token?: string) => new Request(`https://checker.example${path}`,{method:'POST',headers:{Origin:'https://checker.example',...(token?{Authorization:`Bearer ${token}`}:{})}});
beforeAll(async()=>{
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY,status TEXT,created_at TEXT,updated_at TEXT,email_normalized TEXT)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,account_id TEXT,token_hash TEXT,expires_at TEXT,created_at TEXT,revoked_at TEXT)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS credit_operations (id TEXT PRIMARY KEY,account_id TEXT,operation_type TEXT,external_idempotency_key TEXT UNIQUE,credits INTEGER,status TEXT,external_operation_id TEXT,created_at TEXT,updated_at TEXT)").run();
});
describe('self-hosted operator boundary',()=>{
 it('does not enable paid provider usage for an anonymous visitor',async()=>{
  const response=await selfHostRoute(request('/api/v1/self-host/login'),hosted);
  expect(response?.status).toBe(401);
 });
 it('fails closed without an operator secret',async()=>{
  const response=await selfHostRoute(request('/api/v1/self-host/login','fixture-operator-token-at-least-24-characters'),{...hosted,SELF_HOST_ACCESS_TOKEN:''});
  expect(response?.status).toBe(401);
 });
 it('creates a secure operator session and makes the internal grant idempotent',async()=>{
  const login=()=>selfHostRoute(request('/api/v1/self-host/login',hosted.SELF_HOST_ACCESS_TOKEN),hosted);
  const first=await login();expect(first?.status).toBe(200);expect(first?.headers.get('set-cookie')).toContain('HttpOnly');
  expect(first?.headers.get('set-cookie')).toContain('SameSite=Lax');
  await login();
  const grant=await env.DB.prepare("SELECT SUM(credits) AS amount FROM credit_operations WHERE account_id=?").bind(SELF_HOST_ACCOUNT).first<{amount:number}>();
  expect(grant?.amount).toBe(3000000);
  expect(await first?.text()).not.toContain(hosted.SELF_HOST_ACCESS_TOKEN!);
 });
 it('revokes the operator session when signing out',async()=>{
  const login=await selfHostRoute(request('/api/v1/self-host/login',hosted.SELF_HOST_ACCESS_TOKEN),hosted);
  const cookie=login!.headers.get('set-cookie')!.split(';')[0]!;
  const logout=new Request('https://checker.example/api/v1/self-host/logout',{method:'POST',headers:{Origin:'https://checker.example',Cookie:cookie}});
  expect((await selfHostRoute(logout,hosted))?.status).toBe(200);
  expect((await ensureBrowserSession(new Request('https://checker.example',{headers:{Cookie:cookie}}),hosted)).accountId).not.toBe(SELF_HOST_ACCOUNT);
 });
 it('disables billing and analytics on a self-hosted deployment',async()=>{
  expect((await selfHostRoute(request('/api/v1/billing/paddle/checkout-intents'),hosted))?.status).toBe(404);
  expect((await selfHostRoute(request('/api/v1/analytics/events'),hosted))?.status).toBe(204);
 });
 it('does not expose provider credentials in configuration',async()=>withModelRuntime({...hosted,MODEL_CONFIG:'{}'},async()=>{
  const response=await selfHostRoute(new Request('https://checker.example/api/v1/self-host/config'),hosted);
  expect(await response?.json()).toEqual({self_hosted:true,configured:false,models:[]});
 }));
 it('rejects AI admission before any reservation when no model is configured',async()=>withModelRuntime({...hosted,MODEL_CONFIG:'{}'},async()=>{
  const response=await routeRequest(new Request('https://checker.example/api/v1/tasks',{method:'POST',headers:{Origin:'https://checker.example','Content-Type':'application/json'},body:JSON.stringify({product_url:'https://shop.example/products/item',target_market:'United States',shopping_model_route:'observer',shopping_reasoning_effort:'medium'})}),hosted);
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('MODEL_CONFIGURATION_REQUIRED');
 }));
});
