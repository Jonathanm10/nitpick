// The page's calls to the nitpick server, typed by its contract.
import type {
  BuildResponse,
  ErrorResponse,
  HostResponse,
  ProjectsResponse,
  ReviewStateResponse,
  StartReviewRequest,
  StartReviewResponse,
  SwitchDeviceResponse,
} from "@nitpick/server/api"

/** A failed call, carrying the server's message for the error line. */
export class APIError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "APIError"
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new APIError("The nitpick server could not be reached.")
  }
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => null)) as ErrorResponse | null
    throw new APIError(body?.error ?? `The server answered ${response.status}.`)
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

export const api = {
  review: () => call<ReviewStateResponse>("/api/review"),
  host: () => call<HostResponse>("/api/host"),
  projects: () => call<ProjectsResponse>("/api/projects"),
  uploadBuild: (file: File) =>
    call<BuildResponse>(`/api/build?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: file,
    }),
  startReview: (request: StartReviewRequest) =>
    call<StartReviewResponse>("/api/session", json("POST", request)),
  switchDevice: (deviceUDID: string) =>
    call<SwitchDeviceResponse>(
      "/api/session/device",
      json("PUT", { deviceUDID })
    ),
  endReview: () => call<void>("/api/session", { method: "DELETE" }),
}
