Repair this dependency-aware incremental build planner. Its graph validation,
ordering, and change propagation contain interacting bugs. Keep the exported API
and add regression tests. This is a synchronous planning library, not an executor.

Public API:
- Task = { id: string, deps: string[] }. BuildPlan = { order: string[], layers: string[][], skipped: string[] }.
- graph.ts exports validateTasks(value) and topologicalLayers(tasks, selected?).
- impact.ts exports affectedTasks(tasks, changed).
- planner.ts exports BuildPlanner with constructor(tasks), list(), replace(tasks),
  and plan(targets?, changed?).

Contract:
1. Task input must be an array of objects with string ids and arrays of string
   dependency ids. Ids must contain at least one non-whitespace character. Preserve
   accepted ids exactly, including spaces. Reject duplicate task ids, duplicate
   deps, self dependencies, and deps referring to missing tasks. An empty graph is
   valid. Extra object properties are ignored; returned tasks contain only id/deps.
2. Reject cycles in the ENTIRE graph, including disconnected components and cycles
   outside requested targets. Errors for cycles must contain the word "cycle".
   Validate input without mutation. validateTasks returns independent copies.
3. topologicalLayers(tasks, selected?) returns dependency-first parallel waves.
   When selected is omitted, include all tasks. When provided, use exactly that set;
   dependencies outside it are assumed already built and impose no scheduling edge.
   Each wave contains ALL currently ready tasks, sorted by JavaScript's default
   string sort (UTF-16 code unit order). Only after finishing a whole wave may the
   next wave start. Every selected task appears once. An empty selection returns [].
4. All supplied target, changed, and selected lists must be arrays of valid known
   ids. Duplicate entries in these lists are allowed and deduplicated. Empty lists
   have meaning: never treat [] like an omitted argument. Unknown ids must throw,
   even when they would have been outside the requested build. Caller arrays remain
   unchanged. Special ids such as "__proto__" and "constructor" work normally.
5. affectedTasks(tasks, changed) returns changed tasks plus EVERY transitive dependent,
   deduplicated and sorted by the same string ordering. Do not include dependencies
   of changed tasks or unrelated tasks. Empty changed returns [].
6. BuildPlanner owns a copy of its validated graph. Mutating constructor/replace
   input, validateTasks results, or list() results must not change its state. replace
   atomically replaces the WHOLE graph only after validation succeeds: on any error
   retain the old graph. list() preserves the supplied graph's insertion order.
7. plan(targets?, changed?) first computes the transitive dependency closure of
   targets, including targets themselves. Omitted targets means all tasks; targets=[]
   means none. If changed is omitted, execute the whole closure. If changed is given,
   execute only affectedTasks(graph, changed) intersected with that closure. Remaining
   tasks in the closure are skipped (already built). Do not add prerequisites back
   into execution after this filtering. Validate both lists even if targets=[] or
   changed=[] would otherwise make the result empty.
8. layers are topologicalLayers over the execution set, order is EXACTLY layers.flat(),
   and skipped contains nonexecuted tasks from the requested closure in sorted order.
   Do not include unrelated graph nodes in skipped. Every plan returns fresh arrays.
   Plans never mutate planner state or change the results of future plans.
9. Support long chains of at least 3,000 tasks without recursive stack overflow,
   and deterministic results regardless of task/dependency insertion order (except
   list(), which preserves that order).

Example graph:
  types: [], core: [types], ui: [core], cli: [core], docs: []
plan(["ui"], ["types"]) => order ["types","core","ui"], layers [["types"],["core"],["ui"]], skipped []
plan(["ui"], ["core"]) => order ["core","ui"], layers [["core"],["ui"]], skipped ["types"]
plan(["ui"], ["docs"]) => order [], layers [], skipped ["core","types","ui"]
plan([], undefined) => order [], layers [], skipped []

Use Bun and TypeScript. Change only src/ and tests/. Do not remove or weaken existing
tests. This scratch directory is not a Git repository. Run bun test and report changes,
verification, and remaining limitations. A separate grader checks the contract.
