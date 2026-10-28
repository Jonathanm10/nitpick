# Auth matrix against the deployed server, from another LAN machine

Run from a Mac on the office LAN (VPN) against the Device Host's nitpick port, with the server on the proof config (fake YouTrack on the host's loopback). Status codes only; the host's address is redacted.

Sign-in and sign-out (status codes only):

- POST /api/sign-in, wrong token: 401, cookie set: false
- POST /api/sign-in, empty token: 400, cookie set: false
- POST /api/sign-in, right token: 200, cookie set: true
- POST /api/sign-out: 204

| Route | no cookie | forged cookie | signed-out cookie | token as Bearer | signed in |
| --- | --- | --- | --- | --- | --- |
| `GET /api/me` | 401 | 401 | 401 | 401 | 200 |
| `GET /api/devices` | 401 | 401 | 401 | 401 | 200 |
| `GET /api/host` | 401 | 401 | 401 | 401 | 200 |
| `GET /api/projects` | 401 | 401 | 401 | 401 | 200 |
| `GET /api/review` | 401 | 401 | 401 | 401 | 200 |
| `POST /api/session/filing` | 401 | 401 | 401 | 401 | 202 |
| `DELETE /api/filing-result` | 401 | 401 | 401 | 401 | 204 |
| `GET /api/history` | 401 | 401 | 401 | 401 | 200 |
| `POST /api/history/import` | 401 | 401 | 401 | 401 | 400 |
| `GET /api/feedback/environment` | 401 | 401 | 401 | 401 | 200 |
| `POST /api/build` | 401 | 401 | 401 | 401 | 400 |
| `POST /api/session` | 401 | 401 | 401 | 401 | 400 |
| `PUT /api/session/device` | 401 | 401 | 401 | 401 | 400 |
| `PATCH /api/session` | 401 | 401 | 401 | 401 | 400 |
| `POST /api/session/captures` | 401 | 401 | 401 | 401 | 400 |
| `PATCH /api/session/findings/:itemID` | 401 | 401 | 401 | 401 | 400 |
| `DELETE /api/session/findings/:itemID` | 401 | 401 | 401 | 401 | 409 |
| `GET /api/session/findings/:itemID/capture` | 401 | 401 | 401 | 401 | 409 |
| `POST /api/feedback` | 401 | 401 | 401 | 401 | 400 |
| `POST /api/session/findings/:itemID/design-snapshots` | 401 | 401 | 401 | 401 | 400 |
| `PUT /api/session/findings/:itemID/design-snapshots/:snapshotID` | 401 | 401 | 401 | 401 | 400 |
| `PATCH /api/session/findings/:itemID/design-snapshots/:snapshotID` | 401 | 401 | 401 | 401 | 400 |
| `DELETE /api/session/findings/:itemID/design-snapshots/:snapshotID` | 401 | 401 | 401 | 401 | 409 |
| `GET /api/session/findings/:itemID/design-snapshot-data/:dataVersion` | 401 | 401 | 401 | 401 | 409 |
| `GET /api/label-sprite` | 401 | 401 | 401 | 401 | 400 |
| `POST /api/device-stream` | 401 | 401 | 401 | 401 | 400 |
| `GET /api/device-hub/vendor/serve-sim/helper/<UDID>/stream.mjpeg` | 401 | 401 | 401 | 401 | 200 |
| `GET /api/device-hub/vendor/serve-sim/helper/<UDID>/stream.avcc` | 401 | 401 | 401 | 401 | 200 |
| `GET /api/device-hub/vendor/serve-sim/api` | 404 | 404 | 404 | 404 | 404 |
| `GET /api/device-hub/vendor/serve-sim/exec` | 404 | 404 | 404 | 404 | 404 |
| `DELETE /api/session` | 401 | 401 | 401 | 401 | 204 |
| `WS /api/device-hub/vendor/serve-sim/helper/ws` | 401 | 401 | 401 | 401 | 101 |

Input socket, signed in but from another origin of the same site: 403

Non-GET on an allowlisted stream route (no cookie; method check comes before auth):
- POST stream.mjpeg: 405
- PUT stream.mjpeg: 405
- DELETE stream.mjpeg: 405
- PATCH stream.mjpeg: 405
- HEAD stream.mjpeg: 405
