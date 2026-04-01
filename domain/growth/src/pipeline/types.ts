export type DeliverableState = 'BRIEF' | 'DRAFT' | 'REVIEW' | 'FINAL' | 'SENT';
export type DeliverableType =
  | 'weekly-digest'
  | 'client-proposal'
  | 'competitive-analysis'
  | 'campaign-brief'
  | 'custom';

export interface Deliverable {
  id: string;
  orgItemId: string;
  filePath: string;
  clientId?: string;
  type: DeliverableType;
  state: DeliverableState;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineSummary {
  brief: number;
  draft: number;
  review: number;
  final: number;
  sent: number;
}

export interface Deadline {
  deliverableId: string;
  title: string;
  dueDate: string;
  state: DeliverableState;
}
