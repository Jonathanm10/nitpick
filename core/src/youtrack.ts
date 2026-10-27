/** The YouTrack project every Finding of a Review Session files into. */
export interface YouTrackProject {
  /** YouTrack's entity id, e.g. "0-12": what the issues API references. */
  readonly id: string
  /** The key issue IDs derive from, e.g. "RM" in RM-421. */
  readonly shortName: string
  readonly name: string
}

/** The Issue a filed Finding became, referenced only by its ID and URL. */
export interface FiledIssue {
  /** The human-readable issue ID, e.g. "RM-421". */
  readonly idReadable: string
  /** The issue's page on the instance. */
  readonly url: string
}
