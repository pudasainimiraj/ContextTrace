import { createContext, useContext } from "react";
import type { ServiceStatus } from "../../../shared/api.ts";

export const ServiceStatusContext = createContext<ServiceStatus | null>(null);

export function useServiceStatus(): ServiceStatus | null {
  return useContext(ServiceStatusContext);
}
