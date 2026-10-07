import type { CredentialSource } from "../auth.ts";
import { numberOrNull, object, string } from "../validate.ts";
import { frames } from "./stream.ts";
import type { Completion, CompletionRequest, Message, ModelInfo, Provider, ToolCall } from "./types.ts";

const base="https://api.openai.com/v1";
const safeCode=(value:unknown)=>typeof value==="string"&&/^[a-zA-Z0-9_.-]{1,128}$/.test(value)?value:undefined;
export class OpenAIProviderError extends Error {
  readonly code?:string;readonly param?:string;readonly requestId?:string;readonly shape:string;
  constructor(readonly status:number,body:Record<string,any>,requestId?:string,secret?:string) {
    const error=body.error&&typeof body.error==="object"?body.error:body;
    const diagnostic=(value:unknown)=>{const text=safeCode(value);return text&&(!secret||!text.includes(secret))?text:undefined;};
    const code=diagnostic(error.code),param=diagnostic(error.param),id=diagnostic(requestId);
    let help="Check /status and try again later.";
    if(status===401)help="Run /login openai to reconnect your ChatGPT plan.";
    if(status===403)help="ChatGPT plan usage is unavailable for this account, workspace, or region.";
    if(code==="subscription_sharing_usage_limit_exceeded")help="Your app or plan usage limit was reached. Use /usage to manage ChatGPT usage.";
    if(code==="subscription_sharing_usage_unavailable")help="ChatGPT usage availability could not be checked. Try again later.";
    if(code==="subscription_sharing_unsupported_capability")help="This request uses a capability your ChatGPT plan does not support.";
    super(`OpenAI request failed (HTTP ${status}${code?", "+code:""}${param?", "+param:""}). ${help}${id?" Request: "+id:""}`);
    this.code=code;this.param=param;this.requestId=id;this.shape=body.error?"error":body.detail?"detail":"unknown";
  }
}
function inputHistory(messages:readonly Message[]):unknown[] {
  return messages.flatMap((message):unknown[]=>{
    if(message.role==="system")return []; // Sent as instructions on this route.
    if(message.role==="user")return [{role:"user",content:message.content}];
    if(message.role==="tool")return [{type:"function_call_output",call_id:message.callId,output:message.content}];
    if(message.role!=="assistant")return [];
    const raw=message.providerState?.openai as {output?:unknown[]}|undefined;
    if(Array.isArray(raw?.output))return raw.output;
    return [...(message.content?[{role:"assistant",content:message.content}]:[]),...message.toolCalls.map(call=>({type:"function_call",call_id:call.id,name:call.name,namespace:"bitzen",arguments:call.arguments}))];
  });
}
function completion(body:Record<string,any>,request:CompletionRequest):Completion {
  if(body.status!=="completed"||!Array.isArray(body.output))throw new Error("OpenAI did not complete inference; no tools were executed.");
  let text="";const calls:ToolCall[]=[],ids=new Set<string>();
  for(const raw of body.output) {
    const item=object(raw,"OpenAI output item");
    if(item.status!==undefined&&item.status!=="completed")throw new Error("OpenAI returned incomplete output; no tools were executed.");
    if(item.type==="function_call") {
      const id=string(item.call_id,"Tool call ID"),name=string(item.name,"Tool name"),args=string(item.arguments,"Tool arguments",true);
      if(ids.has(id)||item.namespace!=="bitzen"||!request.tools.some(tool=>tool.name===name))throw new Error("OpenAI returned an unexpected tool call; no tools were executed.");
      try {object(JSON.parse(args),"Tool arguments");}catch{throw new Error("OpenAI returned invalid tool arguments; no tools were executed.");}
      ids.add(id);calls.push({id,name,arguments:args});
    }else if(item.type==="message"&&Array.isArray(item.content)) {
      for(const raw of item.content) {const part=object(raw,"OpenAI content");if(part.type==="output_text")text+=string(part.text,"Output text",true);else if(part.type==="refusal")text+=string(part.refusal,"Refusal",true);}
    }else if(item.type!=="reasoning")throw new Error("OpenAI returned an unsupported output item.");
  }
  const usage=body.usage??{};
  return {id:string(body.id,"Response ID"),finishReason:calls.length?"tool_calls":"stop",message:{role:"assistant",content:text||null,toolCalls:calls,providerState:{openai:{output:body.output}}},usage:{inputTokens:numberOrNull(usage.input_tokens),outputTokens:numberOrNull(usage.output_tokens),cachedInputTokens:numberOrNull(usage.input_tokens_details?.cached_tokens),cacheWriteTokens:null,reasoningTokens:numberOrNull(usage.output_tokens_details?.reasoning_tokens),costUsd:null,billing:"chatgpt-plan"}};
}

