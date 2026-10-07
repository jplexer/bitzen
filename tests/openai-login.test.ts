import { expect, test } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { ProfileStore } from "../src/profile.ts";
import { AccountManager } from "../src/login.ts";
import { openAILogin } from "../src/openai-login.ts";
import { OpenAI } from "../src/providers/openai.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { mountTui } from "../src/tui.ts";

const issuer="https://auth.openai.com",scopes="openid email profile offline_access resource.invoke chatgpt.tokens.use.direct";
async function fixture(options:{claims?:Record<string,unknown>;scope?:string;deny?:boolean;revoke?:boolean;callbackClientId?:string;tokenFailure?:number;badSignature?:boolean}={}) {
  const root=await mkdtemp(join(tmpdir(),"bitzen-chatgpt-test-")),store=new ProfileStore(root);
  const {privateKey,publicKey}=await generateKeyPair("ES256"),jwk=await exportJWK(publicKey);
  const urls:string[]=[],displayURLs:string[]=[],forms:URLSearchParams[]=[];
  let callback="",nonce="",clientId="oaiapp_test",refreshes=0,revocations=0;
  const transport:(...args:Parameters<typeof fetch>)=>ReturnType<typeof fetch>=async(url,init)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith("openid-configuration"))return Response.json({issuer,authorization_endpoint:issuer+"/api/accounts/authorize",token_endpoint:issuer+"/api/accounts/oauth/token",revocation_endpoint:issuer+"/api/accounts/oauth/revoke",jwks_uri:issuer+"/.well-known/jwks.json"});
    if(path.endsWith("jwks.json"))return Response.json({keys:[{...jwk,kid:"test",alg:"ES256"}]});
    if(path.endsWith("/oauth/revoke")) {revocations++;forms.push(new URLSearchParams(init?.body as URLSearchParams));return new Response(null,{status:options.revoke===false?503:200});}
    if(path.endsWith("/oauth/token")) {
      const form=new URLSearchParams(init?.body as URLSearchParams);forms.push(form);
      if(options.tokenFailure)return Response.json({error:"invalid_grant",error_description:"refresh-secret-0"},{status:options.tokenFailure});
      expect(form.get("client_id")).toBe(clientId);expect(form.get("resource")).toBe("https://api.openai.com/v1");
      if(form.get("grant_type")==="authorization_code") {
        const authorize=new URL(urls.at(-1)!);
        expect(form.get("code")).toBe("test-code");expect(form.get("redirect_uri")).toBe(callback);
        expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(authorize.searchParams.get("code_challenge")!);
      }else {refreshes++;expect(form.has("scope")).toBe(false);await Bun.sleep(30);}
      const now=Math.floor(Date.now()/1000);
      const id=await new SignJWT({nonce,email:"user@example.com",...options.claims}).setProtectedHeader({alg:"ES256",kid:"test"}).setIssuer(typeof options.claims?.iss==="string"?options.claims.iss:issuer).setAudience(typeof options.claims?.aud==="string"?options.claims.aud:clientId).setSubject(typeof options.claims?.sub==="string"?options.claims.sub:"subject-test").setIssuedAt(now).setExpirationTime(typeof options.claims?.exp==="number"?options.claims.exp:now+3600).sign(privateKey);
      const invalidSignature=id.slice(0,id.lastIndexOf(".")+1)+Buffer.alloc(64).toString("base64url");
      return Response.json({access_token:`access-secret-${refreshes}`,refresh_token:`refresh-secret-${refreshes}`,id_token:options.badSignature?invalidSignature:id,token_type:"Bearer",expires_in:3600,scope:options.scope??scopes});
    }
    if(path==="/v1/models")return Response.json({models:[{slug:"gpt-test-captain",display_name:"Captain GPT",visibility:"list"},{slug:"gpt-test-crewmate",display_name:"Crewmate GPT",visibility:"list"}]});
    throw Error("Unexpected endpoint");
  };
  const adapter=openAILogin(store,{fetch:transport,open:async value=>{
    urls.push(value);const url=new URL(value);callback=url.searchParams.get("redirect_uri")!;nonce=url.searchParams.get("nonce")!;
    expect(url.origin).toBe(issuer);expect(url.pathname).toBe("/api/accounts/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(url.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect((await fetch(callback+"?state=incorrect&code=test-code&client_id="+clientId)).status).toBe(400);
    const response=new URL(callback);response.searchParams.set("state",url.searchParams.get("state")!);
    if(options.deny)response.searchParams.set("error","access_denied");
    else {response.searchParams.set("code","test-code");if(options.callbackClientId)response.searchParams.set("client_id",options.callbackClientId);else if(url.searchParams.get("client_id")==="dynamic_agent_client")response.searchParams.set("client_id",clientId);}
    expect((await fetch(response)).status).toBe(200);
  }});
  const accounts=new AccountManager(store).register(adapter);
  return {root,store,adapter,accounts,transport,urls,displayURLs,forms,get callback(){return callback;},get refreshes(){return refreshes;},get revocations(){return revocations;},set clientId(value:string){clientId=value;},login:()=>accounts.browser("openai",new AbortController().signal,url=>displayURLs.push(url)),dispose:()=>rm(root,{recursive:true,force:true})};
}

