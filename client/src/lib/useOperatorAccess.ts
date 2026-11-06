import { useSyncExternalStore } from "react";
import { operatorTokenSnapshot, subscribeOperatorToken } from "./operatorToken";

export function useOperatorAccess() {
  return useSyncExternalStore(subscribeOperatorToken, operatorTokenSnapshot, operatorTokenSnapshot);
}
