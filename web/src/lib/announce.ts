import { createContext, useContext } from "react";

export type Announce = (text: string) => void;

export const AnnounceContext = createContext<Announce>(() => {});

export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}
