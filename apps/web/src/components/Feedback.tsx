import { useRef, useState, type FormEvent } from 'react';

export function Feedback({taskId,productUrl}:{taskId?:string | undefined;productUrl?:string | undefined}) {
  const [category,setCategory]=useState('incorrect_result');
  const [message,setMessage]=useState('');
  const [email,setEmail]=useState('');
  const [pending,setPending]=useState(false);
  const [sent,setSent]=useState(false);
  const [error,setError]=useState('');
  const submissionId=useRef<string | null>(null);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(pending)return;
    setPending(true);setError('');submissionId.current ??= crypto.randomUUID();
    try {
      const response=await fetch('/api/v1/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:submissionId.current,category,message:message.trim(),email:email.trim(),...(taskId?{task_id:taskId}:productUrl?{product_url:productUrl}:{})})});
      if(!response.ok){const body=await response.json() as {error?:{message?:string}};throw new Error(body.error?.message || 'We could not send your feedback. Please try again.');}
      setSent(true);setMessage('');setEmail('');submissionId.current=null;
    }catch(error){setError(error instanceof Error?error.message:'We could not send your feedback. Please try again.');}finally{setPending(false);}
  }
  return <section id="feedback" className="feedback-section" aria-labelledby="feedback-title">
    <p className="eyebrow">YOUR EXPERIENCE MATTERS</p><h2 id="feedback-title">Help us improve Self-Check</h2>
    <p>Found something wrong or have an idea? Tell us what you expected.</p>
    {sent?<p role="status" className="feedback-success">Thanks—your feedback has been received.</p>:<form onSubmit={submit}>
      <label htmlFor="feedback-category">Feedback type</label><select id="feedback-category" value={category} onChange={e=>setCategory(e.target.value)} disabled={pending}><option value="incorrect_result">Incorrect result</option><option value="unclear">Hard to understand</option><option value="technical_problem">Technical problem</option><option value="suggestion">Suggestion</option></select>
      <label htmlFor="feedback-message">Your feedback</label><textarea id="feedback-message" required minLength={5} maxLength={4000} rows={4} value={message} onChange={e=>setMessage(e.target.value)} disabled={pending} placeholder="What happened, and what did you expect?"/>
      <label htmlFor="feedback-email">Your email (optional)</label><input id="feedback-email" type="email" autoComplete="email" maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} disabled={pending} aria-describedby="feedback-email-help"/>
      <p id="feedback-email-help" className="feedback-note">Leave your email if you’d like a reply. We’ll use it only to follow up on this feedback.</p>
      {(taskId || productUrl)?<p className="feedback-note">Includes {taskId?'a reference to this diagnostic':'this product URL'} to help us investigate. Your feedback is private.</p>:null}
      <p className="feedback-note">Please don’t include passwords or API keys. <a href="/privacy/">Privacy policy</a></p>
      {error?<p role="alert">{error}</p>:null}<button type="submit" disabled={pending}>{pending?'Sending feedback…':'Send feedback'}</button>
    </form>}
    <p className="feedback-note">Prefer email? <a href="mailto:hello@mclab.party">hello@mclab.party</a></p>
  </section>;
}
