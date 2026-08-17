// Captured from a real Ubuntu 22.04 host. Kept verbatim (including column
// alignment and spacing quirks) so parsers are tested against reality rather
// than against tidied-up samples.

export const STAT_8CORE = `cpu  461534 1834 122900 226255632 62901 0 4561 0 0 0
cpu0 57692 229 15362 28281954 7862 0 570 0 0 0
cpu1 57691 229 15362 28281953 7862 0 570 0 0 0
cpu2 57692 229 15363 28281954 7862 0 570 0 0 0
cpu3 57691 229 15362 28281953 7862 0 570 0 0 0
cpu4 57692 229 15363 28281954 7862 0 570 0 0 0
cpu5 57691 229 15362 28281953 7862 0 570 0 0 0
cpu6 57692 229 15362 28281954 7862 0 570 0 0 0
cpu7 57693 231 15364 28281957 7869 0 571 0 0 0
intr 1234567 0 0 0
ctxt 987654321
btime 1700000000
processes 456789
procs_running 2
procs_blocked 0
softirq 55555 0 11111 0 2222 0 0 3333 0 0 4444
`;

// Second sample, ~2s later: cpu0 gained 100 user jiffies and 900 idle jiffies,
// every other core is untouched.
export const STAT_8CORE_NEXT = `cpu  461634 1834 122900 226256532 62901 0 4561 0 0 0
cpu0 57792 229 15362 28282854 7862 0 570 0 0 0
cpu1 57691 229 15362 28281953 7862 0 570 0 0 0
cpu2 57692 229 15363 28281954 7862 0 570 0 0 0
cpu3 57691 229 15362 28281953 7862 0 570 0 0 0
cpu4 57692 229 15363 28281954 7862 0 570 0 0 0
cpu5 57691 229 15362 28281953 7862 0 570 0 0 0
cpu6 57692 229 15362 28281954 7862 0 570 0 0 0
cpu7 57693 231 15364 28281957 7869 0 571 0 0 0
intr 1234599 0 0 0
`;

// A single-core host: only "cpu" and "cpu0".
export const STAT_1CORE = `cpu  100 0 50 900 10 0 0 0 0 0
cpu0 100 0 50 900 10 0 0 0 0 0
intr 1 0
`;

// Same single core after a reboot: counters restart from smaller values.
export const STAT_1CORE_REBOOTED = `cpu  10 0 5 90 1 0 0 0 0 0
cpu0 10 0 5 90 1 0 0 0 0 0
intr 1 0
`;

// Chosen so the derived buckets land near the reference design: 7.75G total,
// 371M of 1024M swap used.
export const MEMINFO = `MemTotal:        8125000 kB
MemFree:         1237000 kB
MemAvailable:    3600000 kB
Buffers:          120000 kB
Cached:          2400000 kB
SwapCached:        10000 kB
Active:          4000000 kB
Inactive:        2000000 kB
SwapTotal:       1048576 kB
SwapFree:         668576 kB
Shmem:             80000 kB
SReclaimable:     100000 kB
`;

// A host with swap disabled.
export const MEMINFO_NO_SWAP = `MemTotal:        1000000 kB
MemFree:          500000 kB
MemAvailable:     600000 kB
Buffers:               0 kB
Cached:           200000 kB
SwapTotal:             0 kB
SwapFree:              0 kB
Shmem:                 0 kB
SReclaimable:          0 kB
`;

export const LOADAVG = `0.07 0.06 0.01 2/456 123456
`;

export const UPTIME = `1234567.89 9876543.21
`;

// Note the ens5 row: a large counter runs straight into the colon with no
// space, which is why the parser splits on the first colon and not on
// whitespace.
export const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1234567    1234    0    0    0     0          0         0  1234567    1234    0    0    0     0       0          0
  eth0: 4500000000 3210000    0    0    0     0          0         0 1845000000 2100000    0    0    0     0       0          0
 ens5:9999999999 1111    0    0    0     0          0         0 8888888888    2222    0    0    0     0       0          0
