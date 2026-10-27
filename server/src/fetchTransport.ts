// The live HTTP seam for YouTrack, behind core's HTTPTransport. It never logs:
// a request's headers carry the token.
import type { HTTPTransport } from "@nitpick/core"

export const fetchTransport: HTTPTransport = {
  async send(request) {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    })
    return {
      status: response.status,
      body: new Uint8Array(await response.arrayBuffer()),
    }
  },
}
