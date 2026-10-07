import { expect, test } from "bun:test";
import type { ClipboardService } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { mountTui, TuiState } from "../src/tui.ts";
import { createTuiView } from "../src/tui-view.ts";
import { cleanText } from "../src/terminal.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { completion, provider } from "./helpers.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoProvider, demoSource, demoTests } from "../src/demo.ts";
import { ProfileStore } from "../src/profile.ts";
import { AccountManager } from "../src/login.ts";
import { pixelPalette } from "../src/logo.ts";

const config = { lead:{provider:"test",model:"lead"}, sidekick:{provider:"test",model:"worker"}, maxCalls:10, maxTurns:10, maxOutputTokens:1000 };

test("mouse selection copies rendered chat; copy shortcuts preserve the draft and Ctrl+C still exits without selection", async () => {
  const setup=await createTestRenderer({exitOnCtrlC:false,width:100,height:32,kittyKeyboard:true});
  const copied:string[]=[];
  const clipboard:Pick<ClipboardService,"writeText">={writeText:async text=>{copied.push(text);return {host:{status:"written"},terminal:{status:"not-attempted",capability:"unknown"}};}};
  let calls=0,exited=false;
  const app=mountTui(setup.renderer,{cwd:"/tmp",config,mode:"crew",allowShell:false,signal:new AbortController().signal,initialTask:"Keep my draft",clipboard,providers:new ProviderRegistry().register(provider(async()=>{calls++;return completion("Done");}))});
  void app.finished.then(()=>{exited=true;});
  try {
    app.state.receive({type:"run_end",status:"completed",report:"Copy this café text.\n\nAnother paragraph.",elapsedMs:1});
    app.view.sync(app.state);await setup.flush();
    const rows=setup.captureCharFrame().split("\n"),y=rows.findIndex(row=>row.includes("Copy this café text.")),x=rows[y]!.indexOf("Copy this café text.");
    expect(y).toBeGreaterThan(0);
    await setup.mockMouse.pressDown(x,y);
    await setup.mockMouse.moveTo(x+19,y);
    expect(copied).toHaveLength(0);
    await setup.mockMouse.release(x+19,y);
    await setup.waitFor(()=>copied.length===1);await setup.flush();
    expect(copied[0]).toBe("Copy this café text.");
    expect(app.state.notice).toBe("Copied selection.");
    for (const modifiers of [{super:true},{meta:true},{ctrl:true,shift:true},{ctrl:true}]) {
      setup.mockInput.pressKey("c",modifiers);
      await setup.waitFor(()=>copied.length===2);copied.pop();
      expect(app.view.composer.plainText).toBe("Keep my draft");
      expect(exited).toBe(false);expect(calls).toBe(0);
    }
    setup.renderer.clearSelection();
    for (const modifiers of [{super:true},{meta:true},{ctrl:true,shift:true}])setup.mockInput.pressKey("c",modifiers);
    await setup.flush();expect(copied).toHaveLength(1);expect(exited).toBe(false);
    expect(app.view.composer.plainText).toBe("Keep my draft");
    setup.mockInput.pressCtrlC();await app.finished;expect(exited).toBe(true);
  } finally {app.destroy();setup.renderer.destroy();}
});

test("clipboard failure keeps the TUI usable and disposed controllers stop copying",async()=>{
  const setup=await createTestRenderer({exitOnCtrlC:false,width:100,height:32,kittyKeyboard:true});
  let attempts=0;
  const clipboard:Pick<ClipboardService,"writeText">={writeText:async()=>{attempts++;throw new Error("Clipboard unavailable");}};
  const app=mountTui(setup.renderer,{cwd:"/tmp",config,mode:"crew",allowShell:false,signal:new AbortController().signal,initialTask:"draft",clipboard,providers:new ProviderRegistry().register(provider(async()=>completion("Done")))});
  try {
    await setup.flush();
    app.view.composer.selectAll();setup.mockInput.pressKey("c",{super:true});
    await setup.waitFor(()=>app.state.notice.includes("Could not copy"));
    expect(attempts).toBe(1);expect(app.view.composer.plainText).toBe("draft");
    app.destroy();
    setup.mockInput.pressKey("c",{super:true});await setup.flush();expect(attempts).toBe(1);
  } finally {app.destroy();setup.renderer.destroy();}
});

