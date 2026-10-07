import { homedir } from "node:os";
import { brandColor, pixelArt, compactPixelArt, terminalColorCells } from "./logo.ts";
import { BoxRenderable, TextRenderable, TextareaRenderable, InputRenderable, ScrollBoxRenderable, MarkdownRenderable, SyntaxStyle, StyledText, RGBA, type TextChunk, type MarkdownOptions, type CliRenderer, type KeyEvent, type Renderable } from "@opentui/core";
import { matchingModels, modelKey, roleLabel, type ModelRole } from "./models.ts";
import type { Config } from "./config.ts";
import { cleanText, fit } from "./terminal.ts";
import { helpText, type Entry, type TuiState } from "./tui-state.ts";

const colors = { bg: "#282c34", panel: "#353940", edge: "#5b626f", text: "#d8dee9", muted: "#9299a3", lead: "#82a7df", worker: "#8bc5b4", brand: brandColor, warn: "#d6ad66", error: "#e88992" };
const money = (value: { knownCostUsd: number; calls: number; unpricedCalls: number;planCalls?:number }) => {
  if(value.calls&&value.calls===(value.planCalls??0))return "ChatGPT plan";
  const amount=value.calls&&value.calls===value.unpricedCalls?"unknown":`$${value.knownCostUsd.toFixed(6)}${value.unpricedCalls-(value.planCalls??0)?" + unknown":""}`;
  return amount+(value.planCalls?" + plan":"");
};
type MarkdownToken = Parameters<NonNullable<MarkdownOptions["renderNode"]>>[0];
function inline(tokens: MarkdownToken[], attributes = 0): TextChunk[] {
  return tokens.flatMap(token => {
    const style = attributes | (token.type === "strong" ? 1 : token.type === "em" ? 2 : token.type === "link" ? 8 : 0);
    if ("tokens" in token && Array.isArray(token.tokens)) return inline(token.tokens, style);
    const value = token.type === "br" ? "\n" : "text" in token ? token.text : token.raw;
    return [{ __isChunk: true as const, text: cleanText(value), attributes: style, fg: RGBA.fromHex(token.type === "codespan" ? colors.worker : colors.text) }];
  });
}
function preview(value: string, lines: number, columns = 140): string {
  const source = cleanText(value).split("\n");
  const excerpt = source.slice(0, lines).map(line => fit(line, columns).trimEnd()).join("\n");
  return source.length > lines || source.slice(0, lines).some(line => line.length > columns) ? `${excerpt}\n… Ctrl+O to expand` : excerpt;
}
function toolBrief(entry: Entry): string {
  try {
    const args = JSON.parse(entry.detail);
    return args.path ?? args.command ?? args.objective ?? args.query ?? "Workspace inspection";
  } catch { return entry.detail; }
}

export interface ViewActions {
  submit: () => void; draft: (text: string) => void;
  models?: () => void; modelRole?: (role: ModelRole) => void;
  modelSelect?: (index: number) => void; modelSearch?: (query: string) => void;
  loginSelect?: (choice?:number) => void; suggest?: (index:number) => void;
}
interface Card { box: BoxRenderable; heading: TextRenderable; body: TextRenderable | MarkdownRenderable; detail: TextRenderable; signature: string }

