import type {
  DailyChatSummary,
  DailyMessage,
  DailyMessages,
  DailySummary,
  DailyTicket,
  SummaryStatus,
  TicketStatus,
  TodoCreateOutcome,
  TodoCreateRequest,
  TodoWriteRecord,
} from "./dingtalk-types";

const SAFE_ERRORS = new Set([
  "invalid_request",
  "invalid_date",
  "user_id_unavailable",
  "busy",
  "dws_missing",
  "todo_write_failed",
  "todo_verify_failed",
  "todo_manual_check_required",
  "summary_not_found",
  "message_cache_unavailable",
  "historical_read_only",
]);

export class DingtalkClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "DingtalkClientError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localUrl(path: string, query?: Record<string, string>): URL {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

async function request(
  path: string,
  init: RequestInit & { query?: Record<string, string> },
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(localUrl(path, init.query), { ...init, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new DingtalkClientError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const code = isRecord(payload) && typeof payload.error === "string" && SAFE_ERRORS.has(payload.error)
      ? payload.error
      : response.status === 429 ? "busy" : "unavailable";
    throw new DingtalkClientError(code);
  }
  return payload;
}

function numberText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asTicket(raw: unknown): DailyTicket | undefined {
  if (!isRecord(raw) || typeof raw.problem !== "string") return undefined;
  const status: TicketStatus = raw.status === "resolved" || raw.status === "unresolved" || raw.status === "unconfirmed"
    ? raw.status
    : "unconfirmed";
  return {
    problem: raw.problem,
    firstSeenAt: numberText(raw.firstSeenAt),
    lastSeenAt: numberText(raw.lastSeenAt),
    status,
    solution: typeof raw.solution === "string" ? raw.solution : null,
    evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((item): item is string => typeof item === "string") : [],
  };
}

function asChat(raw: unknown): DailyChatSummary | undefined {
  if (!isRecord(raw) || typeof raw.chatId !== "string") return undefined;
  const summaryState = raw.summaryState === "llm" || raw.summaryState === "fallback" || raw.summaryState === "failed"
    ? raw.summaryState
    : "failed";
  return {
    chatId: raw.chatId,
    chatName: typeof raw.chatName === "string" ? raw.chatName : "（未命名群）",
    messageCount: typeof raw.messageCount === "number" ? raw.messageCount : 0,
    complete: raw.complete === true,
    partial: raw.partial === true,
    truncated: raw.truncated === true,
    windowCapped: raw.windowCapped === true,
    windowStart: numberText(raw.windowStart),
    windowEnd: numberText(raw.windowEnd),
    summaryState,
    summaryNote: typeof raw.summaryNote === "string" ? raw.summaryNote : null,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    tickets: Array.isArray(raw.tickets)
      ? raw.tickets.map(asTicket).filter((ticket): ticket is DailyTicket => ticket !== undefined)
      : [],
    error: typeof raw.error === "string" ? raw.error : null,
  };
}

function asSummary(raw: unknown): DailySummary | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== 1) return undefined;
  if (typeof raw.date !== "string" || !Array.isArray(raw.chats)) return undefined;
  const counts = isRecord(raw.counts) ? raw.counts : {};
  const count = (key: string) => typeof counts[key] === "number" ? counts[key] as number : 0;
  return {
    schemaVersion: 1,
    date: raw.date,
    generatedAt: numberText(raw.generatedAt),
    windowStart: numberText(raw.windowStart),
    windowEnd: numberText(raw.windowEnd),
    state: raw.state === "ok" || raw.state === "partial" || raw.state === "failed" ? raw.state : "partial",
    model: raw.model === "qodercli" ? "qodercli" : "fallback",
    chats: raw.chats.map(asChat).filter((chat): chat is DailyChatSummary => chat !== undefined),
    singleChats: Array.isArray(raw.singleChats)
      ? raw.singleChats.flatMap((item) => isRecord(item) && typeof item.chatId === "string"
        ? [{ chatId: item.chatId, name: typeof item.name === "string" ? item.name : "" }]
        : [])
      : [],
    skippedGroups: typeof raw.skippedGroups === "number" ? raw.skippedGroups : 0,
    counts: {
      groups: count("groups"),
      messages: count("messages"),
      tickets: count("tickets"),
      unresolved: count("unresolved"),
      unconfirmed: count("unconfirmed"),
      singleChats: count("singleChats"),
      failedChats: count("failedChats"),
    },
    error: typeof raw.error === "string" ? raw.error : null,
  };
}

function asStatus(raw: unknown): SummaryStatus | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.state !== "idle" && raw.state !== "running" && raw.state !== "succeeded" && raw.state !== "failed") return undefined;
  return {
    state: raw.state,
    date: typeof raw.date === "string" ? raw.date : null,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : null,
    error: typeof raw.error === "string" ? raw.error : null,
    modelSource: typeof raw.modelSource === "string" ? raw.modelSource : null,
    elapsedMs: typeof raw.elapsedMs === "number" && Number.isFinite(raw.elapsedMs) ? raw.elapsedMs : null,
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.filter((item): item is string => typeof item === "string")
      : undefined,
  };
}