test("OpenTUI displays a loaded task, adapts to a narrow terminal, and exits cleanly", async () => {
  const setup = await createTestRenderer({exitOnCtrlC:false,width:120,height:36});
  const task = "Repair the job queue.\n\nPreserve the tests.\n" + "More requirements.\n".repeat(30);
  let calls = 0;
  const app = mountTui(setup.renderer, { cwd:"/tmp",config,mode:"crew",allowShell:false,signal:new AbortController().signal,initialTask:task,taskFile:"/tmp/TASK.md",providers:new ProviderRegistry().register(provider(async () => {calls++; return completion("Done");})) });
  try {
    await setup.flush();
    const screen = setup.captureCharFrame();
    expect(screen).toContain("Task loaded. Press Enter to run.");
    expect(screen).toContain("▄██▀▀██▄");
    const renderedColours = new Set(setup.captureSpans().lines.slice(1,6).flatMap(line => line.spans.flatMap(span => [span.fg,span.bg].map(colour => colour.toInts().slice(0,3).join(",")))));
    for (const colour of Object.values(pixelPalette)) expect(renderedColours.has([1,3,5].map(offset => parseInt(colour.slice(offset,offset+2),16)).join(","))).toBe(true);
    expect(screen).toContain("File: /tmp/TASK.md");
    expect(screen).toContain("Repair the job queue.");
    expect(screen).not.toContain("SESSION");
    expect(screen).not.toContain("Activity");
    expect(calls).toBe(0);
    setup.resize(80,24); await setup.flush();
    expect(setup.captureCharFrame()).toContain("Task loaded. Press Enter to run.");
    expect(setup.captureCharFrame()).not.toContain("SESSION");
    setup.mockInput.pressKey("u", {ctrl:true});
    await setup.flush(); expect(app.view.composer.plainText).toBe("");
    await setup.mockInput.pasteBracketedText("line one\nline two");
    await setup.flush(); expect(app.view.composer.plainText).toBe("line one\nline two");
    expect(app.state.input).toBe("line one\nline two"); expect(calls).toBe(0);
    setup.mockInput.pressKey("F2"); await setup.flush(); expect(app.state.mode).toBe("single");
    setup.mockInput.pressTab(); await setup.flush(); expect(app.view.feed.focused).toBe(true);
    expect(app.state.modal).toBeUndefined();
    setup.mockInput.pressKey("F1"); await setup.flush();
    expect(setup.captureCharFrame()).toContain("Keyboard shortcuts");
    setup.mockInput.pressEscape(); await Bun.sleep(80); await setup.flush(); expect(app.state.modal).toBeUndefined();
    setup.mockInput.pressCtrlC(); await app.finished;
  } finally { app.destroy(); setup.renderer.destroy(); }
});

