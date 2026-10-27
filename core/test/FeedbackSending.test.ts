// Ports Tests/NitpickCoreTests/FeedbackSendingTests.swift: a Feedback is sent
// as one Issue to the NIT project, tagged nitpick-feedback:<kind>, with an
// Environment section and an optional window image. Once the Issue exists, a
// failed tag or image upload is a warning, never an error.
//
// Not ported: sending before connecting. Sending takes a YouTrackClient, so
// there is no unconnected call to make. The window image's real pixels are
// checked in server/test/AnnotatedFiling.test.ts.
import { describe, expect, test } from "vitest"
import {
  environmentLines,
  feedbackDescription,
  feedbackEnvironment,
  feedbackHasText,
  feedbackProjectShortName,
  feedbackSummary,
  feedbackTagName,
  sendFeedback,
  type Feedback,
  type FeedbackEnvironment,
  type FeedbackKind,
  type SentFeedback,
} from "../src/feedback.ts"
import { YouTrackError } from "../src/youtrack.ts"
import { bodyText, FakeHTTPTransport } from "./FakeHTTPTransport.ts"
import * as fixtures from "./fixtures.ts"

const { base } = fixtures
const pngBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xab,
])

const versionsOnly: FeedbackEnvironment = {
  nitpick: "1.4.0 (57)",
  macOS: "Version 26.1 (Build 25B78)",
  xcode: "26.1 (17B55)",
}

function feedback({
  kind = "bug" as FeedbackKind,
  title = "  Tray loses focus after capture \n",
  description = "After capturing, the summary field is not focused.",
  environment = versionsOnly,
  imagePNG = undefined as Uint8Array | undefined,
} = {}): Feedback {
  return { kind, title, description, environment, imagePNG }
}

const existingBugTagJSON = `[{"id":"6-3910","name":"nitpick-feedback:bug","$type":"Tag"}]`
const projectJSON = `{"id":"0-77","name":"Nitpick","$type":"Project"}`
const createdIssueJSON = `{"id":"3-900","idReadable":"NIT-42","$type":"Issue"}`
const appliedBugTagJSON = `{"id":"6-3910","name":"nitpick-feedback:bug","$type":"Tag"}`
const attachmentsJSON = `[{"id":"134-90","name":"nitpick-window.png","$type":"IssueAttachment"}]`

const expectedIssueJSON =
  String.raw`{"description":"After capturing, the summary field is not focused.\n\n` +
  String.raw`## Environment\n- Nitpick: 1.4.0 (57)\n- macOS: Version 26.1 (Build 25B78)\n- Xcode: 26.1 (17B55)",` +
  String.raw`"project":{"id":"0-77"},"summary":"Tray loses focus after capture"}`

function enqueueLadder(transport: FakeHTTPTransport): void {
  transport.enqueue(projectJSON)
  transport.enqueue(existingBugTagJSON)
  transport.enqueue(createdIssueJSON)
  transport.enqueue(appliedBugTagJSON)
}

function send(
  transport: FakeHTTPTransport,
  sent: Feedback
): Promise<SentFeedback> {
  return sendFeedback(sent, {
    youTrack: fixtures.youTrack(transport),
    flatten: fixtures.fakeFlatten,
  })
}

function issueCreations(transport: FakeHTTPTransport): number {
  return transport.sentRequests.filter(
    (request) =>
      request.method === "POST" && request.url.startsWith(`${base}/api/issues?`)
  ).length
}

async function failureOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  )
  expect(error).toBeInstanceOf(YouTrackError)
  return (error as YouTrackError).failure
}