function asRecordWrite(raw: unknown): TodoWriteRecord | undefined {
  if (!isRecord(raw) || typeof raw.requestId !== "string") return undefined;
  if (raw.state !== "creating" && raw.state !== "created" && raw.state !== "failed") return undefined;
  return {
    requestId: raw.requestId,
    state: raw.state,
    title: typeof raw.title === "string" ? raw.title : "",
    dueAt: typeof raw.dueAt === "string" ? raw.dueAt : "",
    priority: typeof raw.priority === "number" ? raw.priority : 0,
    taskId: typeof raw.taskId === "string" ? raw.taskId : null,
    dryRun: raw.dryRun === "passed" || raw.dryRun === "failed" ? raw.dryRun : null,
    error: typeof raw.error === "string" ? raw.error : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : null,
  };
}

export async function createTodo(
  input: TodoCreateRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<TodoCreateOutcome> {
  const payload = await request("/local/dingtalk/todo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }, fetchImpl);
  const record = asRecordWrite(payload.data);
  if (!record) throw new DingtalkClientError("invalid_response");
  return { record, reused: payload.reused === true };
}

export async function fetchTodoWrites(fetchImpl: typeof fetch = fetch): Promise<TodoWriteRecord[]> {
  const payload = await request("/local/dingtalk/todo/writes", { method: "GET" }, fetchImpl);
  const data = isRecord(payload.data) ? payload.data.writes : undefined;
  return Array.isArray(data)
    ? data.map(asRecordWrite).filter((item): item is TodoWriteRecord => item !== undefined)
    : [];
}

export async function fetchDailySummary(date?: string, fetchImpl: typeof fetch = fetch): Promise<DailySummary> {
  const payload = await request("/local/dingtalk/summary", {
    method: "GET",
    query: date ? { date } : undefined,
  }, fetchImpl);
  const summary = asSummary(payload.data);
  if (!summary) throw new DingtalkClientError("invalid_response");
  return summary;
}

export async function fetchSummaryStatus(fetchImpl: typeof fetch = fetch): Promise<SummaryStatus> {
  const payload = await request("/local/dingtalk/summary/status", { method: "GET" }, fetchImpl);
  const status = asStatus(payload.data);
  if (!status) throw new DingtalkClientError("invalid_response");
  return status;
}

export async function startDailySummary(date?: string, fetchImpl: typeof fetch = fetch): Promise<SummaryStatus> {
  const payload = await request("/local/dingtalk/summary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(date ? { date } : {}),
  }, fetchImpl);
  const status = asStatus(payload.data);
  if (!status) throw new DingtalkClientError("invalid_response");
  return status;
}

export async function fetchDailyMessages(
  date: string,
  chatId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DailyMessages> {
  const payload = await request("/local/dingtalk/daily-messages", {
    method: "GET",
    query: { date, chatId },
  }, fetchImpl);
  if (!isRecord(payload.data) || !Array.isArray(payload.data.messages)) {
    throw new DingtalkClientError("invalid_response");
  }
  const messages: DailyMessage[] = payload.data.messages.flatMap((item) => {
    if (!isRecord(item) || typeof item.messageId !== "string") return [];
    return [{
      messageId: item.messageId,
      sender: typeof item.sender === "string" ? item.sender : "",
      text: typeof item.text === "string" ? item.text : "",
      time: typeof item.time === "string" ? item.time : "",
    }];
  });
  return {
    date: typeof payload.data.date === "string" ? payload.data.date : date,
    chatId: typeof payload.data.chatId === "string" ? payload.data.chatId : chatId,
    complete: payload.data.complete === true,
    messages,
  };
}

export function dingtalkErrorMessage(error: unknown): string {
  const code = error instanceof DingtalkClientError ? error.code : "unavailable";
  const messages: Record<string, string> = {
    unavailable: "本机服务未响应，请确认已启动 npm run dev:function。",
    invalid_request: "待办内容不完整或格式不对，请检查标题、截止时间与优先级。",
    invalid_date: "日期格式应为 YYYY-MM-DD。",
    user_id_unavailable: "无法解析本人钉钉 userId：请确认 dws 已登录，或用 DINGTALK_USER_ID 覆盖。",
    busy: "同一请求正在处理中，请稍候再试。",
    dws_missing: "dws 未安装或不可用，请先在终端确认登录态。",
    todo_write_failed: "钉钉待办创建失败，未写入任何内容。",
    todo_verify_failed: "待办可能已创建，但读回校验不一致；请到钉钉核对，本页不会自动重试。",
    todo_manual_check_required: "上次创建中断，待办可能已创建；请到钉钉核对后再决定是否新建，本页不会自动重试。",
    summary_stale: "上次生成进程已中断，状态已重置；可重新发起生成。",
    summary_not_found: "该日期还没有群消息总结。",
    message_cache_unavailable: "该群当天的消息缓存已不存在，无法展开证据。",
    historical_read_only: "历史日期产物只读，只能查看已有总结；生成从当前水位继续。",
    invalid_response: "本机服务返回了无法识别的数据。",
  };
  return messages[code] ?? "请求未完成，请稍后重试。";
}