export function createTuiView(renderer: CliRenderer, config: Config, cwd: string, actions: ViewActions) {
  const syntax = SyntaxStyle.fromStyles({default:{fg:colors.text},"markup.heading":{fg:colors.lead,bold:true},"markup.strong":{fg:colors.text,bold:true},"markup.raw":{fg:colors.worker},conceal:{fg:colors.muted}});
  const box = (parent: Renderable, options: ConstructorParameters<typeof BoxRenderable>[1]) => {
    const value = new BoxRenderable(renderer, options); parent.add(value); return value;
  };
  const text = (parent: BoxRenderable, content: string, options: ConstructorParameters<typeof TextRenderable>[1] = {}) => {
    const value = new TextRenderable(renderer, {content,fg:colors.text,wrapMode:"word",flexShrink:0,...options});parent.add(value);return value;
  };
  const root = box(renderer.root,{id:"bitzen",width:"100%",height:"100%",paddingX:1,flexDirection:"column",backgroundColor:colors.bg});
  const directory = cwd === homedir() ? "~" : cwd.startsWith(homedir()+"/") ? "~"+cwd.slice(homedir().length) : cwd;
  const header = box(root,{height:6,flexShrink:0,flexDirection:"row",paddingTop:1,gap:2});
  const styledLogo = (rows: readonly string[]) => new StyledText(terminalColorCells(rows).map(cell => ({
    __isChunk:true as const,text:cell.text,fg:RGBA.fromHex(cell.fg ?? colors.brand),bg:RGBA.fromHex(cell.bg ?? colors.bg),
  })));
  const fullMark = styledLogo(pixelArt), compactMark = styledLogo(compactPixelArt);
  const logo = text(header,"",{id:"brand-mark",fg:colors.brand,width:12,wrapMode:"none",selectable:false});
  logo.content=fullMark;
  const heading = box(header,{flexGrow:1,minWidth:0});
  text(heading,"Bitzen",{attributes:1});
  text(heading,cleanText(directory),{fg:colors.muted,wrapMode:"none",truncate:true});
  const badge = text(header,"",{fg:colors.muted,wrapMode:"none",truncate:true,maxWidth:"45%"});
  const feed = new ScrollBoxRenderable(renderer,{id:"chat",flexGrow:1,minHeight:1,stickyScroll:true,stickyStart:"bottom",scrollX:false,viewportCulling:true,contentOptions:{gap:1,paddingBottom:1},verticalScrollbarOptions:{trackOptions:{backgroundColor:colors.bg,foregroundColor:colors.edge}}});
  root.add(feed);
  const notice = text(root,"",{height:1,fg:colors.warn,wrapMode:"none",truncate:true,visible:false});
  const suggestionsBox = box(root,{visible:false,flexShrink:0,border:["top"],borderColor:colors.edge,backgroundColor:colors.panel,paddingX:1});
  const suggestionRows: TextRenderable[] = [];
  const composerBox = box(root,{height:4,flexShrink:0,border:["top","bottom"],borderColor:colors.edge,paddingX:1,flexDirection:"row",backgroundColor:colors.panel});
  text(composerBox,"›",{width:2,fg:colors.text});
  const composer = new TextareaRenderable(renderer,{
    id:"composer",flexGrow:1,minWidth:0,minHeight:1,initialValue:"",placeholder:"Ask Bitzen to build something…",
    wrapMode:"word",textColor:colors.text,backgroundColor:colors.panel,focusedBackgroundColor:colors.panel,cursorColor:colors.lead,
    keyBindings:[{name:"return",action:"submit"},{name:"return",meta:true,action:"newline"},{name:"return",shift:true,action:"newline"}],
    onSubmit:actions.submit,onContentChange:()=>actions.draft(composer.plainText),
    onPaste:event=>{event.preventDefault();composer.insertText(cleanText(new TextDecoder().decode(event.bytes)));},
  });
  composerBox.add(composer);
  const modelLine = box(root,{height:1,flexShrink:0,flexDirection:"row",justifyContent:"space-between",gap:2});
  const leadModel = text(modelLine,"",{fg:colors.lead,wrapMode:"none",truncate:true,flexShrink:1,onMouseDown:()=>actions.models?.()});
  const sidekickModel = text(modelLine,"",{fg:colors.worker,wrapMode:"none",truncate:true,flexShrink:1,onMouseDown:()=>actions.modelRole?.("sidekick")});
  const footer = box(root,{height:1,flexShrink:0,flexDirection:"row",justifyContent:"space-between",gap:2});
  const status = text(footer,"",{fg:colors.muted,wrapMode:"none",truncate:true,flexShrink:1});
  const hints = text(footer,"ctrl+p models · /help",{fg:colors.muted,wrapMode:"none",truncate:true,flexShrink:1});
  const pickerBox = box(root,{id:"model-picker",position:"absolute",zIndex:10,border:true,borderColor:colors.edge,backgroundColor:colors.bg,paddingX:2,visible:false});
  const pickerTitle = text(pickerBox,"Select model",{attributes:1,height:1});
  const roles = box(pickerBox,{height:1,flexShrink:0,flexDirection:"row",gap:3});
  const leadRole = text(roles,"Captain",{onMouseDown:()=>actions.modelRole?.("lead")});
  const sidekickRole = text(roles,"Crewmate",{onMouseDown:()=>actions.modelRole?.("sidekick")});
  const search = new InputRenderable(renderer,{id:"model-search",placeholder:"Search models, or enter an exact ID…",marginTop:1,maxLength:256,textColor:colors.text,backgroundColor:colors.panel,focusedBackgroundColor:colors.panel,cursorColor:colors.lead,
    onContentChange:()=>actions.modelSearch?.(search.plainText),
    onPaste:event=>{event.preventDefault();search.insertText(cleanText(new TextDecoder().decode(event.bytes)).replace(/\n/g," "));},
  });
  pickerBox.add(search);
  const modelList = box(pickerBox,{flexGrow:1,minHeight:1,marginTop:1});
  const metadata = text(pickerBox,"",{height:1,fg:colors.muted,wrapMode:"none",truncate:true});
  const pickerNotice = text(pickerBox,"",{height:1,fg:colors.warn,wrapMode:"none",truncate:true});
  const pickerHints = text(pickerBox,"↑↓ choose · enter select · tab role · esc back",{height:1,fg:colors.muted,wrapMode:"none",truncate:true});
  const modelRows: TextRenderable[] = [];
  const loginBox = box(root,{id:"login",position:"absolute",zIndex:11,border:true,borderColor:colors.edge,backgroundColor:colors.bg,paddingX:2,visible:false});
  const loginTitle = text(loginBox,"",{height:1,attributes:1});
  const loginMessage = text(loginBox,"",{fg:colors.muted,marginTop:1});
  const browserChoice = text(loginBox,"",{height:1,marginTop:1,onMouseDown:()=>actions.loginSelect?.(0)});
  const keyChoice = text(loginBox,"",{height:1,onMouseDown:()=>actions.loginSelect?.(1)});
  const password = text(loginBox,"",{height:1,marginTop:1,fg:colors.text});
  const loginUrl = text(loginBox,"",{fg:colors.lead,marginTop:1});
  const loginError = text(loginBox,"",{fg:colors.error,marginTop:1});
  const loginHint = text(loginBox,"",{height:1,marginTop:1,fg:colors.muted,wrapMode:"none",truncate:true});
  const cards = new Map<string,Card>(), ids = new WeakMap<Entry,string>();
  let serial = 0, activeState: TuiState | undefined, modal: string | undefined;
  const markdownBody = () => new MarkdownRenderable(renderer,{
    content:"",syntaxStyle:syntax,fg:colors.text,width:"100%",flexShrink:0,
    renderNode:token=>{
      if(token.type==="table")return undefined;
      let content:string|StyledText;
      if(token.type==="list"&&"items" in token) content=new StyledText(token.items.flatMap((item:{tokens:MarkdownToken[]},index:number)=>[
        {__isChunk:true as const,text:`${token.ordered?`${index+(typeof token.start==="number"?token.start:1)}.`:"•"} `,fg:RGBA.fromHex(colors.worker)},
        ...inline(item.tokens),{__isChunk:true as const,text:"\n"},
      ]));
      else if("tokens" in token && Array.isArray(token.tokens))content=new StyledText(inline(token.tokens,token.type==="heading"?1:0));
      else content=cleanText("text" in token?token.text:token.raw);
      return new TextRenderable(renderer,{content,fg:token.type==="code"?colors.worker:colors.text,wrapMode:"word",width:"100%",flexShrink:0});
    },

  });
  function clear() { for(const card of cards.values())card.box.destroyRecursively();cards.clear(); }
  function put(id:string,title:string,body:string,detail:string,color:string,markdown=false,toggle?:()=>void) {
    let card=cards.get(id);
    if(!card) {
      const panel=new BoxRenderable(renderer,{id,width:"100%",flexShrink:0,paddingX:1});feed.add(panel);
      const heading=text(panel,"",{fg:color,attributes:1,onMouseDown:()=>toggle?.()});
      const bodyRenderable=markdown?markdownBody():new TextRenderable(renderer,{content:"",fg:colors.muted,wrapMode:"word",width:"100%",flexShrink:0});
      panel.add(bodyRenderable);
      const detailRenderable=text(panel,"",{fg:colors.muted});
      card={box:panel,heading,body:bodyRenderable,detail:detailRenderable,signature:""};cards.set(id,card);
    }
    const signature=JSON.stringify([title,body,detail,color]);
    if(signature!==card.signature) {
      card.signature=signature;card.heading.content=cleanText(title);card.heading.fg=color;
      // Each body is the complete response-so-far. Incremental Markdown can
      // freeze fragments as blocks, and custom styled nodes snapshot tokens.
      // Clear the parse cache so each update renders the full current text.
      if(card.body instanceof MarkdownRenderable)card.body.content="";
      card.body.content=cleanText(body);card.body.visible=Boolean(body);
      card.detail.content=cleanText(detail);card.detail.visible=Boolean(detail);
    }
    return card.box;
  }
  function sync(state:TuiState) {
    const chatMode = state.modal === "models" || state.modal === "login" ? undefined : state.modal;
    if(activeState!==state||modal!==chatMode){clear();feed.scrollTo(0);}
    activeState=state;modal=chatMode;
    root.paddingX=renderer.width<65?0:1;
    composerBox.height=renderer.height<20?3:Math.min(6,Math.max(3,composer.virtualLineCount+2));
    const fullLogo=renderer.height>=24&&state.status==="Ready";
    logo.content=fullLogo?fullMark:compactMark;logo.width=fullLogo?12:8;
    header.paddingTop=renderer.height<20?0:1;
    header.height=renderer.height<20?3:fullLogo?6:4;
    syncPicker(state);
    syncLogin(state);
    suggestionsBox.visible=Boolean(state.suggestions.length);
    const suggestionCount=Math.min(renderer.height<24?3:5,state.suggestions.length);
    const suggestionStart=Math.max(0,Math.min(state.suggestionIndex-Math.floor(suggestionCount/2),state.suggestions.length-suggestionCount));
    for(let index=0;index<suggestionCount;index++)if(!suggestionRows[index])suggestionRows[index]=text(suggestionsBox,"",{height:1,wrapMode:"none",truncate:true,onMouseDown:()=>actions.suggest?.(suggestionOffset+index)});
    suggestionOffset=suggestionStart;
    suggestionRows.forEach((row,index)=>{
      const suggestion=state.suggestions[index+suggestionStart];row.visible=index<suggestionCount&&Boolean(suggestion);
      if(suggestion){row.content=`${index+suggestionStart===state.suggestionIndex?"›":" "} ${suggestion.value.padEnd(20)} ${suggestion.description}`;row.fg=index+suggestionStart===state.suggestionIndex?colors.text:colors.muted;}
    });
    const elapsed=state.started?((state.elapsedMs??Date.now()-state.started)/1000).toFixed(0)+"s":"";
    const busy=Object.entries(state.agents).filter(([,actor])=>!["Idle","Ready","Unused","Completed","Failed"].includes(actor.status)).map(([name,actor])=>`${roleLabel(name as ModelRole)} ${actor.status.toLowerCase()}`).join(" · ");
    badge.content=chatMode?chatMode==="runs"?"Saved runs · Esc back":"Help · Esc back":state.status==="Running"?busy||"Working…":state.status;
    badge.fg=state.status==="Failed"?colors.error:colors.muted;
    if(state.status==="Ready"&&state.accountStatus)badge.content=state.accountStatus;
    status.content=cleanText(`${state.mode} · ${money(state.usage)} · ${state.usage.calls} calls${elapsed?" · "+elapsed:""}${state.expanded?` · Captain ${money(state.usage.byAgent.lead)} · Crewmate ${money(state.usage.byAgent.sidekick)}`:""}`);
    leadModel.content=cleanText(`Captain · ${config.lead.model||"choose /model"}`);
    sidekickModel.content=cleanText(`Crewmate · ${config.sidekick.model||"choose /model"}`);
    sidekickModel.visible=state.mode==="crew";
    leadModel.maxWidth=state.mode==="crew"?"52%":"100%";
    sidekickModel.maxWidth="48%";
    hints.content=state.suggestions.length?"↑↓ select · tab complete · esc close":state.status==="Running"?"esc interrupt · ctrl+o details":"/ commands · ctrl+p models";
    notice.content=cleanText(state.notice);notice.visible=Boolean(state.notice);
    feed.stickyScroll=!chatMode;feed.stickyStart=state.entries.length&&!chatMode?"bottom":"top";
    const wanted:string[]=[];
    const add=(...args:Parameters<typeof put>)=>{wanted.push(args[0]);put(...args);};
    if(state.modal==="help")add("help","Keyboard shortcuts",helpText,`Captain: ${config.lead.model}\nCrewmate: ${config.sidekick.model}\nWorkspace: ${cwd}`,colors.muted);
    else if(state.modal==="runs") {
      if(!state.runs.length)add("runs-empty","Saved runs","No saved runs in this directory.","Escape returns to chat.",colors.muted);
      state.runs.forEach((run,index)=>add(`run-${index}`,`${index===state.selectedRun?"›":" "} ${run.mode} · ${run.status}`,run.id,`${run.cost===null?"unknown cost":"$"+run.cost.toFixed(6)} · Enter to replay`,index===state.selectedRun?colors.worker:colors.muted));
    } else if(state.entries.length) {
      for(const entry of state.entries) {
        if(entry.kind==="draft"&&!state.expanded&&!entry.expanded)continue;
        if(entry.kind==="model"&&!entry.text&&(entry.done||state.agents[entry.agent!]?.reasoning))continue;
        let id=ids.get(entry);if(!id){id=`entry-${serial++}`;ids.set(entry,id);}
        const expanded=state.expanded||entry.expanded;
        const accent=entry.failed?colors.error:entry.kind==="reasoning"?colors.muted:entry.kind==="feedback"?colors.warn:entry.agent==="sidekick"?colors.worker:entry.kind==="user"?colors.text:colors.lead;
        let title=entry.title,body=entry.text||"Thinking…";
        const tool=entry.kind==="tool";
        if(entry.kind==="command"&&!expanded)body=preview(entry.text,Math.max(3,Math.min(24,renderer.height-16)));
        if(tool) {
          const brief=toolBrief(entry);
          title=`${entry.done?entry.failed?"×":"✓":"›"} ${entry.title}  ${fit(brief,Math.max(15,renderer.width-entry.title.length-10)).trimEnd()}`;
          body=expanded?`${brief}${entry.text?"\n"+entry.text:""}`:entry.text?preview(entry.text,entry.failed?4:2):"";
        } else if(!expanded&&entry.kind==="reasoning"&&!entry.done) {
          // Follow the newest streamed thought instead of freezing the preview
          // on the first paragraph once the response grows longer.
          const recent=cleanText(entry.text).slice(-480).replace(/^[\uDC00-\uDFFF]/, "").split("\n").slice(-6).join("\n");
          body=entry.text.length>recent.length?`… ${recent}`:recent;
        } else if(!expanded&&["reasoning","user","draft"].includes(entry.kind))body=preview(entry.text,entry.kind==="draft"?2:6);
        add(id,title,body,expanded?entry.detail:"",accent,["model","draft","report"].includes(entry.kind),()=>{entry.expanded=!entry.expanded;sync(state);});
      }
    } else if(state.input.trim()&&!state.input.startsWith("/"))add("loaded","Task loaded. Press Enter to run.",state.expanded?state.input:preview(state.input,5),state.taskFile?`File: ${state.taskFile}`:"Ctrl+O to inspect the full prompt",colors.worker);

    for(const [id,card] of cards)if(!wanted.includes(id)){card.box.destroyRecursively();cards.delete(id);}
    // Entries retain stable identities when a reasoning block is inserted before
    // its streamed message. Move existing native children into timeline order.
    wanted.forEach((id,index)=>{const panel=cards.get(id)!.box;if(feed.getChildren()[index]!==panel)feed.add(panel,index);});
    if(state.modal==="runs")feed.scrollChildIntoView(`run-${state.selectedRun}`);
  }
  function syncPicker(state:TuiState) {
    const picker=state.modelPicker;
    pickerBox.visible=state.modal==="models";
    if(!pickerBox.visible||!picker)return;
    const width=Math.max(20,Math.min(90,renderer.width-4)),height=Math.max(11,Math.min(20,renderer.height-4));
    pickerBox.width=width;pickerBox.height=height;pickerBox.left=Math.max(0,Math.floor((renderer.width-width)/2)-Number(root.paddingX||0));pickerBox.top=Math.max(0,Math.floor((renderer.height-height)/2));
    const matches=matchingModels(picker),current=modelKey(config[picker.role]);
    pickerTitle.content=`Select ${roleLabel(picker.role).toLowerCase()} model`;
    leadRole.fg=picker.role==="lead"?colors.lead:colors.muted;leadRole.attributes=picker.role==="lead"?1:0;
    sidekickRole.fg=picker.role==="sidekick"?colors.worker:colors.muted;sidekickRole.attributes=picker.role==="sidekick"?1:0;
    const count=Math.max(1,height-10),start=Math.max(0,Math.min(picker.index-Math.floor(count/2),matches.length-count));
    for(let row=0;row<count;row++) {
      if(!modelRows[row])modelRows[row]=text(modelList,"",{height:1,wrapMode:"none",truncate:true,onMouseDown:()=>actions.modelSelect?.(startIndex+row)});
    }
    startIndex=start;
    modelRows.forEach((row,index)=>{
      const choice=matches[start+index];row.visible=index<count&&Boolean(choice);
      if(!choice)return;
      const selected=start+index===picker.index;
      row.content=cleanText(`${selected?"›":" "} ${modelKey(choice)===current?"✓":" "} ${choice.id} · ${choice.provider}`);
      row.fg=selected?colors.text:colors.muted;row.bg=selected?colors.panel:colors.bg;
    });
    const selected=matches[picker.index];
    const price=(value:number|undefined)=>value===undefined?"?":`$${Number(value.toPrecision(4))}`;
    metadata.content=selected?cleanText([selected.name,selected.contextLength?`${Math.round(selected.contextLength/1000)}k context`:"",selected.inputUsdPerMillion!==undefined||selected.outputUsdPerMillion!==undefined?`${price(selected.inputUsdPerMillion)} in / ${price(selected.outputUsdPerMillion)} out per 1M tokens`:""].filter(Boolean).join(" · ")):"Enter an exact model ID to use it.";
    pickerNotice.content=picker.loading?"Loading catalogue…":picker.error||`${matches.length} models · ✓ current · ctrl+r refresh`;
    pickerHints.content=width<65?"↑↓ choose · enter · tab role · esc":"↑↓ choose · enter select · tab role · esc back";
  }
  function syncLogin(state:TuiState) {
    const login=state.login;loginBox.visible=state.modal==="login";
    if(!loginBox.visible||!login)return;
    const width=Math.max(20,Math.min(88,renderer.width-4)),height=Math.max(12,Math.min(19,renderer.height-2));
    loginBox.width=width;loginBox.height=height;loginBox.left=Math.max(0,Math.floor((renderer.width-width)/2)-Number(root.paddingX||0));loginBox.top=Math.max(0,Math.floor((renderer.height-height)/2));
    loginTitle.content=`Connect ${login.label}`;loginMessage.content=login.message;
    const choosing=login.phase==="choose";
    browserChoice.visible=choosing&&login.browserAvailable;keyChoice.visible=choosing&&login.keyAvailable;
    browserChoice.content=`${login.choice===0?"›":" "} ${login.browserLabel}`;
    keyChoice.content=`${login.choice===1?"›":" "} Paste an API key`;
    browserChoice.fg=login.choice===0?colors.text:colors.muted;keyChoice.fg=login.choice===1?colors.text:colors.muted;
    password.visible=login.phase==="key";password.content=login.keyLength?"•".repeat(Math.min(40,login.keyLength)):"› Paste your key here…";
    loginUrl.visible=Boolean(login.url)&&login.phase==="browser";loginUrl.content=login.url;
    loginError.visible=Boolean(login.error);loginError.content=login.error;
    loginHint.content=choosing?`${login.providers.length>1?"←→ provider · ":""}${login.keyAvailable?"↑↓ method · ":""}enter connect · esc back`:login.phase==="key"?"enter connect · ctrl+u clear · esc back":"esc cancel · return here after browser sign-in";
  }
  let suggestionOffset=0;
  let startIndex=0;
  function focusInput(){composer.focus();composerBox.borderColor=colors.edge;}
  function focusFeed(){feed.focus();composerBox.borderColor=colors.edge;}
  function setDraft(value:string){composer.setText(cleanText(value));composer.gotoBufferEnd();}
  function scroll(key:KeyEvent){const amount=key.name==="pageup"||key.name==="pagedown"?Math.max(1,feed.height-2):3;feed.scrollBy(key.name==="up"||key.name==="pageup"?-amount:amount);}
  const resize=()=>{if(activeState)sync(activeState);};renderer.on("resize",resize);
  return {sync,composer,feed,search,focusSearch:()=>search.focus(),setSearch:(value:string)=>{search.value=cleanText(value);search.gotoBufferEnd();},focusInput,focusFeed,setDraft,scroll,destroy:()=>{renderer.off("resize",resize);clear();root.destroyRecursively();syntax.destroy();}};
}
