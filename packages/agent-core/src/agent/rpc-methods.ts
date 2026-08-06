/**
 * RPC dispatch surface (`Agent.rpcMethods`): the payload handlers a session
 * exposes over the agent RPC channel. Each handler is a thin forward into the
 * subsystem that owns the state (turn, tools, config, modes, background,
 * goal, cron); the busy-guard throws live here so every RPC fails uniformly
 * while a turn or compaction is in flight.
 */

import { randomUUID } from 'node:crypto';

import { CloudCodeError, ErrorCodes } from '#/errors';
import type { AgentAPI } from '#/rpc';
import { expandCommandArguments } from '../plugin/commands';
import type { PromisableMethods } from '../utils/types';
import type { Agent } from './agent';
import type { PluginCommandOrigin } from './context';
import { buildSandboxStatus } from './sandbox-status';

export function buildRpcMethods(agent: Agent): PromisableMethods<AgentAPI> {
  return {
    prompt: (payload) => {
      agent.turn.prompt(payload.input);
    },
    runShellCommand: (payload) => agent.tools.runShellCommand(payload.command, payload.commandId),
    cancelShellCommand: (payload) => agent.tools.cancelShellCommand(payload.commandId),
    steer: (payload) => {
      agent.turn.steer(payload.input);
    },
    cancel: (payload) => {
      agent.turn.cancel(payload.turnId, undefined, { withdrawInput: payload.withdrawInput });
    },
    undoHistory: (payload) => {
      if (agent.turn.hasActiveTurn || agent.fullCompaction.isCompacting) {
        throw new CloudCodeError(
          ErrorCodes.TURN_AGENT_BUSY,
          'Cannot undo history while the agent is busy',
        );
      }
      agent.context.undo(payload.count);
    },
    rewindFiles: async (payload) => {
      const result = await agent.snapshot.rewindFiles(payload.count);
      return result;
    },
    setThinking: (payload) => {
      agent.config.setThinkingEffort(payload.effort);
    },
    setServiceTier: (payload) => {
      agent.config.setServiceTier(payload.serviceTier ?? undefined);
    },
    setSandboxMode: (payload) => {
      agent.config.setSandboxMode(payload.mode ?? undefined);
    },
    setPermission: (payload) => {
      agent.permission.setMode(payload.mode);
    },
    setModel: (payload) => {
      // Validate the alias resolves before recording it so resume / runtime
      // callers fail fast on missing aliases instead of deferring to the
      // next prompt.
      const resolved = agent.modelProvider?.resolveProviderConfig(payload.model);
      if (agent.config.modelAlias !== payload.model) {
        agent.config.update({ modelAlias: payload.model });
      }
      return {
        model: payload.model,
        providerName: resolved?.providerName,
      };
    },
    getModel: () => {
      return agent.config.modelAlias ?? '';
    },
    enterPlan: async () => {
      await agent.planMode.enter();
    },
    cancelPlan: (payload) => {
      agent.planMode.cancel(payload.id);
    },
    clearPlan: () => agent.planMode.clear(),
    enterSwarm: (payload) => {
      agent.swarmMode.enter(payload.trigger);
    },
    exitSwarm: () => {
      agent.swarmMode.exit();
    },
    getSwarmMode: () => {
      return agent.swarmMode.isActive;
    },
    enterCoordinator: () => {
      // Coordinator Mode is a main-thread role switch: a subagent is
      // already someone's worker and must never become a dispatcher.
      if (agent.type !== 'main') {
        throw new CloudCodeError(
          ErrorCodes.REQUEST_INVALID,
          'Coordinator Mode is only available on the main agent',
        );
      }
      agent.coordinatorMode.enter();
    },
    exitCoordinator: () => {
      if (agent.type !== 'main') {
        throw new CloudCodeError(
          ErrorCodes.REQUEST_INVALID,
          'Coordinator Mode is only available on the main agent',
        );
      }
      agent.coordinatorMode.exit();
    },
    getCoordinatorMode: () => {
      return agent.coordinatorMode.isActive;
    },
    beginCompaction: (payload) => {
      agent.fullCompaction.begin({ source: 'manual', instruction: payload.instruction });
    },
    cancelCompaction: () => {
      agent.fullCompaction.cancel();
    },
    registerTool: (payload) => {
      agent.tools.registerUserTool(payload);
    },
    unregisterTool: (payload) => {
      agent.tools.unregisterUserTool(payload.name);
    },
    setActiveTools: (payload) => {
      agent.tools.setActiveTools(payload.names);
    },
    stopBackground: (payload) => {
      void agent.background.stop(payload.taskId, payload.reason);
    },
    detachBackground: (payload) => agent.background.detach(payload.taskId),
    clearContext: () => {
      if (agent.turn.hasActiveTurn || agent.fullCompaction.isCompacting) {
        throw new CloudCodeError(
          ErrorCodes.TURN_AGENT_BUSY,
          'Cannot clear context while the agent is busy',
        );
      }
      agent.context.clear();
    },
    importContext: (payload) => {
      if (agent.turn.hasActiveTurn || agent.fullCompaction.isCompacting) {
        throw new CloudCodeError(
          ErrorCodes.TURN_AGENT_BUSY,
          'Cannot import context while the agent is busy',
        );
      }
      agent.context.importContext(payload.content, payload.source);
    },
    activateSkill: (payload) => {
      if (agent.skills === null) {
        throw new CloudCodeError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${payload.name}" was not found`);
      }
      agent.skills.activate(payload);
    },
    activatePluginCommand: (payload) => {
      const def = agent.pluginCommands.find(
        (d) => d.pluginId === payload.pluginId && d.name === payload.commandName,
      );
      if (def === undefined) {
        throw new CloudCodeError(
          ErrorCodes.REQUEST_INVALID,
          `Plugin command "${payload.pluginId}:${payload.commandName}" was not found`,
        );
      }
      const commandArgs = payload.args ?? '';
      const expanded = expandCommandArguments(def.body, commandArgs);
      const origin: PluginCommandOrigin = {
        kind: 'plugin_command',
        activationId: randomUUID(),
        pluginId: payload.pluginId,
        commandName: payload.commandName,
        commandArgs: payload.args,
        trigger: 'user-slash',
      };
      agent.emitEvent({
        type: 'plugin_command.activated',
        activationId: origin.activationId,
        pluginId: origin.pluginId,
        commandName: origin.commandName,
        commandArgs: origin.commandArgs,
        trigger: origin.trigger,
      });
      agent.turn.prompt([{ type: 'text', text: expanded }], origin);
    },
    startBtw: () => agent.subagentHost!.startBtw(),
    createGoal: (payload) => agent.goal.createGoal(payload),
    getGoal: () => agent.goal.getGoal(),
    pauseGoal: () => agent.goal.pauseGoal(),
    resumeGoal: () => agent.goal.resumeGoal(),
    cancelGoal: () => agent.goal.cancelGoal(),
    // `cron` is null for subagents, which never schedule; report an empty
    // list rather than failing the RPC so callers can poll uniformly.
    getCronTasks: () => ({ tasks: agent.cron?.listTaskSnapshots() ?? [] }),
    getBackgroundOutput: (payload) => agent.background.readOutput(payload.taskId, payload.tail),
    getContext: () => agent.context.data(),
    getConfig: () => agent.config.data(),
    getPermission: () => agent.permission.data(),
    getSandboxStatus: () =>
      buildSandboxStatus({
        sandboxConfig: agent.cloudCodeConfig?.sandbox,
        modeOverride: agent.config.sandboxMode,
        kaos: agent.kaos,
        homedir: agent.homedir,
        brandHomeDir: agent.brandHomeDir,
        skillRoots: agent.skills?.registry.getSkillRoots() ?? [],
        manager: agent.sandbox,
      }),
    getPlan: () => agent.planMode.data(),
    getUsage: () => agent.usage.data(),
    getTools: () => agent.tools.data(),
    getBackground: (payload) => agent.background.list(payload.activeOnly ?? false, payload.limit),
  };
}