test("OpenTUI streams reasoning and collapses long tool results until expanded", async () => {
  const setup = await createTestRenderer({exitOnCtrlC:false,width:120,height:40});
  const state = new TuiState();
  const view = createTuiView(setup.renderer, config, "/tmp", {submit:()=>{},draft:()=>{}});
  try {
    state.receive({type:"model_start",agent:"sidekick",selection:{model:"worker"}});
    view.sync(state); await setup.flush();
    state.receive({type:"model_delta",agent:"sidekick",kind:"reasoning",text:"Check retry boundaries."});
    view.sync(state); await setup.flush();
    expect(setup.captureCharFrame()).toContain("Check retry boundaries.");
    state.receive({type:"model_delta",agent:"sidekick",kind:"reasoning",text:"\nEarlier analysis.".repeat(50)+"\nLATEST IDEA"});
    view.sync(state); await setup.flush();
    expect(setup.captureCharFrame()).toContain("LATEST IDEA");
    state.receive({type:"model_end",agent:"sidekick",message:{...completion("**Fixed** the queue.").message,providerState:{openrouter:{reasoning_details:[{type:"reasoning.encrypted",data:"opaque-secret"}]}}},usage:completion("Fixed").usage,elapsedMs:10});
    view.sync(state); await setup.flush();
    expect(setup.captureCharFrame()).toContain("Check retry boundaries.");
    expect(setup.captureCharFrame()).not.toContain("opaque-secret");
    expect(state.usage.byAgent.sidekick.knownCostUsd).toBe(0.01);
    view.sync(state); await setup.flush();
    expect(setup.captureCharFrame()).toContain("Fixed the queue.");
    state.receive({type:"tool_start",agent:"sidekick",call:{id:"read",name:"read_file",arguments:'{"path":"src/queue.ts"}'}});
    state.receive({type:"tool_end",agent:"sidekick",callId:"read",result:"line\n".repeat(10)+"FINAL OUTPUT LINE"});
    view.sync(state); await setup.flush();
    expect(setup.captureCharFrame()).toContain("src/queue.ts");
    expect(setup.captureCharFrame()).toContain("Check retry boundaries.");
    expect(setup.captureCharFrame()).toContain("Fixed the queue.");
    const screen=setup.captureCharFrame();
    expect(screen.indexOf("Check retry boundaries.")).toBeLessThan(screen.indexOf("Fixed the queue."));
    expect(screen.indexOf("Fixed the queue.")).toBeLessThan(screen.indexOf("read_file"));
    expect(setup.captureCharFrame()).toContain("Ctrl+O to expand");
    expect(setup.captureCharFrame()).not.toContain("FINAL OUTPUT LINE");
    const heading=view.feed.getChildren().at(-1)!.getChildren()[0]!;
    await setup.mockMouse.click(heading.screenX+2,heading.screenY);
    await setup.flush();
    expect(state.entries.at(-1)?.expanded).toBe(true);
    expect(setup.captureCharFrame()).toContain("FINAL OUTPUT LINE");
    await setup.mockMouse.click(heading.screenX+2,heading.screenY);
    await setup.flush();
    expect(setup.captureCharFrame()).not.toContain("FINAL OUTPUT LINE");
    state.expanded=true; view.sync(state); await setup.flush();
    expect(setup.captureCharFrame()).toContain("FINAL OUTPUT LINE");
  } finally {view.destroy(); setup.renderer.destroy();}
});

test("delegation handoff follows sidekick messages and final report is not duplicated",()=>{
  const state=new TuiState();
  state.receive({type:"run_start",task:"Implement",mode:"crew"});
  state.receive({type:"tool_start",agent:"lead",call:{id:"shared-id",name:"delegate",arguments:'{"objective":"Implement"}'}});
  state.receive({type:"tool_start",agent:"sidekick",call:{id:"shared-id",name:"read_file",arguments:'{"path":"a.ts"}'}});
  state.receive({type:"tool_end",agent:"sidekick",callId:"shared-id",result:"file contents"});
  state.receive({type:"model_start",agent:"sidekick",selection:{model:"worker"}});
  state.receive({type:"model_end",agent:"sidekick",message:completion("Implemented").message,usage:completion("Implemented").usage,elapsedMs:10});
  state.receive({type:"tool_end",agent:"lead",callId:"shared-id",result:"Implemented"});
  expect(state.entries.at(-1)?.text).toBe("Received crewmate result; reviewing.");
  expect(state.entries.find(entry=>entry.agent==="sidekick"&&entry.kind==="tool")?.text).toBe("file contents");
  state.receive({type:"model_start",agent:"lead",selection:{model:"lead"}});
  state.receive({type:"model_end",agent:"lead",message:completion(" Reviewed\n").message,usage:completion("Reviewed").usage,elapsedMs:10});
  state.receive({type:"run_end",status:"completed",report:"Reviewed",elapsedMs:20});
  expect(state.entries.filter(entry=>entry.text.trim()==="Reviewed")).toHaveLength(1);
});

