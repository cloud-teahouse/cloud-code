import { ErrorCodes } from '@cloud-code/sdk';

export const PRODUCT_NAME = 'Cloud Code CLI';
export const CLI_COMMAND_NAME = 'cloudcode';
export const PROCESS_NAME = 'cloud-code';

// Used in HTTP User-Agent headers.
export const CLI_USER_AGENT_PRODUCT = 'cloud-code-cli';
export const CLI_UI_MODE = 'shell';

// Upper bound on headless (`cloud-code -p`) shutdown. A wedged cleanup step (e.g. a
// SessionEnd hook, an MCP shutdown, or a connection blackholed by a restrictive
// firewall) must not keep a completed run alive indefinitely — once this elapses
// we stop waiting on cleanup and let the run return.
export const PROMPT_CLEANUP_TIMEOUT_MS = 8000;

// Grace after a headless run has fully completed (turn done, cleanup attempted)
// before force-exiting. `cloud-code -p` otherwise relies on the event loop draining to
// exit; a stray ref'd handle (socket/timer/child) left over from the run would
// wedge it. The guard timer is unref'd, so a healthy run still exits naturally
// well before this fires.
export const HEADLESS_FORCE_EXIT_GRACE_MS = 2000;

// Max time to wait for buffered stdout/stderr to flush before arming the
// force-exit fallback. A slow/piped consumer's still-draining stdio is a
// legitimate ref'd handle — flushing first prevents the fallback from
// truncating completed output. Bounded so a permanently-stuck consumer can't
// re-introduce the hang.
export const HEADLESS_STDIO_DRAIN_TIMEOUT_MS = 10000;

// Published npm package name; this can differ from the executable command.
export const NPM_PACKAGE_NAME = '@cloud-teahouse/cloudcode-cli';

// App-owned data paths. SDK/core runtime config is intentionally not routed here.
export const CLOUD_CODE_HOME_ENV = 'CLOUD_CODE_HOME';
export const CLOUD_CODE_DATA_DIR_NAME = '.cloud-code';
export const CLOUD_CODE_LOG_DIR_NAME = 'logs';
export const CLOUD_CODE_CACHE_DIR_NAME = 'cache';
export const CLOUD_CODE_UPDATE_DIR_NAME = 'updates';
export const CLOUD_CODE_BIN_DIR_NAME = 'bin';
export const CLOUD_CODE_UPDATE_STATE_FILE_NAME = 'latest.json';
export const CLOUD_CODE_UPDATE_INSTALL_STATE_FILE_NAME = 'install.json';
export const CLOUD_CODE_UPDATE_INSTALL_LOCK_FILE_NAME = 'install.lock';
export const CLOUD_CODE_UPDATE_ROLLOUT_LOG_FILE_NAME = 'rollout.log';
export const CLOUD_CODE_PLUGIN_UPDATE_NOTICE_STATE_FILE_NAME = 'plugin-notices.json';
export const CLOUD_CODE_INPUT_HISTORY_DIR_NAME = 'user-history';
export const CLOUD_CODE_BANNER_DIR_NAME = 'banner';
export const CLOUD_CODE_BANNER_STATE_FILE_NAME = 'state.json';

// Managed Kimi auth provider key shared with OAuth/SDK config.
export const DEFAULT_OAUTH_PROVIDER_NAME = 'managed:kimi-code';

// SDK/core error code that tells the TUI to show a login-required startup
// notice. Derived from sdk's ErrorCodes so a future rename in core
// auto-propagates instead of silently breaking the startup recovery path.
export const OAUTH_LOGIN_REQUIRED_CODE = ErrorCodes.AUTH_LOGIN_REQUIRED;

export const FEEDBACK_ISSUE_URL = 'https://github.com/cloud-teahouse/cloud-code/issues';

// Sent in the feedback `version` field so the backend can distinguish this
// TypeScript client from clients that send a bare version.
export const FEEDBACK_VERSION_PREFIX = 'cloud-code-';

// CDN source of truth for the plugin marketplace: this is the upstream Kimi
// distribution CDN that Cloud Code currently piggybacks on — do not "rebrand"
// the URL; it is a live service endpoint, not a product name.
export const CLOUD_CODE_CDN_BASE = 'https://code.kimi.com/kimi-code';
// Update channel: OUR releases, NOT the upstream CDN. Pointing version checks
// upstream would offer to replace this independent build with upstream's
// newer version. The channel is two static files (release-channel/latest and
// release-channel/latest.json) served from the dev branch of the public repo.
// MIGRATION NOTE: the public snapshot export currently strips release-channel/
// (see docs/state.md), so the channel files must be published to the public
// repo before this URL serves anything; until then channel reads 404 and
// update checks treat the channel as unavailable (fail-open, no crash).
export const CLOUD_CODE_UPDATE_CHANNEL_BASE =
  'https://raw.githubusercontent.com/cloud-teahouse/cloud-code/dev/release-channel';
export const CLOUD_CODE_CDN_LATEST_URL = `${CLOUD_CODE_UPDATE_CHANNEL_BASE}/latest`;
// Rollout manifest consumed by update checks; the plain-text `/latest` above
// stays unchanged forever — already-shipped clients hard-fail on non-semver
// bodies, and the CDN install scripts read it for fresh installs.
export const CLOUD_CODE_CDN_LATEST_JSON_URL = `${CLOUD_CODE_UPDATE_CHANNEL_BASE}/latest.json`;
export const CLOUD_CODE_TIPS_BANNER_URL = 'https://cdn.kimi.com/kimi-code-tips/tips.json';
export const CLOUD_CODE_PLUGIN_MARKETPLACE_URL = `${CLOUD_CODE_CDN_BASE}/plugins/marketplace.json`;
export const CLOUD_CODE_PLUGIN_MARKETPLACE_URL_ENV = 'CLOUD_CODE_PLUGIN_MARKETPLACE_URL';
// Official plugins whose usage bills against the user's plan quota. Installing
// one of these shows a quota note after the install result.
export const QUOTA_CONSUMING_PLUGIN_IDS: readonly string[] = ['kimi-datasource'];
// Native install script: OUR repo's scripts/install.sh (the URL the README
// advertises). Never point this at the upstream CDN — its install.sh would
// replace this build with upstream's product on update.
export const CLOUD_CODE_INSTALL_SH_URL =
  'https://raw.githubusercontent.com/cloud-teahouse/cloud-code/main/scripts/install.sh';

// Official download page, referenced by prompt copy that steers users away
// from third-party install sources. Must point at OUR repo — never upstream's
// download page, which would offer to replace this independent build.
export const CLOUD_CODE_OFFICIAL_INSTALL_URL = 'https://github.com/cloud-teahouse/cloud-code';

// Native install commands, split by platform. Use these for prompt copy and spawn calls only; do not assemble the strings elsewhere.
// There is no native Windows installer — install.sh covers Unix, so the
// Windows path goes through WSL.
export const NATIVE_INSTALL_COMMAND_UNIX = `curl -fsSL ${CLOUD_CODE_INSTALL_SH_URL} | bash`;
export const NATIVE_INSTALL_COMMAND_WIN = `wsl bash -c "curl -fsSL ${CLOUD_CODE_INSTALL_SH_URL} | bash"`;
