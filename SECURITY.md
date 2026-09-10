# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/Jonathanm10/nitpick/security/advisories/new).
Include the affected version, reproduction steps, and the potential impact.
Remove tokens, credentials, client screenshots, and other private data from examples.
Do not publish exploit details in a public issue before a fix is available.

## Supported versions

Security fixes target the latest release. Please update to the latest release
before checking whether an issue is still present.

## Automated checks

Dependabot checks Swift packages and GitHub Actions weekly. CodeQL scans Swift
on pushes, pull requests, and a weekly schedule. Pull requests also run a macOS
build, core tests, and dependency review for high or critical vulnerabilities.
Secret scanning and push protection help detect supported credential patterns.

This is a solo-maintained project: automated checks do not require approval or
merging by a second person. Scan results and dependency updates still need
maintainer review; passing checks do not guarantee the absence of vulnerabilities.