test("streamed Markdown stays in paragraphs and lists, finalizes, and reflows on terminal resize",async()=>{
  const setup=await createTestRenderer({exitOnCtrlC:false,width:180,height:40});
  const state=new TuiState(),view=createTuiView(setup.renderer,config,"/tmp",{submit:()=>{},draft:()=>{}});
  const report="### Verification and limitations\n\nNo repository files or existing tests were changed.\n\n- No regression tests were added because there was no code implementation to change.\n- Shell execution is disabled, so installation and runtime verification remain unperformed. Bun, `rg`, and platform-compatible TUI dependencies are still required.\n\n```sh\nbun start tui\nbun start run --cwd /tmp/task\necho 'all lines present'\n```";
  try {
    state.receive({type:"model_start",agent:"lead"});view.sync(state);await setup.renderOnce();
    // Render between small fragments, as an actual provider stream does. A
    // single full-content render hides incremental Markdown parser failures.
    for(const fragment of report.match(/[A-Za-z]+|[^A-Za-z]/g)!) {
      state.receive({type:"model_delta",agent:"lead",kind:"text",text:fragment});
      view.sync(state);await setup.renderOnce();
    }
    await setup.flush();
    const before=setup.captureCharFrame();
    expect(before).toContain("Verification and limitations");
    expect(before).toContain("No repository files or existing tests were changed.");
    expect(before).toContain("No regression tests were added because there was no code implementation to change.");
    expect(before).toContain("Bun, rg, and platform-compatible TUI dependencies are still required.");
    expect(before).toContain("bun start run --cwd /tmp/task");expect(before).toContain("echo 'all lines present'");
    const markdown=view.feed.getChildren()[0]!.getChildren()[1] as import("@opentui/core").MarkdownRenderable;
    expect(markdown.height).toBeLessThan(15);
    state.receive({type:"model_end",agent:"lead",message:completion(report).message,usage:completion(report).usage,elapsedMs:10});
    view.sync(state);await setup.flush();
    expect(setup.captureCharFrame()).toContain("bun start tui");
    expect(setup.captureCharFrame()).toContain("bun start run --cwd /tmp/task");
    setup.resize(64,40);view.sync(state);await setup.flush();
    expect(markdown.height).toBeGreaterThan(8);expect(markdown.height).toBeLessThan(25);
    expect(setup.captureCharFrame()).toContain("No repository files or existing tests were changed.");
    setup.resize(180,40);view.sync(state);await setup.flush();
    expect(setup.captureCharFrame()).toContain("No regression tests were added because there was no code implementation to change.");
    expect(markdown.height).toBeLessThan(15);
    // A terminal response can supply a suffix absent from the final delta.
    // Render the complete final text, including a suffix that wasn't streamed.
    state.receive({type:"model_start",agent:"lead"});
    state.receive({type:"model_delta",agent:"lead",kind:"text",text:"This reply has a "});
    view.sync(state);await setup.renderOnce();
    state.receive({type:"model_end",agent:"lead",message:completion("This reply has a complete sentence.").message,usage:completion("").usage,elapsedMs:10});
    view.sync(state);await setup.flush();
    expect(setup.captureCharFrame()).toContain("This reply has a complete sentence.");
  }finally{view.destroy();setup.renderer.destroy();}
});

test("the native TUI submits a task, completes both agents, and replays its saved trace", async () => {
  const root = await mkdtemp(join(tmpdir(), "bitzen-tui-test-"));
  await Bun.write(join(root,"add.ts"),demoSource); await Bun.write(join(root,"add.test.ts"),demoTests);
  const setup = await createTestRenderer({exitOnCtrlC:false,width:120,height:40});
  const demoConfig = {...config, lead:{provider:"demo",model:"lead"},sidekick:{provider:"demo",model:"sidekick"}};
  const app = mountTui(setup.renderer,{cwd:root,config:demoConfig,mode:"crew",allowShell:true,signal:new AbortController().signal,initialTask:"Fix add() and run bun test.",providers:new ProviderRegistry().register(new DemoProvider())});
  try {
    setup.mockInput.pressEnter();
    await setup.waitFor(()=>app.state.status==="Completed" || app.state.status==="Failed", {maxPasses:10000});
    expect(app.state.status).toBe("Completed");
    await setup.flush();
    expect(await Bun.file(join(root,"add.ts")).text()).toContain("a + b");
    expect(app.state.usage.calls).toBe(9);
    expect(app.state.usage.byAgent.lead.calls).toBe(5);
    expect(app.state.usage.byAgent.sidekick.calls).toBe(4);
    expect(setup.captureCharFrame()).toContain("independently reran");
    expect(setup.captureCharFrame()).toContain("bun test successfully.");
    setup.mockInput.pressKey("F3"); await setup.waitFor(()=>app.state.runs.length===1, {maxPasses:10000});
    setup.mockInput.pressEnter(); await setup.waitFor(()=>app.state.notice.includes("Saved run replay"), {maxPasses:10000});
    expect(app.state.status).toBe("Completed"); expect(app.state.usage.calls).toBe(9);
    setup.mockInput.pressCtrlC(); await app.finished;
  } finally { app.close(); await app.finished; app.destroy(); setup.renderer.destroy(); await rm(root,{recursive:true,force:true}); }
});

