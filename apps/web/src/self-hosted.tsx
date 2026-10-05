import { useEffect, useRef, useState, type FormEvent } from 'react';
import { previewReadiness, previewSnapshot, previewRecheckDiff, type PublicProductPreview, type PreviewSnapshot } from '@mclab/shopify-online-store';
import { DiagnosticReport } from './components/DiagnosticReport';
import type { CustomerTask, ReportHistoryItem } from './types';
import './self-hosted.css';
import { priceScopeLabel } from './preview-evidence';

type Configuration = { configured: boolean; models: Array<{ route_key: string; model_id: string }> };
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = await response.json() as { data?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(value.error?.message ?? 'The request could not complete.');
  return (value.data ?? value) as T;
}
const post = (data: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
export function SelfHostedApp() {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [url, setUrl] = useState(''); const [market, setMarket] = useState(''); const [context, setContext] = useState('');
  const [token, setToken] = useState(''); const [unlocked, setUnlocked] = useState(false);
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PublicProductPreview | null>(null);
  const [previous, setPrevious] = useState<PreviewSnapshot | null>(null);
  const last = useRef<PreviewSnapshot | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null); const [task, setTask] = useState<CustomerTask | null>(null);
  const [history, setHistory] = useState<ReportHistoryItem[]>([]);
  const reportRef = useRef<HTMLElement>(null);
  const readiness = preview ? previewReadiness(preview) : null;
  const diff = readiness ? previewRecheckDiff(previous, readiness) : null;
  const terminal = task && ['completed','incomplete','budget_exhausted','failed_validation','cancelled'].includes(task.session.status);
  const refreshHistory = () => api<{ reports: ReportHistoryItem[] }>('/api/v1/account/history').then(data => setHistory(data.reports));
  useEffect(() => { void api<Configuration>('/api/v1/self-host/config').then(setConfig).catch(error => setMessage(error.message));
    void api<{ operator: boolean }>('/api/v1/self-host/session').then(data => { setUnlocked(data.operator); if (data.operator) void refreshHistory(); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!taskId || terminal) return;
    let active = true;
    const poll = async () => { try { const result = await api<CustomerTask>(`/api/v1/tasks/${taskId}`); if (active) setTask(result); } catch (error) { if (active) setMessage((error as Error).message); } };
    void poll(); const timer = window.setInterval(() => void poll(), 2500);
    return () => { active = false; clearInterval(timer); };
  }, [taskId, terminal]);
  useEffect(() => { if (terminal) { void refreshHistory(); reportRef.current?.focus(); } }, [terminal]);
  async function check(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('Reading public product sources…');
    try { const result = await api<PublicProductPreview>('/api/v1/free-preview', post({ product_url: url })); setPrevious(last.current); last.current = previewSnapshot(previewReadiness(result)); setPreview(result); setMessage(result.status === 'partial' ? 'Partial capture. Unavailable evidence is identified below.' : 'Product-data check complete.'); }
    catch (error) { setPreview(null); setMessage((error as Error).message); } finally { setBusy(false); }
  }
  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { await api('/api/v1/self-host/login', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); setToken(''); setUnlocked(true); setMessage('Operator session connected.'); await refreshHistory(); }
    catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  async function diagnose(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('Starting the recorded diagnostic…');
    try { const started = await api<{ task_id: string }>('/api/v1/tasks', post({ product_url: url, target_market: market, ...(context.trim() ? { buyer_job: context.trim() } : {}), shopping_model_route: 'observer', shopping_reasoning_effort: 'medium' })); setTask(null); setTaskId(started.task_id); setMessage('Diagnostic started. It usually takes several minutes.'); }
    catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  function download(data: unknown) { const href = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})); const a=document.createElement('a');a.href=href;a.download='shopify-check-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(href),1000); }
  return <><header><a className="brand" href="/">shopify-check <small>by MC Lab</small></a><a href="https://github.com/Ch1nZ/shopify-check">GitHub ↗</a></header><main>
    <section className="intro"><p className="eyebrow">OPEN SOURCE · YOUR DEPLOYMENT · YOUR MODELS</p><h1>From product data<br/>to shopping evidence.</h1><p className="lead">Check what your Shopify product page exposes. Then run a recorded AI shopping diagnostic with the providers and models you configure.</p>
      <form onSubmit={check}><label htmlFor="product-url">Shopify product URL</label><div className="input-row"><input id="product-url" type="url" value={url} onChange={e=>setUrl(e.target.value)} required placeholder="https://your-store.com/products/your-product"/><button disabled={busy}>Check product data ↗</button></div><p className="hint">The product-data check makes no AI calls and requires no API key.</p></form>
    </section><p role="status" aria-live="polite">{message}</p>
    {preview && readiness && <section className="panel"><p className="eyebrow">{preview.status === 'partial' ? 'PARTIAL CAPTURE' : 'PRODUCT DATA'}</p><h2>{String(preview.fields.title.value ?? 'Product check')}</h2>{preview.price_context && <p>{priceScopeLabel(preview.price_context)}</p>}<p>{readiness.ready} of {readiness.total} data checks passed. This is not an AI visibility score.</p>{diff && <p>Since the previous check: {diff.improved.length} improved · {diff.regressed.length} regressed · {diff.skipped_definition_changes.length} excluded because definitions changed.</p>}<ul className="check-list">{readiness.checks.map(check=><li key={check.id}><span className={`badge ${check.outcome}`}>{check.outcome === 'pass' ? 'Passed' : check.outcome === 'warn' ? 'Review' : 'Needs attention'}</span><div><strong>{check.label}</strong><p>{check.detail}</p></div></li>)}</ul><h3>What to do next</h3>{readiness.fixes.length ? <ol>{readiness.fixes.map(fix=><li key={fix.id}><strong>{fix.title}</strong><p>{fix.detail}</p></li>)}</ol> : <p>No prioritized fixes established by these checks.</p>}<details><summary>Inspect captured product evidence</summary><pre>{JSON.stringify(preview,null,2)}</pre></details><button className="secondary" onClick={()=>download(preview)}>Download JSON</button></section>}
    <section className="panel"><p className="eyebrow">RECORDED AI SHOPPING DIAGNOSTIC</p><h2>Your providers. Your model choices.</h2><p>The diagnostic researches the product, builds an unbranded buyer situation, audits questions, records a shopping conversation and returns observed outcomes with evidence. Model and search charges are billed by your providers.</p>
      {!config?.configured && <p className="notice">AI is not configured yet. Set the observer, planner and synthesizer routes and their API keys on your server using the repository’s setup guide. No model is selected automatically.</p>}
      {config?.models.length ? <details><summary>Configured models</summary><ul>{config.models.map(model=><li key={model.route_key}>{model.route_key}: {model.model_id}</li>)}</ul></details> : null}
      {!unlocked ? <form onSubmit={login}><label htmlFor="operator-token">Operator access token</label><div className="input-row"><input id="operator-token" type="password" autoComplete="current-password" value={token} onChange={e=>setToken(e.target.value)} required/><button disabled={busy}>Unlock diagnostics</button></div><p className="hint">Use the access token you created for this deployment. Provider API keys stay on the server.</p></form> : <><p>Operator session connected. No MC Lab credits or payment required.</p><form onSubmit={diagnose}><label htmlFor="market">Target market</label><input id="market" value={market} onChange={e=>setMarket(e.target.value)} required minLength={2} placeholder="For example, United States"/><label htmlFor="buyer-context">Buyer context (optional)</label><input id="buyer-context" value={context} onChange={e=>setContext(e.target.value)} placeholder="The purchase need you want to test"/><button disabled={busy || !config?.configured || !url || Boolean(taskId && !terminal)}>Run AI diagnostic</button></form><button className="secondary" onClick={async()=>{await api('/api/v1/self-host/logout',{method:'POST'});setUnlocked(false);setHistory([]);setTask(null);setTaskId(null);}}>Sign out</button></>}
    </section>
    {taskId && <section className="panel" ref={reportRef} tabIndex={-1}><p className="eyebrow">RECORDED EVIDENCE</p><h2>{terminal ? 'Your diagnostic report' : 'Diagnostic in progress'}</h2><p>{task?.progress_stage ?? 'Preparing the product and buyer situation…'}</p>{task?.session.report && <><DiagnosticReport report={task.session.report}/><p>{task.session.report.disclaimer}</p><button onClick={()=>download(task)}>Download report JSON</button></>}</section>}
    {unlocked && <section className="panel"><h2>Saved reports</h2>{history.length ? <ul>{history.map(item=><li key={item.task_id}><button className="text-button" onClick={()=>{setTask(null);setTaskId(item.task_id);}}>{new Date(item.created_at).toLocaleString()} · {item.status}</button></li>)}</ul>:<p>Your diagnostic reports will appear here.</p>}</section>}
    <section className="explainer"><div><h2>Prefer no setup?</h2><p>Use MC Lab’s free hosted preview or optional paid AI diagnostics.</p><a href="https://check.geo.mclab.party/">Hosted Self-Check ↗</a></div><div><h2>Need a deeper diagnosis?</h2><p>Professional diagnosis investigates the evidence and develops a focused fix-and-retest plan.</p><a href="https://geo.mclab.party/">MC Lab professional service ↗</a></div></section>
  </main><footer><p>Apache-2.0 · <a href="https://github.com/Ch1nZ/shopify-check">Source and self-hosting guide</a></p><p>This deployment stores diagnostic evidence in its own database and private object storage. Configured providers receive the relevant product evidence and model prompts. No analytics are sent to MC Lab. Product checks do not guarantee AI recommendations, rankings or sales.</p><p>Independent project. Not affiliated with or endorsed by Shopify.</p></footer></>;
}
