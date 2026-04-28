import { useEffect, useRef, useState } from "react";
import type { DerivedSession } from "../state/sessions";
import { attachTerminal, makeTerminal, type SpellTerminal } from "./xterm-setup";

export interface BashTabProps {
	session: DerivedSession;
	runBash: (sessionId: string, command: string) => Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
}

export function BashTab(props: BashTabProps) {
	const { session, runBash } = props;
	const hostRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<SpellTerminal | null>(null);
	const [cmd, setCmd] = useState("");
	const [running, setRunning] = useState(false);

	useEffect(() => {
		if (!hostRef.current) return;
		const term = makeTerminal();
		termRef.current = term;
		const detach = attachTerminal(term, hostRef.current);
		term.term.writeln(`# bash session attached to ${session.sessionId}\r`);
		return () => {
			detach();
			term.dispose();
			termRef.current = null;
		};
	}, [session.sessionId]);

	async function run() {
		if (!termRef.current || cmd.trim().length === 0 || running) return;
		setRunning(true);
		const term = termRef.current.term;
		term.write(`$ ${cmd}\r\n`);
		try {
			const result = await runBash(session.sessionId, cmd);
			if (result.stdout) term.write(`${result.stdout}\r\n`);
			if (result.stderr) term.write(`\u001b[31m${result.stderr}\u001b[0m\r\n`);
			if (typeof result.exitCode === "number" && result.exitCode !== 0) {
				term.write(`\u001b[31mexit ${result.exitCode}\u001b[0m\r\n`);
			}
		} catch (error) {
			term.write(`\u001b[31m${String(error)}\u001b[0m\r\n`);
		} finally {
			setRunning(false);
			setCmd("");
		}
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
			<div className="term-host" ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
			<div className="bash-input">
				<input
					value={cmd}
					placeholder={running ? "running..." : "Type a bash command and press Enter"}
					onChange={e => setCmd(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter") {
							e.preventDefault();
							void run();
						}
					}}
					disabled={running}
				/>
				<button className="btn btn-primary" onClick={run} disabled={running || cmd.length === 0}>
					Run
				</button>
			</div>
		</div>
	);
}