`;

// Same interfaces 2s later: eth0 received 2000 bytes and sent 1696 bytes.
export const NET_DEV_NEXT = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1234567    1234    0    0    0     0          0         0  1234567    1234    0    0    0     0       0          0
  eth0: 4500002000 3210020    0    0    0     0          0         0 1845001696 2100010    0    0    0     0       0          0
 ens5:9999999999 1111    0    0    0     0          0         0 8888888888    2222    0    0    0     0       0          0
`;

// major minor name reads merged sectors_read ms_read writes merged
// sectors_written ms_write in_flight io_ms weighted_ms
export const DISKSTATS = ` 252       0 vda 500000 1000 20000000 400000 800000 2000 120000000 900000 0 300000 1300000
 252       1 vda1 499000 900 19900000 399000 799000 1900 119000000 899000 0 299000 1290000
   7       0 loop0 10 0 80 5 0 0 0 0 0 5 5
`;

// 2s later on vda1: 100 more reads covering 1600 sectors in 20ms, and 50 more
// writes covering 800 sectors in 10ms. loop0 is idle throughout.
export const DISKSTATS_NEXT = ` 252       0 vda 500100 1000 20001600 400020 800050 2000 120000800 900010 0 300030 1300030
 252       1 vda1 499100 900 19901600 399020 799050 1900 119000800 899010 0 299030 1290030
   7       0 loop0 10 0 80 5 0 0 0 0 0 5 5
`;

// Output shape of `head -1 /proc/[0-9]*/stat`. The third entry's comm contains
// both spaces and parentheses — the classic /proc/pid/stat parser bug.
export const PID_STATS = `==> /proc/1/stat <==
1 (systemd) S 0 1 1 0 -1 4194560 20000 100000 50 100 300 900 200 400 20 0 1 0 5 170000000 3200 18446744073709551615 1 1 0 0 0 0 0 671173123 4096 0 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0

==> /proc/831/stat <==
831 (mariadbd) S 1 831 831 0 -1 4194304 900000 0 0 0 45000 12000 0 0 20 0 9 0 900 3400000000 25100 18446744073709551615 1 1 0 0 0 0 0 0 4096 0 0 0 0 17 1 0 0 0 0 0 0 0 0 0 0 0 0 0

==> /proc/209906/stat <==
209906 (meili (search) x) S 1 209906 209906 0 -1 4194304 5000 0 0 0 600 300 0 0 20 0 23 0 12000 700000000 12288 18446744073709551615 1 1 0 0 0 0 0 0 4096 0 0 0 0 17 5 0 0 0 0 0 0 0 0 0 0 0 0 0
`;

// 2s later: pid 1 idle; mariadbd burned 100 utime + 20 stime jiffies; pid
// 209906 was replaced by a different process reusing the same pid, which shows
// up as a different starttime (999999 rather than 12000).
export const PID_STATS_NEXT = `==> /proc/1/stat <==
1 (systemd) S 0 1 1 0 -1 4194560 20000 100000 50 100 300 900 200 400 20 0 1 0 5 170000000 3200 18446744073709551615 1 1 0 0 0 0 0 671173123 4096 0 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0

==> /proc/831/stat <==
831 (mariadbd) S 1 831 831 0 -1 4194304 900000 0 0 0 45100 12020 0 0 20 0 9 0 900 3400000000 25100 18446744073709551615 1 1 0 0 0 0 0 0 4096 0 0 0 0 17 1 0 0 0 0 0 0 0 0 0 0 0 0 0

==> /proc/209906/stat <==
209906 (impostor) S 1 209906 209906 0 -1 4194304 5000 0 0 0 5000 5000 0 0 20 0 4 0 999999 700000000 4096 18446744073709551615 1 1 0 0 0 0 0 0 4096 0 0 0 0 17 5 0 0 0 0 0 0 0 0 0 0 0 0 0
`;
