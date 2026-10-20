/**
 * Live bridge（实时事件总线）— public entry, mirroring report-bridge.ts / notify-bridge.ts:
 * implementation lives in ./live/ and this file re-exports the public surface
 * so the router and tests can import from dev/live-bridge.ts.
 *
 * 负责人接线提示（本批不改 dev/local-router.ts）：
 * - 路由表常量 LIVE_ROUTES：GET /local/events；
 * - createBus() 桥内单例 + createProducers({cacheDir, bus}).start()；
 * - GET /local/events → handleEvents(request, bus)（SSE 流式响应，
 *   需要 dev/function-local-node.ts 以流式转发 response.body，见交接说明）。
 */
export { BUS_BUFFER_LIMIT, createBus, type Bus, type BusEvent, type BusOptions } from "./live/bus.ts";
export {
  handleEvents,
  LIVE_EVENTS_PATH,
  LIVE_PING_MS,
  LIVE_ROUTES,
  LIVE_TOPICS,
  LOOPBACK_HOSTNAMES,
  type HandleEventsOptions,
  type LiveScheduler,
  type LiveSchedulerHandle,
  type LiveTopic,
} from "./live/live-bridge.ts";
export {
  createProducers,
  DEFAULT_PRODUCER_INTERVAL_MS,
  PRODUCER_SOURCES,
  type FileObservation,
  type ProducerSource,
  type Producers,
  type ProducersOptions,
  type ProducersState,
} from "./live/producers.ts";
