import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRun, savedRuns } from "../src/history.ts";
import { TuiState } from "../src/tui-state.ts";

test("history discovers renamed benchmark copies, replays older modes, and excludes traces outside the workspace",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bitzen-history-"));
  const outside=await mkdtemp(join(tmpdir(),"bitzen-history-outside-"));
  const run=async(workspace:string,id:string,mode:string)=>{
    const directory=join(workspace,".bitzen","runs",id);
    await mkdir(directory,{recursive:true});
    await Bun.write(join(directory,"summary.json"),JSON.stringify({mode,status:"completed",usage:{knownCostUsd:0.01}}));
    await Bun.write(join(directory,"events.jsonl"),JSON.stringify({type:"run_start",task:"Inspect",mode})+"\n");
  };
  try {
    await run(root,"01","crew");
    await run(join(root,"crew"),"02","crew");
    await run(join(root,"single"),"03","single");
    await run(join(root,"renamed-workspace"),"04","previous-crew-name");
    await run(outside,"05","crew");
    await mkdir(join(root,"linked-workspace"));
    await symlink(join(outside,".bitzen"),join(root,"linked-workspace",".bitzen"));
    const runs=await savedRuns(root);
    expect(runs.map(item=>[item.key,item.mode])).toEqual([
      ["renamed-workspace/04","crew"],["single/03","single"],["crew/02","crew"],["root/01","crew"],
    ]);
    const events=await readRun(runs[0]!);
    const state=new TuiState();events.forEach(event=>state.receive(event));
    expect(state.mode).toBe("crew");expect(state.task).toBe("Inspect");
    const single=new TuiState();(await readRun(runs[1]!)).forEach(event=>single.receive(event));
    expect(single.mode).toBe("single");
  } finally {await Promise.all([root,outside].map(path=>rm(path,{recursive:true,force:true})));}
});
