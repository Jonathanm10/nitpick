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
#   host.sh android            install or update what Android reviews need,
#                              then restart the server
#
# Where things live; each environment variable overrides its default:
#   NITPICK_CHECKOUT     ~/nitpick                   git checkout of main
#   NITPICK_RUNTIME      ~/.nitpick                  the pinned Node, and
#                                                    Java and ffmpeg for Android
#   NITPICK_CONFIG_FILE  ~/.config/nitpick/server.env  the server's config
#   NITPICK_BACKUP_DIR   ~/nitpick-backups           one folder per day
#   NITPICK_BACKUP_KEEP  14                          days of backups kept
#   logs                 ~/Library/Logs/nitpick/
#   the Android SDK      ~/Library/Android/sdk       where the server looks
#   its AVDs             ~/.android/avd
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
# The server's PATH: its Node, and the ffmpeg host.sh android installs.
agent_path=$runtime/node/bin:$runtime/ffmpeg:/usr/bin:/bin:/usr/sbin:/sbin
# Days of uptime after which status warns; the tcp_now bug strikes at 49.7.
uptime_warning_days=35

# What Android reviews need (ADR-0013), in the SDK's default place: the
# LaunchAgent passes no ANDROID_HOME, so that is where the server looks.
android_sdk=$HOME/Library/Android/sdk
android_image='system-images;android-37.0;google_apis;arm64-v8a'
android_build_tools='build-tools;37.0.0'
android_avd=Pixel_10
android_avd_profile=pixel_10
android_avd_name='Pixel 10'
# The AVD's RAM, for a cap of one device on an 8 GB host.
android_avd_ram_mb=2048
# Bootstraps sdkmanager, checked against the SHA-256 that
# developer.android.com/studio lists. sdkmanager then installs its own
# latest, and checks each package against the SDK repository's checksums.
cmdline_tools=commandlinetools-mac_arm64-15859902_latest.zip
cmdline_tools_sha256=835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e

say() { printf '%s\n' "$*"; }
fail() {
	printf 'host.sh: %s\n' "$*" >&2
	exit 1
}

usage() {
	fail "usage: host.sh update [ref] | status | backup | restore <backup> | android"
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
	prune_old node node-v
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
	PATH="$runtime/node/bin:$PATH" "$runtime/node/bin/corepack" enable pnpm
}

# pnpm at the version package.json's packageManager pins, through the
# corepack that ships with Node. CI keeps it from asking anything.
run_pnpm() {
	CI=true PATH="$runtime/node/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
		"$runtime/node/bin/pnpm" "$@"
}

# The running server keeps its Node and ffmpeg until the restart; then each
# install of a tool goes, but the one its link names.
prune_old() {
	current=$(readlink "$runtime/$1")
	for installed in "$runtime/$2"*; do
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
		<string>$(xml "$agent_path")</string>
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

	xcode=$(xcodebuild -version 2>/dev/null | tr '\n' ' ') || xcode=
	runtimes=$(xcrun simctl list runtimes 2>/dev/null | grep -v unavailable |
		sed -n 's/^\(iOS [0-9.]*\) .*/\1/p' | tr '\n' ' ') || runtimes=
	if [ -z "$xcode" ] || [ -z "$runtimes" ]; then
		say "Xcode: NOT READY. Xcode: ${xcode:-none}; usable iOS runtimes: ${runtimes:-none}."
		problems=$((problems + 1))
	else
		say "Xcode: $xcode"
		say "iOS runtimes: $runtimes"
	fi
	booted=$(xcrun simctl list devices booted 2>/dev/null | grep -c '(Booted)' || true)
	# Running emulators count against the cap too, where the SDK is installed.
	adb=$android_sdk/platform-tools/adb
	if [ -x "$adb" ]; then
		emulators=$("$adb" devices 2>/dev/null | grep -c '^emulator-[0-9]*	device$' || true)
		booted=$((booted + emulators))
	fi
	say "Booted devices: $booted (cap: $(value maxBootedDevices | sed 's/^$/none/'))"
	android=$(android_health) || android="failed: the server's Android check didn't run."
	case $android in
	ready:*) say "Android: ready. ${android#ready: }" ;;
	sdkMissing:*) say "Android: not set up, so iOS only. host.sh android sets it up." ;;
	*)
		say "Android: NOT READY. ${android#*: }"
		problems=$((problems + 1))
		;;
	esac
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

