import { expect, test } from "bun:test";
import { OpenRouter, type FetchTransport } from "../src/providers/openrouter.ts";
import type { CompletionRequest } from "../src/providers/types.ts";
import { signal } from "./helpers.ts";

function sse(parts: unknown[], done = true) {
  const text = ": keep-alive\r\n\r\n"+parts.map(part=>`data: ${JSON.stringify(part)}\r\n\r\n`).join("")+(done?"data: [DONE]\r\n\r\n":"");
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));
    controller.close();
  } }), {headers:{"Content-Type":"text/event-stream"}});
}
const chunk = (delta: unknown, finish_reason: string|null = null) => ({id:"gen-stream",choices:[{index:0,delta,finish_reason}]});
function adapter(parts: unknown[], done=true) {
  return new OpenRouter({kind:"api-key",getToken:async()=>"test-key"},{fetch:(async()=>sse(parts,done)) as FetchTransport});
}
function request(onProgress: CompletionRequest["onProgress"]): CompletionRequest {
  return {model:"test/model",sessionId:"stream-test",maxOutputTokens:1000,messages:[{role:"user",content:"Test"}],tools:[],signal:signal(),onProgress};
}

test("stream parses fragmented UTF-8, tool arguments, signatures, and trailing usage",async()=>{
  const progress: unknown[]=[];
  const result=await adapter([
    chunk({reasoning_details:[{index:0,type:"reasoning.text",text:"Check ",signature:null}]}),
    chunk({reasoning_details:[{index:0,type:"reasoning.text",text:"the case.",signature:"signed"}]}),
    chunk({reasoning_details:[{index:1,type:"reasoning.encrypted",data:"opaque"}]}),
    chunk({content:"Café "}),chunk({content:"works."}),
    chunk({tool_calls:[{index:0,id:"call-1",type:"function",function:{name:"read_file",arguments:'{"pa'}}]}),
    chunk({tool_calls:[{index:0,function:{arguments:'th":"a.ts"}'}}]}),
    chunk({},"tool_calls"),
    {id:"gen-stream",choices:[],usage:{prompt_tokens:100,completion_tokens:20,cost:0.01,prompt_tokens_details:{cached_tokens:50}}},
  ]).complete(request(async update=>{progress.push(update)}));
  expect(result.message.content).toBe("Café works.");
  expect(result.message.toolCalls).toEqual([{id:"call-1",name:"read_file",arguments:'{"path":"a.ts"}'}]);
  expect(result.message.providerState?.openrouter).toMatchObject({reasoning_details:[{type:"reasoning.text",text:"Check the case.",signature:"signed"},{type:"reasoning.encrypted",data:"opaque"}]});
  expect(result.usage.costUsd).toBe(0.01);expect(result.usage.cachedInputTokens).toBe(50);
  expect(progress).toContainEqual({type:"reasoning",text:"Check "});
  expect(JSON.stringify(progress)).not.toContain("opaque");
});

test("incomplete streams never return partial tools",async()=>{
  const partial=[chunk({tool_calls:[{index:0,id:"call",function:{name:"apply_patch",arguments:'{"path":'}}]})];
  await expect(adapter(partial,false).complete(request(async()=>{}))).rejects.toThrow("before completion");
});
test("mid-stream errors are explained and credentials are redacted",async()=>{
  await expect(adapter([chunk({content:"Partial"}),{error:{message:"Provider failed test-key"}}]).complete(request(async()=>{}))).rejects.toThrow("Provider failed [redacted]");
});
