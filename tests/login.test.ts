import {expect,test} from "bun:test";
import {mkdtemp,rm,stat,symlink} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {ProfileStore} from "../src/profile.ts";
import {AccountManager,openRouterLogin} from "../src/login.ts";
import {loadConfig} from "../src/config.ts";
import {commandSuggestions} from "../src/commands.ts";

test("private profiles persist verified credentials and models, support logout, and never use env defaults",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bitzen-login-test-"));
  try {
    const store=new ProfileStore(join(root,"profile"));
    const accounts=new AccountManager(store).register({id:"test",label:"Test",validateKey:async(key)=>{if(key!=="test-key")throw Error("Invalid");}});
    await accounts.key("test","test-key",new AbortController().signal);
    expect(await new AccountManager(new ProfileStore(store.directory)).connected("test")).toBe(true);
    expect(await accounts.credentials("test").getToken(new AbortController().signal)).toBe("test-key");
    expect((await stat(join(store.directory,"credentials.json"))).mode&0o777).toBe(0o600);
    expect((await stat(store.directory)).mode&0o777).toBe(0o700);
    await Promise.all([store.saveSelection("lead",{provider:"test",model:"captain"}),store.saveSelection("sidekick",{provider:"test",model:"crewmate"})]);
    const settings=await store.selections();expect(settings.sidekick?.model).toBe("crewmate");
    expect(await Bun.file(join(store.directory,"settings.json")).text()).not.toContain("test-key");
    const config=await loadConfig(undefined,{}, {selections:settings});expect(config.lead.provider).toBe("test");
    const empty=await loadConfig(undefined,{}, {allowUnconfigured:true});expect(empty.lead.model).toBe("");expect(empty.sidekick.model).toBe("");
    await expect(accounts.key("test","invalid",new AbortController().signal)).rejects.toThrow("Invalid");
    expect(await accounts.credentials("test").getToken(new AbortController().signal)).toBe("test-key");
    await accounts.logout("test");expect(await accounts.connected("test")).toBe(false);
    await expect(accounts.credentials("test").getToken(new AbortController().signal)).rejects.toThrow("/login");
    await rm(join(store.directory,"credentials.json"));await symlink(join(root,"outside"),join(store.directory,"credentials.json"));
    await expect(store.credential("test")).rejects.toThrow("Cannot read");
  } finally {await rm(root,{recursive:true,force:true});}
});

test("OpenRouter PKCE uses random callback paths, S256, code exchange, and closes its listener",async()=>{
  let callback="",verifier="",exchanged=false;
  const adapter=openRouterLogin({
    onListen:(url,secret)=>{callback=url;verifier=secret;},
    open:async url=>{
      const auth=new URL(url);
      expect(auth.origin).toBe("https://openrouter.ai");expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      expect(auth.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
      expect((await fetch(new URL("/wrong",callback))).status).toBe(404);
      expect((await fetch(callback)).status).toBe(400);
      expect((await fetch(callback+"?code=auth-code")).status).toBe(200);
    },
    fetch:async(url,init)=>{
      expect(String(url)).toBe("https://openrouter.ai/api/v1/auth/keys");
      expect(JSON.parse(init?.body as string)).toEqual({code:"auth-code",code_verifier:verifier,code_challenge_method:"S256"});exchanged=true;
      return Response.json({key:"generated-key"});
    },
  });
  expect(await adapter.browser!(new AbortController().signal,()=>{})).toBe("generated-key");expect(exchanged).toBe(true);
  await expect(fetch(callback)).rejects.toThrow();
});

test("browser login cancellation closes the callback; key verification failures do not reveal the key",async()=>{
  const controller=new AbortController();let callback="";
  const adapter=openRouterLogin({onListen:url=>{callback=url;},open:async()=>{controller.abort();}});
  await expect(adapter.browser!(controller.signal,()=>{})).rejects.toThrow("cancelled");
  await expect(fetch(callback)).rejects.toThrow();
  const rejected=openRouterLogin({fetch:async()=>Response.json({error:{message:"secret-key"}},{status:401})});
  let error="";try{await rejected.validateKey("secret-key",new AbortController().signal);}catch(value){error=String(value);}
  expect(error).toContain("HTTP 401");expect(error).not.toContain("secret-key");
});

test("command completion supports command prefixes, role/mode arguments, and future provider IDs",()=>{
  expect(commandSuggestions("/lo").map(item=>item.value)).toEqual(["/login","/logout"]);
  expect(commandSuggestions("/model cr")[0]?.value).toBe("/model crewmate");
  expect(commandSuggestions("/mode s")[0]?.value).toBe("/mode single");
  expect(commandSuggestions("/login te",["test"])[0]?.value).toBe("/login test");
  expect(commandSuggestions("normal task")).toEqual([]);expect(commandSuggestions("/help\nnormal task")).toEqual([]);
});

test("browser sign-in timeout cleans up the listener and aborted validation never saves a login",async()=>{
  let callback="";
  const adapter=openRouterLogin({timeoutMs:10,onListen:url=>{callback=url;},open:async()=>{}});
  await expect(adapter.browser!(new AbortController().signal,()=>{})).rejects.toThrow("timed out");
  await expect(fetch(callback)).rejects.toThrow();
  const root=await mkdtemp(join(tmpdir(),"bitzen-aborted-login-"));
  try{
    const controller=new AbortController(),store=new ProfileStore(root);
    const accounts=new AccountManager(store).register({id:"test",label:"Test",validateKey:async()=>{controller.abort(new Error("Cancelled"));}});
    await expect(accounts.key("test","key",controller.signal)).rejects.toThrow("Cancelled");
    expect(await accounts.connected("test")).toBe(false);
  }finally{await rm(root,{recursive:true,force:true});}
});
