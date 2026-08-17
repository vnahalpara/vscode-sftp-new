import { getSshClient } from '../../core/sshAccess';
import { splitSections } from './frame';
import { factsCommand } from './probe';
import { parseOsRelease, parseCpuModel } from './parse';
import { MonitorTransport, SamplerChannel } from './collector';
import { HostFacts } from './types';

// Adapt an ssh2 channel to the SamplerChannel the collector consumes. Kept
// separate from execStream so it can be tested against a plain EventEmitter.
export function channelFromStream(stream: any): SamplerChannel {
  let closed = false;
  let onCloseCb: (() => void) | null = null;
  const fireClose = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (onCloseCb) {
      onCloseCb();
    }
  };

  // An error and a close both mean the same thing to the panel: the feed is
  // gone and the user needs a way back.
  stream.on('error', fireClose);
  stream.on('close', fireClose);

  return {
    onData(cb: (chunk: string) => void) {
      stream.on('data', (d: Buffer) => cb(d.toString()));
    },
    onClose(cb: () => void) {
      onCloseCb = cb;
      // The channel may already have died before the listener was attached.
      if (closed) {
        cb();
      }
    },
    write(s: string) {
      if (!closed) {
        stream.write(s);
      }
    },
    close() {
      fireClose();
      stream.end();
    },
  };
}

export function sshTransport(fileService: any, config: any): MonitorTransport {
  return {
    async openSampler(cmd: string) {
      const ssh = await getSshClient(fileService, config);
      return channelFromStream(await ssh.execStream(cmd));
    },
    async exec(cmd: string) {
      const ssh = await getSshClient(fileService, config);
      return ssh.exec(cmd);
    },
  };
}

function num(s: string | undefined, fallback: number): number {
  const n = Number((s || '').trim());
  return isFinite(n) && n > 0 ? n : fallback;
}

// One round trip for everything that does not change while the panel is open.
export async function readFacts(
  transport: MonitorTransport,
  fallbackHost: string
): Promise<HostFacts> {
  const res = await transport.exec(factsCommand());
  const s = splitSections(res.stdout).sections;
  const os = parseOsRelease(s.os || '');
  return {
    hostname: (s.host || '').trim() || fallbackHost,
    prettyName: os.prettyName,
    distroId: os.id,
    cpuModel: parseCpuModel(s.cpu || ''),
    arch: (s.arch || '').trim(),
    cores: num(s.cores, 1),
    pageSize: num(s.page, 4096),
    serverEpochMs: num(s.now, 0),
    linux: (s.kernel || '').trim() === 'Linux',
  };
}
