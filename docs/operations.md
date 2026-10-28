# Running nitpick on its Device Host

nitpick's server and the simulators it streams run on one Mac, the Device
Host: a Liip office Mac mini ([ADR-0012](adr/0012-remote-only-web-app.md)).
This runbook keeps it running. It holds steps and commands only. The host's
address, its account and its config values live on the host and in the
operator's own notes, never in this repo.

Below, `<host>` is the SSH destination of the Device Host; an alias in your
`~/.ssh/config` is easiest. Every command on the host runs over SSH, as the
account that is logged in at the host's console.

## What runs where

| What | On the host |
| --- | --- |
| The code: a checkout of this repo's `main` | `~/nitpick` |
| Node: the newest release of the major version `.node-version` pins | `~/.nitpick/node` |
| The server's config | `~/.config/nitpick/server.env` (mode 0600) |
| The data: open Review Sessions, History, sign-ins | `NITPICK_DATA_DIR` in the config |
| Backups, one folder per day | `~/nitpick-backups/<YYYY-MM-DD>` |
| Logs | `~/Library/Logs/nitpick/server.log` and `backup.log` |
| The services: LaunchAgents | `~/Library/LaunchAgents/ch.liip.nitpick.server.plist` and `ch.liip.nitpick.backup.plist` |

- **The server** runs as a LaunchAgent in the console login's GUI session,
  which the simulators need.
  - It starts at each login.
  - launchd restarts it at once whenever it stops.
  - It writes to `server.log`.
- **The device hub** (`expo-device-hub`) is the server's child process. It
  listens on a random port on the host's loopback interface only, so only
  the server's own port answers on the network. The server restarts the
  hub if it crashes. If the server dies, launchd stops the hub with it.
- **The backup** runs every night at 03:30. If the Mac was asleep then,
  launchd runs it when the Mac wakes.

## The config

`~/.config/nitpick/server.env` is a dotenv file. The LaunchAgent points the
server at it with `NITPICK_CONFIG_FILE`.
[server/config.example.env](../server/config.example.env) lists the keys:

