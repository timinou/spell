import { describe, expect, it } from "bun:test";
import { createActor, createApprovalInput, createClock, createWorkflowEngine } from "./test-helpers";

describe("workflow claim semantics", () => {
	it("blocks second claimants until the lease expires", () => {
		const clock = createClock();
		const engine = createWorkflowEngine(clock.now);
		const approval = engine.createApproval(createApprovalInput({ claimLeaseMs: 1_000 }));
		const firstActor = createActor("operator-1");
		const secondActor = createActor("operator-2");

		engine.claimItem({ itemId: approval.id, actor: firstActor, requestId: "claim-1" });
		expect(() => engine.claimItem({ itemId: approval.id, actor: secondActor, requestId: "claim-2" })).toThrow(
			/already claimed/,
		);

		clock.advanceMs(1_500);
		const claimed = engine.claimItem({ itemId: approval.id, actor: secondActor, requestId: "claim-3" });
		expect(claimed.claim?.actor.actorId).toBe("operator-2");
	});

	it("allows admin override and claim release", () => {
		const engine = createWorkflowEngine();
		const approval = engine.createApproval(createApprovalInput());
		const owner = createActor("operator-1");
		const admin = createActor("admin-1", ["admin"]);

		engine.claimItem({ itemId: approval.id, actor: owner, requestId: "claim-1" });
		const overridden = engine.claimItem({ itemId: approval.id, actor: admin, requestId: "claim-2", force: true });
		expect(overridden.claim?.actor.actorId).toBe("admin-1");
		expect(overridden.claim?.override).toBe(true);

		const released = engine.releaseClaim({ itemId: approval.id, actor: admin, requestId: "release-1", force: true });
		expect(released.claim).toBeUndefined();
		expect(engine.listAudit(approval.id).map(entry => entry.kind)).toContain("claim-acquired");
		expect(engine.listAudit(approval.id).map(entry => entry.kind)).toContain("claim-released");
	});
});
