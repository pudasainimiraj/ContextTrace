import type { ReactNode } from "react";
import type { ServiceStatus } from "../../../shared/api.ts";
import { api } from "../lib/api.ts";
import { usePolling } from "../lib/polling.ts";
import { ServiceStatusContext } from "../lib/service-status.ts";

const STATUS_POLL_MS = 60_000;

/** One poll of GET /api/status for the whole page: the strip, the home list and the indexing panel read it. */
export function ServiceStatusProvider({ children }: { children: ReactNode }) {
  const { data } = usePolling<ServiceStatus>(() => api<ServiceStatus>("/api/status", "read"), STATUS_POLL_MS, "service-status");
  return <ServiceStatusContext.Provider value={data}>{children}</ServiceStatusContext.Provider>;
}
