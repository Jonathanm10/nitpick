# host.sh backup / restore without library/ (local run, stubbed launchctl and curl)

Data dir: sign-in-key, .hidden, history/a.json, reviewers/vera/open-session/session.json, library/abc/build/ReviewMe.app/bin

## backup → ~/nitpick-backups/2026-11-23
.
./2026-11-23
./2026-11-23/.hidden
./2026-11-23/history
./2026-11-23/history/a.json
./2026-11-23/reviewers
./2026-11-23/reviewers/vera
./2026-11-23/reviewers/vera/open-session
./2026-11-23/reviewers/vera/open-session/session.json
./2026-11-23/sign-in-key
library/ is absent.

## restore 2026-11-23 after changing sign-in-key and adding library/def
.
./.hidden
./history
./history/a.json
./library
./library/abc
./library/abc/build
./library/abc/build/ReviewMe.app
./library/abc/build/ReviewMe.app/bin
./library/def
./library/def/entry.json
./reviewers
./reviewers/vera
./reviewers/vera/open-session
./reviewers/vera/open-session/session.json
./sign-in-key   ← sign-in-key content restored from the backup
library/abc and library/def kept from the replaced data dir.
(The restore's final "isn't answering after 60 s" comes from the stubbed curl; the files were in place before it.)
