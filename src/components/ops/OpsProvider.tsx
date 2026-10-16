import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  OpsClientError,
  fetchOpsDigest,
  fetchOpsRefreshStatus,
  opsErrorMessage,
  startOpsRefresh,
} from "../../lib/ops-client";
import type { OpsDigest, OpsRefreshStatus } from "../../lib/ops-types";

const REFRESH_POLL_MS = 3_000;

interface OpsState {
  digest: OpsDigest | null;
  refresh: OpsRefreshStatus | null;
  loading: boolean;
  error: string;
  missing: boolean;
  refreshNow: () => void;
}

const OpsContext = createContext<OpsState | null>(null);

export function OpsProvider({ children }: { children: React.ReactNode }) {
  const [digest, setDigest] = useState<OpsDigest | null>(null);
  const [refresh, setRefresh] = useState<OpsRefreshStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const result = await fetchOpsDigest();
      if (!mounted.current) return;
      setDigest(result.digest);
      setRefresh(result.refresh);
      setMissing(false);
      setError("");
    } catch (caught) {
      if (!mounted.current) return;
      const isMissing = caught instanceof OpsClientError && caught.code === "digest_unavailable";
      setMissing(isMissing);
      setError(isMissing ? "" : opsErrorMessage(caught));
      if (isMissing) fetchOpsRefreshStatus().then((status) => mounted.current && setRefresh(status)).catch(() => undefined);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  const running = refresh?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      fetchOpsRefreshStatus()
        .then((status) => {
          if (!mounted.current) return;
          setRefresh(status);
          if (status.state !== "running") void load();
        })
        .catch((caught: unknown) => mounted.current && setError(opsErrorMessage(caught)));
    }, REFRESH_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const refreshNow = useCallback(() => {
    startOpsRefresh()
      .then((status) => { if (mounted.current) { setRefresh(status); setError(""); } })
      .catch((caught: unknown) => mounted.current && setError(opsErrorMessage(caught)));
  }, []);

  return (
    <OpsContext.Provider value={{ digest, refresh, loading, error, missing, refreshNow }}>
      {children}
    </OpsContext.Provider>
  );
}

export function useOps(): OpsState {
  const value = useContext(OpsContext);
  if (!value) throw new Error("useOps must be used inside OpsProvider");
  return value;
}
