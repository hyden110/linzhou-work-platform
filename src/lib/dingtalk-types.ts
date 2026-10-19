/** Browser-safe shapes for the local DingTalk todo / daily digest endpoints. */

export type TodoPriority = 10 | 20 | 30 | 40;

export interface TodoCreateRequest {
  requestId: string;
  title: string;
  dueAt: string;
  priority: TodoPriority;
  executor: "self";
}

export type TodoWriteState = "creating" | "created" | "failed";

export interface TodoWriteRecord {
  requestId: string;
  state: TodoWriteState;
  title: string;
  dueAt: string;
  priority: number;
  taskId: string | null;
  dryRun: "passed" | "failed" | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface TodoCreateOutcome {
  record: TodoWriteRecord;
  reused: boolean;
}

export type TicketStatus = "resolved" | "unresolved" | "unconfirmed";

export interface DailyTicket {
  problem: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status: TicketStatus;
  solution: string | null;
  evidence: string[];
}

export type SummaryGeneration = "llm" | "fallback" | "failed";

export interface DailyChatSummary {
  chatId: string;
  chatName: string;
  messageCount: number;
  complete: boolean;
  partial: boolean;
  truncated: boolean;
  windowCapped: boolean;
  windowStart: string;
  windowEnd: string;
  summaryState: SummaryGeneration;
  summaryNote: string | null;
  summary: string;
  tickets: DailyTicket[];
  error: string | null;
}

export interface DailySummaryCounts {
  groups: number;
  messages: number;
  tickets: number;
  unresolved: number;
  unconfirmed: number;
  singleChats: number;
  failedChats: number;
}

export interface DailySummary {
  schemaVersion: 1;
  date: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  state: "ok" | "partial" | "failed";
  model: "qodercli" | "fallback";
  chats: DailyChatSummary[];
  singleChats: { chatId: string; name: string }[];
  skippedGroups: number;
  counts: DailySummaryCounts;
  error: string | null;
}

export interface SummaryStatus {
  state: "idle" | "running" | "succeeded" | "failed";
  date: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** env / isolated / default；只含来源标记，不含路径或凭据。 */
  modelSource?: string | null;
  elapsedMs?: number | null;
  /** 非阻断告警码，如 isolated 日志 chmod 失败。 */
  warnings?: string[];
}

export interface DailyMessage {
  messageId: string;
  sender: string;
  text: string;
  time: string;
}

export interface DailyMessages {
  date: string;
  chatId: string;
  complete: boolean;
  messages: DailyMessage[];
}
