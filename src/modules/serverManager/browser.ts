export type BrowserKind = 'chrome' | 'default' | 'chrome-app';

export interface BrowserLaunch {
  cmd: string;
  args: string[];
}

// Returning null means "no idea, let VS Code's openExternal handle it" — which
// is also the honest answer for an unknown platform or a setting value we do
// not recognise.
export function browserCommand(
  kind: BrowserKind,
  url: string,
  platform: NodeJS.Platform
): BrowserLaunch | null {
  const app = kind === 'chrome-app';
  if (kind !== 'chrome' && !app) {
    return null;
  }

  // The empty string after `start` is the window title. Without it, `start`
  // treats a quoted URL as the title and opens nothing.
  switch (platform) {
    case 'darwin':
      return app
        ? { cmd: 'open', args: ['-na', 'Google Chrome', '--args', `--app=${url}`] }
        : { cmd: 'open', args: ['-a', 'Google Chrome', url] };
    case 'linux':
      return app
        ? { cmd: 'google-chrome', args: [`--app=${url}`] }
        : { cmd: 'google-chrome', args: [url] };
    case 'win32':
      return app
        ? { cmd: 'cmd', args: ['/c', 'start', '', 'chrome', `--app=${url}`] }
        : { cmd: 'cmd', args: ['/c', 'start', '', 'chrome', url] };
    default:
      return null;
  }
}