# The server's own Android check, in its LaunchAgent's environment: "ready:"
# with the AVDs, or the problem's kind and the reason the page shows.
android_health() {
	# shellcheck disable=SC2016 # JavaScript, not shell.
	env -i HOME="$HOME" PATH="$agent_path" "$node" --no-warnings --input-type=module -e '
		const [android, { androidProblemReason }, { nodeSubprocessRunner: runner }] =
			await Promise.all(process.argv.slice(1).map((path) => import(path)))
		const ffmpeg = await android.ffmpegPath(process.env)
		const health = await android.checkAndroidHealth(runner, android.androidSDK(process.env),
			async () => ffmpeg !== undefined && (await android.hasLibx264(runner, ffmpeg)))
		console.log(health.status === "ready"
			? `ready: AVDs ${health.devices.map((device) => `${device.name} (${device.osName})`).join(", ")}; ffmpeg ${ffmpeg}`
			: `${health.problem.kind}: ${androidProblemReason(health.problem)}`)
	' "$checkout/server/src/device/android.ts" "$checkout/server/src/device/hostHealth.ts" "$checkout/server/src/subprocess.ts"
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

# --- android -----------------------------------------------------------------

# What Android reviews need (ADR-0013), installed or brought up to date
# without Homebrew or sudo: Java for the SDK's tools, the SDK's packages,
# one AVD, and an ffmpeg with libx264 for serve-emu's stream. The server
# finds them when it starts, so it restarts last.
android() {
	preflight
	[ "$(uname -m)" = arm64 ] || fail "host.sh android sets up Apple silicon hosts only."
	load_config
	mkdir -p "$logs" "$agents"
	: >"$logs/android.log"
	install_java
	install_android_packages
	create_avd
	install_ffmpeg
	write_server_agent
	restart "$server_label"
	wait_until_serving
	prune_old java jdk-
	prune_old ffmpeg ffmpeg-
	android=$(android_health)
	case $android in
	ready:*) say "Android is ready. ${android#ready: }" ;;
	*) fail "Android isn't ready: ${android#*: }" ;;
	esac
}

# Java for sdkmanager and avdmanager: the newest Temurin 21 runtime, checked
# against the checksum Adoptium publishes.
install_java() {
	assets=$(curl -fsSL 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=aarch64&image_type=jre&os=mac&vendor=eclipse') ||
		fail "api.adoptium.net can't be reached for Java."
	# shellcheck disable=SC2016 # JavaScript, not shell.
	fields=$("$node" -e '
		const asset = JSON.parse(process.argv[1]).find(({ binary }) => binary.package.name.endsWith(".tar.gz"))
		console.log(asset.release_name, asset.binary.package.link, asset.binary.package.checksum)' "$assets") ||
		fail "api.adoptium.net lists no Java 21 runtime for macOS on arm64."
	read -r release link checksum <<EOF
$fields
EOF
	case $release in jdk-21*) ;; *) fail "api.adoptium.net named an unexpected Java: $release" ;; esac
	case $release in *[!A-Za-z0-9.+-]*) fail "api.adoptium.net named an unexpected Java: $release" ;; esac
	if [ ! -x "$runtime/$release-jre/Contents/Home/bin/java" ]; then
		say "Installing Java ${release#jdk-} for the Android SDK's tools…"
		download=$(mktemp -d)
		curl -fsSL -o "$download/java.tar.gz" "$link"
		(cd "$download" && printf '%s  java.tar.gz\n' "$checksum" | shasum -a 256 -c - >/dev/null) ||
			fail "$link doesn't match Adoptium's checksum."
		tar -xzf "$download/java.tar.gz" -C "$download"
		[ -x "$download/$release-jre/Contents/Home/bin/java" ] || fail "$link holds no $release-jre."
		mv "$download/$release-jre" "$runtime/$release-jre"
		rm -rf "$download"
	fi
	ln -sfn "$release-jre" "$runtime/java"
}

# The SDK's tools run on nitpick's Java. Their progress goes to a log, which
# holds the last run.
sdk_tool() {
	tool=$1
	shift
	JAVA_HOME=$runtime/java/Contents/Home "$tool" "$@" >>"$logs/android.log" 2>&1 || {
		tail -n 20 "$logs/android.log" >&2
		fail "${tool##*/} $* failed (above). The whole log is $logs/android.log."
	}
}

