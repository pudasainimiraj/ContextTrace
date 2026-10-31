import { createContext, useContext } from "react";
import type { ServiceStatus } from "../../../shared/api.ts";
import type { Polled } from "./polling.ts";

export type ServiceStatusPoll = Pick<Polled<ServiceStatus>, "data" | "error" | "reload">;

export const ServiceStatusContext = createContext<ServiceStatusPoll>({ data: null, error: null, reload: () => {} });

export function useServiceStatus(): ServiceStatus | null {
  return useContext(ServiceStatusContext).data;
}

/** The status with its load error and a reload, for the views that show a failed fetch. */
export function useServiceStatusPoll(): ServiceStatusPoll {
  return useContext(ServiceStatusContext);
}
