// The HTTP contract between server/ and web/. Types only, so web/ can import
// it without pulling in Node code.
import type { SimulatorDevice } from "./device/DeviceHost.ts"

export type { SimulatorDevice }

/** `GET /api/devices` */
export interface DevicesResponse {
  readonly devices: ReadonlyArray<SimulatorDevice>
}

/** Any API failure. */
export interface ErrorResponse {
  readonly error: string
}
