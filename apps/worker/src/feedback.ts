import { z } from 'zod';
import { ensureBrowserSession } from './credits';
import { ownerStatsAuthorized, ownerStatsResponse, ownerStatsToken } from './owner-stats';
import { readBoundedJson, readBoundedText } from './http';
import { validatePublicProductUrl } from '@mclab/shopify-online-store';

const categories = { incorrect_result: 'Incorrect result', unclear: 'Hard to understand', technical_problem: 'Technical problem', suggestion: 'Suggestion' } as const;
const schema = z.object({
  id: z.uuid(), category: z.enum(['incorrect_result','unclear','technical_problem','suggestion']),
  message: z.string().trim().min(5).max(4000), email: z.union([z.email().max(254),z.literal('')]).optional(),
  task_id: z.uuid().optional(), product_url: z.string().max(2048).optional(),
});
type Feedback = { id: string; category: keyof typeof categories; message: string; email: string | null; task_id: string | null; product_url: string | null; status: string; notification_status: string; created_at: string };
const json = (message: string, status: number) => Response.json(status < 400 ? {data:{message}} : {error:{message}}, {status,headers:{'Cache-Control':'no-store'}});
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

export async function feedbackRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!['/api/v1/feedback','/owner/feedback'].includes(url.pathname)) return null;
  if (env.SELF_HOSTED === 'true') return json('Route not found.',404);
  if (url.pathname === '/owner/feedback') return ownerFeedback(request,env);
  if (request.method !== 'POST') return json('Method not allowed.',405);
  if (request.headers.get('origin') !== url.origin) return json('Feedback must be sent from this site.',403);
  if (!(await env.CHECKOUT_RATE_LIMITER.limit({key:`feedback:${request.headers.get('CF-Connecting-IP') ?? 'local'}`})).success) return json('Please wait before sending more feedback.',429);
  const parsed = schema.safeParse(await readBoundedJson(request));
  if (!parsed.success) return json('Choose a feedback type, write 5–4,000 characters, and check your optional email.',400);
  const data = parsed.data;
  let productUrl: string | null = null;
  if (data.product_url) {
    try { const checked = validatePublicProductUrl(data.product_url); const clean = new URL(checked.toString()); clean.search='';clean.hash='';productUrl=clean.toString(); }
    catch { return json('The check reference is invalid. Reload the page and try again.',400); }
  }
  if (data.task_id) {
    const session = await ensureBrowserSession(request,env);
    const owned = await env.DB.prepare('SELECT id FROM jobs WHERE id = ? AND account_id = ?').bind(data.task_id,session.accountId).first();
    if (!owned) return json('That diagnostic is not linked to this browser.',403);
  }
  const now = new Date().toISOString();
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO hosted_feedback (id,category,message,email,task_id,product_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(data.id,data.category,data.message,data.email || null,data.task_id ?? null,productUrl,now,now).run();
  if (inserted.meta.changes) await notifyFeedback(data.id,env);
  return json('Thanks—your feedback has been received.',201);
}

export async function notifyFeedback(id: string, env: Env): Promise<void> {
  const row = await env.DB.prepare('SELECT * FROM hosted_feedback WHERE id = ?').bind(id).first<Feedback>();
  if (!row || row.notification_status === 'sent') return;
  let state = 'failed';
  try {
    if (!env.RESEND_API_KEY || !env.RECOVERY_EMAIL_FROM || !env.FEEDBACK_EMAIL_TO) throw new Error('Email unavailable');
    const response = await fetch('https://api.resend.com/emails', {
      method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`feedback/${id}`},
      body:JSON.stringify({from:env.RECOVERY_EMAIL_FROM,to:[env.FEEDBACK_EMAIL_TO],...(row.email?{reply_to:row.email}:{}),subject:`Self-Check feedback: ${categories[row.category]}`,
        text:`New Self-Check feedback\n\nType: ${categories[row.category]}\n\n${row.message}\n\nReply email: ${row.email ?? 'Not provided'}\n\nPrivate dashboard: https://check.geo.mclab.party/owner/feedback#feedback-${id}\n\nFeedback ID: ${id}\nCheck details stay in the private dashboard. This email is a feedback notification, not a marketing signup.`}),
      signal:AbortSignal.timeout(10000),
    });
    if(response.ok) state='sent';
  } catch { /* Feedback is already persisted; the owner can retry delivery. */ }
  await env.DB.prepare('UPDATE hosted_feedback SET notification_status = ?, updated_at = ? WHERE id = ?').bind(state,new Date().toISOString(),id).run();
}

