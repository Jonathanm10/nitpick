#!/bin/sh
# Installs, updates and checks nitpick on its Device Host: the Mac that runs
# the server and the simulators (docs/operations.md). It runs on the host,
# as the account logged in at its console. scripts/deploy/deploy.sh streams
# it there over SSH, and the daily backup job runs the checkout's copy.
#
#   host.sh update [ref]       install, or update to ref (default: main),
#                              restart the server and check it answers
#   host.sh status             the health check
#   host.sh backup             copy the data directory to a dated folder
#   host.sh restore <backup>   put a backup (a folder, or its date) back
#
# Where things live; each environment variable overrides its default:
#   NITPICK_CHECKOUT     ~/nitpick                   git checkout of main
#   NITPICK_RUNTIME      ~/.nitpick                  the pinned Node
#   NITPICK_CONFIG_FILE  ~/.config/nitpick/server.env  the server's config
#   NITPICK_BACKUP_DIR   ~/nitpick-backups           one folder per day
#   NITPICK_BACKUP_KEEP  14                          days of backups kept
#   logs                 ~/Library/Logs/nitpick/
#
# Every function runs from main, below the definitions, with stdin closed:
# a script read from stdin (sh -s) is never eaten by a command it runs.
set -eu

repository=https://github.com/Jonathanm10/nitpick.git
checkout=${NITPICK_CHECKOUT:-$HOME/nitpick}
runtime=${NITPICK_RUNTIME:-$HOME/.nitpick}
config=${NITPICK_CONFIG_FILE:-$HOME/.config/nitpick/server.env}
backups=${NITPICK_BACKUP_DIR:-$HOME/nitpick-backups}
keep=${NITPICK_BACKUP_KEEP:-14}
logs=$HOME/Library/Logs/nitpick
agents=$HOME/Library/LaunchAgents
server_label=ch.liip.nitpick.server
backup_label=ch.liip.nitpick.backup
domain=gui/$(id -u)
node=$runtime/node/bin/node
# Days of uptime after which status warns; the tcp_now bug strikes at 49.7.
uptime_warning_days=35

say() { printf '%s\n' "$*"; }
fail() {
	printf 'host.sh: %s\n' "$*" >&2
	exit 1
}

usage() {
	fail "usage: host.sh update [ref] | status | backup | restore <backup>"
}

# --- update ------------------------------------------------------------------

update() {
	ref=${1:-main}
	preflight
	update_checkout "$ref"
	install_node
	say "Installing dependencies and building the web app…"
	(
		cd "$checkout"
		run_pnpm install --frozen-lockfile --reporter=silent
		run_pnpm build >/dev/null
	)
	ensure_config
	load_config
	mkdir -p "$logs" "$agents"
	write_server_agent
	write_backup_agent
	restart "$server_label"
	restart "$backup_label"
	wait_until_serving
	prune_old_nodes
	say "nitpick $(git -C "$checkout" rev-parse --short HEAD) is serving on port $(value port)."
}

preflight() {
	[ "$(uname -s)" = Darwin ] || fail "the Device Host must be a Mac."
	command -v git >/dev/null || fail "git is missing: install Xcode first."
	xcrun simctl help >/dev/null 2>&1 ||
		fail "Xcode's simulator tools don't answer: install Xcode, open it once and accept its license."
	[ "$(stat -f %Su /dev/console)" = "$(id -un)" ] ||
		fail "this account isn't logged in at the Mac's console. The server runs in that login's session, which simulators need: log in at the Mac, or turn on automatic login, then run this again."
}

update_checkout() {
	case $1 in '' | *[!A-Za-z0-9._/-]*) fail "not a git ref: $1" ;; esac
	if [ ! -d "$checkout/.git" ]; then
		say "Cloning ${repository}…"
		git clone --quiet "$repository" "$checkout"
	fi
	cd "$checkout"
	[ -z "$(git status --porcelain --untracked-files=no)" ] ||
		fail "$checkout has local changes, which a deploy never overwrites. Inspect them with git -C $checkout diff."
	git fetch --quiet --prune --tags origin
	commit=$(git rev-parse --verify --quiet "origin/$1^{commit}" ||
		git rev-parse --verify --quiet "$1^{commit}") ||
		fail "origin has no branch, tag or commit named $1."
	git checkout --quiet --detach "$commit"
	say "Checked out $(git log -1 --format='%h (%cs) %s' | cut -c1-90)"
}

