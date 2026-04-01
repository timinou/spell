export interface TemplateSection {
  id: string;
  type: 'header' | 'metrics' | 'content' | 'table' | 'callout' | 'custom';
  title: string;
  components: TemplateComponent[];
}

export interface TemplateComponent {
  id: string;
  type: 'stat-cell' | 'section-header' | 'metric-strip' | 'callout-box' | 'page-footer' | 'text-block' | 'table';
  props: Record<string, unknown>;
}

export interface TemplateMetadata {
  name: string;
  description: string;
  sections: TemplateSection[];
  variables: Record<string, { type: string; required: boolean; description: string }>;
  createdAt: string;
  updatedAt: string;
}
