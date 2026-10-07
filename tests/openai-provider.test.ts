import { expect, test } from "bun:test";
import { OpenAI, OpenAIProviderError } from "../src/providers/openai.ts";
import type { CompletionRequest } from "../src/providers/types.ts";
import { Budget } from "../src/budget.ts";
import { formatRunSummary } from "../src/report.ts";
import { exposedReasoning } from "../src/history.ts";
import { TuiState } from "../src/tui-state.ts";

const request:CompletionRequest={model:"gpt-account-model",messages:[{role:"system",content:"Use local tools."},{role:"user",content:"Read the code."}],tools:[{name:"read_file",description:"Read a file",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}}],sessionId:"local-session",maxOutputTokens:8192,signal:new AbortController().signal};
const source={kind:"oauth" as const,getToken:async()=>"secret-bearer"};
const responseBody={id:"resp_test",status:"completed",output:[{type:"reasoning",id:"reason_test",encrypted_content:"opaque-reasoning",summary:[{type:"summary_text",text:"I will inspect the code."}]},{type:"message",id:"msg_test",role:"assistant",status:"completed",content:[{type:"output_text",text:"Reading it now."}]},{type:"function_call",id:"fc_test",call_id:"call_test",namespace:"bitzen",name:"read_file",arguments:'{"path":"src/main.ts"}',status:"completed"}],usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:70},output_tokens_details:{reasoning_tokens:10}}};
function sse(events:unknown[],fragment=false):Response {
  const bytes=new TextEncoder().encode(events.map(event=>"data: "+JSON.stringify(event)+"\r\n\r\n").join(""));
  return new Response(new ReadableStream({start(controller){if(fragment)for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));else controller.enqueue(bytes);controller.close();}}),{headers:{"Content-Type":"text/event-stream","x-request-id":"req_test"}});
}

test("ChatGPT Responses streams text and reasoning, uses namespaced tools and replays full stateless history",async()=>{
  const bodies:Record<string,any>[]=[],updates:unknown[]=[];let tokens=0;
  const adapter=new OpenAI({...source,getToken:async()=>`fresh-token-${++tokens}`},async(url,init)=>{
    expect(String(url)).toBe("https://api.openai.com/v1/responses");expect((init?.headers as Record<string,string>).Authorization).toBe(`Bearer fresh-token-${tokens}`);
    const body=JSON.parse(init!.body as string);bodies.push(body);
    expect(body.store).toBe(false);expect(body.stream).toBe(true);expect(body.instructions).toBe("Use local tools.");
    expect(body.tools[0].type).toBe("namespace");expect(body.tools[0].name).toBe("bitzen");expect(body.tools[0].tools[0].name).toBe("read_file");
    expect(body.include).toContain("reasoning.encrypted_content");
    for(const field of ["max_output_tokens","previous_response_id","temperature","metadata","conversation"])expect(body).not.toHaveProperty(field);
    return sse([{type:"response.reasoning_summary_text.delta",delta:"I will inspect the code."},{type:"response.output_text.delta",delta:"Reading it now."},{type:"response.completed",response:responseBody}],true);
  });
  const first=await adapter.complete({...request,onProgress:async update=>{updates.push(update);}});
  expect(first.finishReason).toBe("tool_calls");expect(first.message.toolCalls).toEqual([{id:"call_test",name:"read_file",arguments:'{"path":"src/main.ts"}'}]);
  expect(first.message.content).toBe("Reading it now.");expect(first.usage.cachedInputTokens).toBe(70);expect(first.usage.reasoningTokens).toBe(10);expect(first.usage.costUsd).toBeNull();expect(first.usage.billing).toBe("chatgpt-plan");
  expect(updates).toEqual([{type:"reasoning",text:"I will inspect the code."},{type:"text",text:"Reading it now."}]);
  await adapter.complete({...request,messages:[...request.messages,first.message,{role:"tool",callId:"call_test",content:"Code here"}]});
  expect(bodies[1]!.input).toEqual([{role:"user",content:"Read the code."},...responseBody.output,{type:"function_call_output",call_id:"call_test",output:"Code here"}]);expect(tokens).toBe(2);
  expect(exposedReasoning(first.message.providerState)).toBe("I will inspect the code.");expect(exposedReasoning(first.message.providerState)).not.toContain("opaque-reasoning");
});

