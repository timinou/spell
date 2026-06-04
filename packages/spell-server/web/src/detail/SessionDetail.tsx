import { useEffect, useState } from "react";
import type { DerivedSession } from "../state/sessions";
import { ArtifactsTab } from "./ArtifactsTab";
import { BashTab } from "./BashTab";
import { StateTab } from "./StateTab";
import { StreamTab } from "./StreamTab";

type TabId = "stream" | "bash" | "state" | "artifacts";

const TAB_LABELS: Array<{ id: TabId; label: string }> = [
	{ id: "stream", label: "Stream" },
	{ id: "bash", label: "Bash" },
	{ id: "state", label: "State" },
	{ id: "artifacts", label: "Artifacts" },
];

interface Props {
	session: DerivedSession;
	subscribeRpcEvents: (sessionId: string, listener: (event: { type: string }) => void) => () => void;
	submitPrompt: (sessionId: string, message: string, deliverAs?: "steer" | "followUp" | "auto") => Promise<void>;
	abort: (sessionId: string) => Promise<void>;
	answerBlockingEvent: (
		sessionId: string,
		eventId: string,
		payload: import("../api/client").EventResponsePayload,
	) => void;
	runBash: (sessionId: string, command: string) => Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
	mintUrl: (sessionId: string, artifactPath: string, ttlSec?: number) => Promise<{ url: string; expiresAt: number }>;
	loadArtifacts: (sessionId: string) => Promise<import("../api/client").ArtifactRef[]>;
}

function tabFromHash(): TabId {
	const hash = window.location.hash.replace("#", "");
	if (hash === "bash" || hash === "state" || hash === "artifacts") return hash;
	return "stream";
}

export function SessionDetail(props: Props) {
	const { session } = props;
	const [tab, setTab] = useState<TabId>(() => tabFromHash());

	useEffect(() => {
		const handler = () => setTab(tabFromHash());
		window.addEventListener("hashchange", handler);
		return () => window.removeEventListener("hashchange", handler);
	}, []);

	const isExternal = session.kind === "external";
	const visible = TAB_LABELS.filter(t => !(isExternal && t.id === "bash"));

	return (
		<div className="main">
			<div className="tabs">
				{visible.map(t => (
					<div
						key={t.id}
						className={`tab${t.id === tab ? " active" : ""}`}
						onClick={() => {
							setTab(t.id);
							window.location.hash = t.id;
						}}
					>
						{t.label}
					</div>
				))}
			</div>
			<div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
				{tab === "stream" && (
					<StreamTab
						session={session}
						subscribeRpcEvents={props.subscribeRpcEvents}
						submitPrompt={props.submitPrompt}
						abort={isExternal ? undefined : props.abort}
						answerBlockingEvent={props.answerBlockingEvent}
					/>
				)}
				{tab === "bash" && !isExternal && <BashTab session={session} runBash={props.runBash} />}
				{tab === "state" && <StateTab session={session} />}
				{tab === "artifacts" && (
					<ArtifactsTab session={session} mintUrl={props.mintUrl} loadArtifacts={props.loadArtifacts} />
				)}
			</div>
		</div>
	);
}
