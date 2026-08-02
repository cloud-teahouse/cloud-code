import { CLI_COMMAND_NAME } from '#/constant/app';
import { Command, InvalidArgumentError, Option } from 'commander';

import type { CLIOptions } from './options';
import { registerDoctorCommand } from './sub/doctor';
import { registerExportCommand } from './sub/export';
import { registerLoginCommand } from './sub/login';
import { registerProviderCommand } from './sub/provider';

export type MainCommandHandler = (opts: CLIOptions) => void;
export type PluginNodeRunnerHandler = (entry: string, args: readonly string[]) => void;
export type UpgradeCommandHandler = () => void | Promise<void>;
export type ServeCommandHandler = (opts: {
  transport: string | undefined;
  uiMode: string | undefined;
  host: string | undefined;
  port: string | undefined;
  token: string | undefined;
}) => void;

export function createProgram(
  version: string,
  onMain: MainCommandHandler,
  onPluginNodeRunner: PluginNodeRunnerHandler = () => {},
  onUpgrade: UpgradeCommandHandler = () => {},
  onServe: ServeCommandHandler = () => {},
): Command {
  const program = new Command(CLI_COMMAND_NAME)
    .description('Cloud Code CLI — The Starting Point for Next-Gen Agents')
    .version(version, '-V, --version')
    .allowUnknownOption(false)
    .configureHelp({ helpWidth: 100 })
    .helpOption('-h, --help', 'Show help.')
    .usage('[options] [command]')
    .addHelpText('after', '\nDocumentation:        https://github.com/cloud-teahouse/cloud-code\n');

  program
    .addOption(
      new Option(
        '-S, --session [id]',
        'Resume a session. With ID: resume that session. Without ID: interactively pick.',
      ).argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .addOption(
      new Option('-r, --resume [id]')
        .hideHelp()
        .argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .option('-c, --continue', 'Continue the previous session for the working directory.', false)
    .addOption(new Option('-C').hideHelp().default(false))
    .option('-y, --yolo', 'Auto-approve regular tool calls; the agent may still ask questions.', false)
    .option('--auto', 'Start in auto permission mode: fully autonomous, the agent will not ask questions.', false)
    .addOption(
      new Option(
        '-m, --model <model>',
        'LLM model alias to use for this invocation. Defaults to default_model in config.toml.',
      ),
    )
    .addOption(
      new Option(
        '-p, --prompt <prompt>',
        'Run one prompt non-interactively and print the response.',
      ),
    )
    .addOption(
      new Option(
        '--output-format <format>',
        'Output format for prompt mode. Defaults to text.',
      ).choices(['text', 'stream-json']),
    )
    .addOption(
      new Option(
        '--skills-dir <dir>',
        'Load skills from this directory instead of auto-discovered user and project directories. Can be repeated.',
      )
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
        .default([]),
    )
    .addOption(
      new Option(
        '--agent <name>',
        'Agent profile to start the new session with. Custom profiles are discovered from agent directories or loaded via --agent-file. Cannot be combined with --session/--continue.',
      )
        .argParser((value: string, previous: string | undefined) => {
          if (previous !== undefined) {
            throw new InvalidArgumentError('--agent may only be specified once.');
          }
          return value;
        })
        .conflicts('agentFile'),
    )
    .addOption(
      new Option(
        '--agent-file <path>',
        'Load an agent definition from a Markdown file and select it for the new session. Cannot be combined with --session/--continue.',
      )
        .argParser((value: string, previous: string[] | undefined) => {
          if ((previous?.length ?? 0) > 0) {
            throw new InvalidArgumentError('--agent-file may only be specified once.');
          }
          return [value];
        })
        .conflicts('agent')
        .default([]),
    )
    .addOption(
      new Option(
        '--add-dir <dir>',
        'Add an additional workspace directory for this session. Can be repeated.',
      )
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
        .default([]),
    )
    .addOption(new Option('--yes').hideHelp().default(false))
    .addOption(new Option('--auto-approve').hideHelp().default(false))
    .option('--plan', 'Start in plan mode.', false)
    .option(
      '--server-stdio',
      'Run against a spawned `cloudcode serve` child over the JSON-RPC stdio protocol.',
      false,
    )
    .addOption(
      new Option(
        '--server <url>',
        'Attach to a running `cloudcode serve --transport ws` daemon (ws://host:port).',
      ),
    )
    .addOption(
      new Option(
        '--server-token <token>',
        'Bearer token for --server. Defaults to CLOUD_CODE_SERVER_TOKEN.',
      ).hideHelp(),
    );

  registerExportCommand(program);
  registerProviderCommand(program);
  registerLoginCommand(program);
  registerDoctorCommand(program);
  program
    .command('serve')
    .description('Run the JSON-RPC protocol server (Phase 4).')
    .addOption(
      new Option('--transport <transport>', 'Transport to serve on.').choices(['stdio', 'ws']).default('stdio'),
    )
    .addOption(new Option('--ui-mode <mode>').hideHelp())
    .addOption(
      new Option('--host <host>', 'Bind address for the ws transport.').default('127.0.0.1'),
    )
    .addOption(
      new Option('--port <port>', 'Port for the ws transport (0 = ephemeral).'),
    )
    .addOption(
      new Option('--token <token>', 'Bearer token for the ws transport (generated when omitted).'),
    )
    .action(
      (cmdOpts: { transport: string; uiMode?: string; host: string; port?: string; token?: string }) => {
        onServe({
          transport: cmdOpts.transport,
          uiMode: cmdOpts.uiMode,
          host: cmdOpts.host,
          port: cmdOpts.port,
          token: cmdOpts.token,
        });
      },
    );
  program
    .command('upgrade')
    .alias('update')
    .description('Upgrade Cloud Code CLI to the latest version.')
    .action(async () => {
      await onUpgrade();
    });

  program
    .command('__plugin_run_node', { hidden: true })
    .argument('<entry>')
    .argument('[args...]')
    .allowUnknownOption(true)
    .action((entry: string, args: string[]) => {
      onPluginNodeRunner(entry, args);
    });

  program.argument('[args...]').action((args: string[]) => {
    if (args.length > 0) {
      program.error(`unknown command '${args[0]}'. See '${CLI_COMMAND_NAME} --help'.`);
    }

    const raw = program.opts<Record<string, unknown>>();

    const rawSession = raw['session'] ?? raw['resume'];
    const sessionValue = rawSession === true ? '' : (rawSession as string | undefined);
    const yoloValue = raw['yolo'] === true || raw['yes'] === true || raw['autoApprove'] === true;
    const autoValue = raw['auto'] === true;

    const opts: CLIOptions = {
      session: sessionValue,
      continue: raw['continue'] === true || raw['C'] === true,
      yolo: yoloValue,
      auto: autoValue,
      plan: raw['plan'] as boolean,
      model: raw['model'] as string | undefined,
      outputFormat: raw['outputFormat'] as CLIOptions['outputFormat'],
      prompt: raw['prompt'] as string | undefined,
      skillsDirs: raw['skillsDir'] as string[],
      agent: raw['agent'] as string | undefined,
      agentFiles: raw['agentFile'] as string[],
      addDirs: raw['addDir'] as string[],
      serverStdio: raw['serverStdio'] === true,
      server: raw['server'] as string | undefined,
      serverToken: raw['serverToken'] as string | undefined,
    };

    onMain(opts);
  });

  return program;
}
