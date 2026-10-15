import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  CrmClientError,
  crmErrorMessage,
  fetchCrmSnapshot,
  fetchRefreshStatus,
  startCrmRefresh,
} from "../../lib/crm-client";
import type { CrmSnapshot, RefreshStatus } from "../../lib/crm-types";

const REFRESH_POLL_MS = 3_000;

interface CrmState {
  snapshot: CrmSnapshot | null;
  refresh: RefreshStatus | null;
  loading: boolean;
  error: string;
  missing: boolean;
  refreshNow: () => void;
}

const CrmContext = createContext<CrmState | null>(null);

export function CrmProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<CrmSnapshot | null>(null);
  const [refresh, setRefresh] = useState<RefreshStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const result = await fetchCrmSnapshot();
      if (!mounted.current) return;
      setSnapshot(result.snapshot);
      setRefresh(result.refresh);
      setMissing(false);
      setError("");
    } catch (caught) {
      if (!mounted.current) return;
      const isMissing = caught instanceof CrmClientError && caught.code === "snapshot_unavailable";
      setMissing(isMissing);
      setError(isMissing ? "" : crmErrorMessage(caught));
      if (isMissing) fetchRefreshStatus().then((status) => mounted.current && setRefresh(status)).catch(() => undefined);
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
      fetchRefreshStatus()
        .then((status) => {
          if (!mounted.current) return;
          setRefresh(status);
          if (status.state !== "running") void load();
        })
        .catch((caught: unknown) => mounted.current && setError(crmErrorMessage(caught)));
    }, REFRESH_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const refreshNow = useCallback(() => {
    startCrmRefresh()
      .then((status) => { if (mounted.current) { setRefresh(status); setError(""); } })
      .catch((caught: unknown) => mounted.current && setError(crmErrorMessage(caught)));
  }, []);

  return (
    <CrmContext.Provider value={{ snapshot, refresh, loading, error, missing, refreshNow }}>
      {children}
    </CrmContext.Provider>
  );
}

export function useCrm(): CrmState {
  const value = useContext(CrmContext);
  if (!value) throw new Error("useCrm must be used inside CrmProvider");
  return value;
}
