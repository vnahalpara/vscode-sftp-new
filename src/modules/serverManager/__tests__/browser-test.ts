import { browserCommand } from '../browser';

const URL = 'http://127.0.0.1:51234/?t=abc';

describe('browserCommand', () => {
  it('returns null for the default browser, so the caller uses openExternal', () => {
    expect(browserCommand('default', URL, 'darwin')).toBeNull();
  });

  it('opens a Chrome tab on macOS', () => {
    expect(browserCommand('chrome', URL, 'darwin')).toEqual({
      cmd: 'open',
      args: ['-a', 'Google Chrome', URL],
    });
  });

  it('opens a Chrome tab on Linux', () => {
    expect(browserCommand('chrome', URL, 'linux')).toEqual({
      cmd: 'google-chrome',
      args: [URL],
    });
  });

  it('opens a Chrome tab on Windows', () => {
    expect(browserCommand('chrome', URL, 'win32')).toEqual({
      cmd: 'cmd',
      args: ['/c', 'start', '', 'chrome', URL],
    });
  });

  it('opens a chromeless app window on macOS', () => {
    expect(browserCommand('chrome-app', URL, 'darwin')).toEqual({
      cmd: 'open',
      args: ['-na', 'Google Chrome', '--args', `--app=${URL}`],
    });
  });

  it('opens a chromeless app window on Linux', () => {
    expect(browserCommand('chrome-app', URL, 'linux')).toEqual({
      cmd: 'google-chrome',
      args: [`--app=${URL}`],
    });
  });

  it('opens a chromeless app window on Windows', () => {
    expect(browserCommand('chrome-app', URL, 'win32')).toEqual({
      cmd: 'cmd',
      args: ['/c', 'start', '', 'chrome', `--app=${URL}`],
    });
  });

  it('falls back to the default browser on an unknown platform', () => {
    expect(browserCommand('chrome', URL, 'aix' as any)).toBeNull();
  });

  it('falls back to the default browser for an unknown setting value', () => {
    expect(browserCommand('netscape' as any, URL, 'darwin')).toBeNull();
  });
});
