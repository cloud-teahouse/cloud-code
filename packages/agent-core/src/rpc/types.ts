import type { RPCMethods } from './client';
import { isLocalRpcMethod, markLocalRpcMethod, wrapRpcPayload } from './payload';

type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

type WithExtraPayload<T, U> = {
  [K in keyof T]: T[K] extends (payload: infer P) => infer R
    ? (payload: Prettify<P & U>) => R
    : never;
};

export type WithAgentId<T> = WithExtraPayload<T, { readonly agentId: string }>;
export type WithSessionId<T> = WithExtraPayload<T, { readonly sessionId: string }>;

export function proxyWithExtraPayload<T, U>(
  methods: RPCMethods<WithExtraPayload<T, U>>,
  extraPayload: U,
): RPCMethods<T> {
  return new Proxy(methods as any, {
    get(target, prop) {
      const origMethod = target[prop as keyof typeof target];
      if (typeof origMethod !== 'function') {
        return origMethod;
      }
      const wrappedMethod = (payload: any, ...args: any) => {
        const rpcPayload = isLocalRpcMethod(origMethod)
          ? wrapRpcPayload(payload, extraPayload)
          : { ...payload, ...extraPayload };
        return origMethod(rpcPayload, ...args);
      };
      return isLocalRpcMethod(origMethod) ? markLocalRpcMethod(wrappedMethod) : wrappedMethod;
    },
  });
}
