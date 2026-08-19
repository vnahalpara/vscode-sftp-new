## 1.26.0 - 2026-08-19
* Security : an already-running VPN tunnel is now only reused when it is **provably ours** — a marker file we wrote, naming a matching port and a live pid, written since the current boot, and the port still answering a SOCKS5 handshake. All five conditions must hold, or the extension starts (or fails to start) its own tunnel instead. Previously, any process that answered the SOCKS5 handshake on the target port was assumed to be our tunnel and adopted — routing the SSH session, credentials included, through a proxy chosen by whichever process won the race to that port.
* New Feature : the VPN SOCKS proxy port is now **deterministic per WireGuard config file** instead of a random free port on every restart, derived from the config path into a configurable range (`sftp.vpn.portRange`, default `21000-21999`). An explicit `vpn.socksPort` in a profile still always wins over the derived port.
* New Feature : `sftp.vpn.keepAlive` (default `true`) leaves a VPN tunnel running when its last consumer disconnects, so the next connection reuses it instead of paying wireproxy's startup and health-check cost again. Closing VS Code (or disabling the extension) still tears every tunnel down regardless of this setting.
* Note : a VPN tunnel that was **adopted** (rather than started by this window) is never signalled when the window closes or its last consumer disconnects — it is dropped from the window's own bookkeeping and left running, marker intact, so the next connection adopts it back. The marker directory is shared by every VS Code window of the same install, so an adopted tunnel may belong to another window that is open and transferring; nothing in the marker distinguishes that from a run that has ended. A tunnel this window started is still torn down as before.
* New Feature : a VPN tunnel of ours that is still running but has stopped answering SOCKS5 (re-probed several times first, to rule out a slow machine rather than a dead one) is now terminated (`SIGTERM`) before its replacement starts, instead of being orphaned to hold its port for the rest of the machine's uptime. The extension never signals a process it did not itself record as its own via the marker above.
* Upgrade note : a VPN tunnel left running by 1.25.0 or earlier can never be adopted by this release. The ownership marker is new here — no earlier build wrote one — and without a marker a listener cannot clear the checks above. Without a pinned `vpn.socksPort`, an old tunnel sits on the random port that build chose and the new one never looks there, so it is simply never found: your connection starts a fresh tunnel on the derived port, and the old process is left holding its own port, orphaned, until the machine restarts or you stop it — one leftover `wireproxy` per VPN config, at most once. **If `vpn.socksPort` is pinned, the old tunnel holds exactly the port the new build wants, and the new build refuses to start** rather than silently sharing a port with a process it cannot verify (that silent sharing was the security gap this release closes) — you'll see an error naming the port. See the README's VPN section ("Upgrading from before 1.26.0") for the recovery step.

## 1.25.0 - 2026-08-19
* New Feature : the Manage Server dashboard's **Terminal** tab — a real interactive shell in the browser, backed by xterm.js over a dedicated `/ws/terminal` WebSocket. It rides the connection's own already-authenticated SSH session and runs as the profile's **ordinary SSH user**, never the root-credential lane — unlike *Open SSH in Terminal*, no password ever appears on a command line for this feature.
* New Feature : the **Logs** tab — discovers log files under `/var/log` and journald units, shows a read-only snapshot, and can Follow (`tail -F` / `journalctl -f`) over a dedicated `/ws/logs` WebSocket. Only paths a discovery scan actually returned for the session may be read or followed. Rotated/compressed/binary files (`*.gz`, `*.1`, `wtmp`, `btmp`, …) are deprioritised into a collapsed group rather than cluttering the primary list. Up to 4 follows may be open per session — each holds an SSH exec channel on the pooled connection shared with SFTP, and OpenSSH's default `MaxSessions` (10) would otherwise be exhausted, breaking file transfers with "administratively prohibited".
* Note : both new WebSocket endpoints are authenticated on the HTTP upgrade with the per-session token, plus `Origin`/`Host` checks — browsers don't apply the same-origin policy to WebSocket upgrades the way they do to `fetch`, and the `Host` check defends against DNS rebinding.
* Note : Log Follow needs the same sudo/root-credential arrangement as the Services and Web server tabs — see the README. `tail -F`/`journalctl -f` run directly (`sudo -n tail`/`sudo -n journalctl`), not inside the `sudo -n sh -c` wrapper the other privileged reads use, so a narrow sudoers rule granting only `/bin/systemctl` does not enable it; it needs its own `NOPASSWD: /bin/tail, /bin/journalctl` rule (or the root-credential lane).
* Note : `ws` is a new runtime dependency (the WebSocket server backing both tabs); the `@xterm/*` packages are devDependencies bundled into `media/webui` by the webui build.

