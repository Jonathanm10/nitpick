# Deploy and host checks on the fallback mini (8 GB M2, macOS 26.3, Xcode 26.2)

Host address, account and paths redacted (`<mini-ip>`, `~`).

## First install, then update

```
$ scripts/deploy/deploy.sh <host> <branch>
Cloning https://github.com/Jonathanm10/nitpick.git…
Checked out f887464 (2026-10-28) WEB-12 fix: host.sh runs corepack enable with the pinned node on PATH
Installing node-v24.22.1-darwin-arm64…
Installing dependencies and building the web app…
host.sh: wrote ~/.config/nitpick/server.env from the example. Fill in its values (docs/operations.md), then run the update again.

(config filled in on the host: NITPICK_HOST, NITPICK_PORT, NITPICK_DATA_DIR, NITPICK_YOUTRACK_URL, NITPICK_MAX_BOOTED_DEVICES=1)

$ time scripts/deploy/deploy.sh <host> <branch>
Checked out f887464 (2026-10-28) WEB-12 fix: host.sh runs corepack enable with the pinned node on PATH
Installing dependencies and building the web app…
nitpick f887464 is serving on port 4870.
… 4.9 s total
```

Three first-run failures were fixed on the way (each in its own commit): bash 3.2 reading `$repository…` as one name, the workspace's `pnpm build` calling `pnpm` by name, and corepack's `env node` shebang.

## Health check

```
$ ssh <host> '~/nitpick/scripts/deploy/host.sh status'
Server: running (pid 6754), nitpick f887464, 2026-10-28
HTTP: the page and the API answer on port 4870
Listening: *:4870 127.0.0.1:49638
Uptime: 0 days (reboot before day 49)
Xcode: Xcode 26.2 Build version 17C52
iOS runtimes: iOS 17.0 iOS 17.5 iOS 18.3 iOS 26.2
Booted devices: 0 (cap: 1)
Memory: free 75%
Disk: 64Gi free
Backups: NONE in ~/nitpick-backups
host.sh: 1 problem(s) above.
```

(Healthy after the first backup.) launchd's view: `state = running`, `properties = keepalive | runatload`, program `~/.nitpick/node/bin/node`.

## The hub's port from another LAN machine

```
port 4870: Connection to <mini-ip> port 4870 [tcp/cc-tracking] succeeded!
port 49638: nc: connectx to <mini-ip> port 49638 (tcp) failed: Connection refused
```

## SIGKILL of the server (launchd KeepAlive, hub clean-up)

```
before: server 6754, hub 6775 (127.0.0.1:49638)
after: server 6930, hub 6931, back in .264 s
old hub 6775 gone
runs = 2
```

## Logs are opened for appending

```
1u R,W,AP,0x10000;CX ~/Library/Logs/nitpick/server.log
2u R,W,AP;CX ~/Library/Logs/nitpick/server.log
```

So the nightly rotation's copy-then-truncate is safe.

## Backup and restore

```
$ host.sh backup
2026-10-28 06:26:28 Backed up the data directory to ~/nitpick-backups/2026-10-28.
$ host.sh restore 2026-10-28
Restored ~/nitpick-backups/2026-10-28. The data directory it replaced, if any, is at ~/Library/Application Support/nitpick-server.before-restore-20261028-062629.
restored key identical to the replaced one; sign-in-key mode -rw-------; backups folder drwx------
$ host.sh restore 1999-01-01
host.sh: 1999-01-01 is neither a backup folder nor the date of one in ~/nitpick-backups.
exit=1
```