test("terminal content cannot inject escape sequences", () => {
  expect(cleanText("\x1b[2Jhello\x1b]0;evil\x07world")).toBe("helloworld");
});

test("Ctrl+C waits for cancellation and preserves unknown upstream cost", async () => {
  const root = await mkdtemp(join(tmpdir(), "bitzen-tui-cancel-"));
  const setup = await createTestRenderer({exitOnCtrlC:false,width:100,height:30});
  let started = false;
  const adapter = provider(request => new Promise((_resolve, reject) => {
    started = true;
    request.signal.addEventListener("abort",()=>reject(request.signal.reason),{once:true});
  }));
  const app = mountTui(setup.renderer,{cwd:root,config,mode:"single",allowShell:false,signal:new AbortController().signal,initialTask:"Investigate",providers:new ProviderRegistry().register(adapter)});
  try {
    setup.mockInput.pressEnter(); await setup.waitFor(()=>started,{maxPasses:10000});
    setup.mockInput.pressKey("p",{ctrl:true}); await setup.flush();
    expect(app.state.modal).toBeUndefined();
    expect(app.state.notice).toContain("Finish or cancel");
    expect(app.config.lead.model).toBe("lead");
    setup.mockInput.pressCtrlC(); await app.finished;
    expect(app.state.status).toBe("Failed");
    expect(app.state.usage.calls).toBe(1); expect(app.state.usage.unpricedCalls).toBe(1);
    expect(app.state.traceDirectory).toContain(".bitzen/runs");
  } finally {app.close(); await app.finished; app.destroy(); setup.renderer.destroy(); await rm(root,{recursive:true,force:true});}
});

