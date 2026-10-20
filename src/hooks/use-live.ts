/**
 * useLive — 实时事件总线（SSE）React 订阅 hook。
 *
 * 契约：useLive(topics, handler) → { status }。
 * - topics 以 join(",") 作为订阅键：内容不变则不因数组字面量重建连接；
 * - handler 存 ref：回调身份变化不触发重订阅（避免每次 render 断开重连）；
 * - 卸载自动 close（清定时器、断流、摘 visibility 监听），status 复位 closed。
 * 依赖 src/lib/live-client.ts：指数退避、since 续传、hidden 暂停由其内部处理。
 */

import { useEffect, useRef, useState } from "react";

import { createLiveClient, type LiveClientEvent, type LiveClientOptions, type LiveStatus } from "../lib/live-client";

export type { LiveClientEvent, LiveStatus };

export interface UseLiveResult {
  readonly status: LiveStatus;
}

export function useLive(
  topics: readonly string[],
  handler: (event: LiveClientEvent) => void,
  options: Omit<LiveClientOptions, "topics" | "onEvent" | "onStatus"> = {},
): UseLiveResult {
  const [status, setStatus] = useState<LiveStatus>("closed");
  const handlerRef = useRef(handler);
  const optionsRef = useRef(options);

  useEffect(() => {
    handlerRef.current = handler;
    optionsRef.current = options;
  });

  const topicKey = topics.join(",");
  useEffect(() => {
    if (!topicKey) return undefined;
    const client = createLiveClient({
      ...optionsRef.current,
      topics: topicKey.split(","),
      onEvent: (event) => handlerRef.current(event),
      onStatus: setStatus,
    });
    return () => {
      client.close();
      setStatus("closed");
    };
  }, [topicKey]);

  return { status };
}
