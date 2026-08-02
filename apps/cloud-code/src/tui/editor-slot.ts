// Editor slot ownership types.
//
// The editor slot (editorContainer in the bottom slot) hosts either the real
// editor or one replacement panel at a time. Panels fall into two classes:
//
// - dialog: user-initiated overlays (help, session picker, slash-command
//   selectors). They can be preempted: a new mount closes them through their
//   registered onPreempt callback so their bookkeeping unwinds exactly as a
//   user cancel would.
// - blocking: agent-blocking panels (approval, question). They own an
//   outstanding RPC that must be answered through the UI; they are never
//   preempted. A mount requested while a blocking panel owns the slot is
//   queued and mounted when the slot frees, and cancelling a still-queued
//   panel via restoreEditor(handle) simply drops the queue entry.

export type EditorSlotKind = 'dialog' | 'blocking';

export interface EditorSlotHandle {
  readonly id: number;
}

export interface EditorSlotMountOptions {
  /** Defaults to 'dialog'. */
  readonly kind?: EditorSlotKind;
  /**
   * Close semantics invoked when this panel is preempted by a newer mount.
   * Pass the same callback the panel's own cancel/close path uses; its
   * restoreEditor(handle) call becomes a no-op because ownership has already
   * transferred.
   */
  readonly onPreempt?: () => void;
}
