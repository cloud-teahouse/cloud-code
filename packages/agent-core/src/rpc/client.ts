import type { PromisableMethods, Promisify } from '#/utils/types';
import { createControlledPromise, objectMap } from '@antfu/utils';

import {
  fromCloudCodeErrorPayload,
  type CloudCodeErrorPayload,
  toCloudCodeErrorPayload,
} from '../errors';
import { abortable } from '../utils/abort';
import type { CoreAPI } from './core-api';
import { markLocalRpcMethod, materializeRpcPayload } from './payload';
import type { SDKAPI } from './sdk-api';

export interface RPCCallOptions {
  signal?: AbortSignal;
}

type RpcResponse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: CloudCodeErrorPayload };

export type RPCMethods<T> = {
  [K in keyof T]: T[K] extends (payload: infer Payload) => infer Return
    ? (payload: Payload, options?: RPCCallOptions) => Promisify<Return>
    : never;
};

export type RPCClient<Self extends Record<string, any>, Other extends Record<string, any>> = (
  self: PromisableMethods<Self>,
) => Promise<RPCMethods<Other>>;

export function createRPC<Left extends Record<string, any>, Right extends Record<string, any>>(): [
  RPCClient<Left, Right>,
  RPCClient<Right, Left>,
] {
  const left = createControlledPromise<PromisableMethods<Left>>();
  const right = createControlledPromise<PromisableMethods<Right>>();

  function cloneWithJson<T>(data: T): T {
    const serialized = JSON.stringify(data);
    return serialized === undefined ? (undefined as T) : (JSON.parse(serialized) as T);
  }

  function cloneForLocalRpc<T>(data: T, preserveJsonSemantics = false): T {
    if (preserveJsonSemantics) return cloneWithJson(data);
    try {
      return structuredClone(data);
    } catch {
      return cloneWithJson(data);
    }
  }

  function simulateNetwork<T>(data: T, preserveJsonSemantics = false): Promise<T> {
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try {
          resolve(cloneForLocalRpc(data, preserveJsonSemantics));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function abortableRpc<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    return signal === undefined ? promise : abortable(promise, signal);
  }

  function mapRpcFunction(fn: Function): Function {
    const mapped = async (payload: any, options?: RPCCallOptions) => {
      const signal = options?.signal;
      const rpcPayload = await simulateNetwork(materializeRpcPayload(payload));
      signal?.throwIfAborted();
      let response: RpcResponse;
      try {
        const handlerResult =
          signal === undefined ? fn(rpcPayload) : fn(rpcPayload, { signal });
        const value = await abortableRpc(Promise.resolve(handlerResult), signal);
        response = { ok: true, value };
      } catch (error) {
        signal?.throwIfAborted();
        response = { ok: false, error: toCloudCodeErrorPayload(error) };
      }
      // Error details are JSON wire data; preserve their coercions in-process too.
      const remoteResponse = await simulateNetwork(response, response.ok === false);
      if (remoteResponse.ok) return remoteResponse.value;
      throw fromCloudCodeErrorPayload(remoteResponse.error);
    };
    return markLocalRpcMethod(mapped);
  }

  function bindAllFunctions<T extends Record<string, any>>(obj: T): T {
    const bound: Record<string, unknown> = {};
    let current: object | null = obj;

    while (current !== null && current !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(current)) {
        if (key === 'constructor' || Object.hasOwn(bound, key)) {
          continue;
        }

        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (typeof descriptor?.value === 'function') {
          bound[key] = descriptor.value.bind(obj);
        }
      }

      current = Object.getPrototypeOf(current);
    }

    return bound as T;
  }

  async function leftClient(self: PromisableMethods<Left>): Promise<RPCMethods<Right>> {
    left.resolve(bindAllFunctions(self));
    return objectMap(await right, (key, fn) => [key, mapRpcFunction(fn)]) as RPCMethods<Right>;
  }

  async function rightClient(self: PromisableMethods<Right>): Promise<RPCMethods<Left>> {
    right.resolve(bindAllFunctions(self));
    return objectMap(await left, (key, fn) => [key, mapRpcFunction(fn)]) as RPCMethods<Left>;
  }

  return [leftClient, rightClient];
}

export type CoreRPCClient = RPCClient<CoreAPI, SDKAPI>;
export type SDKRPCClient = RPCClient<SDKAPI, CoreAPI>;

export type CoreRPC = RPCMethods<CoreAPI>;
