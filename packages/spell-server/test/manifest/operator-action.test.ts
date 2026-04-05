import { describe, expect, it } from "bun:test";
import { parseManifestKdl } from "../../src/manifest/parser";

const BASE_KDL = `name "test"\nversion "1.0.0"\nsetup "worker" { domain "coding" }\ngoal "test-goal" { setup "worker"\nschedule type="cron" expression="0 * * * *"\nprompt "do stuff" }\n`;

describe("operator-action KDL parsing", () => {
	it("parses operator-action with transitions", () => {
		const kdl = `${BASE_KDL}
operator-action "approve-feed" {
  transition from="pending" to="approved-feed"
  trigger-goal "feed-delivery-goal"
  downstream-job kind="feed-delivery"
}`;
		const manifest = parseManifestKdl(kdl);
		expect(manifest.operatorActions).toHaveLength(1);
		const action = manifest.operatorActions[0];
		expect(action.id).toBe("approve-feed");
		expect(action.transitions).toEqual([{ from: "pending", to: "approved-feed" }]);
		expect(action.triggerGoal).toBe("feed-delivery-goal");
		expect(action.downstreamJob).toEqual({ kind: "feed-delivery" });
	});

	it("supports multiple transitions per action", () => {
		const kdl = `${BASE_KDL}
operator-action "reject" {
  transition from="pending" to="rejected"
  transition from="approved-feed" to="rejected"
}`;
		const manifest = parseManifestKdl(kdl);
		expect(manifest.operatorActions[0].transitions).toHaveLength(2);
		expect(manifest.operatorActions[0].transitions[0]).toEqual({ from: "pending", to: "rejected" });
		expect(manifest.operatorActions[0].transitions[1]).toEqual({ from: "approved-feed", to: "rejected" });
	});

	it("parses multiple operator-actions", () => {
		const kdl = `${BASE_KDL}
operator-action "approve" {
  transition from="pending" to="approved"
}
operator-action "reject" {
  transition from="pending" to="rejected"
}`;
		const manifest = parseManifestKdl(kdl);
		expect(manifest.operatorActions).toHaveLength(2);
	});

	it("rejects duplicate operator-action names", () => {
		const kdl = `${BASE_KDL}
operator-action "approve" {
  transition from="pending" to="approved"
}
operator-action "approve" {
  transition from="pending" to="rejected"
}`;
		expect(() => parseManifestKdl(kdl)).toThrow("Duplicate operator-action");
	});

	it("rejects operator-action without transitions", () => {
		const kdl = `${BASE_KDL}
operator-action "empty" {
}`;
		expect(() => parseManifestKdl(kdl)).toThrow("requires at least one transition");
	});

	it("rejects transition without from or to", () => {
		const kdl = `${BASE_KDL}
operator-action "bad" {
  transition from="pending"
}`;
		expect(() => parseManifestKdl(kdl)).toThrow("requires from and to");
	});

	it("returns empty operatorActions when none declared", () => {
		const manifest = parseManifestKdl(BASE_KDL);
		expect(manifest.operatorActions).toEqual([]);
	});

	it("operator-action without trigger-goal or downstream-job", () => {
		const kdl = `${BASE_KDL}
operator-action "defer" {
  transition from="pending" to="deferred"
}`;
		const manifest = parseManifestKdl(kdl);
		const action = manifest.operatorActions[0];
		expect(action.triggerGoal).toBeUndefined();
		expect(action.downstreamJob).toBeUndefined();
	});
});
