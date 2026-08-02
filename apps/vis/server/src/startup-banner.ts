import { hostForUrl } from './config';

export interface StartupBannerOptions {
  readonly authToken?: string;
  readonly host: string;
  readonly cloudCodeHome: string;
  readonly port: number;
}

export function formatStartupBanner(options: StartupBannerOptions): string {
  const authStatus = options.authToken === undefined ? 'auth=disabled' : 'auth=required';
  return (
    `[vis-server] listening on http://${hostForUrl(options.host)}:${String(options.port)} ` +
    `(${authStatus}, CLOUD_CODE_HOME=${options.cloudCodeHome})\n`
  );
}
