# Nitpick owns the simulator lifecycle

The designer drags a CI-produced simulator `.app` (or zip) into nitpick, which boots the chosen device and runs `simctl install` + `simctl launch`. Because nitpick installs and launches the Build itself, it knows with certainty which bundle is under review and can attach trustworthy metadata (bundle ID, version, build from `Info.plist`; device model + OS from the booted simulator) to a YouTrack issue. We rejected "capture whatever simulator is already booted": it would require inferring the foregrounded app, giving weaker provenance. Build *acquisition* stays human in v1 (a dev shares the CI-produced Build); fetching from CI directly is deferred.

Consequence: reviewing Macs need a full Xcode installation — simulators and `simctl` ship with Xcode, not the Command Line Tools. Accepted for Liip-managed Macs; nitpick detects a missing Xcode or runtime and guides setup instead of failing obscurely.
