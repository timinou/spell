/**
 * AskBroker unit tests (PLAN-327): park/resolve, originator-always invariant,
 * fan-out routing, non-blocking delivery, and close-unparks.
 */
import { describe, expect, test } from "bun:test";
import { AskBroker } from "../../src/task/ask-broker";

function makeBroker(): { broker: AskBroker; lastQid: () => string } {
	const broker = new AskBroker("run-1");
	let last = "";
	broker.subscribeRaised(q => {
		last = q.questionId;
	});
	return { broker, lastQid: () => last };
}

describe("AskBroker", () => {
	test("blocking raise parks until answered (answer = resolved value)", async () => {
		const { broker, lastQid } = makeBroker();
		const deliveries: string[] = [];
		broker.registerDelivery("t1", text => deliveries.push(text));

		let resolved: string | undefined;
		const p = broker.raise({ fromTaskId: "t1", question: "which error type?", blocking: true }).then(o => {
			resolved = o.answer;
			return o;
		});

		// Pending until answered.
		expect(broker.pendingCount()).toBe(1);
		broker.answer(lastQid(), "AppError", []);
		const outcome = await p;
		expect(outcome.answer).toBe("AppError");
		expect(resolved).toBe("AppError");
		// Originator is the parked promise — NOT also delivered out-of-band.
		expect(deliveries).toEqual([]);
		expect(broker.pendingCount()).toBe(0);
	});

	test("originator always receives even when omitted from recipients (D2 invariant)", async () => {
		const { broker, lastQid } = makeBroker();
		const p = broker.raise({ fromTaskId: "t1", question: "q", blocking: true });
		const ans = broker.answer(lastQid(), "answer", ["t2", "t3"]); // originator t1 omitted
		expect(ans?.recipients).toContain("t1");
		expect(ans?.recipients).toContain("t2");
		expect(ans?.recipients).toContain("t3");
		await p;
	});

	test("fan-out delivers to non-originator recipients out-of-band", async () => {
		const { broker, lastQid } = makeBroker();
		void lastQid;
		const d1: string[] = [];
		const d2: string[] = [];
		const d3: string[] = [];
		broker.registerDelivery("t1", t => d1.push(t));
		broker.registerDelivery("t2", t => d2.push(t));
		broker.registerDelivery("t3", t => d3.push(t));

		const p = broker.raise({ fromTaskId: "t1", question: "shared?", blocking: true });
		broker.answer(lastQid(), "use X", ["t2"]); // recipients t1(orig)+t2

		await p;
		// t1 is the parked promise (no out-of-band delivery); t2 gets it; t3 does not.
		expect(d1).toEqual([]);
		expect(d2.length).toBe(1);
		expect(d2[0]).toContain("use X");
		expect(d3).toEqual([]);
	});

	test("non-blocking raise acks immediately and delivers answer out-of-band", async () => {
		const { broker } = makeBroker();
		const d1: string[] = [];
		broker.registerDelivery("t1", t => d1.push(t));

		const outcome = await broker.raise({ fromTaskId: "t1", question: "later?", blocking: false });
		expect(outcome.questionId).toBeTruthy();
		expect(outcome.answer).toBeUndefined();
		expect(broker.pendingCount()).toBe(1);

		broker.answer(outcome.questionId, "deferred answer", []);
		// Non-blocking originator receives via delivery, not a parked promise.
		expect(d1.length).toBe(1);
		expect(d1[0]).toContain("deferred answer");
		expect(broker.pendingCount()).toBe(0);
	});

	test("close() unparks blocking callers with cancelled outcome", async () => {
		const { broker } = makeBroker();
		const p = broker.raise({ fromTaskId: "t1", question: "q", blocking: true });
		expect(broker.pendingCount()).toBe(1);
		broker.close("batch done");
		const outcome = await p;
		expect(outcome.cancelled).toBe(true);
		expect(outcome.cancelReason).toBe("batch done");
		expect(broker.pendingCount()).toBe(0);
	});

	test("empty recipients still force-adds originator (exactly [originator])", async () => {
		const { broker, lastQid } = makeBroker();
		const p = broker.raise({ fromTaskId: "t1", question: "q", blocking: true });
		const ans = broker.answer(lastQid(), "a", []);
		expect(ans?.recipients).toEqual(["t1"]);
		await p;
	});

	test("recipients already containing originator dedups (no double-delivery)", async () => {
		const { broker, lastQid } = makeBroker();
		const d2: string[] = [];
		broker.registerDelivery("t2", t => d2.push(t));
		const p = broker.raise({ fromTaskId: "t1", question: "q", blocking: true });
		const ans = broker.answer(lastQid(), "a", ["t1", "t2", "t1"]);
		// t1 appears once; t2 once.
		expect(ans?.recipients.filter(r => r === "t1").length).toBe(1);
		expect(d2.length).toBe(1);
		await p;
	});

	test("two concurrent pending asks resolve independently (no cross-talk)", async () => {
		const broker = new AskBroker("run-2");
		const qids: string[] = [];
		broker.subscribeRaised(q => qids.push(q.questionId));
		const pA = broker.raise({ fromTaskId: "tA", question: "qA", blocking: true });
		const pB = broker.raise({ fromTaskId: "tB", question: "qB", blocking: true });
		expect(broker.pendingCount()).toBe(2);
		// Answer B first, then A — each resolves its own promise.
		broker.answer(qids[1]!, "answerB", []);
		broker.answer(qids[0]!, "answerA", []);
		expect((await pA).answer).toBe("answerA");
		expect((await pB).answer).toBe("answerB");
	});

	test("close() unparks ALL pending blocking callers", async () => {
		const broker = new AskBroker("run-3");
		const pA = broker.raise({ fromTaskId: "tA", question: "qA", blocking: true });
		const pB = broker.raise({ fromTaskId: "tB", question: "qB", blocking: true });
		const pC = broker.raise({ fromTaskId: "tC", question: "qC", blocking: true });
		expect(broker.pendingCount()).toBe(3);
		broker.close("done");
		for (const p of [pA, pB, pC]) {
			expect((await p).cancelled).toBe(true);
		}
		expect(broker.pendingCount()).toBe(0);
	});

	test("answering an unknown questionId is a no-op", () => {
		const { broker } = makeBroker();
		expect(broker.answer("nope", "x", [])).toBeUndefined();
	});

	test("raise after close returns cancelled immediately", async () => {
		const { broker } = makeBroker();
		broker.close();
		const outcome = await broker.raise({ fromTaskId: "t1", question: "q", blocking: true });
		expect(outcome.cancelled).toBe(true);
	});
});