test("ChatGPT plan login validates PKCE and identity, persists private credentials, and reuses registration",async()=>{
  const f=await fixture();
  try {
    await f.login();expect(await f.accounts.connected("openai")).toBe(true);
    const first=new URL(f.urls[0]!);expect(first.searchParams.get("client_id")).toBe("dynamic_agent_client");expect(first.searchParams.get("agent_name_hint")).toBe("Bitzen");
    const before=await f.store.chatgpt();expect(before.hostId).toStartWith("urn:uuid:");expect(before.active).toBe("oaiapp_test");expect(before.accounts[0]?.subject).toBe("subject-test");
    expect((await stat(join(f.root,"credentials.json"))).mode&0o777).toBe(0o600);
    expect((await stat(f.root)).mode&0o777).toBe(0o700);await expect(fetch(f.callback)).rejects.toThrow();
    await f.login();const returning=new URL(f.urls[1]!);
    expect(returning.searchParams.get("client_id")).toBe("oaiapp_test");expect(returning.searchParams.has("agent_name_hint")).toBe(false);
    expect(returning.searchParams.get("ext_agent_host_id")).toBe(first.searchParams.get("ext_agent_host_id"));
    expect(returning.searchParams.get("nonce")).not.toBe(first.searchParams.get("nonce"));expect(returning.searchParams.get("state")).not.toBe(first.searchParams.get("state"));
    expect(returning.searchParams.has("id_token_hint")).toBe(true);expect(f.displayURLs.join(" ")).not.toContain("id_token_hint");
    expect((await f.store.chatgpt()).accounts.length).toBe(1);
    await expect(f.accounts.key("openai","any-api-key",new AbortController().signal)).rejects.toThrow("Continue with ChatGPT");
  }finally{await f.dispose();}
});

test("ChatGPT login rejects invalid issuer, audience, expiry and nonce without activating credentials",async()=>{
  for(const claims of [{iss:"https://attacker.example"},{aud:"other-client"},{exp:1},{nonce:"incorrect"}]) {
    const f=await fixture({claims});
    try {await expect(f.login()).rejects.toThrow("identity verification failed");expect(await f.accounts.connected("openai")).toBe(false);expect((await f.store.chatgpt()).accounts[0]?.session).toBeUndefined();await expect(fetch(f.callback)).rejects.toThrow();}
    finally{await f.dispose();}
  }
});

test("ChatGPT declined consent never exchanges a code; missing plan scope retains identity but blocks inference",async()=>{
  const denied=await fixture({deny:true});
  try {await expect(denied.login()).rejects.toThrow("declined");expect(denied.forms).toHaveLength(0);expect(await denied.accounts.connected("openai")).toBe(false);}
  finally{await denied.dispose();}
  const f=await fixture({scope:"openid profile email offline_access"});
  try {
    await expect(f.login()).rejects.toThrow("plan usage was not approved");expect((await f.store.chatgpt()).accounts[0]?.subject).toBe("subject-test");
    expect(await f.accounts.connected("openai")).toBe(false);await expect(f.accounts.credentials("openai").getToken(new AbortController().signal)).rejects.toThrow("plan use is disabled");
    await expect(f.login()).rejects.toThrow("plan usage was not approved");expect(new URL(f.urls[1]!).searchParams.get("prompt")).toBe("consent");
  }finally{await f.dispose();}
});