| Key | Meaning |
| --- | --- |
| `NITPICK_HOST` | The address to listen on. `0.0.0.0` serves the LAN. The default is loopback only. |
| `NITPICK_PORT` | The port Reviewers open. The default is 4870. |
| `NITPICK_DATA_DIR` | Where the data lives; back it up. |
| `NITPICK_YOUTRACK_URL` | The one YouTrack instance Reviewers sign in to and file into. Required. Changing it drops every stored sign-in. |
| `NITPICK_MAX_BOOTED_DEVICES` | At most this many devices booted at once: 1 on an 8 GB host, 2 on a 16 GB one. See [The device cap](#the-device-cap). |

The config holds no token. Each Reviewer signs in with their own YouTrack
token, which the server keeps encrypted in the data directory, under its
`sign-in-key`. The server refuses to start while the retired
`NITPICK_YOUTRACK_TOKEN` or `NITPICK_ACCESS_TOKEN` is set.

To change a value:

1. Edit the file on the host.
2. Restart the server: `launchctl kickstart -k gui/$(id -u)/ch.liip.nitpick.server`.
3. Run the [health check](#health-check).

## Prepare a new host

Do this once per Mac, at the Mac.

1. Create the account nitpick runs as, and log in with it at the console.
2. Set up the login for unattended reboots:
   - **FileVault off:** turn on automatic login for that account (System
     Settings › Users & Groups). A reboot then brings the session back, and
     the server with it.
   - **FileVault on:** macOS can't log in by itself. After every reboot,
     someone has to unlock the Mac at its login window.
3. Install Xcode, which needs an Apple ID.
   - Open it once, or run `sudo xcodebuild -license accept` and
     `xcodebuild -runFirstLaunch`.
   - Then install the iOS simulator runtime: `xcodebuild -downloadPlatform iOS`.
4. Turn on Remote Login (System Settings › General › Sharing), and add your
   SSH key to the account's `~/.ssh/authorized_keys`.
5. Keep the Mac awake, and have it start again after a power cut:
   `sudo pmset -a sleep 0 disksleep 0 autorestart 1`.
6. For Android reviews ([ADR-0013](adr/0013-android-on-the-device-host.md)),
   install the Android SDK with an AVD and build-tools in its default place,
   `~/Library/Android/sdk`, and an `ffmpeg` with libx264 from Homebrew. The
   LaunchAgent doesn't pass your shell's `ANDROID_HOME`, so the server reads
   the default places. Without them, the server still reviews iOS, and the
   page says what Android lacks.
7. If the macOS firewall is on, allow incoming connections for the pinned
   Node after the first deploy. Otherwise the first start waits on a prompt
   at the console:
   `sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(readlink -f ~/.nitpick/node/bin/node)"`.
   Run it again after a deploy that installs a newer Node.

## Install and update

From a checkout of this repo on your own machine:

```sh
scripts/deploy/deploy.sh <host>            # deploy main
scripts/deploy/deploy.sh <host> <ref>      # a branch, tag or commit; an earlier commit rolls back
NITPICK_DEPLOY_SSH="ssh -i ~/.ssh/<key>" scripts/deploy/deploy.sh <host>   # a key your ssh config doesn't name
```

`deploy.sh` streams `scripts/deploy/host.sh` to the host over SSH and runs
its `update`. The update:

1. Checks the host:
   - it is a Mac
   - Xcode's simulator tools answer
   - the account is logged in at the console
2. Clones this public repo to `~/nitpick`, or fetches it. It checks out the
   ref, and refuses if the checkout has local changes.
3. Installs the newest Node of the pinned major version, checked against
   nodejs.org's checksums. Older Nodes are deleted after the restart.
4. Runs `pnpm install --frozen-lockfile` and `pnpm build`. pnpm is the
   version `package.json` pins, installed by corepack.
5. Writes both LaunchAgents, and restarts the server and the backup job.
6. Waits until the page loads and `/api/me` answers 401 (not signed in).
   Then it prints the commit and the port.

**On the first install**, the update stops after writing the config from the
example. Fill the config in ([The config](#the-config)), then run
`deploy.sh` again.

Reviewers get the new version when they reload the page. A deploy restarts
the server, which takes a few seconds:

- Sign-ins and open Review Sessions are kept on disk, so they stay.
- A File all that the restart interrupts resumes when the server starts again.
- Booted devices keep running. The server forgets which Reviewer runs which
  device until each Reviewer resumes or starts again
  ([The device cap](#the-device-cap)).

Deploy when nobody is reviewing, if you can.

## Health check

```sh
ssh <host> '~/nitpick/scripts/deploy/host.sh status'
```

It prints each check, ends with `Healthy.`, and exits non-zero on any
problem. It checks:

- **The server:** whether it is running, and the deployed commit.
- **HTTP:** whether the page and the API answer.
- **The addresses it listens on:** the server's port, and the hub on
  loopback only.
- **Uptime:** it warns from day 35 ([Reboots](#reboots-and-the-497-day-bug)).
- **The host:** Xcode, the installed iOS runtimes, the booted devices
  against the cap, free memory and free disk.
- **Backups:** the newest one. A missing backup, or one older than a day,
  counts as a problem.

From another machine on the LAN, open `http://<host>:<port>`: the page shows
sign-in. Once signed in, the home page shows "Device Host not ready" with
the reason when Xcode or an iOS runtime is missing.

## Logs

- `tail -f ~/Library/Logs/nitpick/server.log` shows the server and its
  `[device hub]` lines. The hub's token is never logged.
- `~/Library/Logs/nitpick/backup.log` has one line per backup.
- `launchctl print gui/$(id -u)/ch.liip.nitpick.server` is launchd's view of
  the server: its state, pid, number of runs and last exit.
- The nightly backup rotates each log past 10 MB: it copies the log to
  `<name>.1`, then empties it.

## Start, stop and restart

```sh
launchctl kickstart -k gui/$(id -u)/ch.liip.nitpick.server     # restart
launchctl bootout gui/$(id -u)/ch.liip.nitpick.server          # stop, until the next login or deploy
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ch.liip.nitpick.server.plist   # start
```

Over SSH, these work only while the account is logged in at the console.

## Reboots and the 49.7-day bug

macOS has a `tcp_now` bug that strikes after about 49.7 days of uptime.
Closed connections stop expiring, until no new TCP connection can open,
loopback included. The server can no longer reach YouTrack or its own hub,
and SSH fails. Only a reboot fixes it. It took the fallback mini down at
189 days. **Reboot well before day 49.**

To check uptime, run `ssh <host> uptime`, or the health check, which warns
from day 35.

The reboot cadence depends on FileVault:

- **Host without FileVault (the main host):** reboot weekly, unattended, at
  night.
  - `sudo pmset repeat restart U 04:00:00` reboots every Sunday at 04:00.
  - `pmset -g sched` shows the schedule.
  - Automatic login brings the session back, and the server with it.
- **Host with FileVault (the fallback mini):** it can't reboot unattended,
  because FileVault waits at the login window for a password.
  - Reboot by hand once a month, with someone at the Mac to unlock it:
    `sudo shutdown -r now`, then log in at the Mac.
  - `sudo fdesetup authrestart` unlocks the next start once, but it asks
    for the password too.
  - Keep a monthly reminder, and never let uptime pass 40 days.

After any reboot:

1. Log in at the Mac. On a host with automatic login, this happens by itself.
2. Run the health check. It should say `Healthy.` with 0 booted devices.

What a reboot does to the people using nitpick:

- **Open Review Sessions** are kept on disk. Each Reviewer finds theirs
  paused, at "Ready to resume". Resume review boots their device again and
  relaunches the Build.
- **Booted devices**, simulators and emulators, go down with the host. None
  boots again by itself.
- **Sign-ins** are kept on disk, sealed, so nobody has to sign in again.
- **A File all** that the reboot cut short resumes when the server starts.
- **A page left open** during the reboot shows its review paused once the
  server answers again.

## The device cap

`NITPICK_MAX_BOOTED_DEVICES` keeps the host's memory from running out. It
counts iOS simulators and Android emulators alike.

- **When a start needs room:** if starting would boot one device too many,
  the server first shuts down booted devices that nobody is reviewing on.
  If that isn't enough, the Reviewer sees "The Device Host is full", with
  the names of the Reviewers using it, and can try again later. There is
  no queue.
- **One device, one Reviewer:** each device runs for one Reviewer at a time.
  Picking a device someone else is reviewing on names them.
- **When a device stops being someone's:** a Reviewer's device stays theirs
  until they end the review, file it, or upload a new Build. It also stops
  being theirs after 30 minutes without a request from them, for example a
  tab that was closed or left hidden.
- **After a restart:** the server forgets which device is whose. A device
  booted before the restart counts as unused until its Reviewer resumes or
  starts again.
- **Freeing a device by hand:**
  - a simulator: `xcrun simctl list devices booted`, then
    `xcrun simctl shutdown <UDID>`
  - an emulator: `~/Library/Android/sdk/platform-tools/adb devices`, then
    `~/Library/Android/sdk/platform-tools/adb -s <serial> emu kill`

Measured on the 8 GB mini with one iPhone 17 Pro simulator booted and
streaming: free memory went from 74% to 54%. Two devices don't fit there.

## Xcode, simulator runtime and macOS updates

1. Pick a time when nobody is reviewing. The health check should show 0
   booted devices.
2. Update Xcode.
   - If its path changed: `sudo xcode-select -s /Applications/<Xcode>.app`.
   - Then: `sudo xcodebuild -license accept` and `xcodebuild -runFirstLaunch`.
3. Update the runtimes.
   - Install the newest iOS runtime: `xcodebuild -downloadPlatform iOS`.
   - List the installed ones: `xcrun simctl list runtimes`.
   - Delete one nobody needs: `xcrun simctl runtime delete <identifier>`.
     The page greys out devices whose runtime is missing.
   - The page offers every iOS simulator on the host. Add one for a new
     runtime: `xcrun simctl create "iPhone 17 Pro" "iPhone 17 Pro" <runtime identifier>`.
4. Restart the server, so its hub starts on the new Xcode:
   `launchctl kickstart -k gui/$(id -u)/ch.liip.nitpick.server`.
5. Run the health check, then a short review: sign in, start on a device
   with the new runtime, and capture.

A macOS update reboots the host. Follow [Reboots](#reboots-and-the-497-day-bug).

## Backups and restore

**The nightly backup** copies the whole data directory with `ditto` to
`~/nitpick-backups/<YYYY-MM-DD>`, and keeps the last 14.

- The copy goes into a hidden folder first, and gets its date only once it
  is complete.
- The server replaces each file whole and never rewrites one in place, so
  every copied file is complete. The job runs at night, when nobody is
  reviewing.
- The backup includes `sign-in-key`. Without it, no stored sign-in opens:
  every Reviewer has to sign in again, and an interrupted File all waits
  for its Reviewer.
- Backups hold every Reviewer's sealed token together with its key. The
  folder is mode 0700; treat it as a secret.
- **The backups sit on the same disk as the data.** They cover mistakes and
  corruption, not a lost or broken Mac. When that matters, copy them off
  the host as well. For example, from another machine:
  `rsync -a <host>:nitpick-backups/ <safe place>/`.

To back up by hand: `ssh <host> '~/nitpick/scripts/deploy/host.sh backup'`.

**To restore** a backup:

```sh
ssh <host> '~/nitpick/scripts/deploy/host.sh restore <YYYY-MM-DD>'   # or the path of a backup folder
```

It:

1. stops the server
2. moves the data directory aside to `<data>.before-restore-<time>`
3. copies the backup into its place
4. starts the server, and waits until it answers

Delete the folder it moved aside once you are satisfied.

A restore loses everything since the backup: Findings captured, and
sessions filed. Issues filed since then stay in YouTrack, but History no
longer lists them.

## Moving to the main host

The main host is the 16 GB mini with FileVault off, once its CI use ends.

1. [Prepare it](#prepare-a-new-host), including automatic login.
2. Deploy to it with `scripts/deploy/deploy.sh <new host>`. Fill in its
   config:
   - use the same `NITPICK_YOUTRACK_URL`, or every stored sign-in is dropped
   - set the cap to 2
   - then deploy again
3. Schedule its weekly reboot: `sudo pmset repeat restart U 04:00:00`.
4. When nobody is reviewing, stop the old server and take a last backup on
   the old host:
   `launchctl bootout gui/$(id -u)/ch.liip.nitpick.server && ~/nitpick/scripts/deploy/host.sh backup`.
5. Copy that backup across, from your own machine:
   `ssh <old host> 'tar -C ~/nitpick-backups -cf - <YYYY-MM-DD>' | ssh <new host> 'mkdir -p ~/nitpick-backups && tar -C ~/nitpick-backups -xf -'`.
6. On the new host, restore it: `~/nitpick/scripts/deploy/host.sh restore <YYYY-MM-DD>`.
7. Run the health check and a short review. Then send Reviewers the new
   URL.
   - Their open Review Sessions and History came along.
   - Browsers keep sign-in cookies per address, so each Reviewer signs in
     once at the new URL.
8. On the old host, keep the server from coming back at the next login:
   `launchctl disable gui/$(id -u)/ch.liip.nitpick.server`. Do the same for
   `ch.liip.nitpick.backup`. Keep its backups for a while.

## HTTPS

There is no HTTPS yet: nitpick serves plain HTTP on the office LAN, which a
VPN into the office also reaches. Over plain HTTP the browser has no
WebCodecs, so the iOS stream falls back to MJPEG.

A certificate that Liip machines trust needs a Liip infrastructure decision.
A TLS proxy in front of the server would also need two server changes:

- keep the original `Host`, which the Origin check compares against
- set the sign-in cookie's `Secure` flag from the forwarded scheme, which
  the server doesn't read yet
