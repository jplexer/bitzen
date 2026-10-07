import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { LoginError, openBrowser, type LoginAdapter } from "./login.ts";
import type { ChatGPTAccount, ChatGPTSession, ProfileStore } from "./profile.ts";

const issuer="https://auth.openai.com", resource="https://api.openai.com/v1";
const planScope="chatgpt.tokens.use.direct";
export const chatGPTUsageUrl="https://chatgpt.com/settings/usage";
const requestedScopes="openid profile email offline_access resource.invoke "+planScope;
type Transport=(...args:Parameters<typeof fetch>)=>ReturnType<typeof fetch>;
const validSecret=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=32768&&!/[\s\x00-\x1f\x7f]/.test(value);
const hasPlan=(session?:ChatGPTSession)=>Boolean(session?.scopes.includes(planScope));
const equal=(a:string,b:string)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};

export function openAILogin(store:ProfileStore,options:{fetch?:Transport;open?:typeof openBrowser;timeoutMs?:number}={}): LoginAdapter {
  const transport=options.fetch??fetch;
  let metadata:Record<string,string>|undefined, keys:JSONWebKeySet|undefined, keysAt=0;
  let loginAccount:string|undefined, newAccount=false;
  const requestJSON=async(url:string,init:RequestInit,signal:AbortSignal):Promise<Record<string,any>>=>{
    try {
      const response=await transport(url,{...init,signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),redirect:"error"});
      if(!response.ok) {
        if(response.status===400||response.status===401)throw new LoginError("OpenAI could not renew or complete this login. Run /login openai again.");
        throw new LoginError(`OpenAI account request failed (HTTP ${response.status}). Try again later.`);
      }
      const value=await response.json();
      if(!value||typeof value!=="object"||Array.isArray(value))throw new LoginError("OpenAI returned an invalid account response.");
      return value;
    }catch(error){if(error instanceof LoginError)throw error;throw new LoginError(signal.aborted?"Sign-in cancelled.":"Could not contact OpenAI. Check your connection and try again.");}
  };
  const discovery=async(signal:AbortSignal)=>{
    if(!metadata) {
      const data=await requestJSON(issuer+"/.well-known/openid-configuration",{},signal);
      if(data.issuer!==issuer)throw new LoginError("OpenAI identity configuration was not accepted.");
      for(const field of ["authorization_endpoint","token_endpoint","jwks_uri","revocation_endpoint"]) {
        if(typeof data[field]!=="string"||new URL(data[field]).origin!==issuer)throw new LoginError("OpenAI identity configuration was not accepted.");
      }
      metadata=data as Record<string,string>;
    }
    return metadata;
  };
  const identity=async(idToken:string,clientId:string,signal:AbortSignal,nonce?:string)=>{
    const config=await discovery(signal);
    const loadKeys=async()=>{keys=await requestJSON(config.jwks_uri!,{},signal) as JSONWebKeySet;keysAt=Date.now();};
    try {
      if(!keys||Date.now()-keysAt>3600000)await loadKeys();
      let result;
      try {result=await jwtVerify(idToken,createLocalJWKSet(keys!),{issuer,audience:clientId,requiredClaims:["sub","exp","iat"],clockTolerance:5,algorithms:["RS256","ES256"]});}
      catch(error) {
        if((error as {code?:string}).code!=="ERR_JWKS_NO_MATCHING_KEY")throw error;
        await loadKeys();result=await jwtVerify(idToken,createLocalJWKSet(keys!),{issuer,audience:clientId,requiredClaims:["sub","exp","iat"],clockTolerance:5,algorithms:["RS256","ES256"]});
      }
      const payload=result.payload;
      if(typeof payload.sub!=="string"||!payload.sub||nonce!==undefined&&payload.nonce!==nonce)throw Error("Invalid identity");
      if(Array.isArray(payload.aud)&&payload.aud.length>1&&payload.azp!==clientId)throw Error("Invalid authorized party");
      return {subject:payload.sub,email:typeof payload.email==="string"?payload.email.slice(0,256):undefined};
    }catch{throw new LoginError("OpenAI identity verification failed. Start a fresh sign-in.");}
  };
  const tokenSet=(data:Record<string,any>,previous?:ChatGPTSession):ChatGPTSession=>{
    if(!validSecret(data.access_token)||!validSecret(data.refresh_token)||!Number.isFinite(data.expires_in)||data.expires_in<=0||String(data.token_type).toLowerCase()!=="bearer")throw new LoginError("OpenAI returned an incomplete token response.");
    const idToken=data.id_token??previous?.idToken;
    if(!validSecret(idToken))throw new LoginError("OpenAI did not return an identity token.");
    const scopes=typeof data.scope==="string"?data.scope.split(/\s+/).filter(Boolean):previous?.scopes;
    if(!scopes)throw new LoginError("OpenAI did not return the granted permissions.");
    const earliest=typeof data.earliest_refresh_at==="number"?data.earliest_refresh_at*1000:undefined;
    return {accessToken:data.access_token,refreshToken:data.refresh_token,idToken,scopes,expiresAt:Date.now()+data.expires_in*1000,...(earliest?{earliestRefreshAt:earliest}:{})};
  };
  const exchange=async(form:Record<string,string>,signal:AbortSignal)=>{
    const config=await discovery(signal);
    return requestJSON(config.token_endpoint!,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({...form,resource})},signal);
  };
  const current=async()=>{const profile=await store.chatgpt();return profile.accounts.find(account=>account.clientId===profile.active);};
  const getToken=async(signal:AbortSignal):Promise<string>=>store.withSessionLock(async()=>{
    const account=await current();
    if(!account?.subject||!account.session)throw new LoginError("Connect your ChatGPT plan with /login openai.");
    if(!hasPlan(account.session))throw new LoginError("ChatGPT plan use is disabled. Run /login openai and approve plan usage.");
    const session=account.session;
    if(session.expiresAt>Date.now()+60000||session.expiresAt>Date.now()&&(session.earliestRefreshAt??0)>Date.now())return session.accessToken;
    const data=await exchange({grant_type:"refresh_token",client_id:account.clientId,refresh_token:session.refreshToken},signal);
    const replacement=tokenSet(data,session);
    if(data.id_token) {
      const verified=await identity(replacement.idToken,account.clientId,signal);
      if(verified.subject!==account.subject)throw new LoginError("OpenAI returned a different account. Sign in again.");
    }
    await store.updateChatGPT(profile=>{const saved=profile.accounts.find(item=>item.clientId===account.clientId);if(saved)saved.session=replacement;},signal);
    if(!hasPlan(replacement))throw new LoginError("ChatGPT plan use is disabled. Run /login openai and approve plan usage.");
    return replacement.accessToken;
  },signal);
  return {
    id:"openai",label:"OpenAI · ChatGPT plan",browserLabel:"Continue with ChatGPT",keyAvailable:false,usageUrl:chatGPTUsageUrl,
    validateKey:async()=>{throw new LoginError("Use Continue with ChatGPT to connect your plan.");},
    credentialSource:{kind:"oauth",getToken},
    connected:async()=>{const account=await current();return Boolean(account?.subject&&hasPlan(account.session));},
    status:async()=>{const account=await current();return account?.session?`${account.email??account.label} · ${hasPlan(account.session)?"Using ChatGPT plan":"ChatGPT plan usage disabled"}`:"OpenAI disconnected";},
    accounts:async()=>{const profile=await store.chatgpt();return profile.accounts.map((account,index)=>({id:String(index+1),label:`${account.label}${account.email?" · "+account.email:""}`,active:profile.active===account.clientId,connected:hasPlan(account.session)}));},
    selectAccount:async id=>{
      if(id==="new"){newAccount=true;loginAccount=undefined;return;}
      const profile=await store.chatgpt(),account=profile.accounts[Number(id)-1];
      if(!account||!/^\d+$/.test(id))throw new LoginError("Choose a saved account number, or /account new.");
      loginAccount=account.clientId;newAccount=false;
      if(account.subject&&account.session)await store.withSessionLock(()=>store.updateChatGPT(value=>{value.active=account.clientId;}),new AbortController().signal);
    },
    browser:async(parent,onUrl)=>{
      const signal=AbortSignal.any([parent,AbortSignal.timeout(options.timeoutMs??300000)]);
      signal.throwIfAborted();
      await store.withSessionLock(()=>store.updateChatGPT(profile=>{profile.hostId??=`urn:uuid:${crypto.randomUUID()}`;},signal),signal);
      const profile=await store.chatgpt();
      const selected=newAccount?undefined:profile.accounts.find(account=>account.clientId===(loginAccount??profile.active))??(!profile.active?profile.accounts.at(-1):undefined);
      const config=await discovery(signal);
      const state=randomBytes(32).toString("base64url"),nonce=randomBytes(32).toString("base64url"),verifier=randomBytes(32).toString("base64url");
      let resolve!:(value:{code:string;clientId:string})=>void,reject!:(error:unknown)=>void,received=false;
      const result=new Promise<{code:string;clientId:string}>((yes,no)=>{resolve=yes;reject=no;});void result.catch(()=>{});
      const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:request=>{
        const url=new URL(request.url);
        if(request.method!=="GET"||url.pathname!=="/auth/callback")return new Response("Not found",{status:404});
        if(received||!equal(url.searchParams.get("state")??"",state))return new Response("Invalid sign-in state",{status:400});
        received=true;
        if(url.searchParams.has("error"))reject(new LoginError("ChatGPT authorization was declined. Run /login openai to try again."));
        else {
          const code=url.searchParams.get("code"),clientId=url.searchParams.get("client_id")??selected?.clientId;
          if(!validSecret(code)||!clientId||clientId.length>256||!/^oaiapp_[a-zA-Z0-9_-]+$/.test(clientId)||selected&&clientId!==selected.clientId)reject(new LoginError("OpenAI returned an incomplete or mismatched registration. Start a fresh sign-in."));
          else resolve({code,clientId});
        }
        return new Response("Return to Bitzen to finish connecting your ChatGPT plan.",{headers:{"Content-Type":"text/plain","Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
      }});
      const abort=()=>reject(new LoginError(parent.aborted?"Sign-in cancelled.":"ChatGPT sign-in timed out. Run /login openai again."));signal.addEventListener("abort",abort,{once:true});
      try {
        const callback=`http://127.0.0.1:${server.port}/auth/callback`;
        const url=new URL(config.authorization_endpoint!);
        const params:Record<string,string>={client_id:selected?.clientId??"dynamic_agent_client",ext_agent_host_id:profile.hostId!,response_type:"code",redirect_uri:callback,scope:requestedScopes,resource,state,nonce,code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url")};
        if(!selected)params.agent_name_hint="Bitzen";
        else {if(selected.session?.idToken)params.id_token_hint=selected.session.idToken;if(selected.email)params.login_hint=selected.email;if(selected.session&&!hasPlan(selected.session))params.prompt="consent";}
        url.search=new URLSearchParams(params).toString();
        // Retained ID tokens are sent only to OpenAI, never rendered or logged.
        const display=new URL(url);display.searchParams.delete("id_token_hint");
        onUrl(display.toString());
        await (options.open??openBrowser)(url.toString(),signal).catch(()=>onUrl(display.toString(),true));
        if(signal.aborted)abort();
        const {code,clientId}=await result;
        if(!selected)await store.withSessionLock(()=>store.updateChatGPT(value=>{
          if(value.accounts.some(account=>account.clientId===clientId))throw new LoginError("This account is already registered. Choose it with /account.");
          value.accounts.push({clientId,label:`ChatGPT account ${value.accounts.length+1}`});
        },signal),signal);
        // Retain the issued client before code exchange, including invalid_grant.
        loginAccount=clientId;newAccount=false;
        const data=await exchange({grant_type:"authorization_code",client_id:clientId,code,code_verifier:verifier,redirect_uri:callback},signal);
        const session=tokenSet(data),verified=await identity(session.idToken,clientId,signal,nonce);
        if(selected?.subject&&verified.subject!==selected.subject)throw new LoginError("OpenAI returned a different account. The saved login was preserved.");
        await store.withSessionLock(()=>store.updateChatGPT(value=>{
          const account=value.accounts.find(item=>item.clientId===clientId)!;
          Object.assign(account,verified,{session});value.active=clientId;
        },signal),signal);
        if(!hasPlan(session))throw new LoginError("Signed in, but ChatGPT plan usage was not approved. Run /login openai to enable it.");
      }finally {signal.removeEventListener("abort",abort);await server.stop(true);}
    },
    logout:async()=>store.withSessionLock(async()=>{
      const account=await current();let confirmed=true;
      if(account?.session) {
        confirmed=false;
        try {
          const signal=AbortSignal.timeout(15000),config=await discovery(signal);
          for(let attempt=0;attempt<3;attempt++) {
            try {
              const response=await transport(config.revocation_endpoint!,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token:account.session.refreshToken,token_type_hint:"refresh_token",client_id:account.clientId}),signal,redirect:"error"});
              if(response.status===200){confirmed=true;break;}if(response.status<500)break;
            }catch{if(signal.aborted)break;}
            if(attempt<2)await Bun.sleep(200*(attempt+1));
          }
        }catch{}
        await store.updateChatGPT(profile=>{const saved=profile.accounts.find(item=>item.clientId===account.clientId);if(saved)delete saved.session;});
      }
      return confirmed?undefined:"Signed out locally. Remote revocation was not confirmed; disconnect Bitzen in ChatGPT Settings → Usage.";
    },AbortSignal.timeout(30000)),
  };
}
