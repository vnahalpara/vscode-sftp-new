import * as vscode from 'vscode';
import * as LRU from 'lru-cache';
import StatusBarItem from './ui/statusBarItem';
import TransferAggregator from './ui/transferAggregator';
import { COMMAND_TOGGLE_OUTPUT } from './constants';
import AppState from './modules/appState';
import RemoteExplorer from './modules/remoteExplorer';
import DbExplorer from './modules/dbExplorer';

interface App {
  fsCache: LRU.Cache<string, string>;
  state: AppState;
  sftpBarItem: StatusBarItem;
  transferAggregator: TransferAggregator;
  remoteExplorer: RemoteExplorer;
  dbExplorer: DbExplorer;
  context: vscode.ExtensionContext;
}

const app: App = Object.create(null);

app.state = new AppState();
app.sftpBarItem = new StatusBarItem(
  () => {
    if (app.state.profile) {
      return `SFTP: ${app.state.profile}`;
    } else {
      return 'SFTP';
    }
  },
  'SFTP@Natizyskunk',
  COMMAND_TOGGLE_OUTPUT
);
app.transferAggregator = new TransferAggregator(app.sftpBarItem);
app.fsCache = LRU<string, string>({ max: 6 });

export default app;
