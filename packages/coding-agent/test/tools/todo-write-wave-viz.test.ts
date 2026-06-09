import { test, expect } from "bun:test";
import { computeWaveDepths, formatSummary } from "../../src/tools/todo-write";

const mk = (o: any) => ({ id: o.id, content: o.content ?? o.id, status: o.status ?? "pending", blockers: o.blockers });

test("computeWaveDepths: chain a->b->c gives 1,2,3", () => {
  const nodes = [mk({id:"a"}), mk({id:"b", blockers:["a"]}), mk({id:"c", blockers:["b"]})];
  const d = computeWaveDepths(nodes as any);
  expect(d.get("a")).toBe(1); expect(d.get("b")).toBe(2); expect(d.get("c")).toBe(3);
});

test("completed blocker collapses depth", () => {
  const nodes = [mk({id:"a", status:"completed"}), mk({id:"b", blockers:["a"]})];
  const d = computeWaveDepths(nodes as any);
  expect(d.has("a")).toBe(false);     // terminal excluded
  expect(d.get("b")).toBe(1);          // now ready
});

test("diamond: two parallel mids, join at wave 3", () => {
  const nodes = [mk({id:"a"}), mk({id:"b", blockers:["a"]}), mk({id:"c", blockers:["a"]}), mk({id:"d", blockers:["b","c"]})];
  const d = computeWaveDepths(nodes as any);
  expect(d.get("a")).toBe(1); expect(d.get("b")).toBe(2); expect(d.get("c")).toBe(2); expect(d.get("d")).toBe(3);
});

test("cycle guard: a<->b does not hang", () => {
  const nodes = [mk({id:"a", blockers:["b"]}), mk({id:"b", blockers:["a"]})];
  const d = computeWaveDepths(nodes as any);
  expect(d.get("a")).toBeGreaterThanOrEqual(1);
});

test("summary shows wave header + badges only when multi-wave", () => {
  const multi = [mk({id:"a"}), mk({id:"b", blockers:["a"]})];
  const out = formatSummary({ nodes: multi as any, errors:[], completedGroups:[], completedGatedNodes:[], pendingVerificationNodes:[], pendingDeferralNodes:[] });
  console.log("----\n"+out+"\n----");
  expect(out).toContain("Waves: 2");
  expect(out).toContain("[w1]"); expect(out).toContain("[w2]");

  const flat = [mk({id:"x"}), mk({id:"y"})];
  const out2 = formatSummary({ nodes: flat as any, errors:[], completedGroups:[], completedGatedNodes:[], pendingVerificationNodes:[], pendingDeferralNodes:[] });
  expect(out2).not.toContain("Waves:");
  expect(out2).not.toContain("[w1]");
});
