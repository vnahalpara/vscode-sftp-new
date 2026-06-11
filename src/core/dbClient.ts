import * as mysql from 'mysql2/promise';
import logger from '../logger';
import { buildMysqlCommand, parseMysqlBatch, mysqlError } from './dbExec';

export interface DatabaseConfig {
  // resolved from the remote server's perspective (localhost = MySQL on the SSH host)
  host?: string;
  port?: number;
  username: string;
  password: string;
  // the database/schema name
  name: string;
  label?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  key: string;
}

export interface QueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  affectedRows: number;
  durationMs: number;
}

// What DbClient needs from the SSH layer: a forwarded stream (preferred) and exec (fallback).
export interface SshLike {
  openForwardStream(host: string, port: number): Promise<any>;
  exec(cmd: string, input?: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export type SshProvider = () => Promise<SshLike>;

type Transport =
  | { kind: 'stream'; conn: mysql.Connection }
  | { kind: 'exec'; ssh: SshLike };

const TEXT_TYPES = [
  'char',
  'varchar',
  'text',
  'tinytext',
  'mediumtext',
  'longtext',
  'json',
  'enum',
  'set',
];

/**
 * MySQL/MariaDB client over SSH. Prefers a forwarded stream (mysql2 protocol); if the
 * server disables TCP forwarding (e.g. Cloudways: AllowTcpForwarding no), it transparently
 * falls back to running the `mysql` CLI over an SSH exec channel.
 */
export class DbClient {
  private _transport: Transport | null = null;
  private _connecting: Promise<Transport> | null = null;

  constructor(private dbConfig: DatabaseConfig, private sshProvider: SshProvider) {}

  private async _open(): Promise<Transport> {
    const ssh = await this.sshProvider();
    const host = this.dbConfig.host || 'localhost';
    const port = this.dbConfig.port || 3306;

    let stream;
    try {
      stream = await ssh.openForwardStream(host, port);
    } catch (err) {
      // forwarding unavailable -> use the exec transport
      logger.info(`db: TCP forwarding unavailable (${(err as Error).message}); using mysql-over-exec`);
      return { kind: 'exec', ssh };
    }

    const conn = await mysql.createConnection({
      stream,
      user: this.dbConfig.username,
      password: this.dbConfig.password,
      database: this.dbConfig.name,
      multipleStatements: false,
      charset: 'utf8mb4',
      // keep DATE/DATETIME/TIMESTAMP as strings so both transports agree
      dateStrings: true,
      host,
      port,
    });
    conn.on('error', e => {
      logger.error(e, `db connection error (${this.dbConfig.name})`);
      this._transport = null;
    });
    return { kind: 'stream', conn };
  }

  private async _getTransport(): Promise<Transport> {
    if (this._transport) {
      return this._transport;
    }
    if (!this._connecting) {
      this._connecting = this._open().then(
        t => {
          this._transport = t;
          this._connecting = null;
          return t;
        },
        err => {
          this._connecting = null;
          throw err;
        }
      );
    }
    return this._connecting;
  }

  private async _execQuery(ssh: SshLike, sql: string): Promise<QueryResult> {
    const cmd = buildMysqlCommand(this.dbConfig);
    const input = sql.trim().replace(/;?\s*$/, ';') + '\n';
    const start = Date.now();
    const { stdout, stderr } = await ssh.exec(cmd, input);
    const durationMs = Date.now() - start;
    const errMsg = mysqlError(stderr);
    if (errMsg) {
      throw new Error(errMsg);
    }
    const { columns, rows } = parseMysqlBatch(stdout);
    return { columns, rows, rowCount: rows.length, affectedRows: 0, durationMs };
  }

  async query(sql: string, params?: any[]): Promise<QueryResult> {
    try {
      return await this._runOnce(sql, params);
    } catch (err) {
      // A dropped SSH/DB connection leaves a dead transport; drop it and retry
      // once so the next attempt reconnects (getRemoteFileSystem rebuilds the client).
      if (this._isConnectionError(err)) {
        logger.info(`db: connection lost (${(err as Error).message}); reconnecting`);
        this._transport = null;
        return this._runOnce(sql, params);
      }
      throw err;
    }
  }

  private async _runOnce(sql: string, params?: any[]): Promise<QueryResult> {
    const transport = await this._getTransport();

    if (transport.kind === 'exec') {
      // the exec transport has no native parameter binding; callers that need
      // params (search) interpolate safely before calling, so this path runs raw SQL.
      return this._execQuery(transport.ssh, this._inline(sql, params));
    }

    const conn = transport.conn;
    const start = Date.now();
    const [result, fields] = await conn.query(sql, params);
    const durationMs = Date.now() - start;

    if (Array.isArray(result)) {
      const columns = fields ? (fields as any[]).map(f => f.name) : [];
      const rows = (result as any[]).map(row => columns.map(col => row[col]));
      return { columns, rows, rowCount: rows.length, affectedRows: 0, durationMs };
    }
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: (result && (result as any).affectedRows) || 0,
      durationMs,
    };
  }

  private _isConnectionError(err: any): boolean {
    if (!err) {
      return false;
    }
    const code = err.code;
    if (
      code === 'PROTOCOL_CONNECTION_LOST' ||
      code === 'ECONNRESET' ||
      code === 'EPIPE' ||
      code === 'ETIMEDOUT'
    ) {
      return true;
    }
    const msg = String(err.message || err).toLowerCase();
    return (
      msg.indexOf('not connected') !== -1 ||
      msg.indexOf('connection lost') !== -1 ||
      msg.indexOf('econnreset') !== -1 ||
      msg.indexOf('closed') !== -1
    );
  }

  // Inline ? placeholders with escaped literals for the exec (CLI) transport.
  private _inline(sql: string, params?: any[]): string {
    if (!params || params.length === 0) {
      return sql;
    }
    let i = 0;
    return sql.replace(/\?/g, () => {
      const v = params[i++];
      if (v === null || v === undefined) {
        return 'NULL';
      }
      if (typeof v === 'number') {
        return String(v);
      }
      return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, `\\'`)}'`;
    });
  }

  async listTables(): Promise<string[]> {
    const res = await this.query(
      `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [this.dbConfig.name]
    );
    return res.rows.map(r => r[0]);
  }

  async listColumns(table: string): Promise<ColumnInfo[]> {
    const res = await this.query(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS \`key\`
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [this.dbConfig.name, table]
    );
    return res.rows.map(r => ({
      name: r[0],
      type: r[1],
      nullable: r[2] === 'YES',
      key: r[3],
    }));
  }

  async textColumns(): Promise<Map<string, string[]>> {
    const placeholders = TEXT_TYPES.map(() => '?').join(',');
    const res = await this.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN (${placeholders})
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [this.dbConfig.name, ...TEXT_TYPES]
    );
    const map = new Map<string, string[]>();
    for (const row of res.rows) {
      const [t, c] = row;
      if (!map.has(t)) {
        map.set(t, []);
      }
      map.get(t)!.push(c);
    }
    return map;
  }

  get database(): string {
    return this.dbConfig.name;
  }

  async dispose() {
    const transport = this._transport;
    this._transport = null;
    if (transport && transport.kind === 'stream') {
      try {
        await transport.conn.end();
      } catch (_e) {
        /* ignore */
      }
    }
  }
}