test("model picker searches, switches both agents, preserves loaded drafts, and applies choices to the next run",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bitzen-model-picker-"));
  const setup=await createTestRenderer({exitOnCtrlC:false,width:120,height:36});
  const called:string[]=[];
  let leadCalls=0;
  const adapter={...provider(async request=>{
    called.push(request.model);
    if(request.model==="vendor/worker")return completion("Worker completed.");
    leadCalls++;
    return leadCalls===1?completion(null,"delegate",{objective:"Investigate",constraints:[],acceptance_criteria:["Report findings"]}):completion("Reviewed and completed.");
  }),listModels:async()=>[
    {id:"vendor/brain",name:"Large Reasoner",contextLength:200000,inputUsdPerMillion:2,outputUsdPerMillion:10},
    {id:"vendor/worker",name:"Small Worker"},
  ]};
  const task="Investigate this workspace.";
  const app=mountTui(setup.renderer,{cwd:root,config,mode:"crew",allowShell:false,signal:new AbortController().signal,initialTask:task,taskFile:"/tmp/TASK.md",providers:new ProviderRegistry().register(adapter)});
  try{
    setup.mockInput.pressKey("p",{ctrl:true});
    await setup.waitFor(()=>app.state.modelPicker?.loading===false);
    expect(app.view.search.focused).toBe(true);
    setup.mockInput.pressArrow("down"); await setup.flush(); expect(app.state.modelPicker?.index).toBe(1);
    setup.mockInput.pressArrow("up"); await setup.flush(); expect(app.state.modelPicker?.index).toBe(0);
    await setup.mockInput.typeText("reasoner");await setup.flush();
    expect(setup.captureCharFrame()).toContain("vendor/brain");
    expect(setup.captureCharFrame()).toContain("$2 in / $10 out per 1M tokens");
    setup.mockInput.pressEscape();await Bun.sleep(80);await setup.flush();
    expect(app.view.composer.plainText).toBe(task);expect(app.state.taskFile).toBe("/tmp/TASK.md");
    expect(app.config.lead.model).toBe("lead");
    setup.mockInput.pressKey("p",{ctrl:true});await setup.flush();
    await setup.mockInput.typeText("reasoner");setup.mockInput.pressEnter();await setup.flush();
    expect(app.config.lead.model).toBe("vendor/brain");expect(config.lead.model).toBe("lead");
    expect(app.view.composer.plainText).toBe(task);expect(app.state.taskFile).toBe("/tmp/TASK.md");
    expect(setup.captureCharFrame()).toContain("Captain · vendor/brain");
    setup.mockInput.pressKey("p",{ctrl:true});setup.mockInput.pressTab();await setup.flush();
    await setup.mockInput.typeText("small");setup.mockInput.pressEnter();await setup.flush();
    expect(app.config.sidekick.model).toBe("vendor/worker");
    expect(app.config.lead.model).toBe("vendor/brain");
    expect(setup.captureCharFrame()).toContain("Crewmate · vendor/worker");
    setup.resize(60,18);await setup.flush();
    setup.mockInput.pressKey("p",{ctrl:true});await setup.flush();
    expect(setup.captureCharFrame()).toContain("Select captain model");
    expect(setup.captureCharFrame()).not.toContain("▗▄▖");
    expect(setup.captureCharFrame()).toContain("vendor/brain");
    setup.mockInput.pressKey("p",{ctrl:true});setup.mockInput.pressEnter();
    await setup.waitFor(()=>app.state.status==="Completed"||app.state.status==="Failed",{maxPasses:10000});
    expect(app.state.status).toBe("Completed");
    expect(called).toEqual(["vendor/brain","vendor/worker","vendor/brain"]);
    expect(app.view.composer.focused).toBe(true);
  }finally{app.close();await app.finished;app.destroy();setup.renderer.destroy();await rm(root,{recursive:true,force:true});}
});

test("catalogue failure still permits manual model IDs and slash commands do not run inference",async()=>{
  const setup=await createTestRenderer({exitOnCtrlC:false,width:80,height:24});
  let calls=0;
  const adapter={...provider(async()=>{calls++;return completion("Done");}),listModels:async()=>{throw new Error("Offline");}};
  const app=mountTui(setup.renderer,{cwd:"/tmp",config,mode:"single",allowShell:false,signal:new AbortController().signal,providers:new ProviderRegistry().register(adapter)});
  try{
    await setup.mockInput.typeText("/model crewmate");setup.mockInput.pressEnter();
    await setup.waitFor(()=>app.state.modelPicker?.loading===false);
    expect(app.state.modelPicker?.role).toBe("sidekick");
    expect(setup.captureCharFrame()).toContain("Catalogue unavailable");
    await setup.mockInput.typeText("custom/model");setup.mockInput.pressEnter();await setup.flush();
    expect(app.config.sidekick.model).toBe("custom/model");expect(app.state.modal).toBeUndefined();
    await setup.mockInput.typeText("/model captain newer/model");setup.mockInput.pressEnter();await setup.flush();
    expect(app.config.lead.model).toBe("newer/model");expect(calls).toBe(0);
    await setup.mockInput.typeText("/help");setup.mockInput.pressEnter();await setup.flush();
    expect(setup.captureCharFrame()).toContain("Keyboard shortcuts");expect(calls).toBe(0);
  }finally{app.close();await app.finished;app.destroy();setup.renderer.destroy();}
});