# Accepts the SDK's licenses, as Android Studio's setup does. sdkmanager
# checks what it downloads against the SDK repository's checksums.
install_android_packages() {
	sdkmanager=$android_sdk/cmdline-tools/latest/bin/sdkmanager
	if [ ! -x "$sdkmanager" ]; then
		say "Installing the Android SDK's command-line tools…"
		download=$(mktemp -d)
		curl -fsSL -o "$download/$cmdline_tools" "https://dl.google.com/android/repository/$cmdline_tools"
		(cd "$download" && printf '%s  %s\n' "$cmdline_tools_sha256" "$cmdline_tools" | shasum -a 256 -c - >/dev/null) ||
			fail "$cmdline_tools doesn't match the checksum developer.android.com lists."
		unzip -q "$download/$cmdline_tools" -d "$download"
		yes | sdk_tool "$download/cmdline-tools/bin/sdkmanager" --sdk_root="$android_sdk" --licenses
		sdk_tool "$download/cmdline-tools/bin/sdkmanager" --sdk_root="$android_sdk" --install 'cmdline-tools;latest'
		rm -rf "$download"
	fi
	say "Installing or updating the SDK's packages; the first time downloads about 3 GB…"
	yes | sdk_tool "$sdkmanager" --licenses
	sdk_tool "$sdkmanager" --install platform-tools emulator "$android_build_tools" "$android_image"
	sdk_tool "$sdkmanager" --update
}

# The AVD Reviewers boot. One that exists already stays as it is.
create_avd() {
	"$android_sdk/emulator/emulator" -list-avds 2>/dev/null | grep -qx "$android_avd" && return 0
	say "Creating the AVD ${android_avd}…"
	echo no | sdk_tool "$android_sdk/cmdline-tools/latest/bin/avdmanager" create avd \
		--name "$android_avd" --package "$android_image" --device "$android_avd_profile"
	avd_config=$HOME/.android/avd/$android_avd.avd/config.ini
	[ -f "$avd_config" ] || fail "avdmanager made no $avd_config."
	sed -i '' -e '/^hw\.ramSize=/d' -e '/^avd\.ini\.displayname=/d' "$avd_config"
	printf 'hw.ramSize=%s\navd.ini.displayname=%s\n' "$android_avd_ram_mb" "$android_avd_name" >>"$avd_config"
}

# ffmpeg with libx264, which serve-emu encodes an emulator's screen with:
# the newest release of Martin Riedl's static macOS build, checked against
# the SHA-256 published beside it. The server finds it on its PATH.
install_ffmpeg() {
	latest=$(curl -fsS -o /dev/null -w '%{redirect_url}' https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip) ||
		fail "ffmpeg.martin-riedl.de can't be reached for ffmpeg."
	case $latest in
	https://ffmpeg.martin-riedl.de/download/macos/arm64/*/ffmpeg.zip) ;;
	*) fail "ffmpeg.martin-riedl.de named no ffmpeg build: $latest" ;;
	esac
	build=${latest%/ffmpeg.zip}
	build=${build##*/}
	case $build in '' | *[!A-Za-z0-9._-]*) fail "ffmpeg.martin-riedl.de named an unexpected build: $build" ;; esac
	if [ ! -x "$runtime/ffmpeg-$build/ffmpeg" ]; then
		say "Installing ffmpeg ${build#*_}…"
		checksum=$(curl -fsSL "$latest.sha256" | cut -d ' ' -f 1)
		case $checksum in *[!0-9a-f]* | '') fail "ffmpeg.martin-riedl.de has no checksum for $latest." ;; esac
		download=$(mktemp -d)
		curl -fsSL -o "$download/ffmpeg.zip" "$latest"
		(cd "$download" && printf '%s  ffmpeg.zip\n' "$checksum" | shasum -a 256 -c - >/dev/null) ||
			fail "$latest doesn't match its published checksum."
		unzip -q "$download/ffmpeg.zip" -d "$download/ffmpeg-$build"
		"$download/ffmpeg-$build/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q ' libx264 ' ||
			fail "the ffmpeg in $latest has no libx264."
		mv "$download/ffmpeg-$build" "$runtime/ffmpeg-$build"
		rm -rf "$download"
	fi
	ln -sfn "ffmpeg-$build" "$runtime/ffmpeg"
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
	android) android ;;
	*) usage ;;
	esac
}

main "$@"