describe("Feedback sending", () => {
  test("send emits find NIT → find-tag → create issue → apply tag, with exact bodies and no custom fields", async () => {
    const transport = new FakeHTTPTransport()
    enqueueLadder(transport)

    const sent = await send(transport, feedback())

    expect(sent).toEqual({
      idReadable: "NIT-42",
      url: `${base}/issue/NIT-42`,
      warnings: [],
    })
    const requests = transport.sentRequests
    expect(requests).toHaveLength(4)
    for (const request of requests) {
      expect(request.headers.Authorization).toBe(`Bearer ${fixtures.token}`)
      expect(request.headers.Accept).toBe("application/json")
    }

    expect(requests[0]).toEqual({
      method: "GET",
      url: `${base}/api/admin/projects/NIT?fields=id,name`,
      headers: fixtures.expectedHeaders,
    })

    expect(requests[1].method).toBe("GET")
    expect(requests[1].url).toBe(
      `${base}/api/tags?fields=id,name&query=nitpick-feedback:bug&$top=100`
    )

    expect(requests[2].method).toBe("POST")
    expect(requests[2].url).toBe(`${base}/api/issues?fields=id,idReadable`)
    expect(requests[2].headers["Content-Type"]).toBe("application/json")
    expect(bodyText(requests[2])).toBe(expectedIssueJSON)
    expect(bodyText(requests[2])).not.toContain("customFields")

    expect(requests[3].method).toBe("POST")
    expect(requests[3].url).toBe(`${base}/api/issues/3-900/tags?fields=id,name`)
    expect(bodyText(requests[3])).toBe(`{"id":"6-3910"}`)
  })

  test("a missing nitpick-feedback tag is created by exact name after the project and before the issue", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(projectJSON)
    transport.enqueue(
      `[{"id":"6-1","name":"nitpick-feedback:improvements","$type":"Tag"}]`
    )
    transport.enqueue(
      `{"id":"6-3911","name":"nitpick-feedback:improvement","$type":"Tag"}`
    )
    transport.enqueue(createdIssueJSON)
    transport.enqueue(
      `{"id":"6-3911","name":"nitpick-feedback:improvement","$type":"Tag"}`
    )

    await send(transport, feedback({ kind: "improvement" }))

    const requests = transport.sentRequests
    expect(requests).toHaveLength(5)
    expect(requests[0].url).toBe(
      `${base}/api/admin/projects/NIT?fields=id,name`
    )
    expect(requests[1].url).toBe(
      `${base}/api/tags?fields=id,name&query=nitpick-feedback:improvement&$top=100`
    )
    expect(requests[2].method).toBe("POST")
    expect(requests[2].url).toBe(`${base}/api/tags?fields=id,name`)
    expect(bodyText(requests[2])).toBe(
      `{"name":"nitpick-feedback:improvement"}`
    )
    expect(requests[3].url).toBe(`${base}/api/issues?fields=id,idReadable`)
    expect(bodyText(requests[4])).toBe(`{"id":"6-3911"}`)
  })

  test("a 401 on tag lookup is tokenRejected and no issue is created", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(projectJSON)
    transport.enqueue(`{"error":"Unauthorized"}`, 401)

    expect(await failureOf(send(transport, feedback()))).toEqual({
      kind: "tokenRejected",
    })
    expect(transport.sentRequests).toHaveLength(2)
  })

  test("a 403 on tag creation names the permission and no issue is created", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(projectJSON)
    transport.enqueue("[]")
    transport.enqueue(`{"error":"Forbidden"}`, 403)

    expect(await failureOf(send(transport, feedback()))).toEqual({
      kind: "permissionDenied",
      action: "create the “nitpick-feedback:bug” tag (it does not exist yet)",
    })
    expect(transport.sentRequests).toHaveLength(3)
    expect(issueCreations(transport)).toBe(0)
  })

  test("a 403 on the NIT project lookup names the permission and touches no tag", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(`{"error":"Forbidden"}`, 403)

    expect(await failureOf(send(transport, feedback()))).toEqual({
      kind: "permissionDenied",
      action: "read the NIT project",
    })
    expect(transport.sentRequests).toHaveLength(1)
  })

  test("a 404 on the NIT project lookup names NIT and touches no tag", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(`{"error":"Not Found"}`, 404)

    expect(await failureOf(send(transport, feedback()))).toEqual({
      kind: "projectNotFound",
      shortName: "NIT",
    })
    expect(transport.urls.some((url) => url.includes("/api/tags"))).toBe(false)
    expect(transport.sentRequests).toHaveLength(1)
    expect(
      new YouTrackError({ kind: "projectNotFound", shortName: "NIT" }).message
    ).toBe(
      "YouTrack has no NIT project visible to your account. Ask a YouTrack administrator about your access."
    )
  })

  test("a 403 on issue creation names the NIT project; nothing is tagged", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(projectJSON)
    transport.enqueue(existingBugTagJSON)
    transport.enqueue(`{"error":"Forbidden"}`, 403)

    expect(await failureOf(send(transport, feedback()))).toEqual({
      kind: "permissionDenied",
      action: "create an issue in Nitpick",
    })
    expect(transport.sentRequests).toHaveLength(3)
  })

  test("Build and Capture Source lines appear, in fixed order after the versions, only when supplied", async () => {
    const transport = new FakeHTTPTransport()
    enqueueLadder(transport)
    enqueueLadder(transport)
    enqueueLadder(transport)

    await send(transport, feedback({ description: "" }))
    await send(
      transport,
      feedback({
        description: "",
        environment: {
          ...versionsOnly,
          captureSource: "Simulator — iPhone 17 Pro, iOS 26.1",
          build: "ch.liip.reviewme 2.1.0 (421)",
        },
      })
    )
    await send(
      transport,
      feedback({
        description: "",
        environment: { ...versionsOnly, macOS: "Version 26.1\n(Build 25B78)" },
      })
    )

    const bodies = transport.sentRequests
      .filter(
        (request) => request.url === `${base}/api/issues?fields=id,idReadable`
      )
      .map((request) => bodyText(request) ?? "")
    expect(bodies).toHaveLength(3)
    const versions = String.raw`## Environment\n- Nitpick: 1.4.0 (57)\n- macOS: Version 26.1 (Build 25B78)\n- Xcode: 26.1 (17B55)`
    expect(bodies[0]).toBe(
      `{"description":"${versions}","project":{"id":"0-77"},"summary":"Tray loses focus after capture"}`
    )
    expect(bodies[1]).toBe(
      `{"description":"${versions}` +
        String.raw`\n- Build: ch.liip.reviewme 2.1.0 (421)` +
        String.raw`\n- Capture Source: Simulator — iPhone 17 Pro, iOS 26.1",` +
        `"project":{"id":"0-77"},"summary":"Tray loses focus after capture"}`
    )
    expect(bodies[2]).toContain(
      String.raw`\n- macOS: Version 26.1 (Build 25B78)\n`
    )
  })

  test("Environment lines render with fixed labels in fixed order", () => {
    const environment: FeedbackEnvironment = {
      nitpick: "1.4.0 (57)",
      macOS: "26.1",
      xcode: "unknown",
      build: "com.example.app 1.0 (1)",
      captureSource: "Simulator (not running)",
    }

    expect(environmentLines(environment).map((line) => line.label)).toEqual([
      "Nitpick",
      "macOS",
      "Xcode",
      "Build",
      "Capture Source",
    ])
    expect(environmentLines(versionsOnly).map((line) => line.label)).toEqual([
      "Nitpick",
      "macOS",
      "Xcode",
    ])
  })

  test("an optional window image is uploaded as multipart after the tag", async () => {
    const transport = new FakeHTTPTransport()
    enqueueLadder(transport)
    transport.enqueue(attachmentsJSON)

    await send(transport, feedback({ imagePNG: pngBytes }))

    const requests = transport.sentRequests
    expect(requests).toHaveLength(5)
    expect(requests[3].url).toBe(`${base}/api/issues/3-900/tags?fields=id,name`)
    const attach = requests[4]
    expect(attach.method).toBe("POST")
    expect(attach.url).toBe(
      `${base}/api/issues/3-900/attachments?fields=id,name`
    )
    expect(attach.body).toEqual(
      fixtures.multipartBody(fixtures.boundaryOf(attach), [
        { fileName: "nitpick-window.png", data: pngBytes },
      ])
    )
  })

  test("Annotations on the window image are flattened into the uploaded PNG", async () => {
    const transport = new FakeHTTPTransport()
    enqueueLadder(transport)
    transport.enqueue(attachmentsJSON)
    const annotated: Feedback = {
      ...feedback({ imagePNG: pngBytes }),
      imageAnnotations: [
        {
          kind: "rectangle",
          color: "red",
          rect: { x: 40, y: 40, width: 200, height: 120 },
        },
      ],
    }

    await send(transport, annotated)

    const flattened = await fixtures.fakeFlatten(
      pngBytes,
      annotated.imageAnnotations ?? []
    )
    expect(flattened).not.toEqual(pngBytes)
    const attach = transport.sentRequests.at(-1)
    expect(attach?.body).toEqual(
      fixtures.multipartBody(fixtures.boundaryOf(attach), [
        { fileName: "nitpick-window.png", data: flattened },
      ])
    )
  })

  test("no image, no attachments request", async () => {
    const transport = new FakeHTTPTransport()
    enqueueLadder(transport)

    await send(transport, feedback())

    expect(transport.urls.some((url) => url.includes("attachments"))).toBe(
      false
    )
  })

  test("a version the shell could not read is sent as “unknown”", async () => {
    const transport = new FakeHTTPTransport()
    enqueueLadder(transport)

    await send(
      transport,
      feedback({
        description: "",
        environment: feedbackEnvironment({
          macOS: "Version 26.1 (Build 25B78)",
        }),
      })
    )

    expect(bodyText(transport.sentRequests[2])).toBe(
      String.raw`{"description":"## Environment\n- Nitpick: unknown\n- macOS: Version 26.1 (Build 25B78)\n- Xcode: unknown",` +
        `"project":{"id":"0-77"},"summary":"Tray loses focus after capture"}`
    )
  })

  test.each([
    [undefined, undefined],
    ["1.4.0", undefined],
    [undefined, "57"],
    ["", "57"],
    ["1.4.0", " "],
  ])(
    "a missing or blank version, or a version without its build, falls back to “unknown” (%j, %j)",
    (nitpickVersion, nitpickBuild) => {
      const environment = feedbackEnvironment({
        nitpickVersion,
        nitpickBuild,
        macOS: "  ",
        xcode: "",
      })

      expect(environment.nitpick).toBe("unknown")
      expect(environment.macOS).toBe("unknown")
      expect(environment.xcode).toBe("unknown")
    }
  )

  test("read versions pass through; nitpick joins version and build", () => {
    expect(
      feedbackEnvironment({
        nitpickVersion: "1.4.0",
        nitpickBuild: "57",
        macOS: "Version 26.1 (Build 25B78)",
        xcode: "26.1 (17B55)",
      })
    ).toEqual(versionsOnly)
  })

  test("a Review Session adds Build and Capture Source; without one, neither appears", () => {
    const build = {
      bundleID: "ch.liip.reviewme",
      version: "2.1.0",
      buildNumber: "421",
    }
    const device = { name: "iPhone 17 Pro", osName: "iOS 26.1" }
    const environment = (
      review?: Parameters<typeof feedbackEnvironment>[0]["review"]
    ) =>
      feedbackEnvironment({
        nitpickVersion: "1.4.0",
        nitpickBuild: "57",
        macOS: "26.1",
        xcode: "26.1",
        review,
      })

    const hosted = environment({ build, hostName: "DeviceHub", device })
    expect(hosted.build).toBe("ch.liip.reviewme 2.1.0 (421)")
    expect(hosted.captureSource).toBe("DeviceHub — iPhone 17 Pro, iOS 26.1")
    expect(environment({ build, device }).captureSource).toBe(
      "Simulator — iPhone 17 Pro, iOS 26.1"
    )
    expect(environment({ build, hostName: "DeviceHub" }).captureSource).toBe(
      "Simulator (not running)"
    )

    const idle = environment()
    expect(idle.build).toBeUndefined()
    expect(idle.captureSource).toBeUndefined()
  })

  test("the summary is the trimmed title; whitespace alone is no text", () => {
    expect(feedbackSummary(feedback())).toBe("Tray loses focus after capture")
    expect(
      feedbackHasText(feedback({ title: " \n", description: "\t " }))
    ).toBe(false)
    expect(
      feedbackHasText(
        feedback({ title: "", description: "Only a description" })
      )
    ).toBe(true)
    expect(
      feedbackHasText(feedback({ title: "Only a title", description: "" }))
    ).toBe(true)
  })

  test.each([401, 403, 500])(
    "a failed tag after the Issue exists returns the Issue with a warning; no second issue is created (HTTP %i)",
    async (status) => {
      const transport = new FakeHTTPTransport()
      transport.enqueue(projectJSON)
      transport.enqueue(existingBugTagJSON)
      transport.enqueue(createdIssueJSON)
      transport.enqueue(`{"error":"nope"}`, status)
      transport.enqueue(attachmentsJSON)

      const sent = await send(transport, feedback({ imagePNG: pngBytes }))

      expect(sent).toEqual({
        idReadable: "NIT-42",
        url: `${base}/issue/NIT-42`,
        warnings: ["The nitpick-feedback:bug tag could not be applied."],
      })
      expect(transport.urls.at(-1)).toBe(
        `${base}/api/issues/3-900/attachments?fields=id,name`
      )
      expect(issueCreations(transport)).toBe(1)
    }
  )

  test.each([401, 403, 500])(
    "a failed image upload after the Issue exists returns the Issue with a warning; no second issue is created (HTTP %i)",
    async (status) => {
      const transport = new FakeHTTPTransport()
      enqueueLadder(transport)
      transport.enqueue(`{"error":"nope"}`, status)

      const sent = await send(transport, feedback({ imagePNG: pngBytes }))

      expect(sent.idReadable).toBe("NIT-42")
      expect(sent.warnings).toEqual(["The window image could not be attached."])
      expect(transport.sentRequests).toHaveLength(5)
      expect(issueCreations(transport)).toBe(1)
    }
  )

  test("a clean send carries no warnings", async () => {
    const transport = new FakeHTTPTransport()
    enqueueLadder(transport)

    const sent = await send(transport, feedback())

    expect(sent.warnings).toEqual([])
  })

  test("a blank title never reaches the network", async () => {
    const transport = new FakeHTTPTransport()

    expect(
      await failureOf(send(transport, feedback({ title: " \n" })))
    ).toEqual({ kind: "feedbackTitleRequired" })
    expect(transport.sentRequests).toEqual([])
    expect(new YouTrackError({ kind: "feedbackTitleRequired" }).message).toBe(
      "The Feedback needs a title before it can be sent."
    )
  })

  test("Feedback kinds map to their nitpick-feedback tags", () => {
    expect(feedbackTagName("bug")).toBe("nitpick-feedback:bug")
    expect(feedbackTagName("improvement")).toBe("nitpick-feedback:improvement")
    expect(feedbackProjectShortName).toBe("NIT")
  })

  // Not in the Swift suite: the window image's flattening failing after the
  // Issue exists is a warning like a refused upload.
  test("a window image that can't be flattened is a warning, not a second issue", async () => {
    const transport = new FakeHTTPTransport()
    enqueueLadder(transport)

    const sent = await sendFeedback(
      {
        ...feedback({ imagePNG: pngBytes }),
        imageAnnotations: [
          { kind: "label", color: "red", text: "here", at: { x: 1, y: 1 } },
        ],
      },
      {
        youTrack: fixtures.youTrack(transport),
        flatten: async () => {
          throw new Error("unreadable")
        },
      }
    )

    expect(sent.warnings).toEqual(["The window image could not be attached."])
    expect(transport.sentRequests).toHaveLength(4)
  })

  // Feedback.issueDescription is internal in Swift; the golden files pin it.
  test("the description puts the trimmed text before the Environment", () => {
    expect(
      feedbackDescription(
        feedback({ description: "  Two\nlines \n", environment: versionsOnly })
      )
    ).toBe(
      "Two\nlines\n\n## Environment\n- Nitpick: 1.4.0 (57)\n- macOS: Version 26.1 (Build 25B78)\n- Xcode: 26.1 (17B55)"
    )
  })
})