test("ChatGPT signature failures and returning account mismatches preserve previously verified credentials",async()=>{
  const options:{claims:Record<string,unknown>;badSignature?:boolean;callbackClientId?:string}={claims:{}};
  const f=await fixture(options);
  try {
    await f.login();const original=(await f.store.chatgpt()).accounts[0]?.session;
    options.badSignature=true;await expect(f.login()).rejects.toThrow("identity verification failed");expect((await f.store.chatgpt()).accounts[0]?.session).toEqual(original);
    options.badSignature=false;options.claims.sub="different-user";
    await expect(f.login()).rejects.toThrow("different account");expect((await f.store.chatgpt()).accounts[0]?.subject).toBe("subject-test");
    options.claims={};options.callbackClientId="oaiapp_wrong";
    const before=f.forms.length;await expect(f.login()).rejects.toThrow("mismatched registration");expect(f.forms.length).toBe(before);
    expect((await f.store.chatgpt()).accounts[0]?.session).toEqual(original);
  }finally{await f.dispose();}
});

test("failed ChatGPT code exchange retains the issued registration for the next login attempt",async()=>{
  const options:{tokenFailure?:number}={tokenFailure:400},f=await fixture(options);
  try {
    await expect(f.login()).rejects.toThrow("/login openai");expect((await f.store.chatgpt()).accounts[0]?.clientId).toBe("oaiapp_test");expect(await f.accounts.connected("openai")).toBe(false);
    options.tokenFailure=undefined;await f.login();expect(new URL(f.urls[1]!).searchParams.get("client_id")).toBe("oaiapp_test");expect((await f.store.chatgpt()).accounts.length).toBe(1);
  }finally{await f.dispose();}
});

test("ChatGPT refresh is shared across independent stores and persists the rotated tokens",async()=>{
  const f=await fixture();
  try {
    await f.login();await f.store.updateChatGPT(profile=>{profile.accounts[0]!.session!.expiresAt=Date.now()-1;});
    const other=new AccountManager(new ProfileStore(f.root));other.register(openAILogin(other.store,{fetch:f.transport}));
    const values=await Promise.all([f.accounts.credentials("openai").getToken(new AbortController().signal),other.credentials("openai").getToken(new AbortController().signal)]);
    expect(values).toEqual(["access-secret-1","access-secret-1"]);expect(f.refreshes).toBe(1);
    expect((await f.store.chatgpt()).accounts[0]?.session?.refreshToken).toBe("refresh-secret-1");
  }finally{await f.dispose();}
});

test("ChatGPT accounts keep separate registrations and logout revokes only the selected session",async()=>{
  const f=await fixture();
  try {
    await f.login();const host=(await f.store.chatgpt()).hostId;
    await f.adapter.selectAccount!("new");f.clientId="oaiapp_second";await f.login();
    expect((await f.store.chatgpt()).accounts.length).toBe(2);expect((await f.store.chatgpt()).hostId).toBe(host);
    await f.adapter.selectAccount!("1");expect((await f.store.chatgpt()).active).toBe("oaiapp_test");
    await f.accounts.logout("openai");expect(f.revocations).toBe(1);expect(f.forms.at(-1)?.get("client_id")).toBe("oaiapp_test");
    expect(await f.accounts.connected("openai")).toBe(false);expect((await f.store.chatgpt()).accounts[0]?.clientId).toBe("oaiapp_test");expect((await f.store.chatgpt()).accounts[0]?.session).toBeUndefined();
    expect((await f.store.chatgpt()).accounts[1]?.session).toBeDefined();
    await f.adapter.selectAccount!("2");expect(await f.accounts.connected("openai")).toBe(true);
    await f.adapter.selectAccount!("1");f.clientId="oaiapp_test";await f.login();
    expect(new URL(f.urls.at(-1)!).searchParams.has("id_token_hint")).toBe(false);expect((await f.store.chatgpt()).accounts.length).toBe(2);
  }finally{await f.dispose();}
});

test("ChatGPT logout reports unconfirmed remote revocation and still clears local tokens",async()=>{
  const f=await fixture({revoke:false});
  try {await f.login();expect(await f.accounts.logout("openai")).toContain("Remote revocation was not confirmed");expect(f.revocations).toBe(3);expect(await f.accounts.connected("openai")).toBe(false);}
  finally{await f.dispose();}
});

