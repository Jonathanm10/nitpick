import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, onTestFinished, test } from "vitest"
import { fetchTransport } from "../src/fetchTransport.ts"

interface Received {
  method?: string
  url?: string
  headers: IncomingHttpHeaders
  body: string
}

async function echoServer(status: number): Promise<{
  url: string
  received: Received[]
}> {
  const received: Received[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      })
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(`{"login":"vera"}`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve()))
  )
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, received }
}

describe("Live HTTP transport", () => {
  test("sends the method, headers and body as given, and returns status and bytes", async () => {
    const server = await echoServer(201)

    const response = await fetchTransport.send({
      method: "POST",
      url: `${server.url}/api/issues?fields=id,idReadable`,
      headers: {
        Authorization: "Bearer perm:t",
        "Content-Type": "application/json",
      },
      body: new TextEncoder().encode(`{"summary":"Header clips"}`),
    })

    expect(response.status).toBe(201)
    expect(new TextDecoder().decode(response.body)).toBe(`{"login":"vera"}`)
    expect(server.received).toMatchObject([
      {
        method: "POST",
        url: "/api/issues?fields=id,idReadable",
        headers: {
          authorization: "Bearer perm:t",
          "content-type": "application/json",
        },
        body: `{"summary":"Header clips"}`,
      },
    ])
  })

  test("any status resolves: the YouTrack client maps it", async () => {
    const server = await echoServer(401)

    const response = await fetchTransport.send({
      method: "GET",
      url: `${server.url}/api/users/me`,
      headers: {},
    })

    expect(response.status).toBe(401)
  })

  test("no response at all rejects", async () => {
    await expect(
      fetchTransport.send({
        method: "GET",
        url: "http://127.0.0.1:1/",
        headers: {},
      })
    ).rejects.toThrow()
  })
})
