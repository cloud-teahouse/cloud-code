import type { enMessages } from '../en';
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
 * 简体中文消息表。类型上强制与 en 字典完整同形：缺 key / 多 key 都是
 * 编译期错误（各域文件已逐个 `Record<keyof typeof enX, string>` 约束，
 * 这里再做一次整体兜底）。
 */
export const zhCnMessages: Record<keyof typeof enMessages, string> = {
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
};