test("providers without a catalogue keep configured choices and permit exact ID entry",async()=>{
  const setup=await createTestRenderer({exitOnCtrlC:false,width:80,height:24});
  let calls=0;
  const app=mountTui(setup.renderer,{cwd:"/tmp",config,mode:"single",allowShell:false,signal:new AbortController().signal,providers:new ProviderRegistry().register(provider(async()=>{calls++;return completion("Done");}))});
  try{
    setup.mockInput.pressKey("p",{ctrl:true});await setup.waitFor(()=>app.state.modelPicker?.loading===false);await setup.flush();
    expect(app.state.modelPicker?.choices.map(choice=>choice.id)).toEqual(["lead","worker"]);
    expect(app.state.modelPicker?.error).toBe("");
    await setup.mockInput.typeText("custom-model");setup.mockInput.pressEnter();await setup.flush();
    expect(app.config.lead.model).toBe("custom-model");expect(calls).toBe(0);
  }finally{app.close();await app.finished;app.destroy();setup.renderer.destroy();}
});

test("slash suggestions complete commands and arguments, and /help permits the next task",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bitzen-command-test-"));
  const setup=await createTestRenderer({exitOnCtrlC:false,width:100,height:32});let calls=0;
  const app=mountTui(setup.renderer,{cwd:root,config,mode:"single",allowShell:false,signal:new AbortController().signal,providers:new ProviderRegistry().register(provider(async()=>{calls++;return completion("Done");}))});
  try{
    for(const letter of "/help")setup.mockInput.pressKey(letter);
    setup.mockInput.pressEnter();await setup.flush();expect(app.state.entries.at(-1)?.title).toBe("Keyboard shortcuts");
    await setup.mockInput.typeText("/hel");await setup.flush();expect(setup.captureCharFrame()).toContain("/help");
    setup.mockInput.pressTab();await setup.flush();expect(app.state.input).toBe("/help ");
    setup.mockInput.pressEnter();await setup.flush();expect(app.state.modal).toBeUndefined();expect(app.view.composer.focused).toBe(true);
    await setup.mockInput.typeText("Explain this workspace.");expect(app.state.input).toBe("Explain this workspace.");
    setup.mockInput.pressEnter();await setup.waitFor(()=>app.state.status==="Completed",{maxPasses:10000});expect(calls).toBe(1);
    await setup.mockInput.typeText("/mode ");await setup.flush();expect(app.state.suggestions.map(item=>item.value)).toEqual(["/mode crew","/mode single"]);
    setup.mockInput.pressArrow("down");setup.mockInput.pressTab();await setup.flush();expect(app.state.input).toBe("/mode single ");
    setup.mockInput.pressEnter();expect(app.state.mode).toBe("single");expect(calls).toBe(1);
    await setup.mockInput.typeText("/does-not-exist");setup.mockInput.pressEnter();expect(app.state.notice).toContain("Unknown command");expect(calls).toBe(1);
  }finally{app.close();await app.finished;app.destroy();setup.renderer.destroy();await rm(root,{recursive:true,force:true});}
});

test("TUI onboarding masks keys, preserves task files, persists model choices, and logs out",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bitzen-tui-login-"));
  const setup=await createTestRenderer({exitOnCtrlC:false,width:100,height:32});
  const store=new ProfileStore(join(root,"profile"));let keySeen="";
  const accounts=new AccountManager(store).register({id:"test",label:"Test",validateKey:async key=>{keySeen=key;}});
  const emptyConfig={...config,lead:{provider:"test",model:""},sidekick:{provider:"test",model:""}};
  const adapter={...provider(async()=>completion("Done")),listModels:async()=>[{id:"captain-model",name:"Captain Model"},{id:"crewmate-model",name:"Crewmate Model"}]};
  const task="Keep this loaded task.";
  const app=mountTui(setup.renderer,{cwd:root,config:emptyConfig,mode:"crew",accounts,allowShell:false,signal:new AbortController().signal,initialTask:task,taskFile:"/tmp/TASK.md",providers:new ProviderRegistry().register(adapter)});
  try{
    await setup.waitFor(()=>app.state.modal==="login",{maxPasses:10000});
    setup.mockInput.pressTab();setup.mockInput.pressEnter();expect(app.state.login?.phase).toBe("key");
    await setup.mockInput.pasteBracketedText("private-secret-key");await setup.flush();
    expect(setup.captureCharFrame()).toContain("••••");expect(setup.captureCharFrame()).not.toContain("private-secret-key");
    expect(JSON.stringify(app.state)).not.toContain("private-secret-key");expect(app.view.composer.plainText).toBe(task);
    setup.mockInput.pressEnter();await setup.waitFor(()=>app.state.modal==="models"&&app.state.modelPicker?.loading===false,{maxPasses:10000});
    expect(keySeen).toBe("private-secret-key");expect(app.state.taskFile).toBe("/tmp/TASK.md");
    await setup.mockInput.typeText("captain-model");setup.mockInput.pressEnter();
    await setup.waitFor(()=>app.state.modelPicker?.role==="sidekick",{maxPasses:10000});
    await setup.mockInput.typeText("crewmate-model");setup.mockInput.pressEnter();
    await setup.waitFor(()=>app.state.modal===undefined,{maxPasses:10000});
    expect((await store.selections()).sidekick?.model).toBe("crewmate-model");expect(app.view.composer.plainText).toBe(task);
    setup.mockInput.pressKey("u",{ctrl:true});await setup.mockInput.typeText("/logout test");setup.mockInput.pressEnter();
    await setup.waitFor(()=>app.state.notice.includes("Disconnected"),{maxPasses:10000});expect(await accounts.connected("test")).toBe(false);
    expect(app.state.accountStatus).toContain("Not connected");
  }finally{app.close();await app.finished;app.destroy();setup.renderer.destroy();await rm(root,{recursive:true,force:true});}
});