# The newest Node of the major version .node-version pins, checked against
# nodejs.org's checksums. Each update picks up that major's latest patch.
install_node() {
	major=$(tr -d ' \n' <"$checkout/.node-version")
	case $major in '' | *[!0-9]*) fail ".node-version must hold a major version, not \"$major\"." ;; esac
	case $(uname -m) in
	arm64) arch=arm64 ;;
	x86_64) arch=x64 ;;
	*) fail "no Node build for $(uname -m)." ;;
	esac
	dist=https://nodejs.org/dist/latest-v$major.x
	sums=$(curl -fsSL "$dist/SHASUMS256.txt") || fail "nodejs.org can't be reached for Node $major."
	line=$(printf '%s\n' "$sums" | grep -E " node-v$major\.[0-9]+\.[0-9]+-darwin-$arch\.tar\.gz\$") ||
		fail "nodejs.org lists no Node $major for macOS on $arch."
	tarball=${line##* }
	name=${tarball%.tar.gz}
	if [ ! -x "$runtime/$name/bin/node" ]; then
		say "Installing ${name}…"
		mkdir -p "$runtime"
		download=$(mktemp -d)
		curl -fsSL -o "$download/$tarball" "$dist/$tarball"
		(cd "$download" && printf '%s\n' "$line" | shasum -a 256 -c - >/dev/null) ||
			fail "$tarball doesn't match nodejs.org's checksum."
		tar -xzf "$download/$tarball" -C "$download"
		mv "$download/$name" "$runtime/$name"
		rm -rf "$download"
	fi
	ln -sfn "$name" "$runtime/node"
	# A pnpm shim beside node: the workspace's own scripts call pnpm by name.
	"$runtime/node/bin/corepack" enable pnpm
}

# pnpm at the version package.json's packageManager pins, through the
# corepack that ships with Node. CI keeps it from asking anything.
run_pnpm() {
	CI=true PATH="$runtime/node/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
		"$runtime/node/bin/pnpm" "$@"
}

# The running server keeps its Node until the restart; older ones go after.
prune_old_nodes() {
	current=$(readlink "$runtime/node")
	for installed in "$runtime"/node-v*; do
		[ -d "$installed" ] && [ "${installed##*/}" != "$current" ] && rm -rf "$installed"
	done
	return 0
}

ensure_config() {
	if [ ! -f "$config" ]; then
		mkdir -p "$(dirname "$config")"
		chmod 700 "$(dirname "$config")"
		(umask 077 && cp "$checkout/server/config.example.env" "$config")
		fail "wrote $config from the example. Fill in its values (docs/operations.md), then run the update again."
	fi
	chmod 600 "$config"
}

# The config as the server reads it, by its own loadConfig: key=value lines.
load_config() {
	[ -f "$config" ] || fail "no config at $config: run host.sh update first."
	[ -x "$node" ] || fail "no Node at $node: run host.sh update first."
	# shellcheck disable=SC2016 # JavaScript, not shell.
	resolved=$(NITPICK_CONFIG_FILE=$config "$node" --no-warnings --input-type=module -e '
		const { loadConfig } = await import(process.argv[1])
		const config = loadConfig(process.env)
		for (const [key, value] of Object.entries(config)) {
			console.log(`${key}=${value ?? ""}`)
		}' "$checkout/server/src/config.ts") || fail "the server can't read $config (above)."
	[ -n "$(value youTrackURL)" ] || fail "set NITPICK_YOUTRACK_URL in $config."
}

value() { printf '%s\n' "$resolved" | sed -n "s/^$1=//p"; }

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# The server, in the console login's session: simulators need it. launchd
# restarts it whenever it stops, and starts it at each login.
write_server_agent() {
	install_agent "$server_label" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$server_label</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml "$node")</string>
		<string>$(xml "$checkout/server/src/main.ts")</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$(xml "$checkout")</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>NITPICK_CONFIG_FILE</key>
		<string>$(xml "$config")</string>
		<key>PATH</key>
		<string>$(xml "$runtime/node/bin"):/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>$(xml "$logs/server.log")</string>
	<key>StandardErrorPath</key>
	<string>$(xml "$logs/server.log")</string>
</dict>
</plist>
EOF
}

