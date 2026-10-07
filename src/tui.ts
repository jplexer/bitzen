import { createCliRenderer, createClipboard, createHostClipboard, createRendererClipboardAdapter, type ClipboardService, type CliRenderer, type KeyEvent, type Selection } from "@opentui/core";
import type { AccountManager } from "./login.ts";
import { LoginError, openBrowser } from "./login.ts";
import { commandSuggestions, commands } from "./commands.ts";
import { cleanText } from "./terminal.ts";
import type { Config } from "./config.ts";
import { HarnessRunError, runHarness } from "./harness.ts";
import { readRun, savedRuns } from "./history.ts";
import type { ProviderRegistry } from "./providers/registry.ts";
import { formatRunSummary } from "./report.ts";
import { matchingModels, modelChoices, modelKey, roleLabel, validModelId, type ModelChoice, type ModelRole } from "./models.ts";
import { TuiState, helpText } from "./tui-state.ts";
import { createTuiView } from "./tui-view.ts";
export { TuiState } from "./tui-state.ts";

export interface TuiOptions {
  cwd: string; config: Config; providers: ProviderRegistry; mode: "crew" | "single";
  accounts?: AccountManager; allowShell: boolean; signal: AbortSignal; initialTask?: string; taskFile?: string;
  clipboard?: Pick<ClipboardService, "writeText">;
}

