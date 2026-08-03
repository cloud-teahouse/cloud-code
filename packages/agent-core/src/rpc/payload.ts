const RPC_PAYLOAD_OVERLAY = Symbol('cloud-code.rpc-payload-overlay');
const LOCAL_RPC_METHOD = Symbol('cloud-code.local-rpc-method');

interface RpcPayloadOverlay {
  readonly [RPC_PAYLOAD_OVERLAY]: true;
  readonly payload: unknown;
  readonly extraPayload: unknown;
}

export function wrapRpcPayload(payload: unknown, extraPayload: unknown): unknown {
  return {
    [RPC_PAYLOAD_OVERLAY]: true,
    payload,
    extraPayload,
  } satisfies RpcPayloadOverlay;
}

export function markLocalRpcMethod<T extends Function>(method: T): T {
  Object.defineProperty(method, LOCAL_RPC_METHOD, { value: true });
  return method;
}

export function isLocalRpcMethod(value: unknown): value is Function {
  return (
    typeof value === 'function' &&
    (value as Partial<{ readonly [LOCAL_RPC_METHOD]: true }>)[LOCAL_RPC_METHOD] === true
  );
}

function isRpcPayloadOverlay(value: unknown): value is RpcPayloadOverlay {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<RpcPayloadOverlay>)[RPC_PAYLOAD_OVERLAY] === true
  );
}

function copyEnumerableProperties(target: Record<PropertyKey, unknown>, source: unknown): void {
  if (source === null || source === undefined) return;
  const sourceObject = new Object(source) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(sourceObject)) {
    if (!Object.prototype.propertyIsEnumerable.call(sourceObject, key)) continue;
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value: sourceObject[key],
      writable: true,
    });
  }
}

export function materializeRpcPayload(payload: unknown): unknown {
  if (!isRpcPayloadOverlay(payload)) return payload;

  const extraPayloads: unknown[] = [];
  let current: unknown = payload;
  while (isRpcPayloadOverlay(current)) {
    extraPayloads.push(current.extraPayload);
    current = current.payload;
  }
  extraPayloads.reverse();
  const materialized: Record<PropertyKey, unknown> = {};
  copyEnumerableProperties(materialized, current);
  for (const extraPayload of extraPayloads) {
    copyEnumerableProperties(materialized, extraPayload);
  }
  return materialized;
}
