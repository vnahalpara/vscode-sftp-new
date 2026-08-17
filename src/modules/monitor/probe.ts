import { TICK, END } from './frame';

// The fast lane. Paced from our side: each newline we write to stdin produces
// exactly one snapshot. That means the interval can change with no restart,
// pausing is simply not writing, and closing the channel ends the loop (read
// hits EOF) so a closed panel cannot leave a shell running on the server.
// `-t <idle>` is the backstop for an unclean disconnect where the close never
// reaches the far end.
export function samplerScript(idleTimeoutSec: number): string {
  return [
    `while read -r -t ${idleTimeoutSec} _; do`,
    `  echo "${TICK} $(date +%s%3N)"`,
    `  echo "--stat"; cat /proc/stat`,
    `  echo "--mem"; cat /proc/meminfo`,
    `  echo "--load"; cat /proc/loadavg`,
    `  echo "--up"; cat /proc/uptime`,
    `  echo "--net"; cat /proc/net/dev`,
    `  echo "--disk"; cat /proc/diskstats`,
    `  echo "--pids"; head -1 /proc/[0-9]*/stat 2>/dev/null`,
    `  echo "${END}"`,
    `done`,
  ].join('\n');
}

// The slow lane: everything that changes rarely or costs a process spawn. Each
// command tolerates its own absence so one missing binary cannot empty the
// whole batch.
export function slowBatchCommand(): string {
  return [
    `echo "--df"; df -PT -B1 2>/dev/null`,
    `echo "--ps"; ps -eo pid=,user=,nlwp=,args= 2>/dev/null`,
    `echo "--addr"; ip -o -4 addr 2>/dev/null`,
  ].join('; ');
}

// Collected once, when the panel opens.
export function factsCommand(): string {
  return [
    `echo "--os"; cat /etc/os-release 2>/dev/null`,
    `echo "--cpu"; cat /proc/cpuinfo 2>/dev/null`,
    `echo "--arch"; uname -m`,
    `echo "--kernel"; uname -s`,
    `echo "--cores"; nproc 2>/dev/null`,
    `echo "--page"; getconf PAGESIZE 2>/dev/null`,
    `echo "--host"; hostname 2>/dev/null`,
    `echo "--now"; date +%s%3N`,
  ].join('; ');
}