// The controller is also used with OpenTUI's real native test renderer.
export function mountTui(renderer: CliRenderer, options: TuiOptions) {
  const config = structuredClone(options.config);
  let catalogue: ModelChoice[] = [], catalogueLoaded = false;
  let catalogueRequest = 0, catalogueController: AbortController | undefined;
  let authController: AbortController | undefined, authPending: Promise<void> | undefined, loginSecret = "";
  const connectedProviders = new Set<string>();
  const shellAllowed = options.allowShell;
  let state = new TuiState(options.initialTask, options.taskFile); state.mode = options.mode;
  let active: AbortController | undefined, pending: Promise<void> | undefined;
  let closing = false, disposed = false, loadingHistory = false;
  let ownedClipboard: ClipboardService | undefined, copyRequest = 0;
  let copying = Promise.resolve();
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const refresh = () => {
    if (!disposed && !renderer.isDestroyed) {
      state.suggestions = !state.modal && !state.suggestionsDismissed ? commandSuggestions(state.input,options.accounts?.list().map(provider=>provider.id)??options.providers.list().map(provider=>provider.id)) : [];
      state.suggestionIndex = Math.max(0,Math.min(state.suggestionIndex,state.suggestions.length-1));
      view.sync(state);renderer.requestRender();
    }
  };
  const view = createTuiView(renderer, config, options.cwd, {
    models: () => openModels(),
    modelRole: role => { if (state.modal === "models") changeRole(role); else openModels(role); },
    modelSelect: index => { if (state.modelPicker) state.modelPicker.index = index; selectModel(); },
    modelSearch: query => { if (state.modelPicker?.query === query) return; if (state.modelPicker) { state.modelPicker.query = query; state.modelPicker.index = 0; refresh(); } },
    loginSelect: choice => {if(state.login&&choice!==undefined)state.login.choice=choice;loginAction();},
    suggest: index => {state.suggestionIndex=index;completeCommand();},
    submit: () => submit(),
    draft: value => {
      if (state.input === value) return;
      state.input = value; state.taskFile = undefined; state.suggestionIndex=0; state.suggestionsDismissed=false; refresh();
    },
  });
  const reset = (initialTask = "") => {
    const mode = state.mode,accountStatus=state.accountStatus; state = new TuiState(initialTask); state.mode = mode;state.accountStatus=accountStatus;
    view.setDraft(initialTask); view.focusInput(); refresh();
  };
  const close = () => {
    closing = true; loginSecret=""; authController?.abort(); catalogueController?.abort(); active?.abort(new Error("Exited TUI."));
    if (!pending && !authPending) finish();
  };
  const selectedText = () => renderer.getSelection()?.getSelectedText()
    || (view.composer.focused ? view.composer.getSelectedText() : view.search.focused ? view.search.getSelectedText() : "");
  const copySelection = (value = selectedText()) => {
    if (!value) return;
    const request = ++copyRequest;
    // Serialize writes so a slow earlier selection cannot overwrite a newer one.
    copying = copying.then(async () => {
      if (disposed || closing) return;
      let message = "Could not copy text. Try your terminal's native selection.";
      try {
        const clipboard = options.clipboard ?? (ownedClipboard ??= createClipboard({host:createHostClipboard(),terminal:createRendererClipboardAdapter(renderer)}));
        const result = await clipboard.writeText(value,{destination:"best-available",signal:options.signal});
        if (result.host.status === "written") message = "Copied selection.";
        else if (result.terminal.status === "attempted") message = "Copy sent to terminal.";
      } catch {}
      if (!disposed && !closing && request === copyRequest) {state.notice=message;refresh();}
    });
  };
  // Most macOS terminals keep Cmd+C for themselves. Copy on mouse release as
  // well, since an OpenTUI highlight is separate from the terminal's selection.
  const selection = (value: Selection) => {if (!value.isDragging) copySelection(value.getSelectedText());};
  const submit = () => {
    if (closing || !state.input.trim()) return;
    const task = state.input.trim(), mode = state.mode, resumeDirectory = state.resumeDirectory;
    if (task.startsWith("/") && !task.includes("\n")) { executeCommand(task); return; }
    if(pending){state.notice="A task is running. Use /cancel or wait before starting another.";refresh();return;}
    if (options.accounts) {
      const missing=[config.lead,...(mode==="crew"?[config.sidekick]:[])].find(selection=>!connectedProviders.has(selection.provider));
      if(missing){openLogin(missing.provider);return;}
    }
    if(!config.lead.model || mode==="crew"&&!config.sidekick.model){state.notice="Choose a model before starting this task.";openModels(!config.lead.model?"lead":"sidekick");return;}
    const runConfig = structuredClone(config);
    // A continuation starts a new trace, not a new visible conversation.
    const historyEntries = resumeDirectory ? state.entries : [];
    const accountStatus=state.accountStatus;state = new TuiState(); state.mode = mode;state.accountStatus=accountStatus; state.task = task; state.status = "Running"; state.started = Date.now();
    state.entries = [...historyEntries]; state.resumeDirectory = resumeDirectory;
    view.setDraft(""); view.focusInput(); refresh();
    active = new AbortController();
    pending = (async () => {
      try {
        const result = await runHarness({ ...options, config: runConfig, allowShell:shellAllowed, task, mode, resumeDirectory, signal: active!.signal, onEvent: event => { state.receive(event); refresh(); } });
        state.traceDirectory = result.traceDirectory;
        state.resumeDirectory = result.traceDirectory;
      } catch (error) {
        state.status = "Failed";
        state.notice = error instanceof Error ? error.message : "Task failed.";
        if (error instanceof HarnessRunError) { state.usage = error.usage; state.traceDirectory = error.traceDirectory; state.resumeDirectory = error.traceDirectory; }
      } finally {
        pending = undefined; active = undefined; if (!closing) view.focusInput(); refresh();
        if (closing && !authPending) finish();
      }
    })();
  };
  const applyModel = async (role: ModelRole, choice: ModelChoice) => {
    if (pending || !validModelId(choice.id)) { state.notice = "Enter an exact model ID without spaces."; refresh(); return; }
    options.providers.get(choice.provider);
    const selection={provider:choice.provider,model:choice.id};
    try {await options.accounts?.store.saveSelection(role,selection);}catch{state.notice="Could not save the model choice.";refresh();return;}
    if(disposed||closing)return;
    config[role] = selection;
    state.notice = `${roleLabel(role)} switched to ${choice.id}`;
    state.modal = undefined; view.focusInput(); refresh();
    if(options.accounts&&role==="lead"&&state.mode==="crew"&&!config.sidekick.model)openModels("sidekick");
  };
  const changeRole = (role: ModelRole) => {
    if (!state.modelPicker) return;
    state.modelPicker.role = role; state.modelPicker.index = 0;
    state.modelPicker.choices = availableChoices(role); refresh();
  };
  const availableChoices=(role:ModelRole)=>modelChoices(config,catalogue,role).filter(choice=>!options.accounts||connectedProviders.has(choice.provider));
  const loadCatalogue = async (force = false) => {
    if (catalogueLoaded && !force) return;
    catalogueController?.abort(); catalogueController = new AbortController();
    const request = ++catalogueRequest;
    const signal = AbortSignal.any([catalogueController.signal, options.signal]);
    const providers = options.providers.list().filter(provider => provider.listModels&&(!options.accounts||connectedProviders.has(provider.id)));
    const results = await Promise.allSettled(providers.map(async provider => (await provider.listModels!(signal))
      .filter(model => validModelId(model.id)).map(model => ({...model,provider:provider.id}))));
    if (disposed || closing || request !== catalogueRequest || signal.aborted) return;
    catalogue = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
    catalogueLoaded = !results.some(result => result.status === "rejected");
    if (state.modelPicker) {
      const picker = state.modelPicker;
      const previous = matchingModels(picker)[picker.index];
      picker.choices = availableChoices(picker.role); picker.loading = false;
      picker.error = results.some(result => result.status === "rejected") ? "Catalogue unavailable. You can enter an exact model ID." : "";
      picker.index = Math.max(0,previous ? matchingModels(picker).findIndex(choice => modelKey(choice) === modelKey(previous)) : 0);
      refresh();
    }
  };
  const openModels = (role: ModelRole = "lead") => {
    if (pending) { state.notice = "Finish or cancel the current task to switch models."; refresh(); return; }
    if(options.accounts&&!connectedProviders.size){openLogin(config[role].provider);return;}
    state.notice = ""; state.modal = "models";
    state.modelPicker = {role,query:"",index:0,choices:availableChoices(role),loading:!catalogueLoaded,error:""};
    view.setSearch(""); refresh(); view.focusSearch();
    void loadCatalogue();
  };
  const selectModel = () => {
    const picker = state.modelPicker;
    if (!picker || state.modal !== "models" || pending) return;
    const found = matchingModels(picker)[picker.index];
    const id = picker.query.trim();
    const provider=options.accounts&&!connectedProviders.has(config[picker.role].provider)?[...connectedProviders][0]!:config[picker.role].provider;
    if (found) applyModel(picker.role,found);
    else if (validModelId(id) && (provider !== "openrouter" || id.includes("/"))) applyModel(picker.role,{provider,id,name:id});
    else { picker.error = "No matches. Enter the exact model ID, or change your search."; refresh(); }
  };
  const closeModal = () => { if(state.modal==="login"){authController?.abort();loginSecret="";if(state.login)state.login.keyLength=0;} state.modal = undefined; if (!pending) view.focusInput(); else view.focusFeed(); };
  const history = async () => {
    if (pending) { state.notice = "Finish or cancel the current task before resuming a run."; refresh(); return; }
    if (loadingHistory) return;
    loadingHistory = true; state.modal = "runs"; const target = state;
    try { const runs = await savedRuns(options.cwd); if (state === target) { state.runs = runs; state.selectedRun = 0; } }
    catch (error) { if (state === target) state.notice = String(error); }
    finally { loadingHistory = false; refresh(); }
  };
  const replay = async () => {
    const run = state.runs[state.selectedRun];
    if (pending || !run) return;
    const target = state;
    try {
      const events = await readRun(run);
      if (state !== target || pending || closing) return;
      reset(); for (const event of events) state.receive(event);
      state.traceDirectory = run.directory; state.resumeDirectory = run.directory;
      state.notice = "Saved run ready · Type a continuation and press Enter · Ctrl+N starts fresh";
      view.focusInput();
      refresh();
      // Re-engage bottom following after the picker/reset, before layout grows
      // to the replayed history. Later drafts leave manual scrolling untouched.
      view.feed.scrollTo(view.feed.scrollHeight);
    } catch (error) { state.notice = String(error); }
    refresh();
  };
  const commandReply = (title:string,text:string) => {
    state.entries.push({kind:"command",title,text,detail:"",done:true});view.focusInput();refresh();
  };
  const completeCommand = () => {
    const suggestion=state.suggestions[state.suggestionIndex];if(!suggestion)return;
    state.input=suggestion.value+" ";state.taskFile=undefined;state.suggestionsDismissed=false;state.suggestionIndex=0;view.setDraft(state.input);refresh();view.focusInput();
  };
  const updateAccounts = async () => {
    if(!options.accounts)return;
    connectedProviders.clear();
    for(const adapter of options.accounts.list())if(await options.accounts.connected(adapter.id))connectedProviders.add(adapter.id);
    const statuses=[];
    for(const adapter of options.accounts.list())if(connectedProviders.has(adapter.id))statuses.push(adapter.status?await adapter.status():adapter.label+" connected");
    state.accountStatus=statuses.join(" · ")||"Not connected · /login";
    refresh();
  };
  const openLogin = (provider=config.lead.provider) => {
    if(pending){state.notice="Finish or cancel the current task before changing login.";refresh();return;}
    if(!options.accounts){state.notice="Login is unavailable for this provider setup.";refresh();return;}
    try{options.accounts.adapter(provider);}catch{state.notice="Choose a supported login provider: "+options.accounts.list().map(adapter=>adapter.id).join(", ");refresh();return;}
    authController?.abort();loginSecret="";state.modal="login";
    const adapter=options.accounts.adapter(provider);
    state.login={provider,label:adapter.label,browserAvailable:Boolean(adapter.browser),browserLabel:adapter.browserLabel??"Sign in with your browser",keyAvailable:adapter.keyAvailable!==false,providers:options.accounts.list().map(item=>item.id),phase:"choose",choice:adapter.browser?0:1,keyLength:0,url:"",message:adapter.keyAvailable===false?"Use your existing ChatGPT plan. Approve Bitzen in your browser.":"Connect in your browser, or paste an API key in the terminal.",error:""};
    view.focusFeed();refresh();
  };
  const finishLogin = (browser:boolean) => {
    if(!options.accounts || !state.login || authPending)return;
    const target=state.login,secret=loginSecret;loginSecret="";target.keyLength=0;
    target.phase=browser?"browser":"saving";target.error="";
    authController=new AbortController();const signal=AbortSignal.any([authController.signal,options.signal]);
    refresh();
    authPending=(async()=>{
      try {
        if(browser)await options.accounts!.browser(target.provider,signal,(url,manual)=>{
          if(state.login!==target||state.modal!=="login"||signal.aborted)return;
          target.url=url;target.message=manual?"Open this URL in your browser to continue.":"Finish signing in in your browser. Escape cancels.";refresh();
        });
        else await options.accounts!.key(target.provider,secret,signal);
        if(signal.aborted||disposed||closing)return;
        await updateAccounts();catalogueLoaded=false;catalogue=[];
        for(const role of ["lead","sidekick"] as const)if(!config[role].model)config[role].provider=target.provider;
        if(state.login===target&&state.modal==="login") {
          state.modal=undefined;state.notice=`Connected to ${target.provider}.`;view.focusInput();refresh();
          if(!config.lead.model)openModels("lead");
        }
      } catch(error) {
        if(state.login===target&&state.modal==="login"&&!closing&&!disposed){target.phase=browser?"choose":"key";target.error=signal.aborted?"Sign-in cancelled.":error instanceof LoginError?error.message:target.keyAvailable?"Could not sign in. Try again or use a different key.":"Could not sign in. Try /login openai again.";refresh();}
      } finally {authPending=undefined;authController=undefined;loginSecret="";if(closing&&!pending)finish();}
    })();
  };
  const loginAction = () => {
    const login=state.login;if(!login||state.modal!=="login")return;
    if(login.phase==="choose") {
      if(login.choice===0 && options.accounts?.adapter(login.provider).browser)finishLogin(true);
      else {login.phase="key";login.message="Paste your API key. Input is masked; Enter connects.";refresh();}
    }else if(login.phase==="key")finishLogin(false);
  };
  const executeCommand = (input:string) => {
    const [raw,...args]=input.trim().split(/\s+/),name=raw!.slice(1).toLowerCase();
    if(!commands.some(command=>command.name===name)){state.notice=`Unknown command ${raw}. Use /help.`;state.suggestionsDismissed=true;refresh();return;}
    if(pending&&!['help','status','cost','usage','details','cancel','quit'].includes(name)){state.notice="Finish or cancel the current task before changing this setting.";refresh();return;}
    view.setDraft("");state.suggestionsDismissed=true;state.notice="";
    const noArgs=()=>{if(args.length){state.notice=`/${name} does not accept arguments.`;refresh();return false;}return true;};
    switch(name) {
      case "help":if(noArgs())commandReply("Keyboard shortcuts",commands.map(command=>`/${command.name} — ${command.description}`).join("\n")+"\n\nTab completes · ↑↓ select · Enter runs\nCtrl+P models · Ctrl+O details · Escape cancel");break;
      case "quit":if(noArgs())close();break;
      case "new":case "clear":if(noArgs())reset();break;
      case "cancel":if(noArgs()){active?.abort(new Error("Cancelled by user."));state.notice=pending?"Cancelling…":"No task is running.";}break;
      case "models":case "model":{
        const role:ModelRole=["crewmate","sidekick"].includes(args[0]??"")?"sidekick":"lead";
        if(["captain","crewmate","lead","sidekick"].includes(args[0]??""))args.shift();
        if(args.length>1){state.notice="Use /model [captain|crewmate] [model ID].";break;}
        if(args[0])void applyModel(role,{provider:config[role].provider,id:args[0],name:args[0]});else openModels(role);break;
      }
      case "mode":{
        if(args.length>1 || args[0]&&!['crew','single'].includes(args[0])){state.notice="Use /mode crew or /mode single.";break;}
        state.mode=args[0]?args[0]==="single"?"single":"crew":state.mode==="crew"?"single":"crew";
        state.notice=`Mode: ${state.mode}`;break;
      }
      case "details":if(noArgs())state.expanded=!state.expanded;break;
      case "resume":if(noArgs())void history();break;
      case "cost":if(noArgs())commandReply("Task cost",formatRunSummary({usage:state.usage,traceDirectory:state.traceDirectory||"No task yet"}));break;
      case "status":if(noArgs())commandReply("Session status",`${state.accountStatus||"Provider managed externally"}\nCaptain: ${config.lead.model||"Not selected"}\nCrewmate: ${config.sidekick.model||"Not selected"}\nMode: ${state.mode} · Shell: ${shellAllowed?"enabled":"disabled"}`);break;
      case "login":if(args.length>1)state.notice="Use /login [provider].";else openLogin(args[0]);break;
      case "usage":if(noArgs()) {
        const url=options.accounts?.list().find(adapter=>adapter.id==="openai")?.usageUrl;
        if(!url){state.notice="ChatGPT usage settings are unavailable.";break;}
        commandReply("Manage ChatGPT usage",url);void openBrowser(url).catch(()=>{state.notice="Open the usage URL in your browser.";refresh();});
      }break;
      case "account":{
        const adapter=options.accounts?.list().find(item=>item.accounts&&item.selectAccount);
        if(!adapter){state.notice="Saved ChatGPT accounts are unavailable.";break;}
        if(args.length>1){state.notice="Use /account [number|new].";break;}
        void (async()=>{
          try {
            if(!args[0]) {const accounts=await adapter.accounts!();commandReply("ChatGPT accounts",accounts.length?accounts.map(account=>`${account.active?"›":" "} ${account.id}. ${account.label} · ${account.connected?"connected":"sign in"}`).join("\n")+"\n\n/account NUMBER to switch · /account new to add another":"No saved accounts. Use /login openai or /account new.");return;}
            await adapter.selectAccount!(args[0]);catalogueController?.abort();catalogue=[];catalogueLoaded=false;await updateAccounts();
            const selected=(await adapter.accounts!()).find(account=>account.id===args[0]);
            if(args[0]==="new"||!selected?.active||!selected.connected)openLogin(adapter.id);
            else {state.notice="ChatGPT account switched. Choose a model for this account.";openModels(config.lead.provider===adapter.id?"lead":"sidekick");}
          }catch(error){state.notice=error instanceof LoginError?error.message:"Could not switch ChatGPT account.";refresh();}
        })();break;
      }
      case "logout":{
        if(args.length>1){state.notice="Use /logout [provider].";break;}
        const provider=args[0]??config.lead.provider;
        if(!options.accounts){state.notice="Login is managed externally.";break;}
        try{options.accounts.adapter(provider);}catch{state.notice="Choose a supported provider to log out.";break;}
        void options.accounts.logout(provider).then(async warning=>{catalogueController?.abort();catalogue=[];catalogueLoaded=false;await updateAccounts();state.notice=warning||`Disconnected from ${provider}.`;refresh();}).catch(()=>{state.notice="Could not remove the saved login.";refresh();});break;
      }
    }
    refresh();
  };
  const keypress = (key: KeyEvent) => {
    if (key.eventType === "release") return;
    // Native edit callbacks are batched. Read the current buffer before handling
    // Enter/Tab so fast typing or paste followed immediately by Enter is reliable.
    if(!state.modal && view.composer.focused && state.input!==view.composer.plainText) {
      state.input=view.composer.plainText;state.taskFile=undefined;state.suggestionsDismissed=false;state.suggestionIndex=0;refresh();
    }
    if(state.modal==="models"&&state.modelPicker&&state.modelPicker.query!==view.search.plainText) {
      state.modelPicker.query=view.search.plainText;state.modelPicker.index=0;refresh();
    }
    let handled = true;
    if (key.name === "c" && (key.super || key.meta || key.ctrl && (key.shift || Boolean(selectedText())))) copySelection();
    else if (key.ctrl && key.name === "c") close();
    else if (key.name === "escape") { if(state.suggestions.length){state.suggestionsDismissed=true;} else if (state.modal) closeModal(); else if (pending) active?.abort(new Error("Cancelled by user.")); }
    else if (key.ctrl && key.name === "p") { if (state.modal === "models") closeModal(); else openModels(); }
    else if (state.modal === "login") {
      const login=state.login!;
      if(login.phase==="choose") {
        if(key.name==="left"||key.name==="right"){const index=login.providers.indexOf(login.provider),offset=key.name==="left"?-1:1;openLogin(login.providers[(index+offset+login.providers.length)%login.providers.length]);}
        else if(key.name==="tab"||key.name==="up"||key.name==="down")login.choice=login.browserAvailable?(login.keyAvailable?1-login.choice:0):1;
        else if(key.name==="return")loginAction();
      }else if(login.phase==="key") {
        if(key.name==="return")loginAction();
        else if(key.name==="backspace")loginSecret=loginSecret.slice(0,-1);
        else if(key.ctrl&&key.name==="u")loginSecret="";
        else if(!key.ctrl&&!key.meta&&/^[\x21-\x7e]+$/.test(key.sequence))loginSecret=(loginSecret+key.sequence).slice(0,4096);
        login.keyLength=loginSecret.length;
      }
    }
    else if (!state.modal && state.suggestions.length && view.composer.focused && !key.ctrl && !key.meta && ["up","down","tab","return"].includes(key.name)) {
      if(key.name==="up"||key.name==="down")state.suggestionIndex=(state.suggestionIndex+(key.name==="up"?-1:1)+state.suggestions.length)%state.suggestions.length;
      else if(key.name==="tab" || state.input.trim()!==state.suggestions[state.suggestionIndex]?.value)completeCommand();
      else submit();
    }
    else if (state.modal === "models") {
      const picker = state.modelPicker!;
      if (key.name === "tab") changeRole(picker.role === "lead" ? "sidekick" : "lead");
      else if (key.name === "up" || key.name === "down") picker.index = Math.max(0,Math.min(matchingModels(picker).length-1,picker.index+(key.name === "up" ? -1 : 1)));
      else if (key.name === "return") selectModel();
      else if (key.ctrl && key.name === "r") { picker.loading = true; void loadCatalogue(true); }
      else handled = false;
    }
    else if (key.name === "f1") { if(state.modal==="help")closeModal();else {state.modal="help";view.focusFeed();} }
    else if (key.name === "f2") { if (!pending) state.mode = state.mode === "crew" ? "single" : "crew"; }
    else if (key.name === "f3") { if (state.modal === "runs") state.modal = undefined; else void history(); }
    else if (key.name === "tab") { if (view.composer.focused) view.focusFeed(); else view.focusInput(); }
    else if (key.ctrl && key.name === "n") { if (!pending) reset(); }
    else if (key.ctrl && key.name === "o") state.expanded = !state.expanded;
    else if (key.ctrl && key.name === "l") { if (view.composer.focused) view.focusFeed(); else view.focusInput(); }
    else if (key.ctrl && key.name === "u") { state.taskFile = undefined; view.setDraft(""); }
    else if (key.name === "return" && !key.meta && !key.shift) { if (state.modal === "runs") void replay(); else if (!state.modal) submit(); }
    else if (state.modal === "runs" && (key.name === "up" || key.name === "down")) state.selectedRun = Math.max(0, Math.min(state.runs.length - 1, state.selectedRun + (key.name === "up" ? -1 : 1)));
    else if (key.name === "pageup" || key.name === "pagedown" || !view.composer.focused && (key.name === "up" || key.name === "down")) view.scroll(key);
    else if (state.modal) handled = true;
    else handled = false;
    if (handled) { key.preventDefault(); key.stopPropagation(); refresh(); }
  };
  const paste = (event: {bytes:Uint8Array;preventDefault(): void; stopPropagation(): void}) => {
    if(state.modal==="login") {
      event.preventDefault();event.stopPropagation();
      if(state.login?.phase==="key"){loginSecret=(loginSecret+cleanText(new TextDecoder().decode(event.bytes)).trim()).slice(0,4096);state.login.keyLength=loginSecret.length;refresh();}
    }else if(state.modal&&state.modal!=="models"){event.preventDefault();event.stopPropagation();}
  };
  renderer.keyInput.on("keypress", keypress); renderer.keyInput.on("paste", paste);
  renderer.on("selection", selection);
  options.signal.addEventListener("abort", close, { once: true });
  renderer.on("destroy", close);
  view.setDraft(options.initialTask ?? "");
  view.composer.gotoBufferHome();
  // Preserve the source label during initial native-editor synchronization.
  state.taskFile = options.taskFile; view.focusInput(); refresh();
  const timer = setInterval(refresh, 150);
  if(options.accounts)void updateAccounts().then(()=>{if(!closing&&!disposed&&!state.modal&&!connectedProviders.has(config.lead.provider))openLogin();}).catch(()=>{state.notice="Could not read the saved account. Use /login to reconnect.";refresh();});
  if (options.signal.aborted) close();
  return {
    finished, close, get state() { return state; }, get config() { return structuredClone(config); }, view,
    destroy: () => {
      disposed = true; loginSecret=""; authController?.abort(); catalogueController?.abort(); clearInterval(timer); renderer.keyInput.off("keypress", keypress); renderer.keyInput.off("paste", paste);
      renderer.off("selection", selection);
      options.signal.removeEventListener("abort", close); renderer.off("destroy", close); view.destroy();
      return ownedClipboard?.dispose().catch(()=>{});
    },
  };
}

export async function startTui(options: TuiOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The TUI needs an interactive terminal. Use bun start run for redirected output.");
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], backgroundColor: "#282c34", screenMode: "alternate-screen", consoleMode: "disabled", openConsoleOnError: false, targetFps: 30 });
  const app = mountTui(renderer, options);
  try { await app.finished; }
  finally {
    await app.destroy(); renderer.destroy(); process.stdin.pause(); process.stdin.unref();
    if (app.state.traceDirectory) console.log(formatRunSummary({ usage: app.state.usage, traceDirectory: app.state.traceDirectory }));
  }
}
