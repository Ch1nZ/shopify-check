import { describe, it, expect } from 'vitest';
import { generateText } from 'ai';
import { providerFor } from '../src/provider';
import { withModelRuntime, validateDiagnosticModels, endpoint, endpointKey } from '../src/runtime';
import type { ModelRolePolicy } from '@mclab/contracts';
const policy: ModelRolePolicy = { role:'query_generator', route_key:'planner', reasoning_effort:'medium', search:{enabled:false}, max_output_tokens:100, max_call_cost_usd_micros:100000, max_retries:0, allow_provider_fallback:false };
const route = (provider: string, model = 'operator-selected-model', search = false) => ({ provider, model, key_env:'CUSTOM_KEY', search, ...(provider === 'openai-compatible' ? {base_url:'https://models.example/v1'} : {}) });
const runtime = (provider: string) => ({MODEL_CONFIG:JSON.stringify({planner:route(provider),observer:route(provider,'operator-search-model',true),synthesizer:route(provider)}),CUSTOM_KEY:'fixture-provider-key'});
describe('operator-selected providers',()=>{
 it('has no model defaults and fails before admission when routes are missing',()=>withModelRuntime({},()=>expect(validateDiagnosticModels).toThrow('Configure')));
 it.each(['openai','google','anthropic','openrouter','openai-compatible'])('uses an explicitly configured %s model',provider=>withModelRuntime(runtime(provider),()=>{
  const result=providerFor(policy);
  expect(typeof result.model).toBe('object');
  expect((result.model as {modelId:string}).modelId).toBe('operator-selected-model');
 }));
 it.each(['openai','google','anthropic','openrouter'])('attaches native search for %s',provider=>withModelRuntime(runtime(provider),()=>{
  validateDiagnosticModels();
  const result=providerFor({...policy,route_key:'observer',search:{enabled:true,max_search_requests:1}});
  expect(Object.keys(result.tools ?? {})).toHaveLength(1);
 }));
 it('does not silently run a search role on a generic chat endpoint',()=>withModelRuntime(runtime('openai-compatible'),()=>expect(validateDiagnosticModels).toThrow('native-search')));
 it('keeps concurrent deployments and their credentials isolated',async()=>{
  const run=(key:string)=>withModelRuntime({...runtime('openai'),CUSTOM_KEY:key},async()=>{await Promise.resolve();return endpointKey(endpoint('planner'));});
  expect(await Promise.all([run('first-fixture-key'),run('second-fixture-key')])).toEqual(['first-fixture-key','second-fixture-key']);
 });
 it('sends compatible requests only to the configured endpoint with its own key',async()=>withModelRuntime(runtime('openai-compatible'),async()=>{
  const calls:Array<{url:string;authorization:string|null;body:string}>=[];
  const fakeFetch:typeof fetch=async(input,init)=>{const req=new Request(input,init);calls.push({url:req.url,authorization:req.headers.get('authorization'),body:await req.text()});return Response.json({id:'fixture-response',object:'chat.completion',created:1,model:'operator-selected-model',choices:[{index:0,message:{role:'assistant',content:'Fixture answer'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}});};
  const result=await generateText({...providerFor(policy,fakeFetch),prompt:'Fixture question',maxRetries:0});
  expect(result.text).toBe('Fixture answer');expect(calls).toHaveLength(1);expect(calls[0]?.url).toBe('https://models.example/v1/chat/completions');expect(calls[0]?.authorization).toBe('Bearer fixture-provider-key');expect(JSON.parse(calls[0]!.body).model).toBe('operator-selected-model');
 }));
});
