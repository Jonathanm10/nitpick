| Route (UDID and host redacted) | Method | none | wrong | Bearer | cookie |
| --- | --- | --- | --- | --- | --- |
| helper/<udid>/stream.avcc (H.264)                    | GET    |  401 |  401 |  200 |  200 |
| helper/<udid>/stream.mjpeg                           | GET    |  401 |  401 |  200 |  200 |
| helper/<udid>/stream.mjpeg                           | HEAD   |  405 |  405 |  405 |  405 |
| helper/<udid>/stream.mjpeg                           | POST   |  405 |  405 |  405 |  405 |
| helper/<udid>/stream.mjpeg                           | PUT    |  405 |  405 |  405 |  405 |
| helper/<udid>/stream.mjpeg                           | PATCH  |  405 |  405 |  405 |  405 |
| helper/<udid>/stream.mjpeg                           | DELETE |  405 |  405 |  405 |  405 |
| helper/<udid>/stream.mjpeg                           | OPTIONS |  405 |  405 |  405 |  405 |
| helper/ws?device=<udid> (input)                      | WS     |  401 |  401 |  101 |  101 |
| helper/ws?device=<udid> from another origin          | WS     |  401 |  401 |  403 |  403 |
| serve-sim exec                                       | POST   |  404 |  404 |  404 |  404 |
| serve-sim exec                                       | GET    |  404 |  404 |  404 |  404 |
| serve-sim exec-ws                                    | WS     |  404 |  404 |  404 |  404 |
| serve-sim /api (reveals its exec token)              | GET    |  404 |  404 |  404 |  404 |
| serve-sim grid start (boots and attaches)            | POST   |  404 |  404 |  404 |  404 |
| helper/<udid>/config                                 | GET    |  404 |  404 |  404 |  404 |
| helper/<udid>/../../exec (traversal)                 | GET    |  404 |  404 |  404 |  404 |
| hub /api/devices                                     | GET    |  404 |  404 |  404 |  404 |
| hub /api/devices/shutdown                            | POST   |  404 |  404 |  404 |  404 |
| serve-emu /api/devices                               | GET    |  404 |  404 |  404 |  404 |