test("ChatGPT catalog shows account-specific model slugs and hides non-list models without fake API pricing",async()=>{
  const adapter=new OpenAI(source,async(url,init)=>{
    expect(String(url)).toBe("https://api.openai.com/v1/models");expect((init?.headers as Record<string,string>).Authorization).toBe("Bearer secret-bearer");
    return Response.json({models:[{slug:"first",display_name:"First",visibility:"list",context_window:256000},{slug:"hidden",display_name:"Hidden",visibility:"hide"},{slug:"second",display_name:"Second",visibility:"list"}]});
  });
  expect(await adapter.listModels(request.signal)).toEqual([{id:"first",name:"First",contextLength:256000},{id:"second",name:"Second"}]);
});

test("ChatGPT retains completed stream items when the final event contains only usage",async()=>{
  const bodies:Record<string,any>[]=[],updates:unknown[]=[];
  const adapter=new OpenAI(source,async(_url,init)=>{
    bodies.push(JSON.parse(init!.body as string));
    return sse([
      {type:"response.output_item.added",output_index:0,item:{type:"reasoning",id:"reason_test",encrypted_content:"unfinished"}},
      {type:"response.output_item.done",output_index:0,item:responseBody.output[0]},
      {type:"response.output_text.delta",output_index:1,delta:"Reading it now."},
      {type:"response.output_item.done",output_index:1,item:responseBody.output[1]},
      {type:"response.output_item.added",output_index:2,item:{...responseBody.output[2],status:"in_progress",arguments:""}},
      {type:"response.function_call_arguments.delta",output_index:2,delta:'{"path":'},
      {type:"response.function_call_arguments.done",output_index:2,arguments:'{"path":"src/main.ts"}'},
      {type:"response.output_item.done",output_index:2,item:responseBody.output[2]},
      {type:"response.completed",response:{...responseBody,output:[]}},
    ],true);
  });
  const first=await adapter.complete({...request,onProgress:async update=>{updates.push(update);}});
  expect(first.finishReason).toBe("tool_calls");expect(first.message.content).toBe("Reading it now.");expect(first.message.toolCalls[0]?.arguments).toBe('{"path":"src/main.ts"}');
  expect(first.message.providerState?.openai).toEqual({output:responseBody.output});expect(first.usage.outputTokens).toBe(20);
  expect(updates).toEqual([{type:"text",text:"Reading it now."}]);
  await adapter.complete({...request,messages:[...request.messages,first.message,{role:"tool",callId:"call_test",content:"Source code"}]});
  expect(bodies[1]!.input).toEqual([{role:"user",content:"Read the code."},...responseBody.output,{type:"function_call_output",call_id:"call_test",output:"Source code"}]);
});

test("ChatGPT stream items and final output merge once, preserving final reasoning rather than partial data",async()=>{
  const adapter=new OpenAI(source,async()=>sse([
    ...responseBody.output.map((item,index)=>({type:"response.output_item.done",output_index:index,item})),
    {type:"response.completed",response:responseBody},
  ]));
  const result=await adapter.complete(request);
  expect(result.message.toolCalls).toHaveLength(1);expect(result.message.providerState?.openai).toEqual({output:responseBody.output});
});

test("completed stream items never execute without final success or alongside an unfinished item",async()=>{
  const done={type:"response.output_item.done",output_index:0,item:responseBody.output[2]};
  for(const tail of [[],[{type:"response.failed",response:{error:{code:"subscription_sharing_usage_limit_exceeded"}}}],
    [{type:"response.output_item.added",output_index:1,item:{type:"function_call",id:"partial",status:"in_progress"}},{type:"response.completed",response:{...responseBody,output:[]}}]]) {
    const adapter=new OpenAI(source,async()=>sse([done,...tail]));
    await expect(adapter.complete(request)).rejects.toThrow();
  }
  const incomplete=new OpenAI(source,async()=>sse([done,{type:"response.incomplete",response:{...responseBody,status:"incomplete",output:[],incomplete_details:{reason:"max_output_tokens"}}}]));
  expect((await incomplete.complete(request)).message.toolCalls).toEqual([]);
});

