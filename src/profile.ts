import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelSelection } from "./providers/types.ts";

export type Selections = Partial<Record<"lead" | "sidekick", ModelSelection>>;
interface Credential { token: string; kind: "api-key" | "oauth" }
export interface ChatGPTSession {
  accessToken: string; refreshToken: string; idToken: string; scopes: string[];
  expiresAt: number; earliestRefreshAt?: number;
}
export interface ChatGPTAccount {
  clientId: string; subject?: string; email?: string; label: string; session?: ChatGPTSession;
}
export interface ChatGPTProfile { hostId?: string; active?: string; accounts: ChatGPTAccount[] }

export class ProfileStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(readonly directory = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "bitzen")) {}
  private async prepare(): Promise<void> {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const directory=await lstat(this.directory);
    if(!directory.isDirectory()||directory.isSymbolicLink())throw new Error("Invalid Bitzen profile directory.");
    await chmod(this.directory,0o700);
  }
  // OAuth refresh tokens rotate. The filesystem lock also serializes different
  // Bitzen processes, not just Captain and Crewmate requests in this process.
  async withSessionLock<T>(action:()=>Promise<T>, signal:AbortSignal): Promise<T> {
    await this.prepare();
    const path=join(this.directory,".session-lock"), deadline=Date.now()+30000;
    let lock;
    while(!lock) {
      signal.throwIfAborted();
      try {lock=await open(path,"wx",0o600);await lock.writeFile(String(process.pid));}
      catch(error) {
        if((error as NodeJS.ErrnoException).code!=="EEXIST")throw new Error("Cannot lock the account profile.");
        let existing;
        try {
          existing=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
          const info=await existing.stat();if(!info.isFile())throw new Error("Invalid session lock.");
          const pid=Number(await existing.readFile("utf8"));
          if(Number.isInteger(pid)&&pid>0) {
            try {process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")await rm(path,{force:true});}
          }else if(Date.now()-info.mtimeMs>30000)await rm(path,{force:true});
        }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new Error("Cannot read the account lock.");}
        finally {await existing?.close();}
        if(Date.now()>deadline)throw new Error("Account is busy in another Bitzen process. Try again.");
        await Bun.sleep(50);
      }
    }
    try {signal.throwIfAborted();return await action();}
    finally {await lock.close();await rm(path,{force:true});}
  }
  private async read(name: string): Promise<Record<string, any>> {
    let file;
    try {
      file = await open(join(this.directory,name),constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!(await file.stat()).isFile()) throw new Error("Invalid Bitzen profile file.");
      const value = JSON.parse(await file.readFile("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Bitzen profile file.");
      return value;
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`Cannot read Bitzen ${name}.`);
    } finally { await file?.close(); }
  }
  private update(name: string, change: (value: Record<string, any>) => void, signal?: AbortSignal): Promise<void> {
    const write = this.writes.catch(()=>{}).then(async()=>{
      signal?.throwIfAborted();
      const value = await this.read(name); change(value);
      await this.prepare();
      const temp = join(this.directory,`.${name}-${crypto.randomUUID()}`);
      try {
        const file = await open(temp,"wx",0o600);
        try { await file.writeFile(JSON.stringify(value,null,2)+"\n"); await file.sync(); } finally {await file.close();}
        signal?.throwIfAborted();
        await rename(temp,join(this.directory,name));
      } finally {await rm(temp,{force:true});}
    });
    this.writes = write; return write;
  }
  async credential(provider: string): Promise<Credential | undefined> {
    const value = (await this.read("credentials.json"))[provider];
    return value && typeof value.token === "string" && value.token.trim() && ["api-key","oauth"].includes(value.kind) ? value : undefined;
  }
  saveCredential(provider: string, credential: Credential, signal?:AbortSignal): Promise<void> {
    if (credential.token.length>4096 || !credential.token.trim() || /[\s\x00-\x1f\x7f]/.test(credential.token)) return Promise.reject(new Error("Invalid provider credential."));
    return this.update("credentials.json",value=>{value[provider]=credential;},signal);
  }
  logout(provider: string): Promise<void> { return this.update("credentials.json",value=>{delete value[provider];}); }
  async chatgpt(): Promise<ChatGPTProfile> {
    const value=(await this.read("credentials.json")).chatgpt;
    if(!value)return {accounts:[]};
    if(typeof value!=="object"||!Array.isArray(value.accounts))throw new Error("Invalid ChatGPT profile.");
    return value;
  }
  updateChatGPT(change:(profile:ChatGPTProfile)=>void,signal?:AbortSignal): Promise<void> {
    return this.update("credentials.json",value=>{const profile=value.chatgpt??{accounts:[]};change(profile);value.chatgpt=profile;},signal);
  }
  async selections(): Promise<Selections> {
    const raw = await this.read("settings.json"), result: Selections = {};
    for(const role of ["lead","sidekick"] as const) {
      const value = raw[role];
      if(value && typeof value.provider === "string" && typeof value.model === "string" && value.model.trim())result[role]={provider:value.provider,model:value.model};
    }
    return result;
  }
  saveSelection(role: "lead" | "sidekick", selection: ModelSelection): Promise<void> {
    return this.update("settings.json",value=>{value[role]=selection;});
  }
}