## 1.24.0 - 2026-08-19
* New Feature : the Manage Server dashboard's **Services** tab lists `systemd` service units (active/failed first, then alphabetical, with search) and runs start/stop/restart/reload/reload-or-restart, each behind a confirmation dialog, with the result shown inline per row.
* New Feature : the **Web server** tab detects nginx/Apache, shows version/active/enabled state and listening ports, parses `/etc/nginx` or `/etc/apache2`/`/etc/httpd` config into a virtual-host table (server name, listen addresses, SSL, root, proxy target, logs), reads each vhost's TLS certificate expiry via `openssl`, and runs `nginx -t`/`apachectl configtest` on demand.
* New Feature : an optional root-credential lane — a profile carrying both `root_user` and `root_password` runs privileged Services/Web server commands over a second SSH connection authenticated as those credentials, instead of under the profile's own user. The commands still carry `sudo -n` on that lane (root sudos to itself), so a host without `sudo`, or with a `requiretty`/`secure_path` restriction, still fails; and most distributions ship `PermitRootLogin prohibit-password`, so root password login has to be enabled on the server for this to connect at all. On a hop/bastion profile the credentials apply to the innermost hop (the real destination), never the jump host.
* Note : privileged commands require either passwordless sudo for the profile's user or the root-credential lane above; a failed action surfaces a hint naming the account/host instead of failing silently. sudo actually execs `systemctl`, `sh` and `sed` — `nginx`, `apache2ctl`, `httpd` and `openssl` run *inside* a `sudo -n sh -c` script, so a sudoers rule naming those binaries never matches. **`NOPASSWD: /bin/sh` is equivalent to unrestricted root**; the root-credential lane is the better trade for the Web server tab. A narrow, per-command rule (e.g. `NOPASSWD: /bin/systemctl restart nginx`) will not match either, since every command carries a `--` end-of-options guard and a fully-qualified unit name — see the README.
* Fix : the SFTP connection pool could open a second, orphaned SSH connection for a hop/bastion profile. Connecting mutates the option object it is given (`port` on non-final hops, `privateKey` on the innermost one) and those writes reached the caller's own config, changing the pool key after the first successful connect — so the next operation missed the cache, and the original connection stayed open beyond the reach of `SFTP: Reconnect`. The pool now deep-copies before connecting.
* Security : the Web server tab's config-file reader (`/api/file`) could be pointed at any root-readable path. The vhost listing frames each file with an `@@<path>` marker on the same stream the file's own bytes travel in, so a line beginning `@@/etc/shadow` inside any config file seeded the per-session allowlist. Allowed paths are now intersected against the hard-coded config directories the listing actually globs.
* Fix : listing services, `systemctl status` and web-server detection no longer open the root-credential connection — they carry no `sudo`, so they run over the connection you already have. Previously, merely opening the Services tab dialled the root lane, and on a host with root password login disabled both tabs failed to load with a raw ssh2 authentication error.
* Fix : a config file with no trailing newline swallowed the next file's `@@` marker, attributing that file's vhosts to the previous one and 403ing its View button.
* Fix : web-server detection now extends `PATH` with `/usr/sbin`/`/sbin`, which RHEL-family hosts keep off a non-root user's non-login PATH — nginx/httpd there were reported as "not detected".
* Fix : the Web server tab's action buttons now send the fully-qualified unit name (`nginx.service`), matching the Services tab and the documented sudoers example.

## 1.23.0 - 2026-08-18
* New Feature : the **Manage Server** page is now a real dashboard instead of the earlier raw-JSON diagnostics view. A sidebar (Dashboard, Activity, Database, Servers & settings) and a live status badge frame an **Overview** tab with stat cards for CPU, Memory, Disk, Load (1m) and Uptime; charts for CPU usage, per-core usage, memory usage, load average and network throughput; and tables for filesystems, top processes, disk I/O and network interfaces, all streamed over the existing SSH-backed Server-Sent Events channel. A range selector switches the charts between the last 5, 15 and 60 minutes of in-memory history.
* Note : Services, Web server, Logs, Terminal and Database appear as visibly disabled tabs, pending later releases. Metric history is still held in memory only and does not survive a VS Code restart.

## 1.22.1 - 2026-08-18
* Fix : Manage Server showed a green **online** badge for a connection whose sampler channel failed to open. `Collector.start()` reports that failure through a callback instead of throwing, so the session claimed "online" over the top of the "offline" it had just set. The status is now only promoted when nothing has already marked the connection dead.
* Fix : **Reconnect**, **Export Database** and **Export Table** were contributed in `package.json` but their handler files had never been committed, so all three appeared in the command palette and failed with "command not found". The handlers now ship.
* Fix : a clean checkout of the repository did not compile — `fileService.ts` had imported `reconnectRemoteFs` since the transfer-progress work, but the function itself was only ever present in an uncommitted working tree.
* New Feature : database and table **export** over the existing SSH channel (mysqldump on the server, gzipped, downloaded over SFTP), plus per-row delete and a custom SQL runner in the data browser. Both confirm before writing, and the SQL runner warns separately when an `UPDATE`/`DELETE` carries no `WHERE`.

## 1.22.0 - 2026-08-18
* New Feature : **Manage Server** — right-click a connection root in the Remote Explorer (directly below *Open SSH in Terminal*) to open a live server-management page in Chrome. VS Code starts a token-authenticated HTTP server bound to `127.0.0.1` only, and streams that host's metrics over Server-Sent Events using the connection's existing SSH channel. No agent is installed on the server.
* Removed : the in-editor **Open Monitoring** webview, replaced by Manage Server. The `sftp.monitor.*` settings are replaced one-for-one by `sftp.serverManager.*` (`browser`, `interval`, `slowInterval`, `historyMinutes`).
* Security : the server manager API never returns `password`, `passphrase`, `ssh_prefix`, `interactiveAuth`, `git.password` or `database[].password` — profiles are redacted through an allowlist before they reach the browser.
* Note : metric history is held in memory only and does not survive a VS Code restart. Services, web server, logs, terminal and database management follow in later releases.

