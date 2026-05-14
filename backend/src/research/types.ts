// ── Research Plan ──

export interface ResearchPlan {
  title: string;
  language: string;
  sections: ResearchSection[];
}

export interface ResearchSection {
  id: number;
  heading: string;
  queries: string[];
}

// ── Findings ──

export interface SectionFinding {
  sectionId: number;
  heading: string;
  summary: string;
  keyFacts: string[];
  sources: SourceRef[];
  gaps: string[];
}

export interface SourceRef {
  title: string;
  url: string;
  relevance: string;
}

// ── Search & Read Results ──

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface PageContent {
  url: string;
  title: string;
  text: string;
}

// ── Gap Analysis ──

export interface GapAnalysis {
  sufficient: boolean;
  additionalQueries: string[];
}

// ── Research Task (MongoDB) ──

export type ResearchStatus =
  | "pending"
  | "decomposing"
  | "searching"
  | "reading"
  | "compressing"
  | "analyzing"
  | "writing"
  | "completed"
  | "failed";

export interface ResearchTaskDoc {
  _id?: string;
  sessionId?: string;
  query: string;
  status: ResearchStatus;
  plan?: ResearchPlan;
  findings: SectionFinding[];
  currentRound: number;
  createdAt: Date;
  completedAt?: Date;
  error?: string;
}

export interface ResearchReportDoc {
  taskId: string;
  html: string;
  createdAt: Date;
}

// ── Pipeline Context ──

export interface PipelineContext {
  openai: any;
  model: string;
  mcp: any;
  config: {
    maxSearchRounds: number;
    maxPagesPerRound: number;
    maxTokensPerFinding: number;
  };
}
