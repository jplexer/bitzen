import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { benchmarkCommands, benchmarkDetails, gradeBenchmark, prepareBenchmark, prepareReference } from "../src/benchmark.ts";
import { runProcess } from "../src/tools.ts";
import { signal } from "./helpers.ts";

test.each([["job-queue",53],["build-planner",52]] as const)("%s copies are identical; grader rejects starter and accepts reference",async(name,cases)=>{
  const fixture=await prepareBenchmark(name);const reference=await prepareReference(name);
  const grading: string[]=[];
  try {
    const files=[...new Bun.Glob("**/*").scanSync({cwd:fixture.crew,onlyFiles:true})];
    for(const file of files)expect(await Bun.file(join(fixture.crew,file)).text()).toBe(await Bun.file(join(fixture.single,file)).text());
    expect(files).toHaveLength(5);
    const bad=await gradeBenchmark(fixture.crew,signal(),name);grading.push(bad.gradingDirectory);
    expect(bad.exitCode).toBe(1);
    const good=await gradeBenchmark(reference,signal(),name);grading.push(good.gradingDirectory);
    expect(good.exitCode).toBe(0);expect(good.stderr).toContain(`${cases} pass`);
    const visible=await runProcess([process.execPath,"test"],reference,signal());
    expect(visible.exitCode).toBe(0);expect(visible.stderr).toContain("6 pass");
    if(name==="build-planner")expect(benchmarkCommands(fixture.root,name)).toContain("grade --name build-planner");
  } finally {await Promise.all([fixture.root,reference,...grading].map(path=>rm(path,{recursive:true,force:true})));}
});

test("benchmark names are validated before constructing paths",()=>{
  expect(benchmarkDetails().name).toBe("job-queue");
  for(const name of ["missing","../job-queue","constructor","__proto__"])expect(()=>benchmarkDetails(name)).toThrow("Unknown benchmark");
});