// This is the public Sign in with ChatGPT route, using plan-authorized OAuth.
// Its preview supports streamed, stateless Responses with namespaced tools.
export class OpenAI implements Provider {
  readonly id="openai";
  constructor(private readonly credentials:CredentialSource,private readonly transport:(...args:Parameters<typeof fetch>)=>ReturnType<typeof fetch>=fetch) {}
  private async request(path:string,init:RequestInit,parent:AbortSignal):Promise<{response:Response;token:string}> {
    const signal=AbortSignal.any([parent,AbortSignal.timeout(180000)]),token=await this.credentials.getToken(signal);
    let response;
    try {response=await this.transport(base+path,{...init,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},signal,redirect:"error"});}
    catch {throw new Error(signal.aborted?"OpenAI request cancelled or timed out.":"Could not connect to OpenAI.");}
    if(!response.ok) {
      let body:Record<string,any>={};try {body=object(await response.json(),"Error");}catch{}
      throw new OpenAIProviderError(response.status,body,response.headers.get("x-request-id")??undefined,token);
    }
    return {response,token};
  }
  async listModels(signal:AbortSignal):Promise<ModelInfo[]> {
    const {response}=await this.request("/models",{method:"GET"},signal),body=object(await response.json(),"OpenAI model catalog");
    if(!Array.isArray(body.models))throw new Error("OpenAI returned an invalid ChatGPT model catalog.");
    return body.models.filter(model=>model&&model.visibility==="list"&&typeof model.slug==="string").map(model=>({id:model.slug,name:typeof model.display_name==="string"?model.display_name:model.slug,...(typeof model.context_window==="number"?{contextLength:model.context_window}:{})}));
  }
  async complete(request:CompletionRequest):Promise<Completion> {
    const {response,token}=await this.request("/responses",{method:"POST",body:JSON.stringify({
      model:request.model,input:inputHistory(request.messages),instructions:request.messages.filter(message=>message.role==="system").map(message=>message.content).join("\n\n"),store:false,stream:true,
      include:["reasoning.encrypted_content"],reasoning:{summary:"auto"},
      tools:request.tools.length?[{type:"namespace",name:"bitzen",description:"Bitzen's local coding and delegation tools.",tools:request.tools.map(tool=>({type:"function",name:tool.name,description:tool.description,parameters:tool.parameters,strict:false}))}]:[],
    })},request.signal);
    if(!response.body)throw new Error("OpenAI returned an empty stream.");
    const completedItems=new Map<number,Record<string,unknown>>(),startedItems=new Set<number>();
    for await(const data of frames(response.body,"OpenAI")) {
      request.signal.throwIfAborted();
      let event:Record<string,any>;try {event=object(JSON.parse(data),"OpenAI event");}catch{throw new Error("OpenAI returned an invalid stream event; no tools were executed.");}
      if(event.type==="response.output_item.added"||event.type==="response.output_item.done") {
        const index=event.output_index;
        if(!Number.isSafeInteger(index)||index<0||index>10000)throw new Error("OpenAI returned an invalid output index; no tools were executed.");
        startedItems.add(index);
        if(event.type==="response.output_item.done") {
          if(completedItems.has(index))throw new Error("OpenAI returned a duplicate completed item; no tools were executed.");
          completedItems.set(index,object(event.item,"OpenAI completed output item"));
        }
      }
      if(event.type==="response.output_text.delta"&&typeof event.delta==="string")await request.onProgress?.({type:"text",text:event.delta});
      if(event.type==="response.reasoning_summary_text.delta"&&typeof event.delta==="string")await request.onProgress?.({type:"reasoning",text:event.delta});
      if(event.type==="response.failed"||event.type==="error")throw new OpenAIProviderError(response.status,event.response??event,response.headers.get("x-request-id")??undefined,token);
      if(event.type==="response.incomplete") {
        // Return usage for output-limit accounting, but discard every partial tool.
        const body=event.response??{},usage=body.usage??{};
        return {id:typeof body.id==="string"?body.id:"incomplete",message:{role:"assistant",content:null,toolCalls:[]},finishReason:body.incomplete_details?.reason==="max_output_tokens"?"length":"incomplete",usage:{inputTokens:numberOrNull(usage.input_tokens),outputTokens:numberOrNull(usage.output_tokens),cachedInputTokens:numberOrNull(usage.input_tokens_details?.cached_tokens),cacheWriteTokens:null,reasoningTokens:numberOrNull(usage.output_tokens_details?.reasoning_tokens),costUsd:null,billing:"chatgpt-plan"}};
      }
      if(event.type==="response.completed") {
        const body=object(event.response,"OpenAI response");
        if(!Array.isArray(body.output))throw new Error("OpenAI returned invalid completed output; no tools were executed.");
        const output=body.output.slice();
        // The plan route's terminal event can contain usage with output: [].
        // Keep final output_item.done payloads (including encrypted reasoning),
        // but never construct executable tools from added items or deltas.
        for(const [index,item] of completedItems) {
          const final=output[index];
          if(final&&(final.type!==item.type||final.id!==item.id))throw new Error("OpenAI returned mismatched completed output; no tools were executed.");
          output[index]=item;
        }
        for(const index of startedItems)if(!output[index])throw new Error("OpenAI returned unfinished output; no tools were executed.");
        return completion({...body,output},request);
      }
    }
    throw new Error("OpenAI stream ended before response.completed; no tools were executed.");
  }
}
