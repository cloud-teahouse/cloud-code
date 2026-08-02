import { approval } from './approval';
import { commands } from './commands';
import { common } from './common';
import { controllers } from './controllers';
import { coordinator } from './coordinator';
import { dialogs } from './dialogs';
import { editor } from './editor';
import { footer } from './footer';
import { help } from './help';
import { messages } from './messages';
import { notices } from './notices';
import { panels } from './panels';
import { plugins } from './plugins';
import { selectors } from './selectors';
import { status } from './status';
import { swarm } from './swarm';
import { teams } from './teams';
import { tokenActivity } from './token-activity';
import { toolResults } from './tool-results';
import { utils } from './utils';
import { welcome } from './welcome';
import { workflows } from './workflows';
import { errors } from './errors';

/**
 * English messages — source of truth. `MessageKey` is derived from this
 * object; other locales must be complete `Record<MessageKey, string>` maps,
 * so a missing/extra key there is a compile-time error.
 */
export const enMessages = {
  ...common,
  ...welcome,
  ...help,
  ...commands,
  ...approval,
  ...footer,
  ...dialogs,
  ...status,
  ...plugins,
  ...editor,
  ...messages,
  ...swarm,
  ...teams,
  ...coordinator,
  ...panels,
  ...notices,
  ...selectors,
  ...controllers,
  ...utils,
  ...workflows,
  ...tokenActivity,
  ...toolResults,
  ...errors,
} as const;

export type MessageKey = keyof typeof enMessages;