test("ChatGPT partial or invalid streamed tool calls cannot escape to execution",async()=>{
  for(const output of [
    [{...responseBody.output[2],namespace:"unexpected"}],
    [{...responseBody.output[2],arguments:"{"}],
    [{...responseBody.output[2],status:"in_progress"}],
    [responseBody.output[2],responseBody.output[2]],
  ]) {
    const adapter=new OpenAI(source,async()=>sse([{type:"response.completed",response:{...responseBody,output}}]));
    await expect(adapter.complete(request)).rejects.toThrow("no tools were executed");
  }
  const ended=new OpenAI(source,async()=>sse([{type:"response.function_call_arguments.delta",delta:'{"path":"'}]));
  await expect(ended.complete(request)).rejects.toThrow("before response.completed");
  const incomplete=new OpenAI(source,async()=>sse([{type:"response.incomplete",response:{...responseBody,status:"incomplete",incomplete_details:{reason:"max_output_tokens"}}}]));
  const result=await incomplete.complete(request);expect(result.finishReason).toBe("length");expect(result.message.toolCalls).toEqual([]);expect(result.usage.inputTokens).toBe(100);
});

test("ChatGPT plan-limit errors after streaming are actionable and HTTP admission failures retain safe diagnostics",async()=>{
  const midStream=new OpenAI(source,async()=>sse([{type:"response.output_text.delta",delta:"Starting"},{type:"response.failed",response:{error:{code:"subscription_sharing_usage_limit_exceeded",message:"secret-bearer"}}}]));
  try {await midStream.complete(request);throw Error("Expected failure");}catch(error) {
    expect(error).toBeInstanceOf(OpenAIProviderError);expect(String(error)).toContain("/usage");expect(String(error)).not.toContain("secret-bearer");
  }
  const denied=new OpenAI(source,async()=>Response.json({detail:"secret-bearer"},{status:403,headers:{"x-request-id":"req_denied"}}));
  try {await denied.complete(request);throw Error("Expected failure");}catch(error) {
    expect(error).toBeInstanceOf(OpenAIProviderError);const failure=error as OpenAIProviderError;
    expect(failure.status).toBe(403);expect(failure.shape).toBe("detail");expect(failure.requestId).toBe("req_denied");expect(failure.message).not.toContain("secret-bearer");
  }
  const reflected=new OpenAI(source,async()=>Response.json({error:{code:"secret-bearer",param:"secret-bearer"}},{status:401,headers:{"x-request-id":"secret-bearer"}}));
  try {await reflected.complete(request);throw Error("Expected failure");}catch(error){expect(String(error)).not.toContain("secret-bearer");expect(String(error)).toContain("/login openai");}
});

test("ChatGPT costs remain plan usage in the chat and final report, including mixed-provider tasks",async()=>{
  const adapter=new OpenAI(source,async()=>sse([{type:"response.completed",response:responseBody}]));
  const result=await adapter.complete(request),budget=new Budget(10);
  budget.beforeCall("lead");budget.record(result.usage,"lead");
  const planReport=formatRunSummary({usage:budget.snapshot(),traceDirectory:"/tmp/run"});
  expect(planReport).toContain("Using ChatGPT plan (USD cost not reported)");expect(planReport).toContain("Captain: ChatGPT plan, 1 call");expect(planReport).not.toContain("without cost data");
  budget.beforeCall("sidekick");budget.record({...result.usage,billing:undefined,costUsd:0.02},"sidekick");
  const mixedReport=formatRunSummary({usage:budget.snapshot(),traceDirectory:"/tmp/run"});expect(mixedReport).toContain("Total cost: $0.020000 + ChatGPT plan");expect(mixedReport).toContain("Crewmate: $0.020000");
  const state=new TuiState();state.receive({type:"model_start",agent:"lead"});state.receive({type:"model_end",agent:"lead",message:result.message,usage:result.usage,elapsedMs:500});
  expect(state.entries.find(entry=>entry.kind==="model")?.detail).toContain("Using ChatGPT plan");expect(state.entries.find(entry=>entry.kind==="reasoning")?.text).toBe("I will inspect the code.");
  expect(JSON.stringify(state.entries)).not.toContain("opaque-reasoning");
});
