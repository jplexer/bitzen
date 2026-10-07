import { createHash, randomBytes } from "node:crypto";
import type { CredentialSource } from "./auth.ts";
import { ProfileStore } from "./profile.ts";
import { openAILogin } from "./openai-login.ts";

// Only explicitly safe, locally authored messages may reach the login dialog.
export class LoginError extends Error {}

export interface LoginAdapter {
  id: string; label: string;
  browserLabel?: string; keyAvailable?: boolean; usageUrl?: string;
  browser?(signal: AbortSignal, onUrl: (url: string, manual?: boolean) => void): Promise<string | void>;
  validateKey(key: string, signal: AbortSignal): Promise<void>;
  credentialSource?: CredentialSource;
  connected?(): Promise<boolean>;
  status?(): Promise<string>;
  logout?(): Promise<string | void>;
  accounts?(): Promise<{id:string;label:string;active:boolean;connected:boolean}[]>;
  selectAccount?(id:string): Promise<void>;
}
export class AccountManager {
  private adapters = new Map<string,LoginAdapter>();
  constructor(readonly store: ProfileStore) {}
  register(adapter: LoginAdapter): this {if(this.adapters.has(adapter.id))throw new Error("Duplicate login provider.");this.adapters.set(adapter.id,adapter);return this;}
  list(): LoginAdapter[] {return [...this.adapters.values()];}
  adapter(id: string): LoginAdapter {const adapter=this.adapters.get(id);if(!adapter)throw new Error(`Login is unavailable for ${id}.`);return adapter;}
  async connected(id: string): Promise<boolean> {return this.adapters.get(id)?.connected?.()??Boolean(await this.store.credential(id));}
  credentials(id: string): CredentialSource {return this.adapters.get(id)?.credentialSource??{kind:"api-key",getToken:async signal=>{signal.throwIfAborted();const credential=await this.store.credential(id);if(!credential)throw new Error(`Sign in to ${id} with /login in the TUI.`);return credential.token;}};}
  async browser(id: string, signal: AbortSignal, onUrl: (url: string,manual?:boolean)=>void): Promise<void> {
    const adapter=this.adapter(id);if(!adapter.browser)throw new Error("Browser sign-in is unavailable. Use an API key.");
    const key=await adapter.browser(signal,onUrl);signal.throwIfAborted();if(typeof key==="string")await this.store.saveCredential(id,{token:key,kind:"oauth"},signal);
  }
  async key(id: string, key: string, signal: AbortSignal): Promise<void> {
    if(!key || key.length>4096 || /[\s\x00-\x1f\x7f]/.test(key))throw new Error("Enter a valid API key.");
    const adapter=this.adapter(id);if(adapter.keyAvailable===false)throw new LoginError("Use Continue with ChatGPT to connect your plan.");
    await adapter.validateKey(key,signal);signal.throwIfAborted();await this.store.saveCredential(id,{token:key,kind:"api-key"},signal);
  }
  logout(id: string): Promise<string | void> {return this.adapters.get(id)?.logout?.()??this.store.logout(id);}
}
export async function openBrowser(url: string, signal?:AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const command=process.platform==="darwin"?["open",url]:process.platform==="win32"?["rundll32.exe","url.dll,FileProtocolHandler",url]:["xdg-open",url];
  const child=Bun.spawn(command,{stdin:"ignore",stdout:"ignore",stderr:"ignore"});
  let abort!:()=>void, timer:ReturnType<typeof setTimeout>|undefined;
  const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(new Error("Sign-in cancelled."));signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();});
  // Some browser launchers stay alive with the browser. Do not wait indefinitely
  // or close the user's browser when they cancel the login in the terminal.
  const launched=new Promise<void>(resolve=>{timer=setTimeout(resolve,5000);});
  try {await Promise.race([child.exited.then(code=>{if(code!==0)throw new Error("Open the sign-in URL in your browser.");}),cancelled,launched]);}
  finally {clearTimeout(timer);signal?.removeEventListener("abort",abort);}
}
export function openRouterLogin(options: {fetch?:(...args:Parameters<typeof fetch>)=>ReturnType<typeof fetch>;open?:typeof openBrowser;timeoutMs?:number;onListen?:(callback:string,verifier:string)=>void} = {}): LoginAdapter {
  const transport=options.fetch??fetch;
  return {id:"openrouter",label:"OpenRouter",
    validateKey:async(key,parent)=>{
      const signal=AbortSignal.any([parent,AbortSignal.timeout(15000)]);
      const response=await transport("https://openrouter.ai/api/v1/key",{headers:{Authorization:`Bearer ${key}`},signal});
      if(!response.ok)throw new Error(`OpenRouter could not verify this key (HTTP ${response.status}).`);
      const body=await response.json() as Record<string,unknown>;if(!body?.data || typeof body.data!=="object")throw new Error("OpenRouter returned an invalid key response.");
    },
    browser:async(parent,onUrl)=>{
      const signal=AbortSignal.any([parent,AbortSignal.timeout(options.timeoutMs??300000)]);
      signal.throwIfAborted();
      const verifier=randomBytes(32).toString("base64url"),challenge=createHash("sha256").update(verifier).digest("base64url");
      const path=`/callback/${randomBytes(24).toString("base64url")}`;
      let resolveCode!:(code:string)=>void, rejectCode!:(error:unknown)=>void, received=false;
      const code=new Promise<string>((resolve,reject)=>{resolveCode=resolve;rejectCode=reject;});
      // Attach a handler before the browser launch so cancellation cannot leave an unhandled rejection.
      void code.catch(()=>{});
      const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:request=>{
        const url=new URL(request.url);
        if(request.method!=="GET" || url.pathname!==path)return new Response("Not found",{status:404});
        const value=url.searchParams.get("code");
        if(received || !value || value.length>4096)return new Response("Invalid callback",{status:400});
        received=true;resolveCode(value);
        return new Response("Authorization received. Return to the Bitzen terminal.",{headers:{"Content-Type":"text/plain","Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
      }});
      const abort=()=>rejectCode(new Error(parent.aborted?"Sign-in cancelled.":"Sign-in timed out. Try /login again."));
      signal.addEventListener("abort",abort,{once:true});
      try {
        const callback=`http://127.0.0.1:${server.port}${path}`;
        const url=new URL("https://openrouter.ai/auth");url.searchParams.set("callback_url",callback);url.searchParams.set("code_challenge",challenge);url.searchParams.set("code_challenge_method","S256");
        onUrl(url.toString());options.onListen?.(callback,verifier);
        await (options.open??openBrowser)(url.toString(),signal).catch(()=>onUrl(url.toString(),true));
        if(signal.aborted)abort();
        const authCode=await code;
        const response=await transport("https://openrouter.ai/api/v1/auth/keys",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:authCode,code_verifier:verifier,code_challenge_method:"S256"}),signal});
        if(!response.ok)throw new Error(`OpenRouter sign-in failed (HTTP ${response.status}).`);
        const body=await response.json() as Record<string,unknown>;if(typeof body.key!=="string" || !body.key.trim())throw new Error("OpenRouter did not return a key.");
        return body.key;
      } finally {signal.removeEventListener("abort",abort);await server.stop(true);}
    },
  };
}
export function defaultAccounts(store = new ProfileStore()): AccountManager {return new AccountManager(store).register(openRouterLogin()).register(openAILogin(store));}
