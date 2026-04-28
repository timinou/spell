import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getToken, setToken as persistToken } from "./storage";

interface AuthState {
	token: string | null;
	identity: { name: string } | null;
	status: "checking" | "ok" | "anonymous" | "rejected";
	signIn: (token: string) => Promise<void>;
	signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

async function probeToken(token: string): Promise<{ name: string } | null> {
	try {
		const r = await fetch("/web/api/sessions", { headers: { Authorization: `Bearer ${token}` } });
		if (!r.ok) return null;
		// We don't currently return identity from this endpoint; client trusts the token.
		return { name: "you" };
	} catch {
		return null;
	}
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
	const [token, setToken] = useState<string | null>(() => getToken());
	const [identity, setIdentity] = useState<{ name: string } | null>(null);
	const [status, setStatus] = useState<AuthState["status"]>("checking");

	useEffect(() => {
		let cancelled = false;
		if (!token) {
			setStatus("anonymous");
			setIdentity(null);
			return;
		}
		setStatus("checking");
		probeToken(token).then(id => {
			if (cancelled) return;
			if (id) {
				setIdentity(id);
				setStatus("ok");
			} else {
				setIdentity(null);
				setStatus("rejected");
				persistToken(null);
				setToken(null);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [token]);

	const signIn = useCallback(async (next: string) => {
		const id = await probeToken(next);
		if (!id) {
			setStatus("rejected");
			throw new Error("invalid token");
		}
		persistToken(next);
		setToken(next);
		setIdentity(id);
		setStatus("ok");
	}, []);

	const signOut = useCallback(() => {
		persistToken(null);
		setToken(null);
		setIdentity(null);
		setStatus("anonymous");
	}, []);

	const value = useMemo<AuthState>(() => ({ token, identity, status, signIn, signOut }), [token, identity, status, signIn, signOut]);
	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error("useAuth outside provider");
	return ctx;
}
