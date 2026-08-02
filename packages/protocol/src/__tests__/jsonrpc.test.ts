import { describe, it, expect } from 'vitest';

import { kimiErrorPayloadSchema } from '../events';
import {
  CLOUD_CODE_PROTOCOL_VERSION,
  eventNotificationSchema,
  initializeParamsSchema,
  initializeResultSchema,
  interactionResolvedParamsSchema,
  jsonRpcMessageSchema,
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
  JSON_RPC_ERROR,
} from '../jsonrpc';

describe('jsonRpcRequestSchema', () => {
  it('accepts a forward CoreAPI-shaped request (golden)', () => {
    const golden = {
      jsonrpc: '2.0',
      id: 12,
      method: 'prompt',
      params: {
        sessionId: 'session-1',
        agentId: 'main',
        input: [{ type: 'text', text: 'hello' }],
      },
    };
    expect(jsonRpcRequestSchema.parse(golden)).toEqual(golden);
    expect(jsonRpcMessageSchema.parse(golden)).toEqual(golden);
  });

  it('accepts a reverse SDKAPI request (golden)', () => {
    const golden = {
      jsonrpc: '2.0',
      id: 'srv-1',
      method: 'requestApproval',
      params: {
        sessionId: 'session-1',
        agentId: 'main',
        turnId: 3,
        toolCallId: 'call-1',
        toolName: 'Bash',
        action: 'Bash',
        display: { kind: 'text', text: 'echo hi' },
      },
    };
    expect(jsonRpcRequestSchema.parse(golden)).toEqual(golden);
  });

  it('rejects a request without the 2.0 marker', () => {
    expect(() => jsonRpcRequestSchema.parse({ id: 1, method: 'prompt' })).toThrow();
  });
});

describe('jsonRpcResponseSchema', () => {
  it('accepts a success response (golden)', () => {
    const golden = { jsonrpc: '2.0', id: 12, result: null };
    expect(jsonRpcResponseSchema.parse(golden)).toEqual(golden);
  });

  it('accepts an error response carrying a CloudCodeErrorPayload in data (golden)', () => {
    const golden = {
      jsonrpc: '2.0',
      id: 12,
      error: {
        code: JSON_RPC_ERROR.SERVER_ERROR,
        message: 'Session not found.',
        data: {
          code: 'session.not_found',
          message: 'Session not found.',
          retryable: false,
        },
      },
    };
    expect(jsonRpcResponseSchema.parse(golden)).toEqual(golden);
    const parsed = jsonRpcResponseSchema.parse(golden);
    expect(kimiErrorPayloadSchema.parse(parsed.error?.data)).toEqual(golden.error.data);
  });
});

describe('handshake schemas', () => {
  it('accepts an initialize request payload (golden)', () => {
    const golden = {
      clientInfo: { name: 'cloud-code-cli', version: '0.1.0' },
      capabilities: { sessionIds: ['session-1'] },
      protocolVersion: CLOUD_CODE_PROTOCOL_VERSION,
    };
    expect(initializeParamsSchema.parse(golden)).toEqual(golden);
  });

  it('accepts an initialize result payload (golden)', () => {
    const golden = {
      serverInfo: { name: 'cloud-code-server', version: '0.1.0' },
      protocolVersion: CLOUD_CODE_PROTOCOL_VERSION,
      homeDir: '/home/user/.cloud-code',
    };
    expect(initializeResultSchema.parse(golden)).toEqual(golden);
  });

  it('rejects an initialize payload without clientInfo', () => {
    expect(() => initializeParamsSchema.parse({ capabilities: {} })).toThrow();
  });
});

describe('event notification schema', () => {
  it('accepts an event notification frame (golden)', () => {
    const golden = {
      jsonrpc: '2.0',
      method: 'event',
      params: {
        sessionId: 'session-1',
        agentId: 'main',
        type: 'assistant.delta',
        turnId: 3,
        delta: 'chunk',
      },
    };
    expect(eventNotificationSchema.parse(golden)).toEqual(golden);
  });

  it('rejects an event notification with an unknown event type', () => {
    expect(() =>
      eventNotificationSchema.parse({
        jsonrpc: '2.0',
        method: 'event',
        params: { sessionId: 's', agentId: 'main', type: 'not.an.event' },
      }),
    ).toThrow();
  });
});

describe('interactionResolvedParamsSchema', () => {
  it('accepts the interaction/resolved payload (golden)', () => {
    const golden = { sessionId: 'session-1', toolCallId: 'call-1' };
    expect(interactionResolvedParamsSchema.parse(golden)).toEqual(golden);
  });

  it('rejects a payload without toolCallId', () => {
    expect(() => interactionResolvedParamsSchema.parse({ sessionId: 's' })).toThrow();
  });
});
