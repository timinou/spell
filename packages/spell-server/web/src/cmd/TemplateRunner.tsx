import { useState } from "react";
import type { ManifestTemplate } from "../api/client";

interface Props {
	template: ManifestTemplate;
	onSubmit: (params: Record<string, unknown>) => Promise<void>;
	onCancel: () => void;
}

export function TemplateRunnerModal({ template, onSubmit, onCancel }: Props) {
	const [values, setValues] = useState<Record<string, string | boolean>>(() => {
		const init: Record<string, string | boolean> = {};
		for (const param of template.params) init[param.name] = param.type === "boolean" ? false : "";
		return init;
	});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit() {
		setError(null);
		setBusy(true);
		try {
			const params: Record<string, unknown> = {};
			for (const param of template.params) {
				const raw = values[param.name];
				if (param.type === "boolean") params[param.name] = Boolean(raw);
				else if (param.type === "number") params[param.name] = raw === "" ? undefined : Number(raw);
				else params[param.name] = raw === "" ? undefined : raw;
				if (param.required && (params[param.name] === undefined || params[param.name] === "")) {
					setError(`'${param.name}' is required`);
					setBusy(false);
					return;
				}
				if (params[param.name] === undefined) delete params[param.name];
			}
			await onSubmit(params);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="modal-overlay" onClick={onCancel}>
			<div className="modal-panel" onClick={e => e.stopPropagation()}>
				<h3>Run {template.name}</h3>
				{template.description && <div className="muted">{template.description}</div>}
				{template.params.length === 0 && <div className="muted">No parameters.</div>}
				{template.params.map(param => (
					<label key={param.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
						<span className="muted">
							{param.name} <span style={{ fontSize: 11 }}>({param.type}{param.required ? ", required" : ""})</span>
						</span>
						{param.type === "boolean" ? (
							<input
								type="checkbox"
								checked={Boolean(values[param.name])}
								onChange={e => setValues(v => ({ ...v, [param.name]: e.target.checked }))}
							/>
						) : (
							<input
								type={param.type === "number" ? "number" : "text"}
								value={values[param.name] as string}
								onChange={e => setValues(v => ({ ...v, [param.name]: e.target.value }))}
							/>
						)}
					</label>
				))}
				{error && <div style={{ color: "var(--red)" }}>{error}</div>}
				<div className="modal-actions">
					<button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
					<button className="btn btn-primary" onClick={submit} disabled={busy}>
						{busy ? "Running..." : "Run"}
					</button>
				</div>
			</div>
		</div>
	);
}