## 1.16.3 - 2023-06-16
* [#356] New Feature : Upload to all profiles (Pull request [#313](https://github.com/Natizyskunk/vscode-sftp/pull/313) from @wewawa vscode-sftp:create_multi_command).
* [#357] Fix : Correcting Typo 'avaliable' => 'available' (Pull request [#343](https://github.com/Natizyskunk/vscode-sftp/pull/343) from @kjo-sdds vscode-sftp:develop).
* [#358] Permissions : Add filePerm and dirPerm options for configuring permissions (Pull request [#347](https://github.com/Natizyskunk/vscode-sftp/pull/347) from @Jchase2 vscode-sftp:develop).
* [#359] Fix : Correcting sftp connection with public key (Pull request [#350](https://github.com/Natizyskunk/vscode-sftp/pull/350) from @inu1255 vscode-sftp:develop).
* Upgrade `ssh2` version to official v1.13.0 by @mscdex.

## pre-1.16.2 - 2022-11-30
* [#271] Fix case change of file name not sent correctly (Pull request [#249](https://github.com/Natizyskunk/vscode-sftp/pull/249) from @NyaPPuu vscode-sftp:fix_rename).
* [#272] Update npm `types/node` depedency to v9.6.51.

## 1.16.1 - 2022-11-02
* [#251] Add multiple select + Update `Download File` & `Downalod Folder` commands to the remote view + Add `Upload File` & `Upload Folder` commands to the remote view (Pull request [#221](https://github.com/Natizyskunk/vscode-sftp/pull/221) from @NyaPPuu vscode-sftp:add_multiple_select).

## 1.16.0 - 2022-10-29
* [#242] Add order option and fix typos in docs (Pull request [#157](https://github.com/Natizyskunk/vscode-sftp/pull/157) from @NyaPPuu vscode-sftp:add_order_option).
* [#243] Fix refresh when creating/deleting file/folder + Fix 'Reveal in Remote Explorer' and Refresh Button in Remote Explorer. (Pull request [#159](https://github.com/Natizyskunk/vscode-sftp/pull/159) from @NyaPPuu vscode-sftp:fix_refresh).
* [#244] Cleanup Text in Markdown Files (Pull request [#213](https://github.com/Natizyskunk/vscode-sftp/pull/213) from @BrayFlex vscode-sftp:develop).

## 1.15.20 - 2022-08-28
* Fix typo 'worksapce' to 'workspace' (Pull request [#158](https://github.com/Natizyskunk/vscode-sftp/pull/158) from @NyaPPuu vscode-sftp:fix_typo).
* Add `Download File` & `Downalod Folder` commands to the remote view (Thanks to @mrandrey on issue #97).
* Update npm `types/fs-extra` depedency to v9.0.13 (Pull request [#204](https://github.com/Natizyskunk/vscode-sftp/pull/204) from @dependabot vscode-sftp:dependabot/npm_and_yarn/types/fs-extra-9.0.13).
* Update npm `typescript-tslint-plugin` depedency to v1.0.2 (Pull request [#206](https://github.com/Natizyskunk/vscode-sftp/pull/206) from @dependabot vscode-sftp:dependabot/npm_and_yarn/typescript-tslint-plugin-1.0.2).
* Update npm `tslint` depedency to v6.1.3 (Pull request [#207](https://github.com/Natizyskunk/vscode-sftp/pull/207) from @dependabot vscode-sftp:dependabot/npm_and_yarn/tslint-6.1.3).
* Update npm `ts-loader` depedency to v9.4.1 (Pull request [#208](https://github.com/Natizyskunk/vscode-sftp/pull/208) from @dependabot vscode-sftp:dependabot/npm_and_yarn/ts-loader-9.4.1).
* Update npm `typescript` depedency to v3.9.7.
* Update npm `jest` depedency to v29.0.3.

## 1.15.19 - 2022-08-26
* [#72] Change `uploadOnSave` default value from true to false.

## 1.15.18 - 2022-08-26
* Update npm `async` depedency to v3.2.4.
* Update npm `fs-extra` depedency to v10.1.0.
* Update npm `tmp` depedency to v0.2.1.
* Update npm `upath` depedency to v2.0.1.

## 1.15.17 - 2022-08-26
* Upgrade `ssh2` version to official v1.11.0 by @mscdex.

## 1.15.16 - 2022-05-26
* Reorder cipher and serverHostKey algorithms.
* Update [FAQ.md](https://github.com/Natizyskunk/vscode-sftp/blob/master/FAQ.md), and [documentations](https://github.com/Natizyskunk/vscode-sftp/tree/master/docs).

## 1.15.15 - 2022-08-21
* Fix "Open SSH in Terminal" not working because "terminal.integrated.shell.windows" is deprecated and fix typo `src/commands/commandOpenSshConnection.ts`. (Pull request [#155](https://github.com/Natizyskunk/vscode-sftp/pull/155) from @mean-cj vscode-sftp:patch-2).

## 1.15.14 - 2022-05-06
* Update npm `async` depedency to v2.6.4.
* Update npm `minimist` depedency to v1.2.6.

## 1.15.13 - 2022-02-11
* Add support for OpenSSH v8.8 SSH private key by using SHA-2 instead of SHA-1 to fix SSH public key signatures. (See issue [#112](https://github.com/Natizyskunk/vscode-sftp/issues/112)).

## 1.15.12 - 2022-02-11
* Add deletions support to "Upload Changed files" command. (Pull request [#113](https://github.com/Natizyskunk/vscode-sftp/pull/113) from @brykov vscode-sftp:master merged inside [#117](https://github.com/Natizyskunk/vscode-sftp/pull/117)).

* ## 1.15.11 - 2022-02-09
* Enhance sftp interactiveAuth mode (See [Wiki](https://github.com/Natizyskunk/vscode-sftp/wiki/SFTP-only-Configuration#interactiveauth)). (Pull request [#94](https://github.com/Natizyskunk/vscode-sftp/pull/94) from @lacastorine vscode-sftp:lacastorine merged inside [#114](https://github.com/Natizyskunk/vscode-sftp/pull/114)).

## 1.15.10 - 2021-11-22
* Update npm `json-schema` devDepedency to v0.2.3.

## 1.15.9 - 2021-11-21
* Remove ssh configuration bug introduced in pull request [#69](https://github.com/Natizyskunk/vscode-sftp/pull/69) from @clemyan while we can find another solution.

## 1.15.8 - 2021-11-12
  * Fix 'Upload Changed Files' & 'No Such File' bugs (Commit [fix upload changed files](https://github.com/wandway/vscode-sftp/commit/775016788e4c59db901dc68a20c1f61ebcca7bc7#diff-20516d8841b4891f1926f1e40e447e99e0575a5e36ba6814f6b85b45db1b8fbb) from @wandway vscode-sftp:master).
  * Make the 'Upload Changed Files' command visible and add a default keyboard shortcut (Ctrl+Alt+U) to call it (Merged pull request [#84](https://github.com/Natizyskunk/vscode-sftp/pull/84) from @PaPa31 vscode-sftp:master). See [FAQ](https://github.com/Natizyskunk/vscode-sftp/blob/master/FAQ.md#clicking-upload-changed-files-does-not-work)).
  * Update Webpack from 4.39.2 to 5.0.0.
  * Update Webpack-cli from 3.3.7 to 4.7.0.

## 1.15.7 - 2021-11-12
  * Upgrade `ssh2` version to official v1.5.0 by @mscdex.

## 1.15.6 - 2021-10-27
  * Fix ssh configuration resolution (Merged pull request [#69](https://github.com/Natizyskunk/vscode-sftp/pull/69) from @clemyan vscode-sftp:fix-ssh-config).

## 1.15.5 - 2021-10-27
  * Update mtime after file was saved before upload (Merged pull request [#75](https://github.com/Natizyskunk/vscode-sftp/pull/75) from @viperet vscode-sftp:save_before_upload_mtime).
  * Add pull request issue template.
  * Add funding/sponsors page.
  * Add code scanning alert.

## 1.15.4 - 2021-10-04
  * Remove error message when calling sftp.sync.remoteToLocal command in vscode tasks.json.

## 1.15.3 - 2021-09-10
  * Upgrade `ssh2` version to official v1.4.0 bcy @mscdex.

## 1.15.2 - 2021-08-24
  * Fix the `useTempFile` bug (Merged pull request [#41](https://github.com/Natizyskunk/vscode-sftp/pull/41) from @kripper vscode-sftp:master).
  * Change `useTempFile` default value from true to false.
  * Fix the "Cannot read property 'handle' of undefined" bug (related to `useTempFile` bug) [TypeError: Cannot read property 'handle' of undefined](https://github.com/Natizyskunk/vscode-sftp/issues/43).
  * Fix the "fd argument must be of type number. Received undefined" bug (related to `useTempFile` bug) [TypeError since last update (The "fd" argument must be of type number.)](https://github.com/Natizyskunk/vscode-sftp/issues/34).
  * Fix the "Permission denied" bug when uploading.
  * New option [openSsh](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration#openssh) (Pull request [#42](https://github.com/Natizyskunk/vscode-sftp/pull/42) from @kripper vscode-sftp:atomic-rename merged inside [#45](https://github.com/Natizyskunk/vscode-sftp/pull/45)).
  * Update of the wiki to add support for openSsh option.

## 1.15.1 - 2021-08-24
  * Add the `useTempFile` option to the test configuration spec.
  * Fix get target mode error && add more precise logger-infos for tranfer tasks (Merged pull request [#29](https://github.com/Natizyskunk/vscode-sftp/pull/29) from @kripper vscode-sftp:master).

## 1.15.0 - 2021-08-23
  * New option [useTempFile](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration#usetempfile) (Merged pull request [#29](https://github.com/Natizyskunk/vscode-sftp/pull/29) from @kripper vscode-sftp:master).
  * Update of the wiki to add support for useTempFile option.

## 1.14.0 - 2021-08-06
  * Update of the FAQ to add support for old/legacy systems.
  * switching from beta to stable.

## 1.14.0-beta - 2021-07-15
  * Add `create remote file` and `create remote folder` commands (Merged pull request [#18](https://github.com/Natizyskunk/vscode-sftp/pull/18) from @mathsgod vscode-sftp:master).

## 1.13.6 - 2021-07-15
  * Fix syntax in `src\fileHandlers\transfer\__tests__\transfer-test.ts`.

## 1.13.5 - 2021-07-10
  * Reorder test parameters for `keepalive`.
  * Add v1.13.5-beta. Only use beta version if you still encounter the "REQUEST_FAILURE" error like described in those two issues : [Buffering on save file after 15 minute](https://github.com/Natizyskunk/vscode-sftp/issues/7) & [Infinite spinner on file save after server rest connection with client](https://github.com/Natizyskunk/vscode-sftp/issues/8).

## 1.13.4 - 2021-07-10
  * Fix "Error with the transfer direction."
  * Add loggers for transfer informations.

## 1.13.3 - 2021-07-09
  * re-add braces >=2.3.1 to package.json.
  * re-add yargs-parser ^20.2.4 to package.json.
  * Remove `yarn.lock`.
  * Add `package-lock.json`.
  * Fix Writing CHANNEL_DATA (0) / Writing FSETSTAT (Merged pull request [#12](https://github.com/Natizyskunk/vscode-sftp/pull/12) from @zarausto vscode-sftp:patch-1).
  * Fix transfer-test for Windows platform (Merged pull request [#11](https://github.com/Natizyskunk/vscode-sftp/pull/11) from @alex1504 vscode-sftp:fix-transfer-test).

## 1.13.2 - 2021-07-07
  * remove braces >=2.3.1 to package.json.
  * remove yargs-parser ^20.2.4 to package.json.
  * Remove the fix for the "No such file" error on VSCode 1.56 since it's been implementend in the new ssh2 v1.1.0 npm package (Commit [SFTP: explicitly set autoClose option for node 14+](https://github.com/mscdex/ssh2/commit/c0de05d186065ad4081b98d2f7aa0fe22161ec09) from @mscdex ssh2:master).

## 1.13.1 - 2021-07-06
  * Add braces >=2.3.1 to package.json.
  * Add node-notifier >=8.0.1 to package.json.
  * Add yargs-parser ^20.2.4 to package.json.
  * Changing publisher and repo links.
  * Fixed error "No such file" on VSCode 1.56.
  * Fixed issue with uploading of file which has unsaved changes.

## 1.13.0 - 2021-07-06
  * Upgrade `ssh2` version to official v1.1.0 by @mscdex.

## 1.12.10 - 2021-05-15
  * Improve sftp reliability.

## 1.12.3 - 2019-04-27
  * Minor improvements.
  * Bug fix.

## 1.12.1 - 2019-03-28
  * Fix [#510](https://github.com/liximomo/vscode-sftp/issues/510).

## 1.12.0 - 2019-03-21
  * new option [sshCustomParams](https://github.com/liximomo/vscode-sftp/wiki/SFTP-only-Configuration#sshcustomparams).

## 1.11.0 - 2019-03-15
  * Save before upload.
  * Fix [#490](https://github.com/liximomo/vscode-sftp/issues/490).

## 1.9.4 - 2019-02-26
  * Fix sshConfig file not work.
  * Open SSH in Terminal can enter to remote path.

## 1.9.3 - 2019-01-30
  * New icon for RemoteExplorer. Thanks [niccolomineo](https://github.com/niccolomineo) and [jonbp](https://github.com/jonbp).
  * Change `port` to number in the generated configuration.

## 1.9.2 - 2019-01-22
  * Fix [#388](https://github.com/liximomo/vscode-sftp/issues/388).
  * Fix [#456](https://github.com/liximomo/vscode-sftp/issues/456).
  * Fix [#459](https://github.com/liximomo/vscode-sftp/issues/459).

## 1.9.0 - 2019-01-08
  * Control files and folders to show or hide in Remote Explorer by `remoteExplorer.filesExclude`. [#410](https://github.com/liximomo/vscode-sftp/issues/410).
  * Suport new OpenSSH key format. [#391](https://github.com/liximomo/vscode-sftp/issues/391).
  * Improve performance.

## 1.8.4 - 2018-12-16
  * Fix ignore not work when use profile. [#428](https://github.com/liximomo/vscode-sftp/issues/428).

## 1.8.3 - 2018-12-14
  * Upgrade VSCode engine version.

## 1.8.2 - 2018-12-13
  * Add **Collapse All** action to RemoteExplorer.

## 1.8.0 - 2018-12-06
  * New command [Upload Changed Files](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-upload-changed-files).
  * Fix bugs.

## 1.7.6 - 2018-11-22
  * Reduce *80%* startup time.
  * Fix [#396](https://github.com/liximomo/vscode-sftp/issues/396).

## 1.7.5 - 2018-11-15
  * Fix [#394](https://github.com/liximomo/vscode-sftp/issues/394).

## 1.7.4 - 2018-11-09
  * Fix [#362](https://github.com/liximomo/vscode-sftp/issues/362).
  * Don't upload the file when it's in downloading. [#390](https://github.com/liximomo/vscode-sftp/issues/390).

## 1.7.3 - 2018-11-03
  * New configuration [limitOpenFilesOnRemote](https://github.com/liximomo/vscode-sftp/wiki/Configuration#limitopenfilesonremote).
  * Show `upload file` context menu in SCM.

## 1.7.2 - 2018-10-29
  * New command [Open SSH in Terminal](https://github.com/liximomo/vscode-sftp/wiki/Commands#open-ssh-in-terminal).

## 1.7.1 - 2018-10-25
  * New setting [downloadwhenopeninremoteexplorer](https://github.com/liximomo/vscode-sftp/wiki/Setting#downloadwhenopeninremoteexplorer).
  * fix some bugs.

## 1.7.0 - 2018-10-19
### New Features
  * New command [Upload Active Folder](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-upload-active-folder).
  * New command [Download Active Folder](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-download-active-folder).
  * New command [List Active Folder](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-list-active-folder).
  * New command [Cancel All Transfers](https://github.com/liximomo/vscode-sftp/wiki/Commands#cancel-all-transfers).
  * New configuration [remotetimeoffsetinhours](https://github.com/liximomo/vscode-sftp/wiki/Configuration#remotetimeoffsetinhours).

## 1.6.0 - 2018-10-12
### New Features
  * New command [Sync Local -> Remote](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-sync-local---remote).
  * New command [Sync Remote -> Local](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-sync-remote---local).
  * New command [Sync Both Directions](https://github.com/liximomo/vscode-sftp/wiki/Commands#sftp-sync-both-directions).
  * New configuration [syncOption](https://github.com/liximomo/vscode-sftp/wiki/Configuration#syncoption) for `Sync` command.

### Breaking Changes
  * Remove Command `SFTP: Sync To Remote`.
  * Remove Command `SFTP: Sync To Local`.
  * Remove configuration option `syncModel`.

## 1.5.13 - 2018-10-08
* Fix [#344](https://github.com/liximomo/vscode-sftp/issues/344).

## 1.5.12 - 2018-10-07
* New command `Diff Active File with Remote`.
* Command `Set Profile` can receive an argument from keybindings.

  ```json
  {
    "key": "ctrl+shift+cmd+d",
    "command": "sftp.setProfile",
    "args": "dev"
  }
  ```

## 1.5.10 - 2018-09-28
* Fix [#332](https://github.com/liximomo/vscode-sftp/issues/332).

## 1.5.9 - 2018-09-27
* Fix [#330](https://github.com/liximomo/vscode-sftp/issues/330).

## 1.5.8 - 2018-09-25
* Show name in the remote explorer. [#315](https://github.com/liximomo/vscode-sftp/issues/315).
* Fix [#308](https://github.com/liximomo/vscode-sftp/issues/308).

## 1.5.0 - 2018-09-13
### New Features
  * new [alt commands](https://github.com/liximomo/vscode-sftp#alt-commands) `Force Download` and `Force Upload`. This allow you to download/upload files but disregard ignore rules.

### Breaking Changes
  * Rename command `sftp.trans.remote(SFTP: Upload)` to `sftp.upload.activeFile` and command `sftp.trans.local(SFTP: Download)` to `sftp.download.activeFile`. Please update your keybinding if you've used one of these commands.

### Deprecated
  * Commands `SFTP: List` and `SFTP: List All` will be removed in favor of `Remote Explorer` in next release.

## 1.4.1 - 2018-09-03
### Feature
  * [Configuration in User Setting](https://github.com/liximomo/vscode-sftp#configuration-in-user-setting) Configuration your remote in User Setting.

### Fix
  * Fix sshConfig file not overwriting default configuration. [#305](https://github.com/liximomo/vscode-sftp/issues/305).

## 1.4.0 - 2018-08-27
### Feature
  * [Connection Hopping](https://github.com/liximomo/vscode-sftp#connection-hopping) allow you to connection to a target server through a proxy with ssh protocol.

## 1.3.9 - 2018-08-14
* Fix [#286](https://github.com/liximomo/vscode-sftp/issues/286).
* Fix [#287](https://github.com/liximomo/vscode-sftp/issues/287).

## 1.3.8 - 2018-08-13
* Fix [#285](https://github.com/liximomo/vscode-sftp/issues/285).

## 1.3.7 - 2018-08-10
* Fix bug in `remoteExplorer.refresh`.

## 1.3.0 - 2018-08-02
### New Features
  * [Remote Explorer](https://github.com/liximomo/vscode-sftp#remote-explorer).

## 1.2.7 - 2018-07-27
### New Features
  * `ignoreFile` [option](https://github.com/liximomo/vscode-sftp/wiki/Configuration#ignorefile).

## 1.2.3 - 2018-06-19
### New Features
  * [Swtichable Profiles](https://github.com/liximomo/vscode-sftp/#profiles).

## 1.2.0 - 2018-06-19
* Support [SSH configuration file](https://www.ssh.com/ssh/config/). The default ssh configuration file is `~/.ssh/config`. This can be changed by `sshConfigPath` option.

## 1.1.12 - 2018-06-08
* Fix [#200](https://github.com/liximomo/vscode-sftp/issues/200). Thanks for [Gergo Koos](https://github.com/gergokoos).

## 1.1.11 - 2018-05-21
* Fix [#198](https://github.com/liximomo/vscode-sftp/issues/198).

## 1.1.10 - 2018-05-18
* Show open folder prompt in `sftp:config` command.
* Fix [#174](https://github.com/liximomo/vscode-sftp/issues/174).

## 1.1.9 - 2018-05-17
* Add `confirm` option to `downloadOnOpen`.
* Fix [#160](https://github.com/liximomo/vscode-sftp/issues/160).
* Fix [#195](https://github.com/liximomo/vscode-sftp/issues/195).

## 1.1.8 - 2018-05-15
* Some UX improvements.
    * Only show `sftp` menu when extension get activated (Thanks [@mikolino](https://github.com/mikolino)).
    * Remove some unnecessary warning.
* Improve ftp reliability.
* Upgrade `ssh2` version.

## 1.1.7 - 2018-03-31
* `name` [configuration](https://github.com/liximomo/vscode-sftp#full-config).
* Fix bugs.

## 1.1.6 - 2018-03-24
* Better procedure message in status bar.
* Fix sync error when synced target is not exist.
* Fix [#146](https://github.com/liximomo/vscode-sftp/issues/146).

## 1.1.5 - 2018-03-23
* Improve stability of `ftp` protocol.
* Fix document don't show automatically after select a file through `list` command.
* Fix [#113](https://github.com/liximomo/vscode-sftp/issues/113).

## 1.1.4 - 2018-03-21
* `connectTimeout` [config](https://github.com/liximomo/vscode-sftp#full-config).
* `downloadOnOpen` [config](https://github.com/liximomo/vscode-sftp#full-config).
* Fix ftp unexpectedly traverse up director [#80](https://github.com/liximomo/vscode-sftp/issues/80). Thanks for [Andrey Orst](https://github.com/andreyorst)'s help.

## 1.1.3 - 2018-03-18
* Remove default ignore configuration. No files will be ignored if you don't explicitly configuration `ignore` option. Related isuse [#138](https://github.com/liximomo/vscode-sftp/issues/138).
* Fix [#133](https://github.com/liximomo/vscode-sftp/issues/133).
* Fix [#136](https://github.com/liximomo/vscode-sftp/issues/136).


## 1.1.0 - 2018-03-13
* `diff` command.
* Fix [#113](https://github.com/liximomo/vscode-sftp/issues/113).
* Fix [#124](https://github.com/liximomo/vscode-sftp/issues/124).

## 1.0.5 - 2018-02-24
* Support [multi select in the Explorer](https://code.visualstudio.com/updates/v1_20#_multi-select-in-the-explorer).
* Fix some bugs.

## 1.0.4 - 2018-02-08
* New configuration option `concurrency`.
* New configuration option `algorithms`.
* Fix [#103](https://github.com/liximomo/vscode-sftp/issues/103).

## 1.0.3 - 2018-02-05
* Simplify default configuration file's content when exec `sftp: config`.
* Configuration autocomplete.
* Fix watcher stop work after 'download' or 'sync to local'.

## 1.0.2 - 2018-01-30
* Add FTPS support.
* Add passphrase/password dialog support.
* Fix configuration not found error after configuration file changed.
* Fix `sftp config` failed to show created configuration file in vscode.

## 1.0.0 - 2018-01-26
🎉🎉🎉This release include some new features, bugfixs and improvements. It may be bring some new bugs, welcome to feedback.

### New Features
* `list` and `list all` command.
  * `list` will list all remote files except those match your ignore rules.
  * `list all` will list all remote files.

  The target will be dowmload after you select. And it will be open in vscode if the target is a file.
* When you download a folder through a command, the vscode explorer will be refreshed when the command finish.

### Breaking Changes
* Change to git ignore [spec](https://git-scm.com/docs/gitignore). It's more powerful and concise. You may need to change your ignore configuration.


## 0.9.4 - 2017-12-18
* `Context` now receives a relative path.
* Fix [#69](https://github.com/liximomo/vscode-sftp/issues/69), [#70](https://github.com/liximomo/vscode-sftp/issues/70).

## 0.9.0 - 2017-12-16
* Add a option to configuration a local path that correspond to a remote path.
* Support multiple configurations in one configuration file.
* Remove `.sftpConfig.json` configuration file support.
* Remove none-worksapce-root configuration files support.

## 0.8.11 - 2017-11-30
* Fix ftp can't preserve file permissions.

## 0.8.10 - 2017-11-20
* Disable create configuration at none-workspace-root-folder.

## 0.8.9 - 2017-11-17
* Preserve file permissions.
* Better README thanks [kataklys](https://github.com/kataklys).
* Fix Empty (0kb) files when download and uplaod. Thanks for [kataklys](https://github.com/kataklys)'s help ([#33](https://github.com/liximomo/vscode-sftp/issues/33))
* Show a waring for existing none-worksapce-root configuration files. Previously you can create multiple configuration files anywhere under workspace. So you won't need to open multiple vscode instances to make `sftp` working in different folders. Sincle vscode support [Multi-root Workspaces](https://code.visualstudio.com/docs/editor/multi-root-workspaces). There is no necessary to support multiple configuration now. This will make `sftp` both simple and a bettern starup performace.

## 0.8.8 - 2017-11-11
### Bugfix
* Files is not correctly filtered at configuration setup.

## 0.8.7 - 2017-11-07
### Bugfix
* Configuration setup not work for directories whose name does end with `.vscode`.

## 0.8.6 - 2017-11-06
* Performance improvement.
* Show a waring to the old `.sftpConfig.json` file.

### Behaviour Change
Now `uploadOnSave` only happens on a vscode save opetarion. It used to happen on a disk save opetarion caused by anything.

## 0.8.5 - 2017-10-18
### Improvement
* support more cipher algorithms.

## 0.8.4 - 2017-10-10
### Improvement
* log more infos to output pannel.

## 0.8.3 - 2017-09-26
### Bugfix
* fix couldn't create configuration through file picker when no sub files in the directory.

## 0.8.2 - 2017-09-24
### Enhance
* Don't need to reload vscode after execute `SFTP: config` command.
* `SFTP: config` creates `sftp.json` now.

## 0.8.1 - 2017-09-22
### Bugfix
* WIN could not find configuration(path is not normalized).

## 0.8.0 - 2017-09-22
### Feature
* support multi-root workspace.

### Change
* Configuration file name is changing to `sftp.json` from `.sftpConfig.json` for concision.

### Bugfix
* fix a bug that always return the same ssh session when have multiple configurations in workspace.

## 0.7.11 - 2017-09-13
### Bugfix
* fix tribe retrive.

## 0.7.10 - 2017-09-13
### Bugfix
* fix configuration not found when have multiple configuration files in workspace.

## 0.7.9 - 2017-09-01
### Bugfix
* change tip text from uploading to sync when download and upload.

## 0.7.8 - 2017-08-20
### Bugfix
* Fix `command not found error` when no folder opened.

## 0.7.7 - 2017-07-25
### Bugfix
* Fix folder match of ignore.

## 0.7.6 - 2017-07-24
### Bugfix
* Fix [files in "ignored" directories are still uploaded](https://github.com/liximomo/vscode-sftp/issues/15). Thanks for [Tom Spence](https://github.com/tomjaimz)'s help.

## 0.7.5 - 2017-07-18
### Feature
* A new editor configuration `sftp.printDebugLog`, dafault with false.

## 0.7.4 - 2017-07-14
### Enhance
* Configuration validation failing at startup does not require a reload to make extension work.

## 0.7.3 - 2017-07-13
### Feature
* Configuration validation.

### Misc
* More accurate watcher description.

## 0.7.2 - 2017-07-04
### Feature
* Add a way to execute commands on all detected configuration root folders.(run commands throw command palette)

## 0.7.1 - 2017-07-04
### Bugfix
* Fix miss files because of throttle.

## 0.7.0 - 2017-06-30
### Breaking Change
* Now configuration files are located in .vscode folder. Just move every .sftpConfig.json to the .vscode folder of same hierarchy.

## 0.6.14 - 2017-06-29
### Enhance
* show authentication input as asterisk.

## 0.6.13 - 2017-06-28
### Feature
* ssh agent authentication.

## 0.6.12 - 2017-06-26
### Feature
* Interactive authentication.

## 0.6.11 - 2017-06-22
### Feature
* Ignore works for download/sync remote file to local.

## 0.6.10 - 2017-06-13
### Enhance
* Better log.

## 0.6.9 - 2017-06-11
### Bugfix
* Remove unnecessary error message.
* Sync blocks on symlink.

## 0.6.8 - 2017-06-09
### Enhance
* Activate the extension only when it needs to. You must have the vscode greater than 1.13.0.

## 0.6.7 - 2017-06-07
### Enhance
* Keeping active so you don't have to reload vscode to active sftp when create configuration file at the first time.

## 0.6.6 - 2017-06-06
### Bugfix
* Window can't auto create dir non-existing.

## 0.6.2 - 2017-06-05
### Bugfix
* Incorrectly configuration not found error popup.

## 0.6.1 - 2017-06-03
### Bugfix
* Don't watch file when there is no .sftpConfig file.

## 0.6.0 - 2017-06-02
### Feature
* Support ftp.

### Feedback
* More debug info.

### Bugfix
* Fix `SFTPFileSystem.rmdir` doesn't resolve correctly.
* Disable watcher on pulling files.
* Make true re-connect when it need to.

## 0.5.4 - 2017-05-30
### Feedback
* Better error log.
* Output debug info in sftp output channel.

### Bugfix
* Fix some files missed uploading when they has updated because of throttle.

## 0.5.3 - 2017-05-26
### Feature
* AutoSave now works even in external file update!🎉🎉🎉
* A new configuration `watcher`. Now there is a way to perceive external file change(create, delete).

## 0.5.2 - 2017-05-22
### Bugfix
* Running a command through shortcut couldn't find active document correctly.

### Feedback
* Show path that is relative to the workspace root instead of full path on status bar.

## 0.5.1 - 2017-05-22
### Enhance
* Provide a way to run command at the workspace root.

## 0.5.0 - 2017-05-19
### Feature
* Keep ssh connect alive (re-connect only when needed).

## 0.4.12 - 2017-05-18
### Bugfix
* Fix binary file upload.

## 0.4.11 - 2017-05-18
### Feedback
* Better status indication.

## 0.4.10 - 2017-05-18
### Bugfix
* Configuration file not found in windows.
* Check existence of privateKeyPath.

## 0.4.0 - 2017-05-17
### Configuration
* Add option `syncModel`.

### Command
* New command Upload.
* New command Download.
