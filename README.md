# Vaibhav SFTP Plus — SFTP sync extension for VS Code

A patched build of the SFTP/FTP sync extension, updated to work with current Node.js / VS Code versions (fixes the `isDate is not a function` crash by upgrading `ssh2`).

Maintained by [@vnahalpara](https://github.com/vnahalpara). <br>
Based on the SFTP extension by [@Natizyskunk](https://github.com/Natizyskunk/), originally forked from [liximomo's SFTP plugin](https://github.com/liximomo/vscode-sftp.git).

- VSIX release : https://github.com/vnahalpara/vscode-sftp-new/releases/

## INFOS - 2023/06/23
This is the main repository for the SFTP extension since [@liximomo](https://github.com/liximomo) has set his own to deprecated in favor of this one in the VSCode marketplace.
There are also other forks that are available. Feel free to try them.

A lot of work as been brought to fix bugs, add new features and more than 50 updates have been released with a lot of improvements and stability fixes for almost two years now. 😎

At the start of the year 2023, a new fork from [@satiromarra](https://github.com/satiromarra) was born with some really cool features. So for the future we decided to work together and put our efforts in one place to make an even better extension for the community.

As of today (2023-06-23) we'll now be two collaborators : [@satiromarra](https://github.com/satiromarra) and [@me](https://github.com/Natizyskunk) 🙂.

We've been working hard to fix a lot of things and we've updated more than 50 new releases with a lot of improvements and stability fixes and we've brought new features for almost two years now. 

We'll try to keep this extension up-to-date as much as we can and add new relevant features. For the last 6 months I wasn't able to work a lot on the project because of personal reasons at the time so I'm glad [@satiromarra](https://github.com/satiromarra) was able to take on while I wasn't here.

Also we would be more than happy to have you participate in one way or another to this project. You can do so by simply following the [templates](https://github.com/Natizyskunk/vscode-sftp/issues/new/choose) when you open a new issue or a new pull request.

---

VSCode-SFTP enables you to add, edit or delete files within a local directory and have it sync to a remote server directory using different transfer protocols like FTP or SSH. The most basic setup requires only a few lines of configuration with a wide array of specific settings also available to meet the needs of any user. Both powerful and fast, it helps developers save time by allowing the use of a familiar editor and environment.

- Features
  - [Browser remote with Remote Explorer](#remote-explorer)
  - Diff local and remote
  - Sync directory
  - Upload/Download
  - Upload on save
  - File Watcher
  - Multiple configurations
  - Switchable profiles
  - Temp File support
- [Commands](https://github.com/Natizyskunk/vscode-sftp/wiki/Commands)
- [Debug](#debug)
- [FAQ](#FAQ)

## Installation

### Method 1 (Recommended : Auto update)
1. Select Extensions (Ctrl + Shift + X).
2. Uninstall current sftp extension from @liximomo.
3. Install new extension directly from VS Code Marketplace : https://marketplace.visualstudio.com/items?itemName=Natizyskunk.sftp.
4. Voilà!

### Method 2 (Manual update)
To install just follow these steps from within VSCode:
1. Select Extensions (Ctrl + Shift + X).
2. Uninstall current sftp extension from @liximomo.
3. Open "More Action" menu(ellipsis on the top) and click "Install from VSIX…".
4. Locate VSIX file and select.
5. Reload VSCode.
6. Voilà!

## Platform support (Windows & macOS)

The extension and all of its features run on **both Windows and macOS** (and Linux). The DB
commands run `mysql` **on the remote server** over SSH, so nothing extra is installed locally
for database support. Two optional, terminal-only conveniences rely on Unix helper tools — see
the notes below.

| Feature | Windows | macOS |
|---|---|---|
| SFTP/FTP sync (upload / download / diff / sync) | ✅ | ✅ |
| Remote Explorer, Go To Folder | ✅ | ✅ |
| Database: browse, data view (paging/sort/filter), search, SQL runner, cell/row edit, Find Table | ✅ | ✅ |
| Manage Server (**Linux servers only**) | ✅ | ✅ |
| VPN tunnel for SFTP **and** database traffic | ✅ | ✅ |
| Open SSH in Terminal (plain) | ✅ | ✅ |
| Open SSH in Terminal **through the VPN** | ⚠️ needs `nc` (see note) | ✅ |
| `ssh_prefix` using `sshpass` | ⚠️ `sshpass` is Unix-only | ✅ |

The Windows and macOS columns above describe your **workstation**. Manage Server reads
`/proc` on the server, so the **server** must be Linux regardless of which one you run VS Code on.

## Manage Server

Right-click a connection root in the Remote Explorer → **Manage Server** (or run
`SFTP: Manage Server` from the command palette) to manage that server from your browser.

VS Code starts a small HTTP server on `127.0.0.1` — loopback only, never exposed to your
network — and opens Chrome on a token-authenticated page for that one connection. Everything it
shows is collected over the connection's existing SSH channel: no agent is installed on the
server, and no new service runs there.

The dashboard streams live metrics over the connection's SSH channel and renders an **Overview**
tab: five stat cards (CPU, Memory, Disk, Load (1m), Uptime), charts for CPU usage, per-core usage,
memory usage, load average and network throughput, plus tables for filesystems, top processes by
CPU, disk I/O (IOPS and latency) and network interfaces. A range selector switches the charts
between the last 5, 15 and 60 minutes of in-memory history. **Services**, **Web server**,
**Terminal** and **Logs** are also live tabs — see below. **Database** is not yet implemented:
it appears as a visibly disabled tab for every profile, including profiles that have `database`
configured (that configuration drives the separate **Databases** sidebar view, not this tab).

The Terminal and Logs tabs each open their own token-authenticated WebSocket (`/ws/terminal`,
`/ws/logs`) alongside the dashboard's existing HTTP/SSE traffic, gated the same way the rest of the
page is: the per-session token, plus checks on the request's `Origin` and `Host` headers so that a
malicious page open in another tab — or a hostile domain that resolves to `127.0.0.1` — cannot ride
a leaked token in.

Metric history lives in memory only and is not persisted across VS Code restarts.

Settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `sftp.serverManager.browser` | `chrome` | `chrome`, `default`, or `chrome-app` for a chromeless window |
| `sftp.serverManager.interval` | `2000` | Milliseconds between live samples |
| `sftp.serverManager.slowInterval` | `15000` | Milliseconds between slow-lane samples |
| `sftp.serverManager.historyMinutes` | `60` | Minutes of in-memory history for the charts |

Requires an SFTP (SSH) connection — FTP has no exec channel — and a Linux host, because
collection reads `/proc` and every action below shells out to `systemctl`/`nginx`/`apache2`.

### Services tab

Lists every `systemd` service unit (`systemctl list-units --type=service --all`, merged with
`list-unit-files` for the enabled/disabled/generated state), sorted with active units first, then
failed, then everything else alphabetically. A search box filters by unit name or description.

Each row has buttons for **start**, **stop**, **restart**, **reload** and **reload-or-restart**.
Every button — including start — opens a confirmation dialog first, because these run on the live
host over SSH; there is no fast path that skips the confirmation. `enable`/`disable` (changing
whether a unit starts on boot) are intentionally not offered here. A row's result (success or
failure, with the command's output) stays inline under that row until you dismiss it — nothing
auto-clears or times out.

### Web server tab

Detects `nginx` and/or Apache (`apache2`/`httpd`) on the host: whether each is installed, its
version, its `systemd` active/enabled state, and which of ports 80/443/8080/8443 are listening.
For whichever is present, it parses the site config files under `/etc/nginx` or `/etc/apache2`
(and RHEL-style `/etc/httpd`) into a table of virtual hosts — server name, aliases, listen
addresses, SSL, document root, proxy target, log paths — and reads each referenced TLS
certificate with `openssl x509` to show its expiry, subject and issuer, colour-coded by days
remaining. A **Test config** button runs `nginx -t` or `apachectl configtest`/`httpd -t` and shows
the raw output. A view button on each vhost row shows the actual config file text as read from
the server.

### Sudo requirement for Services and Web server

Every command that changes state or reads a protected file is wrapped in `sudo -n`
(non-interactive: it never prompts for a password). If sudo isn't set up to allow that without a
prompt, the action fails and the tab shows a hint naming the account and host, instead of silently
doing nothing. Listing services, `systemctl status` and detecting nginx/Apache carry no `sudo` and
need no privilege at all — those parts of both tabs load regardless.

What sudo actually executes matters, because a sudoers rule matches the argv it sees, not the
intent behind it:

| What you clicked | What sudo runs |
| --- | --- |
| A Services / Web server action button | `sudo -n systemctl <action> -- '<unit>.service'` |
| Loading the vhost table | `sudo -n sh -c '…cat each config file…'` |
| **Test config** | `sudo -n sh -c 'nginx -t 2>&1'` (or the `apachectl`/`httpd` chain) |
| Certificate expiry on the vhost table | `sudo -n sh -c '…openssl x509…'` |
| The **View** button on a vhost row | `sudo -n sed -n '1,400p' -- '<path>'` |

So `nginx`, `apache2ctl`, `httpd` and `openssl` are **never** the program sudo runs — they run
*inside* a `sudo -n sh -c` script, and sudoers only ever sees `/bin/sh`. A `NOPASSWD` rule naming
those binaries gets you nothing; it is the single most common way to end up with a working
Services tab and a Web server tab that fails on every panel.

You need either:

- **Root credentials on the profile** (next section) — recommended; or
- **Passwordless sudo** for the connection's own user, covering `/bin/systemctl` (Services) plus
  `/bin/sh` and `/bin/sed` (Web server):

  ```
  deploy ALL=(ALL) NOPASSWD: /bin/systemctl
  deploy ALL=(ALL) NOPASSWD: /bin/sh, /bin/sed
  ```

> **`NOPASSWD: /bin/sh` is equivalent to giving that account unrestricted root.** A shell will run
> anything, so the rule places no limit whatsoever on what the account can do — it is a full root
> grant written in five words. `/bin/sed` is very nearly as bad (`sed` can write files as root via
> `w`). If that isn't a trade you want to make, grant only `/bin/systemctl` — the Services tab then
> works and the Web server tab reports sudo failures — or use the root-credential lane below, which
> at least keeps the privilege attached to a credential you control and can rotate, rather than
> permanently widening what the deploy account can do on the host.

#### Root-credential lane (optional)

If a connection profile in `sftp.json` carries both `root_user` and `root_password`, every
privileged command runs over a **second SSH connection** authenticated with those credentials
instead of under the profile's own user. Only privileged commands use this second connection —
opening the dashboard, browsing the Overview tab, listing services, `systemctl status` and
detecting nginx/Apache all use the connection you already have; the first Services or Web server
*action* (or the vhost listing) is what opens it.

**The commands still carry `sudo -n` on this lane.** The root lane changes *who* runs them, not
*how*: `sudo -n systemctl …` is what gets executed either way, and `root` simply sudos to itself.
On a host with no `sudo` installed, or with a `requiretty`/`secure_path` restriction in
`/etc/sudoers` that blocks a non-interactive session, the root lane fails on every action too —
and the hint says so rather than suggesting a sudoers rule for root.

Note also that most Linux distributions ship `PermitRootLogin prohibit-password` in
`/etc/ssh/sshd_config`, which refuses password authentication for root. Setting `root_user`/
`root_password` alone is not enough on such a host; root password login has to be enabled on the
server as well, or the actions will fail with `All configured authentication methods failed`.

**What this option costs.** It is recommended over granting `NOPASSWD: /bin/sh`, but it is not
free, and both of its costs are worth weighing before you choose it:

- `root_password` is stored **in cleartext** in `sftp.json`, exactly like every other credential
  this extension reads. That file lives in your workspace, so it is easy to commit to a shared
  repository by accident. Add it to `.gitignore`, and do not use this option in a repository you
  do not control.
- Enabling `PermitRootLogin yes` to make the lane work is a **host-wide** change, not a
  per-feature one. It exposes root to password guessing from anywhere the SSH port is reachable,
  for every client, not just this extension.

If neither trade appeals, the third option is to leave the root lane unconfigured and accept that
the Web server tab's read panels (vhost config, Test config, certificates, View) will not work:
the action buttons on both tabs need only `NOPASSWD: /bin/systemctl`, which is a genuinely narrow
grant, and everything else in the dashboard needs no privilege at all.

If a profile connects through a hop/bastion (`hop`), `root_user`/`root_password` describe the
**innermost hop** — the real destination server — never the jump host; the jump host's own
credentials are never touched.

If a profile has only one of `root_user`/`root_password` (a half-finished edit), it is treated as
having neither, and commands fall back to `sudo -n` under the profile's own user.

The **Servers & settings** page shows which account privileged commands will actually run as.

```json
{
  "name": "prod",
  "host": "example.com",
  "username": "deploy",
  "password": "…",
  "root_user": "root",
  "root_password": "…"
}
```

#### Why a narrow sudoers allowlist rule will not work

Beyond the `/bin/sh` point above, every command is built with a `--` end-of-options guard before
the target name, and unit names are fully qualified — both tabs send the same shape:

```
sudo -n systemctl restart -- 'nginx.service'
```

A sudoers `NOPASSWD` rule written the way people usually write one, e.g.
`deploy ALL=(ALL) NOPASSWD: /bin/systemctl restart nginx`, will **not** match that command line:
sudoers matches the exact argv, and neither the `--` nor the `.service` suffix appears in a rule
written that way. This is deliberate, not an oversight — the `--` guard is a defence against a
unit/path name being reinterpreted as a flag, and it is not going to be removed for allowlist
compatibility. If you want a narrow rule, write it to match what is actually run (including the
`--` and the `.service` suffix); otherwise grant the binary without arguments, as in the examples
above.

### Terminal tab

A real interactive shell in the browser, backed by [xterm.js](https://xtermjs.org/) over a
dedicated `/ws/terminal` WebSocket. It rides the connection's own already-authenticated SSH
session — no new `ssh` process is spawned, and unlike **Open SSH in Terminal** (which shells out to
a real `ssh` process, optionally prefixed with `ssh_prefix`, e.g. `sshpass -p …`), no password ever
appears on any command line for this feature.

**The shell runs as the profile's ordinary SSH user — the same account used for file transfers —
never the root-credential lane described above.** Whatever that account can do on the host, the
Terminal tab can do, with no further prompt and no `sudo` wrapper of its own. Configuring
`root_user`/`root_password` changes nothing about the Terminal: don't assume a Terminal session is
root because the dashboard's privileged actions elsewhere run as root, and don't assume it's
unprivileged if the SSH user itself happens to have passwordless sudo or is `root` — either way, the
Terminal is exactly that account, no more and no less.

Closing the tab (or the browser) ends the shell; there is no persistent session to reattach to.

### Logs tab

Discovers log files under `/var/log` (up to three directories deep) and journald units that have
ever logged (`GET /api/logs`), shows a read-only snapshot of a selected source (its first 500
lines — the *start* of the file, which for an actively growing log is old content; use Follow for
recent activity), and can switch to a live **Follow** — `tail -F` for a file, `journalctl -f` for a unit —
over a dedicated `/ws/logs` WebSocket.

**Only paths a discovery scan actually returned for this session can be read or followed.** There
is no free-form path field: `GET /api/logs` seeds a per-session allowlist, and both the snapshot
read and Follow re-check the requested path against it — and against the same `/var/log`-rooted
shape check the scan itself applies — before doing anything privileged with it.

Rotated, compressed and login-accounting files that a scan of `/var/log` legitimately turns up —
`*.gz`/`*.bz2`/`*.xz`/`*.zip`, `*.1`/`*.2`/…, `*.old`, `wtmp`, `btmp`, `lastlog`, `faillog` — are
not hidden, but are demoted into a separate, collapsed-by-default group below the primary file
list, each tagged with why. `tail`/`sed` render most of these as binary garbage or truncated text,
so keeping them out of the primary list keeps that list usable at a glance without pretending the
scan didn't find them.

journald units have no one-shot snapshot route — the only way to see a unit's output is to start
Follow.

**Discovery, the snapshot read and Follow all need the same privileged-read arrangement as the
Services and Web server tabs** — see [Sudo requirement for Services and Web
server](#sudo-requirement-for-services-and-web-server) above; nothing about Logs relaxes it. One
detail is specific to Follow, though: `tail -F`/`journalctl -f` run directly (`sudo -n tail …` /
`sudo -n journalctl …`), not inside the `sudo -n sh -c` wrapper the vhost reads and Test config use
— so a sudoers rule that grants only `/bin/systemctl` (enough for the Services tab's action
buttons) does **not** enable Follow, and neither does one that grants only `/bin/sh`/`/bin/sed`.
Follow needs its own rule naming the binaries it actually execs:

```
deploy ALL=(ALL) NOPASSWD: /bin/tail, /bin/journalctl
```

— or the root-credential lane, which covers all of it.

**Up to 4 log follows may be open at once per Manage Server session.** Starting a fifth is refused
outright rather than queued. Every open follow holds an SSH exec channel for as long as it runs, on
the same pooled SSH connection shared with SFTP transfers, the metrics sampler and the Terminal
tab. OpenSSH's default `MaxSessions` is 10 channels per connection, and running past it doesn't
just refuse the extra follow — every other channel on that connection starts failing too, including
file transfers, with `administratively prohibited`. The cap keeps six channels of headroom under
that limit for everything else the dashboard and your file transfers need. Note the Terminal is
not capped: each browser tab left on the Terminal tab holds one more channel, so opening the
dashboard in several tabs at once can still reach the limit.

### Install the .vsix (both platforms)
- **UI:** Extensions panel → `…` menu → **Install from VSIX…** → pick `vaibhav-sftp-plus-<version>.vsix` → reload.
- **CLI:**
  - macOS / Linux: `code --install-extension vaibhav-sftp-plus-<version>.vsix --force`
  - Windows (PowerShell): `code --install-extension .\vaibhav-sftp-plus-<version>.vsix --force`

### VPN tunnel — install `wireproxy`
Download the binary for your OS from the [wireproxy releases](https://github.com/whyvl/wireproxy/releases):
- **macOS:** grab `wireproxy_darwin_arm64` (Apple Silicon) or `_amd64` (Intel), put it on your `PATH`,
  then clear the quarantine flag: `xattr -d com.apple.quarantine /path/to/wireproxy`.
- **Windows:** grab `wireproxy_windows_amd64.exe`, save it somewhere like `C:\tools\wireproxy.exe`,
  and point the config at it:
  ```json
  "vpn": { "type": "wireguard", "configFile": "C:\\Users\\you\\surfshark\\nyc.conf", "wireproxyPath": "C:\\tools\\wireproxy.exe" }
  ```
- If the binary isn't on `PATH`, set `vpn.wireproxyPath` to its full path on either OS.

### Database — nothing to install locally
The DB features tunnel through the same SSH connection and run `mysql` **on the server**, so they
work on Windows and macOS identically. Only the remote server needs the `mysql` client (Cloudways
and most hosts have it).

### Terminal-only notes
- **Open SSH in Terminal through the VPN** adds an `ssh -o ProxyCommand="nc -X 5 -x …"`. `nc` with
  SOCKS support ships on macOS/Linux but **not on Windows** by default. File transfers and database
  traffic still go through the VPN on Windows — only this terminal shortcut needs `nc`.
- **`ssh_prefix: "sshpass -p …"`** uses `sshpass`, a Unix tool (`brew install hudochenkov/sshpass/sshpass`
  on macOS). On Windows, prefer key-based auth instead of `sshpass`.

## Documentation
- [Home](https://github.com/Natizyskunk/vscode-sftp/wiki)
- [Settings](https://github.com/Natizyskunk/vscode-sftp/wiki/Setting)
- [Common configuration](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration)
- [SFTP configuration](https://github.com/Natizyskunk/vscode-sftp/wiki/SFTP-only-Configuration)
- [FTP confriguration](https://github.com/Natizyskunk/vscode-sftp/wiki/FTP(s)-only-Configuration)
- [Commands](https://github.com/Natizyskunk/vscode-sftp/wiki/Commands)

## Usage
If the latest files are already on a remote server, you can start with an empty local folder,
then download your project, and from that point sync.

1. In `VS Code`, open a local directory you wish to sync to the remote server (or create an empty directory
that you wish to first download the contents of a remote server folder in order to edit locally).
2. `Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on Mac open command palette, run `SFTP: config` command.
3. A basic configuration file will appear named `sftp.json` under the `.vscode` directory, open and edit the configuration parameters with your remote server information.

For instance:
```json
{
    "name": "Profile Name",
    "host": "name_of_remote_host",
    "protocol": "ftp",
    "port": 21,
    "secure": true,
    "username": "username",
    "remotePath": "/public_html/project", // <--- This is the path which will be downloaded if you "Download Project"
    "password": "password",
    "uploadOnSave": false
}
```
The password parameter in `sftp.json` is optional, if left out you will be prompted for a password on sync.
_Note：_ backslashes and other special characters must be escaped with a backslash.

4. Save and close the `sftp.json` file.
5. `Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on Mac open command palette.
6. Type `sftp` and you'll now see a number of other commands. You can also access many of the commands from the project's file explorer context menus.
7. A good one to start with if you want to sync with a remote folder is `SFTP: Download Project`.  This will download the directory shown in the `remotePath` setting in `sftp.json` to your local open directory.
8. Done - you can now edit locally and after each save it will upload to sync your remote file with the local copy.
9. Enjoy!

For detailed explanations please go to [wiki](https://github.com/Natizyskunk/vscode-sftp/wiki).

## Example configurations
You can see the full list of configuration options [here](https://github.com/Natizyskunk/vscode-sftp/wiki/configuration).

- [sftp sync extension for VS Code](#sftp-sync-extension-for-vs-code)
  - [Installation](#installation)
    - [Method 1 (Recommended : Auto update)](#method-1-recommended--auto-update)
    - [Method 2 (Manual update)](#method-2-manual-update)
  - [Documentation](#documentation)
  - [Usage](#usage)
  - [Example configurations](#example-configurations)
    - [Simple](#simple)
    - [Profiles](#profiles)
    - [Multiple Context](#multiple-context)
    - [Connection Hopping](#connection-hopping)
      - [Single Hop](#single-hop)
      - [Multiple Hop](#multiple-hop)
    - [Configuration in User Setting](#configuration-in-user-setting)
  - [Remote Explorer](#remote-explorer)
    - [Multiple Select](#multiple-select)
    - [Order](#order)
  - [Debug](#debug)
  - [FAQ](#faq)
  - [Donation](#donation)
    - [Buy Me a Coffee](#buy-me-a-coffee)
    - [PayPal](#paypal)

### Simple
```json
{
  "host": "host",
  "username": "username",
  "remotePath": "/remote/workspace"
}
```

### Profiles
```json
{
  "username": "username",
  "password": "password",
  "remotePath": "/remote/workspace/a",
  "watcher": {
    "files": "dist/*.{js,css}",
    "autoUpload": false,
    "autoDelete": false
  },
  "profiles": {
    "dev": {
      "host": "dev-host",
      "remotePath": "/dev",
      "uploadOnSave": true
    },
    "prod": {
      "host": "prod-host",
      "remotePath": "/prod"
    }
  },
  "defaultProfile": "dev"
}
```

_Note：_ `context` and `watcher` are only available at root level.

Use `SFTP: Set Profile` to switch profile.

### Multiple Context
The context must **not be same**.
```json
[
  {
    "name": "server1",
    "context": "project/build",
    "host": "host",
    "username": "username",
    "password": "password",
    "remotePath": "/remote/project/build"
  },
  {
    "name": "server2",
    "context": "project/src",
    "host": "host",
    "username": "username",
    "password": "password",
    "remotePath": "/remote/project/src"
  }
]
```

_Note：_ `name` is required in this mode.

### Connection Hopping
You can connect to a target server through a proxy with ssh protocol.

_Note：_ Variable substitution is not working in a hop configuration.

#### Single Hop
local -> hop -> target
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // hop
  "host": "hopHost",
  "username": "hopUsername",
  "privateKeyPath": "/Users/localUser/.ssh/id_rsa", // <-- The key file is assumed on the local.

  "hop": {
    // target
    "host": "targetHost",
    "username": "targetUsername",
    "privateKeyPath": "/Users/hopUser/.ssh/id_rsa", // <-- The key file is assumed on the hop.
  }
}
```

#### Multiple Hop
local -> hopa -> hopb -> target
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // hopa
  "host": "hopAHost",
  "username": "hopAUsername",
  "privateKeyPath": "/Users/hopAUsername/.ssh/id_rsa" // <-- The key file is assumed on the local.

  "hop": [
    // hopb
    {
      "host": "hopBHost",
      "username": "hopBUsername",
      "privateKeyPath": "/Users/hopaUser/.ssh/id_rsa" // <-- The key file is assumed on the hopa.
    },

    // target
    {
      "host": "targetHost",
      "username": "targetUsername",
      "privateKeyPath": "/Users/hopbUser/.ssh/id_rsa", // <-- The key file is assumed on the hopb.
    }
  ]
}
```

### VPN Tunnel (per-connection static IP)

Some servers only accept SSH/SFTP from an allowlisted **static IP**. Instead of routing
your whole machine through a VPN (which needs admin rights), this routes **only this one
SFTP connection** through a userspace WireGuard tunnel that exposes a local SOCKS5 proxy.
The rest of your machine is untouched and no root/admin is required. **SFTP only.**

**One-time setup**

1. Install [`wireproxy`](https://github.com/whyvl/wireproxy) — download the prebuilt binary for
   your OS/arch from the [releases page](https://github.com/whyvl/wireproxy/releases) (or build it
   with `go install github.com/whyvl/wireproxy/cmd/wireproxy@latest`). It is not in Homebrew core.
   Make sure the binary is on your `PATH`, or point `vpn.wireproxyPath` at it.
   On macOS, downloaded binaries may need the quarantine flag cleared:
   `xattr -d com.apple.quarantine /path/to/wireproxy`.
2. In your VPN provider's dashboard, do the **WireGuard Manual Setup** for the static-IP
   location and download the `.conf` (it contains your private key). For Surfshark this is
   *VPN → Manual Setup → WireGuard*, then the **Static IP** location (e.g.
   `us-nyc-st004.prod.surfshark.com`). Save it somewhere like `~/surfshark/us-nyc-st004.conf`.
3. Ask the server admin to allowlist that location's **egress IP** (the IP the VPN shows).

```json
{
  "name": "Locked-down server",
  "host": "1.2.3.4",
  "protocol": "sftp",
  "port": 22,
  "username": "username",
  "remotePath": "/var/www",
  "vpn": {
    "type": "wireguard",
    "configFile": "~/surfshark/us-nyc-st004.conf",
    "wireproxyPath": "wireproxy", // optional; defaults to PATH lookup
    "socksPort": 0,               // optional; 0 (default) = derive a stable port, see below
    "healthCheckTimeout": 15000   // optional; ms to wait for the tunnel
  }
}
```

Notes:
- The downloaded `.conf` holds your WireGuard private key — keep it out of source control.
  The extension writes a working copy into its storage with `0600` permissions and never logs it.
- WireGuard needs outbound **UDP 51820**; corporate firewalls that block it will fail with a
  clear error in the SFTP output channel.
- Composable with `hop`: the VPN carries the first outbound connection, then hops proceed inside it.
- Connections sharing the same `configFile` reuse a single `wireproxy` process.

#### The SOCKS port is now stable per config file

Without an explicit `vpn.socksPort`, the extension no longer picks a random free port on
every restart. It derives a port deterministically from the WireGuard config file's path,
inside a configurable range, so the same `.conf` always lands on the same port across
window reloads — anything that hard-codes it (a `ProxyCommand`, a note in `sftp.json`)
keeps working instead of going stale.

- **`sftp.vpn.portRange`** (string, default `"21000-21999"`) — the range the deterministic
  port is chosen from. Accepts `"low-high"`; anything else (missing dash, reversed bounds,
  out of the 1024–65535 range) silently falls back to the default rather than breaking
  connections.
- **`sftp.vpn.keepAlive`** (boolean, default `true`) — leave the tunnel running when the
  last SFTP/terminal session using it disconnects, so the next connection reuses it instead
  of paying wireproxy's startup and health-check cost again. Set to `false` to kill the
  tunnel as soon as its last user releases it, as before. Either way, closing VS Code (or
  disabling the extension) tears down every tunnel that window itself started — as long as
  the extension gets to shut down cleanly. A force-quit or a crashed extension host skips
  that teardown entirely, and the tunnel is left holding its port until the next connection
  adopts or replaces it.

An explicit `vpn.socksPort` in a profile still always wins over the derived port — it is
never silently moved.

#### Why a running tunnel is only ever adopted, not just reused

When the derived (or pinned) port is already occupied, the extension does not simply assume
it can use whatever is listening there. A port that answers a SOCKS5 handshake only proves
that *something* speaks SOCKS5 on it — not that it is this extension's tunnel, and not that
it goes where you expect. Any other process on the machine can bind a port in the same range
and speak SOCKS5 back. Trusting that alone would route your SSH session — password or key
included — through a proxy chosen by whichever process won the race to that port; on a
shared or already-compromised machine that is a straightforward man-in-the-middle.

So the extension only reuses ("adopts") an already-running listener when **all** of the
following hold:
1. A marker file it wrote itself, in its own extension storage directory, exists for that
   config file.
2. The marker's recorded port matches the port in question.
3. The marker's recorded process ID is still alive.
4. The marker was written since the machine last booted (a marker surviving a reboot names a
   process ID that has, with certainty, been recycled onto something unrelated).
5. The port still answers a SOCKS5 handshake.

If any single one of those fails, the extension does not adopt — it either starts its own
tunnel on a free port, or, when `vpn.socksPort` pins an exact port, fails the connection
outright rather than silently sharing that port with an unknown process.

**A tunnel of ours that stops responding may be terminated.** If everything above says a
listener is our own previous tunnel except the live SOCKS5 answer — it is ours, its process
is alive, but it has stopped talking — the extension re-probes it a few more times (to rule
out a slow machine rather than a dead one) and, only if it still never answers, sends it
`SIGTERM` before starting its replacement. This never happens to a process the extension did
not itself record in a marker it trusts; a listener that fails any of the five adoption
checks above is left alone, not signalled.

**An adopted tunnel is never torn down by the window that adopted it.** The marker directory
is shared by every VS Code window of the same install, so a tunnel that passes all five
checks may equally well belong to another window that is open and transferring right now —
nothing recorded in the marker can tell "a previous run" from "the window next to this one".
So closing a window (or, with `keepAlive: false`, simply disconnecting) tears down only the
tunnels *that* window started; one it adopted is dropped from its own bookkeeping and left
running, exactly as `keepAlive: true` would leave it. Its marker stays on disk, so the next
connection adopts it again — and if it has genuinely wedged in the meantime, the reap above
still cleans it up.

#### Upgrading from before 1.26.0

The marker file format changed in 1.26.0 to support the boot check above, so **a marker
written by an older build is refused for both adoption and reaping** — the new code cannot
tell an old marker apart from a foreign one, so it treats it the same way: not proof of
anything. In practice, on the first connection after upgrading:

- If a tunnel from the old build is still running for a given VPN config, it is **not**
  adopted and **not** reaped. It keeps running and holding its port, orphaned, until the
  machine restarts or you kill it yourself. This happens at most once per VPN config file.
- **If you have `vpn.socksPort` pinned** to a port that old tunnel still holds, the new
  build will **refuse to start**, with an error naming the port — it no longer silently
  proceeds and shares the port with a process it can't verify (that silent sharing was the
  security gap this release closes). You'll see something like *"VPN SOCKS port … is
  already in use by something this extension did not start"*.

**To recover:** find and stop the leftover `wireproxy` process (e.g. `pgrep wireproxy` /
`ps aux | grep wireproxy`, then stop the one holding the port named in the error), or
restart the machine. Either clears the stale listener and the next connection starts (or
re-derives) a tunnel normally.

### Database (MySQL over SSH)

Browse and search MySQL/MariaDB databases that live behind your SSH server (e.g. a
Cloudways `localhost` database) — the connection is tunneled over the same SSH session, so
no DB port needs to be exposed. **SFTP connections only.**

Add a `database` array to a connection in `sftp.json`:

```json
{
  "name": "My Server",
  "host": "1.2.3.4",
  "protocol": "sftp",
  "username": "user",
  "remotePath": "/var/www",
  "database": [
    {
      "host": "localhost",
      "port": 3306,
      "username": "db_user",
      "password": "db_pass",
      "name": "my_database",
      "label": "main (wp)"
    }
  ]
}
```

- `host`/`port` are resolved **from the remote server's perspective** (`localhost` = MySQL on
  the SSH host). `port` defaults to `3306`. `name` is the database (schema) name. `label` is an
  optional tree display name.
- Multiple databases per connection are supported (array).
- Composes with `vpn`/`hop` automatically — DB traffic rides the SSH connection.

Then use the **Databases** view in the SFTP sidebar:

- **Search Database…** — the headline feature: find a string across *every* text column of the
  whole database (or one table). Streams matches as it scans, shows progress, and is cancelable.
- **New Query / Run Query** — open a `.sql` editor bound to a database; run the selection or the
  whole file with `Cmd/Ctrl+Enter`. Bare `SELECT`s get an automatic `LIMIT`
  (`sftp.db.defaultLimit`, default 500); `UPDATE`/`DELETE` without a `WHERE` prompts first.
- **Select Top 100 / Show Structure** — right-click a table. Results open in a sortable grid with
  cell-copy and **Export CSV**.

> Passwords are stored in `sftp.json` as plaintext (same as the SSH `password` field today). Keep
> the file out of source control.

### Configuration in User Setting
You can use `remote` to tell sftp to get the configuration from [remote-fs](https://github.com/liximomo/vscode-remote-fs).

In User Setting:
```json
"remotefs.remote": {
  "dev": {
    "scheme": "sftp",
    "host": "host",
    "username": "username",
    "rootPath": "/path/to/somewhere"
  },
  "projectX": {
    "scheme": "sftp",
    "host": "host",
    "username": "username",
    "privateKeyPath": "/Users/xx/.ssh/id_rsa",
    "rootPath": "/home/foo/some/projectx"
  }
}
```

In sftp.json:
```json
{
  "remote": "dev",
  "remotePath": "/home/xx/",
  "uploadOnSave": false,
  "ignore": [".vscode", ".git", ".DS_Store"]
}
```

## Remote Explorer
![remote-explorer-preview](https://raw.githubusercontent.com/Natizyskunk/vscode-sftp/master/assets/showcase/remote-explorer.png)

Remote Explorer lets you explore files in remote. You can open Remote Explorer by:

1. Run Command `View: Show SFTP`.
2. Click SFTP view in Activity Bar.

You can only view a files content with Remote Explorer. Run command `SFTP: Edit in Local` to edit it in local.

### Multiple Select
You are able to select multiple files/folders at once on the remote server to download and upload. You can do it simply by holding down Ctrl or Shift while selecting all desired files, just like on the regular explorer view.

_Note：_ You need to manually refresh the parent folder after you **delete** a file if the explorer isn't correctly updated.

### Order
You can order the remote Explorer by adding the `remoteExplorer.order` parameter inside your `sftp.json` config file.

In sftp.json:
```json
{
  "remoteExplorer": {
    "order": 1 // <-- Default value is 0.
  }
}
```

## Debug
1. Open User Settings.
  - On Windows/Linux - `File > Preferences > Settings`
  - On macOS - `Code > Preferences > Settings`
2. Set `sftp.debug` to `true` and reload vscode.
3. View the logs in `View > Output > sftp`.

## FAQ
You can see all the Frequently Asked Questions [here](./FAQ.md).

## Donation
If this project helped you reduce development time and you wish to contribute financially

### Buy Me a Coffee
[![Buy Me A Coffee](https://bmc-cdn.nyc3.digitaloceanspaces.com/BMC-button-images/custom_images/orange_img.png)](https://www.buymeacoffee.com/Natizyskunk)

### PayPal
<!-- [![PayPal](https://www.paypalobjects.com/en_US/i/btn/btn_donate_SM.gif)](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=BY89QD47D7MPS&source=url) -->
[![PayPal](https://www.paypalobjects.com/en_US/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?business=DELD7APHHM3BC&no_recurring=0&currency_code=EUR)
[![PayPal Me](https://img.shields.io/badge/Donate-PayPal-green.svg)](https://paypal.me/natanfourie)
