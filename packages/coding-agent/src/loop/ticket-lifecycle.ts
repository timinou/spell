import type { TicketState } from "./contracts";
import { TICKET_STATES } from "./contracts";
import type { ManifestSnapshot, ManifestTicket } from "./types";

/** Valid state transitions per ticket state. DONE is terminal. */
const TICKET_TRANSITIONS: Record<TicketState, readonly TicketState[]> = {
	ITEM: ["DOING", "BLOCKED", "HOLD"],
	DOING: ["DONE", "BLOCKED", "HOLD", "ITEM"],
	DONE: [],
	BLOCKED: ["ITEM", "DOING"],
	HOLD: ["ITEM", "DOING"],
};

export interface TicketTransitionResult {
	ticket: ManifestTicket;
	previousState: TicketState;
	/** IDs of tickets that became unblocked as a cascade effect. */
	unblockedTickets: string[];
	triggeredActions: Array<{ targetId: string; keyword: string }>;
}

function findTicket(manifest: ManifestSnapshot, ticketId: string): ManifestTicket {
	const ticket = manifest.tickets.find(t => t.id === ticketId);
	if (!ticket) {
		throw new Error(`Ticket not found: ${ticketId}`);
	}
	return ticket;
}

function ticketById(manifest: ManifestSnapshot, id: string): ManifestTicket | undefined {
	return manifest.tickets.find(t => t.id === id);
}

export class TicketLifecycleManager {
	/**
	 * Validate and execute a ticket state transition within a manifest.
	 * Mutates the ticket in-place. Returns cascade effects.
	 */
	transitionTicket(
		manifest: ManifestSnapshot,
		ticketId: string,
		newState: TicketState,
		iteration?: number,
	): TicketTransitionResult {
		const ticket = findTicket(manifest, ticketId);
		const previousState = ticket.state;
		const allowed = TICKET_TRANSITIONS[previousState];

		if (!allowed.includes(newState)) {
			throw new Error(`Invalid transition: ${previousState} -> ${newState} for ticket ${ticketId}`);
		}

		ticket.state = newState;

		if (iteration !== undefined) {
			ticket.iterationHistory.push(iteration);
		}

		const unblockedTickets: string[] = [];
		const triggeredActions: Array<{ targetId: string; keyword: string }> = [];

		if (newState === TICKET_STATES.done) {
			// Cascade: unblock tickets whose only remaining blocker was this ticket
			for (const other of manifest.tickets) {
				if (other.state !== TICKET_STATES.blocked) continue;
				if (!this.isDependencySatisfied(manifest, other.id)) continue;
				// All deps now satisfied — unblock
				other.state = TICKET_STATES.item;
				unblockedTickets.push(other.id);
			}

			// Process trigger rules sourced from this ticket
			for (const rule of manifest.triggerRules) {
				if (rule.source !== ticketId) continue;
				const target = ticketById(manifest, rule.target);
				if (!target) continue;

				const targetAllowed = TICKET_TRANSITIONS[target.state];
				const keyword = rule.keyword.toUpperCase() as TicketState;

				if (!targetAllowed.includes(keyword)) {
					// Invalid transition for target — skip silently
					continue;
				}

				target.state = keyword;
				triggeredActions.push({ targetId: rule.target, keyword: rule.keyword });
			}
		}

		return { ticket, previousState, unblockedTickets, triggeredActions };
	}

	/** Start working on a ticket (ITEM -> DOING). Throws if deps are unmet. */
	startTicket(manifest: ManifestSnapshot, ticketId: string, iteration: number): TicketTransitionResult {
		if (!this.isDependencySatisfied(manifest, ticketId)) {
			const ticket = findTicket(manifest, ticketId);
			const unmet = ticket.dependencies.filter(depId => {
				const dep = ticketById(manifest, depId);
				return !dep || dep.state !== TICKET_STATES.done;
			});
			throw new Error(`Cannot start ticket ${ticketId}: unmet dependencies: ${unmet.join(", ")}`);
		}
		return this.transitionTicket(manifest, ticketId, TICKET_STATES.doing, iteration);
	}

	/** Complete a ticket (DOING -> DONE). */
	completeTicket(manifest: ManifestSnapshot, ticketId: string, iteration: number): TicketTransitionResult {
		return this.transitionTicket(manifest, ticketId, TICKET_STATES.done, iteration);
	}

	/** Block a ticket. */
	blockTicket(manifest: ManifestSnapshot, ticketId: string): TicketTransitionResult {
		return this.transitionTicket(manifest, ticketId, TICKET_STATES.blocked);
	}

	/** Check if all of a ticket's dependencies are in DONE state. */
	isDependencySatisfied(manifest: ManifestSnapshot, ticketId: string): boolean {
		const ticket = findTicket(manifest, ticketId);
		return ticket.dependencies.every(depId => {
			const dep = ticketById(manifest, depId);
			return dep !== undefined && dep.state === TICKET_STATES.done;
		});
	}

	/** Get tickets ready to work on: ITEM state with all deps satisfied. */
	getReadyTickets(manifest: ManifestSnapshot): ManifestTicket[] {
		return manifest.tickets.filter(t => t.state === TICKET_STATES.item && this.isDependencySatisfied(manifest, t.id));
	}

	/** Get tickets currently in progress. */
	getActiveTickets(manifest: ManifestSnapshot): ManifestTicket[] {
		return manifest.tickets.filter(t => t.state === TICKET_STATES.doing);
	}

	/** Get completed tickets. */
	getCompletedTickets(manifest: ManifestSnapshot): ManifestTicket[] {
		return manifest.tickets.filter(t => t.state === TICKET_STATES.done);
	}

	/** Check if all tickets are DONE. */
	isManifestComplete(manifest: ManifestSnapshot): boolean {
		return manifest.tickets.every(t => t.state === TICKET_STATES.done);
	}

	/** Get manifest progress as a human-readable summary string. */
	getProgressSummary(manifest: ManifestSnapshot): string {
		const total = manifest.tickets.length;
		let done = 0;
		let doing = 0;
		let blocked = 0;

		for (const t of manifest.tickets) {
			if (t.state === TICKET_STATES.done) done++;
			else if (t.state === TICKET_STATES.doing) doing++;
			else if (t.state === TICKET_STATES.blocked) blocked++;
		}

		const remaining = total - done - doing - blocked;
		return `${done}/${total} tickets done, ${doing} in progress, ${blocked} blocked, ${remaining} remaining`;
	}
}
