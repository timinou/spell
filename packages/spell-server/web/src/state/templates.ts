import { create } from "zustand";
import type { ManifestTemplate } from "../api/client";

interface TemplatesState {
	templates: ManifestTemplate[];
	loaded: boolean;
	setTemplates: (templates: ManifestTemplate[]) => void;
}

export const useTemplates = create<TemplatesState>(set => ({
	templates: [],
	loaded: false,
	setTemplates: templates => set({ templates, loaded: true }),
}));
