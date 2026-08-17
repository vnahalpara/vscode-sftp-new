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
