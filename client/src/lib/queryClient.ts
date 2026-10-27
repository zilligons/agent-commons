import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { buildOperatorRequest, hasOperatorToken, operatorRequestError, operatorTokenSnapshot, subscribeOperatorToken, OperatorRequestError } from "./operatorToken";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    let code: unknown;
    if (res.status === 503) {
      try {
        const body: unknown = await res.json();
        if (body && typeof body === "object" && "code" in body && body.code === "OPERATOR_UNCONFIGURED") code = "OPERATOR_UNCONFIGURED";
      } catch {}
    }
    throw operatorRequestError(res.status, code);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const version = operatorTokenSnapshot().version;
  const request = buildOperatorRequest(method, url, data);
  let res: Response;
  try { res = await fetch(request.url, request.init); }
  catch { throw new Error("Unable to reach the same-origin API. Please try again."); }
  if (version !== operatorTokenSnapshot().version) throw new OperatorRequestError("Operator access changed. Please try again.");

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey, signal }) => {
    const version = operatorTokenSnapshot().version;
    const request = buildOperatorRequest("GET", queryKey.join("/"));
    let res: Response;
    try { res = await fetch(request.url, { ...request.init, signal }); }
    catch { throw new Error("Unable to reach the same-origin API. Please try again."); }
    if (version !== operatorTokenSnapshot().version) throw new OperatorRequestError("Operator access changed. Please try again.");

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    const result = await res.json();
    if (version !== operatorTokenSnapshot().version) throw new OperatorRequestError("Operator access changed. Please try again.");
    return result;
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      enabled: () => hasOperatorToken(),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

subscribeOperatorToken(() => {
  void queryClient.cancelQueries();
  queryClient.clear();
});
