import { useState } from "react";
import { useAuth } from "./AuthProvider";

export function Login() {
	const { signIn, status } = useAuth();
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		try {
			await signIn(value.trim());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<div className="login">
			<form onSubmit={onSubmit}>
				<h2>Spell Dashboard</h2>
				<label className="muted" htmlFor="token-input">Bearer token</label>
				<input id="token-input" type="password" value={value} onChange={e => setValue(e.target.value)} autoFocus />
				<button className="btn btn-primary" type="submit" disabled={value.length === 0}>
					{status === "checking" ? "Checking\u2026" : "Sign In"}
				</button>
				{error && <div className="muted" style={{ color: "var(--red)" }}>{error}</div>}
				{status === "rejected" && !error && <div className="muted" style={{ color: "var(--red)" }}>Token rejected.</div>}
			</form>
		</div>
	);
}