test("ChatGPT cancellation and timeout clean up the listener and never save tokens",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bitzen-chatgpt-cancel-"));
  try {
    for(const cancel of [true,false]) {
      let callback="";const controller=new AbortController();
      const adapter=openAILogin(new ProfileStore(root),{timeoutMs:30,fetch:async()=>Response.json({issuer,authorization_endpoint:issuer+"/authorize",token_endpoint:issuer+"/token",jwks_uri:issuer+"/jwks",revocation_endpoint:issuer+"/revoke"}),open:async url=>{callback=new URL(url).searchParams.get("redirect_uri")!;if(cancel)controller.abort();}});
      await expect(adapter.browser!(controller.signal,()=>{})).rejects.toThrow(cancel?"cancelled":"timed out");await expect(fetch(callback)).rejects.toThrow();
      expect(await adapter.connected!()).toBe(false);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test("native TUI selects ChatGPT login, discovers both models and preserves a supplied task file",async()=>{
  const f=await fixture(),setup=await createTestRenderer({exitOnCtrlC:false,width:100,height:32});
  let routerCatalogCalls=0;
  f.accounts.register({id:"openrouter",label:"OpenRouter",browser:async()=>"unused",validateKey:async()=>{}});
  const providers=new ProviderRegistry().register({id:"openrouter",complete:async()=>{throw Error("No inference");},listModels:async()=>{routerCatalogCalls++;return [];}}).register(new OpenAI(f.accounts.credentials("openai"),f.transport));
  const config={lead:{provider:"openrouter",model:""},sidekick:{provider:"openrouter",model:""},maxCalls:10,maxTurns:10,maxOutputTokens:1000};
  const app=mountTui(setup.renderer,{cwd:f.root,config,providers,mode:"crew",accounts:f.accounts,initialTask:"Keep this task",taskFile:"/tmp/TASK.md",allowShell:false,signal:new AbortController().signal});
  try {
    await setup.waitFor(()=>app.state.modal==="login",{maxPasses:10000});setup.mockInput.pressArrow("right");await setup.flush();
    expect(app.state.login?.provider).toBe("openai");expect(setup.captureCharFrame()).toContain("Continue with ChatGPT");expect(setup.captureCharFrame()).not.toContain("Paste an API key");
    setup.mockInput.pressTab();expect(app.state.login?.choice).toBe(0);setup.mockInput.pressEnter();
    await setup.waitFor(()=>app.state.modal==="models"&&!app.state.modelPicker?.loading,{maxPasses:10000});
    expect(routerCatalogCalls).toBe(0);expect(app.state.modelPicker?.choices.map(item=>item.provider)).toEqual(["openai","openai"]);
    await setup.mockInput.typeText("gpt-test-captain");setup.mockInput.pressEnter();await setup.waitFor(()=>app.state.modelPicker?.role==="sidekick",{maxPasses:10000});
    await setup.mockInput.typeText("gpt-test-crewmate");setup.mockInput.pressEnter();await setup.waitFor(()=>!app.state.modal,{maxPasses:10000});
    expect(app.state.accountStatus).toContain("Using ChatGPT plan");expect(app.view.composer.plainText).toBe("Keep this task");expect(app.state.taskFile).toBe("/tmp/TASK.md");
    expect((await f.store.selections()).lead?.provider).toBe("openai");expect((await f.store.selections()).sidekick?.model).toBe("gpt-test-crewmate");
    expect(JSON.stringify(app.state)).not.toContain("access-secret");expect(JSON.stringify(app.state)).not.toContain("refresh-secret");
    setup.mockInput.pressKey("u",{ctrl:true});await setup.mockInput.typeText("/help");setup.mockInput.pressEnter();await setup.flush();
    await setup.mockInput.typeText("/account");setup.mockInput.pressEnter();await setup.waitFor(()=>app.state.entries.some(entry=>entry.title==="ChatGPT accounts"),{maxPasses:10000});
    expect(app.state.entries.at(-1)?.text).toContain("user@example.com");expect(app.view.composer.focused).toBe(true);
    await setup.mockInput.typeText("/logout openai");setup.mockInput.pressEnter();await setup.waitFor(()=>app.state.notice.includes("Disconnected"),{maxPasses:10000});
    expect(f.revocations).toBe(1);expect(app.state.accountStatus).toContain("Not connected");
  }finally{app.close();await app.finished;app.destroy();setup.renderer.destroy();await f.dispose();}
});
