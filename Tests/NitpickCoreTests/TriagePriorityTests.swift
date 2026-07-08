import Foundation
import NitpickCore
import Testing

/// Triage — Priority — through the app core's public API: the session-setup
/// schema read, the create-body custom field, the write-side degradation
/// (retry once without the field), and the dropped-field report single
/// filing and file-all return. Asserts the exact HTTP request shapes, like
/// the rest of filing (ADR-0008). Prior art: YouTrackConnectionTests (the
/// project schema read) and IssueFilingTests (request shapes).
@Suite("Triage — Priority")
struct TriagePriorityTests {
    static let base = SessionTrayScenarioTests.base

    /// A project schema response: a Priority enum bundle plus an unrelated
    /// bundle field, in the project's own order. `bundle` is present only on
    /// bundle-backed fields.
    static let prioritySchemaJSON = """
        [
          {"field":{"name":"State"},"bundle":{"values":[{"name":"Open"},{"name":"Fixed"}]}},
          {"field":{"name":"Priority"},"bundle":{"values":[{"name":"Show-stopper"},{"name":"Critical"},{"name":"Normal"}]}}
        ]
        """

    static func priorityFinding(_ name: String = "Critical") -> Finding {
        var finding = IssueFilingTests.finding()
        finding.priority = FindingPriority(name: name)
        return finding
    }

    /// The create body a Priority-carrying Finding files: the custom field,
    /// then the same description/project/summary the base filing sends.
    static func expectedBody(priority: String) -> String {
        #"{"customFields":[{"$type":"SingleEnumIssueCustomField","name":"Priority","value":{"name":"\#(priority)"}}],\#(IssueFilingTests.expectedIssueJSON.dropFirst())"#
    }

    // MARK: - Session-setup schema read

    @Test("session setup reads the project's Priority scale in project order, with the exact request shape")
    func readsPriorityScale() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: Self.prioritySchemaJSON)

        let schema = await core.loadProjectSchema(for: IssueFilingTests.session.project)

        #expect(schema.priorities == [
            FindingPriority(name: "Show-stopper"),
            FindingPriority(name: "Critical"),
            FindingPriority(name: "Normal"),
        ])
        let request = try #require(transport.sentRequests.last)
        #expect(request.httpMethod == "GET")
        #expect(request.httpBody == nil)
        #expect(request.url?.absoluteString
            == "\(Self.base)/api/admin/projects/0-12/customFields?fields=field(name),bundle(values(name),aggregatedUsers(login,fullName))&$top=100")
    }

    @Test("a failed schema read is non-fatal: an empty scale, no error surfaced")
    func schemaReadIsNonFatal() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(statusCode: 403, json: #"{"error":"Forbidden"}"#)

        let schema = await core.loadProjectSchema(for: IssueFilingTests.session.project)
        #expect(schema.priorities.isEmpty)
    }

    @Test("a project with no Priority field yields an empty scale")
    func noPriorityField() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: #"[{"field":{"name":"State"},"bundle":{"values":[{"name":"Open"}]}}]"#)

        let schema = await core.loadProjectSchema(for: IssueFilingTests.session.project)
        #expect(schema.priorities.isEmpty)
    }

    // MARK: - Filing translation

    @Test("Priority rides the create body as a native custom field; nothing else about filing changes")
    func priorityInCreateBody() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: IssueFilingTests.existingTypeTagJSON)
        transport.enqueue(json: IssueFilingTests.createdIssueJSON)
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)
        transport.enqueue(json: IssueFilingTests.appliedTypeTagJSON)

        let result = try await core.file(Self.priorityFinding("Critical"), in: IssueFilingTests.session)
        #expect(result.issue == SessionTrayScenarioTests.filedIssue("RM-421"))
        #expect(result.droppedFields.isEmpty)

        let creation = transport.sentRequests[4]
        #expect(creation.url?.absoluteString == "\(Self.base)/api/issues?fields=id,idReadable")
        #expect(creation.httpBody.map { String(decoding: $0, as: UTF8.self) } == Self.expectedBody(priority: "Critical"))
    }

    // MARK: - Write-side degradation

    @Test("a create rejected for the field retries once without it — the Finding still files and the drop is reported")
    func retriesWithoutRejectedField() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: IssueFilingTests.existingTypeTagJSON)
        transport.enqueue(statusCode: 400, json: #"{"error":"custom field rejected"}"#)  // create w/ field
        transport.enqueue(json: IssueFilingTests.createdIssueJSON)                        // retry w/o field
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)
        transport.enqueue(json: IssueFilingTests.appliedTypeTagJSON)

        let result = try await core.file(Self.priorityFinding("Critical"), in: IssueFilingTests.session)
        #expect(result.issue == SessionTrayScenarioTests.filedIssue("RM-421"))
        #expect(result.droppedFields == [DroppedTriageField(field: .priority, intendedValue: "Critical")])

        // design lookup, type lookup, create (w/ field, 400), create (w/o
        // field), attach, design-tag, type-tag.
        let requests = transport.sentRequests.dropFirst(2)
        try #require(requests.count == 7)
        let attempted = requests[requests.startIndex + 2]
        let retried = requests[requests.startIndex + 3]
        #expect(attempted.url?.absoluteString == "\(Self.base)/api/issues?fields=id,idReadable")
        #expect(retried.url?.absoluteString == "\(Self.base)/api/issues?fields=id,idReadable")
        #expect(attempted.httpBody.map { String(decoding: $0, as: UTF8.self) } == Self.expectedBody(priority: "Critical"))
        // The retry drops the custom field entirely — the base body returns.
        #expect(retried.httpBody.map { String(decoding: $0, as: UTF8.self) } == IssueFilingTests.expectedIssueJSON)
    }

    @Test("a 403 on creation is a genuine failure — no field-dropping retry")
    func genuineFailureNeverRetries() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: IssueFilingTests.existingTypeTagJSON)
        transport.enqueue(statusCode: 403, json: #"{"error":"Forbidden"}"#)

        await #expect(throws: YouTrackError.permissionDenied(action: "create an issue in Review Me")) {
            try await core.file(Self.priorityFinding(), in: IssueFilingTests.session)
        }
        // No retry: two connect + design lookup + type lookup + the 403 create.
        #expect(transport.sentRequests.count == 5)
    }

    // MARK: - file-all reporting

    @Test("file-all reports dropped fields keyed by tray item")
    func fileAllReportsDroppedField() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        var session = IssueFilingTests.session
        let id = session.addFinding(Self.priorityFinding("Critical"))

        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: IssueFilingTests.existingTypeTagJSON)
        transport.enqueue(statusCode: 400, json: #"{"error":"custom field rejected"}"#)
        transport.enqueue(json: IssueFilingTests.createdIssueJSON)
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)
        transport.enqueue(json: IssueFilingTests.appliedTypeTagJSON)

        let outcome = await core.fileAll(in: session)
        #expect(outcome.failure == nil)
        #expect(outcome.droppedFields == [id: [DroppedTriageField(field: .priority, intendedValue: "Critical")]])
    }
}