# The daily backup, at night when nobody reviews. A Mac asleep then runs it
# when it wakes.
write_backup_agent() {
	install_agent "$backup_label" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$backup_label</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>$(xml "$checkout/scripts/deploy/host.sh")</string>
		<string>backup</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>NITPICK_CHECKOUT</key>
		<string>$(xml "$checkout")</string>
		<key>NITPICK_RUNTIME</key>
		<string>$(xml "$runtime")</string>
		<key>NITPICK_CONFIG_FILE</key>
		<string>$(xml "$config")</string>
		<key>NITPICK_BACKUP_DIR</key>
		<string>$(xml "$backups")</string>
		<key>NITPICK_BACKUP_KEEP</key>
		<string>$(xml "$keep")</string>
	</dict>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>3</integer>
		<key>Minute</key>
		<integer>30</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>$(xml "$logs/backup.log")</string>
	<key>StandardErrorPath</key>
	<string>$(xml "$logs/backup.log")</string>
</dict>
</plist>
EOF
}

install_agent() {
	cat >"$agents/$1.plist.new"
	plutil -lint -s "$agents/$1.plist.new" || fail "the $1 agent isn't a valid plist."
	mv "$agents/$1.plist.new" "$agents/$1.plist"
}

# Unload, then load: a changed plist takes effect, and SIGTERM lets the
# server stop its hub and any File all resumes at the next start.
restart() {
	stop_agent "$1"
	launchctl enable "$domain/$1"
	launchctl bootstrap "$domain" "$agents/$1.plist"
}

stop_agent() {
	launchctl bootout "$domain/$1" 2>/dev/null || true
	waited=0
	while launchctl print "$domain/$1" >/dev/null 2>&1; do
		waited=$((waited + 1))
		[ "$waited" -le 30 ] || fail "$1 didn't stop within 30 s."
		sleep 1
	done
}

# Over loopback when the server listens on every address.
base_url() {
	case $(value host) in
	0.0.0.0 | :: | '') printf 'http://127.0.0.1:%s' "$(value port)" ;;
	*:*) printf 'http://[%s]:%s' "$(value host)" "$(value port)" ;;
	*) printf 'http://%s:%s' "$(value host)" "$(value port)" ;;
	esac
}

# The page loads, and the API answers 401 until someone signs in.
answers() {
	page=$(curl -fsS --max-time 3 "$(base_url)/" 2>/dev/null) || return 1
	case $page in *'<div id="root">'*) ;; *) return 1 ;; esac
	[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$(base_url)/api/me")" = 401 ]
}

wait_until_serving() {
	waited=0
	until answers; do
		waited=$((waited + 1))
		[ "$waited" -le 60 ] ||
			fail "nitpick isn't answering on port $(value port) after 60 s. See $logs/server.log."
		sleep 1
	done
}

# --- status ------------------------------------------------------------------

status() {
	load_config
	problems=0
	service=$(launchctl print "$domain/$server_label" 2>/dev/null) || service=
	pid=$(printf '%s\n' "$service" | sed -n 's/^	pid = //p')
	if [ -n "$pid" ]; then
		say "Server: running (pid $pid), nitpick $(git -C "$checkout" log -1 --format='%h, %cs')"
	else
		say "Server: NOT RUNNING. Last exit: $(printf '%s\n' "$service" | sed -n 's/^	last exit code = //p'). See $logs/server.log."
		problems=$((problems + 1))
	fi
	if answers; then
		say "HTTP: the page and the API answer on port $(value port)"
	else
		say "HTTP: NOT ANSWERING on port $(value port)"
		problems=$((problems + 1))
	fi
	if [ -n "$pid" ]; then
		listening=$(server_sockets "$pid")
		say "Listening: $(printf '%s' "$listening" | tr '\n' ' ')"
		# Only the server's own port may face the network; the hub stays on loopback.
		exposed=$(printf '%s\n' "$listening" | grep -v -e '^127\.0\.0\.1:' -e '^\[::1\]:' -e ":$(value port)\$" || true)
		if [ -n "$exposed" ]; then
			say "Hub: EXPOSED beyond loopback: $exposed"
			problems=$((problems + 1))
		fi
	fi

	boot=$(sysctl -n kern.boottime | sed -n 's/^{ sec = \([0-9]*\),.*/\1/p')
	days=$((($(date +%s) - boot) / 86400))
	if [ "$days" -ge "$uptime_warning_days" ]; then
		say "Uptime: $days days. REBOOT SOON: macOS's tcp_now bug stops new connections after 49.7 days."
		problems=$((problems + 1))
	else
		say "Uptime: $days days (reboot before day 49)"
	fi

	say "Xcode: $(xcodebuild -version 2>/dev/null | tr '\n' ' ')"
	say "iOS runtimes: $(xcrun simctl list runtimes 2>/dev/null | sed -n 's/^\(iOS [0-9.]*\) .*/\1/p' | tr '\n' ' ')"
	booted=$(xcrun simctl list devices booted 2>/dev/null | grep -c '(Booted)' || true)
	say "Booted devices: $booted (cap: $(value maxBootedDevices | sed 's/^$/none/'))"
	say "Memory: $(memory_pressure -Q 2>/dev/null | sed -n 's/^System-wide memory free percentage: /free /p')"
	say "Disk: $(df -h "$(value dataDirectory)" 2>/dev/null | awk 'NR == 2 { print $4 " free" }')"

	newest=$(newest_backup)
	if [ -z "$newest" ]; then
		say "Backups: NONE in $backups"
		problems=$((problems + 1))
	else
		say "Backups: newest $newest"
		[ "$newest" = "$(date +%Y-%m-%d)" ] || [ "$newest" = "$(date -v-1d +%Y-%m-%d)" ] || {
			say "Backups: the newest is OLDER THAN A DAY. See $logs/backup.log."
			problems=$((problems + 1))
		}
	fi
	[ "$problems" -eq 0 ] || fail "$problems problem(s) above."
	say "Healthy."
}

