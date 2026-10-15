export type ViewId =
  | "cockpit"
  | "lifecycle"
  | "overview"
  | "ask"
  | "map"
  | "assistant"
  | "documents"
  | "yunqi"
  | "sync";

export interface CountRow {
  name: string;
  count: number;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  source: string;
  sourceLabel: string;
  relativePath: string;
  type: string;
  size: number;
  modifiedAt: string;
  topics: string[];
  solutionTracks: string[];
  customers: string[];
  events: string[];
  status: string;
  location: string;
}

export interface KnowledgeIndex {
  schemaVersion: number;
  mode: "local-index-preview";
  label: string;
  generatedAt: string;
  roots: Array<{ id: string; label: string }>;
  allowedExtensions: string[];
  stats: {
    totalDocuments: number;
    totalBytes: number;
    bySource: CountRow[];
    byType: CountRow[];
    byTopic: CountRow[];
    bySolutionTrack: CountRow[];
    byCustomer: CountRow[];
    byEvent: CountRow[];
  };
  recentDocuments: KnowledgeDocument[];
  documents: KnowledgeDocument[];
  syncSummary: {
    added: number;
    updated: number;
    skipped: number;
    deleted: number;
    failed: number;
  };
  errors: Array<{
    source: string;
    relativePath: string;
    stage: string;
    message: string;
  }>;
}

export interface YunqiEvidence {
  label: string;
  anchor?: string;
  url?: string;
}

export interface YunqiTalk {
  id: string;
  who: string;
  role: string;
  title: string;
  tags: string[];
  headline: string;
  key: boolean;
}

export interface YunqiForum {
  id: string;
  layerId: string;
  title: string;
  meta: string[];
  lead: string;
  sections: Array<{ heading: string; items: string[] }>;
  notes: string[];
  talkCount: number;
  talks: YunqiTalk[];
  gapNotes: string[];
}

export interface YunqiForumRow {
  id: string;
  title: string;
  agenda: string;
  when: string;
  where: string;
  positioning: string;
  releases: string;
  cases: string;
}

export interface YunqiLayer {
  id: string;
  order: number;
  label: string;
  title: string;
  summary: string;
  trendIds: string[];
  forumIds: string[];
  forums: YunqiForumRow[];
}

export interface YunqiTrend {
  id: string;
  index: number;
  layerId: string;
  groupBadge: string;
  groupHeading: string;
  groupNote: string;
  title: string;
  body: string;
  evidence: YunqiEvidence[];
}

export interface YunqiHighlights {
  schemaVersion: number;
  mode: "local-content-highlights";
  label: string;
  generatedAt: string;
  source: {
    id: string;
    title: string;
    origin: string;
    relativePath: string;
    type: string;
    bytes: number;
    modifiedAt: string;
    digest: string;
  };
  thesis: { tag: string; statement: string; note: string };
  synthesis: Array<{ index: number; title: string; body: string; evidence: YunqiEvidence[] }>;
  layers: YunqiLayer[];
  trends: YunqiTrend[];
  forums: YunqiForum[];
  method: {
    sections: Array<{ heading: string; body: string; rows: string[] }>;
    gaps: string[];
  };
  stats: {
    layers: number;
    trends: number;
    synthesis: number;
    forums: number;
    talks: number;
    gaps: number;
    methodSections: number;
  };
}

export type ShelfId = "solutions" | "customers" | "events" | "topics";

export interface LocalRuntimeStatus {
  available: boolean;
  open: boolean;
  preview: boolean;
}

