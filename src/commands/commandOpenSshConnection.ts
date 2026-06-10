import * as vscode from 'vscode';
import { COMMAND_OPEN_CONNECTION_IN_TERMINAL } from '../constants';
import { getAllFileService } from '../modules/serviceManager';
import { ExplorerRoot } from '../modules/remoteExplorer';
import { interpolate } from '../utils';
import { reportError } from '../helper';
import * as vpnTunnel from '../core/vpnTunnel';
import { checkCommand } from './abstract/createCommand';

const isWindows = process.platform === 'win32';

function shouldUseAgent(config) {
  return typeof config.agent === 'string' && config.agent.length > 0;
}

function shouldUseKey(config) {
  return typeof config.privateKeyPath === 'string' && config.privateKeyPath.length > 0;
}

function adaptPath(filepath) {
  if (isWindows) {
    return filepath.replace(/\\\\/g, '\\');
  }

  // convert to unix style
  return filepath.replace(/\\\\/g, '/').replace(/\\/g, '/');
}

function getSshCommand(
  config: {
    host: string;
    port: number;
    username: string;
    ssh_prefix?: string;
    proxyCommand?: string;
  },
  extraOption?: string
) {
  // Route ssh through the VPN's local SOCKS5 proxy when present.
  const proxyOpt = config.proxyCommand ? `-o "ProxyCommand=${config.proxyCommand}" ` : '';
  let sshStr = `ssh ${proxyOpt}-t ${config.username}@${config.host} -p ${config.port}`;
  // A custom prefix (e.g. "sshpass -p secret") is prepended to the ssh command.
  // "::/::" is a JSON-friendly token for a literal backslash.
  if (config.ssh_prefix && config.ssh_prefix !== 'undefined') {
    const prefix = config.ssh_prefix.replace(/::\/::/g, '\\');
    sshStr = `${prefix} ${sshStr}`;
  }
  if (extraOption) {
    sshStr += ` ${extraOption}`;
  }
  // sshStr += ` "cd \\"${config.workingDir}\\"; exec \\$SHELL -l"`;
  return sshStr;
}

export default checkCommand({
  id: COMMAND_OPEN_CONNECTION_IN_TERMINAL,

  async handleCommand(exploreItem?: ExplorerRoot) {
    let remoteConfig;
    if (exploreItem && exploreItem.explorerContext) {
      remoteConfig = exploreItem.explorerContext.config;
      if (remoteConfig.protocol !== 'sftp') {
        return;
      }
    } else {
      const remoteItems = getAllFileService().reduce<
        { label: string; description: string; config: any }[]
      >((result, fileService) => {
        const config = fileService.getConfig();
        if (config.protocol === 'sftp') {
          result.push({
            label: config.name || config.remotePath,
            description: config.host,
            config,
          });
        }
        return result;
      }, []);
      if (remoteItems.length <= 0) {
        return;
      }

      const item = await vscode.window.showQuickPick(remoteItems, {
        placeHolder: 'Select a folder...',
      });
      if (item === undefined) {
        return;
      }

      remoteConfig = item.config;
    }

    // If this connection uses a VPN, bring the tunnel up and route ssh through
    // its SOCKS5 proxy so the terminal egresses from the same (allowlisted) IP
    // as file transfers. Requires `nc` with SOCKS support (default on macOS/Linux).
    let proxyCommand;
    if (remoteConfig.vpn) {
      try {
        const socksPort = await vpnTunnel.acquire(remoteConfig.vpn);
        proxyCommand = `nc -X 5 -x 127.0.0.1:${socksPort} %h %p`;
      } catch (error) {
        reportError(error, 'open ssh in terminal (vpn)');
        return;
      }
    }

    const sshConfig = {
      host: remoteConfig.host,
      port: remoteConfig.port,
      username: remoteConfig.username,
      ssh_prefix: remoteConfig.ssh_prefix,
      proxyCommand,
    };
    const terminal = vscode.window.createTerminal(remoteConfig.name);

    // Release the tunnel reference when this terminal is closed.
    if (remoteConfig.vpn) {
      const sub = vscode.window.onDidCloseTerminal(closed => {
        if (closed === terminal) {
          vpnTunnel.release(remoteConfig.vpn);
          sub.dispose();
        }
      });
    }
    let sshCommand;
    if (shouldUseAgent(remoteConfig)) {
      sshCommand = getSshCommand(sshConfig);
    } else if (shouldUseKey(remoteConfig)) {
      sshCommand = getSshCommand(sshConfig, `-i "${adaptPath(remoteConfig.privateKeyPath)}"`);
    } else {
      sshCommand = getSshCommand(sshConfig);
    }

    if (remoteConfig.sshCustomParams) {
      sshCommand =
        sshCommand +
        ' ' +
        interpolate(remoteConfig.sshCustomParams, {
          remotePath: remoteConfig.remotePath,
        });
    }

    terminal.sendText(sshCommand);
    terminal.show();

    // Run post_connect command(s) once the SSH session has had time to connect.
    if (remoteConfig.post_connect) {
      const commands = Array.isArray(remoteConfig.post_connect)
        ? remoteConfig.post_connect
        : [remoteConfig.post_connect];
      setTimeout(() => {
        commands.forEach(cmd => terminal.sendText(cmd));
      }, 2000);
    }
  },
});