# Listening TCP addresses of the server and its children, one per line.
server_sockets() {
	pids=$1
	for child in $(pgrep -P "$1"); do pids=$pids,$child; done
	lsof -nP -a -iTCP -sTCP:LISTEN -p "$pids" 2>/dev/null |
		awk 'NR > 1 { print $9 }' | sort -u
}

newest_backup() {
	newest=
	for folder in "$backups"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
		[ -d "$folder" ] && newest=${folder##*/}
	done
	printf '%s' "$newest"
}

# --- backup and restore ------------------------------------------------------

# A copy of the whole data directory, sign-in-key included: without it no
# stored sign-in opens. Files are replaced whole, never rewritten in place,
# so each copied file is complete. The partial copy is renamed only once
# done, so a folder with a date is always a whole backup.
backup() {
	load_config
	data=$(value dataDirectory)
	[ -d "$data" ] || fail "no data directory at $data."
	mkdir -p "$backups"
	chmod 700 "$backups"
	day=$(date +%Y-%m-%d)
	partial=$backups/.$day.partial
	rm -rf "$partial"
	ditto "$data" "$partial"
	rm -rf "${backups:?}/$day"
	mv "$partial" "$backups/$day"
	set -- "$backups"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]
	excess=$(($# - keep))
	while [ "$excess" -gt 0 ]; do
		rm -rf "$1"
		shift
		excess=$((excess - 1))
	done
	rotate_log server.log
	rotate_log backup.log
	say "$(date '+%Y-%m-%d %H:%M:%S') Backed up the data directory to $backups/$day."
}

# launchd keeps the log open for appending, so it's copied, then emptied.
rotate_log() {
	log=$logs/$1
	[ -f "$log" ] || return 0
	[ "$(stat -f %z "$log")" -gt 10485760 ] || return 0
	cp "$log" "$log.1"
	: >"$log"
}

restore() {
	[ $# -eq 1 ] || usage
	load_config
	from=$1
	[ -d "$from" ] || from=$backups/$1
	[ -e "$from/sign-in-key" ] || [ -d "$from/reviewers" ] || [ -d "$from/history" ] ||
		fail "$1 is neither a backup folder nor the date of one in $backups."
	data=$(value dataDirectory)
	stop_agent "$server_label"
	aside=$data.before-restore-$(date +%Y%m%d-%H%M%S)
	[ ! -e "$data" ] || mv "$data" "$aside"
	ditto "$from" "$data"
	restart "$server_label"
	wait_until_serving
	say "Restored $from. The data directory it replaced, if any, is at $aside."
}

main() {
	exec </dev/null
	[ $# -ge 1 ] || usage
	command=$1
	shift
	case $command in
	update) update "$@" ;;
	status) status ;;
	backup) backup ;;
	restore) restore "$@" ;;
	*) usage ;;
	esac
}

main "$@"
