import {
  SECONDARY_DERIVED_MODEL_ALIAS,
  secondaryModelPatch,
  type CloudCodeConfig,
  type SecondaryModelConfig,
} from '../config';
import { CloudCodeError, ErrorCodes } from '../errors';

/**
 * Subagent model binding — the secondary-model half of the spawn decision.
 *
 * `[secondary_model]` is a recipe: `model` points at a `[models]` entry and
 * every remaining field is a subagent-only patch. When patch fields exist,
 * the config loader synthesizes the derived model entry
 * ({@link SECONDARY_DERIVED_MODEL_ALIAS}) into the in-memory `models` view
 * (see `applySecondaryModelConfig` in `config/secondary-model.ts`), so the
 * binding here resolves it by alias like any other model. The
 * `CLOUD_CODE_SECONDARY_MODEL` / `CLOUD_CODE_SECONDARY_EFFORT` env vars
 * override `model` / `default_effort` in memory only — they are overlaid at
 * config load time, so by the time a session reads `config.secondaryModel`
 * the env has already been applied.
 *
 * Unlike upstream, Cloud Code's secondary model is a stable feature: it is
 * not gated behind an experiment flag.
 */

/** The Agent/AgentSwarm `model` parameter value that selects the `[secondary_model]` config. */
export const SECONDARY_MODEL_KEYWORD = 'secondary';

/** The `[secondary_model]` section after resolution. */
export interface SecondaryModelResolution {
  readonly model: string | undefined;
  readonly effort: string | undefined;
}

/**
 * The `[secondary_model]` recipe in effect for a session (used by the
 * startup-warning computation). Cloud Code's secondary model is a stable
 * feature, so unlike upstream this is not gated on an experiment flag.
 */
export function resolveSecondaryModelRecipe(
  config: CloudCodeConfig | undefined,
): SecondaryModelConfig | undefined {
  return config?.secondaryModel;
}

/**
 * Resolve the `[secondary_model]` binding for a subagent spawn. A recipe with
 * patch fields binds the synthesized derived entry; a pointer-only recipe
 * binds the pointed entry directly. `default_effort` applies as the explicit
 * subagent thinking effort; without it the child inherits the caller's level.
 */
export function resolveSecondaryModel(
  config: SecondaryModelConfig | undefined,
): SecondaryModelResolution {
  const model = nonBlank(config?.model);
  return {
    model:
      model !== undefined && secondaryModelPatch(config) !== undefined
        ? SECONDARY_DERIVED_MODEL_ALIAS
        : model,
    effort: nonBlank(config?.defaultEffort),
  };
}

/**
 * The "Available models" block appended to the `Agent` / `AgentSwarm` tool
 * descriptions so the parent model knows it can pick. `undefined` when the
 * secondary model is not configured or the caller's model is not bound yet.
 */
export function buildSubagentModelDescriptions(
  config: CloudCodeConfig | undefined,
  callerModelAlias: string | undefined,
): string | undefined {
  const secondaryModel = resolveSecondaryModel(config?.secondaryModel).model;
  if (secondaryModel === undefined || callerModelAlias === undefined) return undefined;
  return [
    'Available models (pass via model):',
    `- secondary: ${secondaryModel} — the configured secondary model; prefer it for routine subagent tasks`,
    `- primary: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks`,
  ].join('\n');
}

/**
 * Strip the `model` property from a subagent collaboration tool's advertised
 * JSON schema. Callers that gate the parameter off use this so the
 * secondary-model concept never enters the prompt, and a stray `model`
 * argument is rejected instead of silently inheriting the caller's model.
 * Returns the input unchanged when there is no `model` property; otherwise a
 * shallow copy — the input is never mutated, so callers can keep both
 * variants as shared constants.
 */
export function stripSubagentModelParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (typeof properties !== 'object' || properties === null || !('model' in properties)) {
    return parameters;
  }
  const nextProperties = { ...(properties as Record<string, unknown>) };
  delete nextProperties['model'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const required = parameters['required'];
  if (Array.isArray(required) && required.includes('model')) {
    next['required'] = required.filter((entry) => entry !== 'model');
  }
  return next;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Point a spawn-time model resolution failure at the secondary-model
 * configuration when the bound model is not the caller's own — otherwise the
 * parent model sees a bare "model not configured" error with no hint that it
 * comes from `[secondary_model]`.
 */
export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string | undefined,
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (!(error instanceof CloudCodeError) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  // ProviderManager tags only the missing-alias failure with details.model;
  // malformed aliases and providers must keep their own actionable errors.
  if (error.details?.['model'] !== boundModel) return error;
  return new CloudCodeError(
    ErrorCodes.CONFIG_INVALID,
    `[secondary_model].model is "${boundModel}", but no model with that name is configured. ` +
      'Fix the [secondary_model] section or define the model.',
    { details: error.details },
  );
}