test("login cancellation clears secret input and preserves the draft without running a task",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bitzen-tui-login-cancel-"));
  const setup=await createTestRenderer({exitOnCtrlC:false,width:80,height:24});
  const store=new ProfileStore(join(root,"profile"));let calls=0;
  const accounts=new AccountManager(store).register({id:"test",label:"Test",validateKey:async()=>{throw Error("No request expected");}});
  const app=mountTui(setup.renderer,{cwd:root,config,mode:"single",accounts,allowShell:false,signal:new AbortController().signal,initialTask:"Draft",providers:new ProviderRegistry().register(provider(async()=>{calls++;return completion("Done");}))});
  try{
    await setup.waitFor(()=>app.state.modal==="login",{maxPasses:10000});setup.mockInput.pressTab();setup.mockInput.pressEnter();
    await setup.mockInput.typeText("secret");setup.mockInput.pressEscape();await Bun.sleep(80);await setup.flush();
    expect(app.state.modal).toBeUndefined();expect(app.state.login?.keyLength).toBe(0);expect(app.view.composer.plainText).toBe("Draft");expect(calls).toBe(0);
    expect(await accounts.connected("test")).toBe(false);
  }finally{app.close();await app.finished;app.destroy();setup.renderer.destroy();await rm(root,{recursive:true,force:true});}
});

test("commands stay usable during a task while model and mode changes are blocked",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bitzen-active-commands-"));
  const setup=await createTestRenderer({exitOnCtrlC:false,width:100,height:32});let started=false;
  const adapter=provider(request=>new Promise((_resolve,reject)=>{started=true;request.signal.addEventListener("abort",()=>reject(request.signal.reason),{once:true});}));
  const app=mountTui(setup.renderer,{cwd:root,config,mode:"single",allowShell:false,signal:new AbortController().signal,initialTask:"Wait",providers:new ProviderRegistry().register(adapter)});
  try{
    setup.mockInput.pressEnter();await setup.waitFor(()=>started,{maxPasses:10000});
    await setup.mockInput.typeText("/mode crew");setup.mockInput.pressEnter();expect(app.state.mode).toBe("single");expect(app.state.notice).toContain("Finish or cancel");
    setup.mockInput.pressKey("u",{ctrl:true});await setup.mockInput.typeText("/cost");setup.mockInput.pressEnter();expect(app.state.entries.at(-1)?.title).toBe("Task cost");
    await setup.mockInput.typeText("/cancel");setup.mockInput.pressEnter();await setup.waitFor(()=>app.state.status==="Failed",{maxPasses:10000});
    expect(app.state.usage.calls).toBe(1);expect(app.state.usage.unpricedCalls).toBe(1);
  }finally{app.close();await app.finished;app.destroy();setup.renderer.destroy();await rm(root,{recursive:true,force:true});}
});
