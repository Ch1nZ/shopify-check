import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { feedbackRoute } from '../src/feedback';
import { createAccountSession } from '../src/credits';
const testEnv = env as Env & { TEST_DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
beforeAll(async () => { await applyD1Migrations(testEnv.TEST_DB,testEnv.TEST_MIGRATIONS); });
afterEach(()=>vi.unstubAllGlobals());
const runtime = () => ({...env, DB:testEnv.TEST_DB, SELF_HOSTED:'false', OWNER_STATS_TOKEN:'fixture-owner-token', RESEND_API_KEY:'fixture-no-network', RECOVERY_EMAIL_FROM:'test@example.com', FEEDBACK_EMAIL_TO:'owner@example.com', CHECKOUT_RATE_LIMITER:{limit:async()=>({success:true})}} as unknown as Env);
const payload = () => ({id:crypto.randomUUID(),category:'suggestion',message:'Synthetic feedback for a test.'});
const request = (body:unknown, headers:Record<string,string>={}) => new Request('https://checker.example/api/v1/feedback',{method:'POST',headers:{Origin:'https://checker.example','Content-Type':'application/json',...headers},body:JSON.stringify(body)});
const owner = (body?:Record<string,string>,token='fixture-owner-token') => new Request('https://checker.example/owner/feedback',body?{method:'POST',headers:{Origin:'https://checker.example','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token,...body})}:{headers:{Authorization:`Bearer ${token}`}});
const row = (id:string) => testEnv.TEST_DB.prepare('SELECT * FROM hosted_feedback WHERE id=?').bind(id).first<Record<string,unknown>>();

it('disables hosted feedback in self-hosted installations without touching storage or email',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 const res=await feedbackRoute(request(payload()),{...runtime(),SELF_HOSTED:'true',DB:undefined} as unknown as Env);
 expect(res?.status).toBe(404);expect(fetcher).not.toHaveBeenCalled();
});
it('rejects cross-origin, invalid and rate-limited submissions',async()=>{
 const data=payload(), rt=runtime();
 expect((await feedbackRoute(request(data,{Origin:'https://stranger.example'}),rt))?.status).toBe(403);
 expect((await feedbackRoute(request({...data,email:'invalid'}),rt))?.status).toBe(400);
 expect((await feedbackRoute(request({...data,message:'a'.repeat(4001)}),rt))?.status).toBe(400);
 rt.CHECKOUT_RATE_LIMITER={limit:async()=>({success:false})} as RateLimit;
 expect((await feedbackRoute(request(data),rt))?.status).toBe(429);expect(await row(data.id)).toBeNull();
});
it('bounds streamed request bodies',async()=>{
 await expect(feedbackRoute(request({...payload(),message:'a'.repeat(17000)}),runtime())).rejects.toMatchObject({status:413});
});
it('persists before email, sets reply-to and prevents duplicate notifications',async()=>{
 const data={...payload(),email:'visitor@example.com',product_url:'https://store.example/products/fixture?token=private#fragment'};
 const fetcher=vi.fn(async(_url:unknown,init:RequestInit)=>{
  expect((await row(data.id))?.notification_status).toBe('pending');
  const body=JSON.parse(init.body as string);
  expect(body.to).toEqual(['owner@example.com']);expect(body.reply_to).toBe(data.email);
  expect(body.text).not.toContain('token=private');expect(new Headers(init.headers).get('Idempotency-Key')).toBe(`feedback/${data.id}`);
  return new Response('{}',{status:200});
 });vi.stubGlobal('fetch',fetcher);
 expect((await feedbackRoute(request(data),runtime()))?.status).toBe(201);
 expect(await row(data.id)).toMatchObject({notification_status:'sent',product_url:'https://store.example/products/fixture'});
 expect((await feedbackRoute(request(data),runtime()))?.status).toBe(201);expect(fetcher).toHaveBeenCalledTimes(1);
});
it('keeps feedback when notification fails, supports anonymous submission and owner retry',async()=>{
 const data=payload();const fetcher=vi.fn().mockRejectedValueOnce(new Error('provider unavailable')).mockResolvedValue(new Response('{}'));
 vi.stubGlobal('fetch',fetcher);
 expect((await feedbackRoute(request(data),runtime()))?.status).toBe(201);
 expect(await row(data.id)).toMatchObject({notification_status:'failed',email:null});
 expect((await feedbackRoute(owner({id:data.id,action:'retry'}),runtime()))?.status).toBe(200);
 expect((await row(data.id))?.notification_status).toBe('sent');
 expect(JSON.parse(fetcher.mock.calls[1]![1].body)).not.toHaveProperty('reply_to');
});
it('protects the inbox and status changes, escapes visitor text',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}')));
 const data={...payload(),message:'<script>alert("test")</script>'};await feedbackRoute(request(data),runtime());
 const denied=await feedbackRoute(owner(undefined,'incorrect'),runtime());expect(await denied!.text()).not.toContain(data.id);
 expect((await feedbackRoute(owner({id:data.id,status:'resolved'},'incorrect'),runtime()))?.status).toBe(401);
 expect((await row(data.id))?.status).toBe('new');
 const changed=await feedbackRoute(owner({id:data.id,status:'resolved'}),runtime());
 expect((await row(data.id))?.status).toBe('resolved');
 const html=await changed!.text();expect(html).toContain('&lt;script&gt;');expect(html).not.toContain(data.message);
 expect(changed!.headers.get('Cache-Control')).toContain('no-store');
 expect((await feedbackRoute(owner({id:data.id,status:'arbitrary'}),runtime()))?.status).toBe(400);
});
it('accepts a diagnostic reference only from its owning browser',async()=>{
 const rt=runtime(), accountId=crypto.randomUUID(), jobId=crypto.randomUUID(), now=new Date().toISOString();
 await rt.DB.prepare('INSERT INTO accounts (id,created_at,updated_at) VALUES (?,?,?)').bind(accountId,now,now).run();
 await rt.DB.prepare("INSERT INTO jobs (id,account_id,job_kind,protocol_version,pricing_version,reserved_credits,reservation_id,status,created_at,updated_at) VALUES (?,?,'guided_search_premium','guided-shopping/1.0','test',30,?,'failed',?,?)").bind(jobId,accountId,crypto.randomUUID(),now,now).run();
 const data={...payload(),task_id:jobId};
 expect((await feedbackRoute(request(data),rt))?.status).toBe(403);expect(await row(data.id)).toBeNull();
 const session=await createAccountSession(accountId,rt);
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}')));
 expect((await feedbackRoute(request(data,{Cookie:session.setCookie!.split(';')[0]!}),rt))?.status).toBe(201);
 expect((await row(data.id))?.task_id).toBe(jobId);
});
