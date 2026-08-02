import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from '@cloud-code/sdk';

import { t } from '../../i18n';

import { adaptApprovalRequest } from './adapter';
import type { ApprovalController } from './controller';

export function createApprovalRequestHandler(
  controller: ApprovalController,
  onResponse?: (request: ApprovalRequest, response: ApprovalResponse) => void,
): ApprovalHandler {
  return async (event): Promise<ApprovalResponse> => {
    try {
      const response = await controller.show(adaptApprovalRequest(event));
      onResponse?.(event, response);
      return response;
    } catch {
      const response: ApprovalResponse = {
        decision: 'cancelled',
        feedback: t('utils.reverseRpc.approvalHandlerFailed'),
      };
      onResponse?.(event, response);
      return response;
    }
  };
}
