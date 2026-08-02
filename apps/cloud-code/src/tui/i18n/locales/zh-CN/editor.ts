import type { editor as enDomain } from '../en/editor';

/** 贡献规范见 common.ts。 */

export const editor: Record<keyof typeof enDomain, string> = {
  // ── 输入编辑器 ──
  'editor.shellMode.label': '! shell 模式',
  'editor.placeholder': '输入消息（? 查看快捷键）',

  // ── 自动补全 ──
  'editor.autocomplete.noMatch': '  没有匹配的命令',
};