async function ownerFeedback(request: Request, env: Env): Promise<Response> {
  if (!ownerStatsToken(env)) return json('Route not found.',404);
  if (!['GET','POST'].includes(request.method)) return json('Method not allowed.',405);
  let form = new URLSearchParams();
  if(request.method==='POST') {
    if(request.headers.get('origin')!==new URL(request.url).origin) return json('Origin not allowed.',403);
    const body=await readBoundedText(request.body,16384);form=new URLSearchParams(body);
  }
  const token=form.get('token') ?? request.headers.get('authorization')?.replace(/^Bearer /,'') ?? '';
  if(!await ownerStatsAuthorized(request,env,token)) return ownerStatsResponse(page(`<h1>Self-Check feedback</h1><p>Private owner dashboard.</p>${request.method==='POST'?'<p>Token rejected.</p>':''}<form method="post"><label>Owner token <input type="password" name="token" required autocomplete="off"></label><button>Open feedback</button></form>`),request.method==='POST'?401:200);
  if(request.method==='POST' && form.has('id')) {
    const id=z.uuid().safeParse(form.get('id'));
    if(!id.success)return json('Invalid feedback reference.',400);
    if(form.get('action')==='retry') await notifyFeedback(id.data,env);
    else {
      const status=z.enum(['new','in_progress','resolved']).safeParse(form.get('status'));
      if(!status.success)return json('Invalid status.',400);
      await env.DB.prepare('UPDATE hosted_feedback SET status = ?, updated_at = ? WHERE id = ?').bind(status.data,new Date().toISOString(),id.data).run();
    }
  }
  const rows=await env.DB.prepare('SELECT * FROM hosted_feedback ORDER BY created_at DESC LIMIT 100').all<Feedback>();
  const cards=rows.results.map(row=>`<article id="feedback-${escape(row.id)}"><h2>${escape(categories[row.category])}</h2><p>${escape(row.created_at)} · ${escape(row.status.replace('_',' '))} · Notification: ${escape(row.notification_status==='sent'?'accepted by email provider':row.notification_status)}</p><p class="message">${escape(row.message)}</p><p>Reply email: ${row.email?`<a href="mailto:${escape(row.email)}">${escape(row.email)}</a>`:'Not provided'}</p>${row.product_url?`<p>Product: <a href="${escape(row.product_url)}" rel="noreferrer">${escape(row.product_url)}</a></p>`:''}${row.task_id?`<p>Diagnostic reference: <code>${escape(row.task_id)}</code></p>`:''}<small>Feedback ID: ${escape(row.id)}</small><form method="post"><input type="hidden" name="token" value="${escape(token)}"><input type="hidden" name="id" value="${escape(row.id)}"><label>Status <select name="status">${['new','in_progress','resolved'].map(s=>`<option value="${s}"${s===row.status?' selected':''}>${s.replace('_',' ')}</option>`).join('')}</select></label><button name="action" value="status">Save status</button>${row.notification_status!=='sent'?'<button name="action" value="retry">Retry notification</button>':''}</form></article>`).join('');
  return ownerStatsResponse(page(`<h1>Self-Check feedback</h1><p><a href="/owner/stats">Owner stats</a> · Latest 100 submissions. Emails are for replying to feedback only.</p>${cards || '<p>No feedback yet.</p>'}`));
}
function page(content: string) { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private feedback · MC Lab</title><style>body{font:16px system-ui;color:#20332f;background:#f6f5ef;max-width:960px;margin:40px auto;padding:20px}article{background:white;border:1px solid #d5dfd7;border-radius:12px;padding:24px;margin:20px 0;overflow-wrap:anywhere}.message{white-space:pre-wrap}input,select,button{font:inherit;padding:10px;margin:8px}button{cursor:pointer}a{color:#235d4b}code{word-break:break-all}</style></head><body>${content}</body></html>`; }
