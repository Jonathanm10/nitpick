import Foundation
import NitpickCore
import Testing

/// Triage — Assignee — through the app core's public API: the session-setup
/// assignable-users read (reusing the non-fatal Priority read), the
/// create-body custom field, and the shared write-side degradation. Asserts
/// exact HTTP request shapes (ADR-0008). Prior art: TriagePriorityTests.
@Suite("Triage — Assignee")
struct TriageAssigneeTests {
    static let base = SessionTrayScenarioTests.base

    /// A project schema with an Assignee user bundle and a Priority enum
    /// bundle — the read pulls both in one request.
    static let assigneeSchemaJSON = """
        [
          {"field":{"name":"Priority"},"bundle":{"values":[{"name":"Critical"}]}},
          {"field":{"name":"Assignee"},"bundle":{"aggregatedUsers":[
            {"login":"vera","fullName":"Vera Baumann"},
            {"login":"jonas","fullName":"Jonas Frei"}
          ]}}
        ]
        """

    static let vera = FindingAssignee(login: "vera", fullName: "Vera Baumann")

    static func assigneeFinding(_ assignee: FindingAssignee = vera) -> Finding {
        var finding = IssueFilingTests.finding()
        finding.assignee = assignee
        return finding
    }

    // MARK: - Session-setup users read

    @Test("session setup reads the project's assignable users alongside the Priority scale")
    func readsAssignableUsers() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: Self.assigneeSchemaJSON)

        let schema = await core.loadProjectSchema(for: IssueFilingTests.session.project)

        #expect(schema.assignees == [
            FindingAssignee(login: "vera", fullName: "Vera Baumann"),
            FindingAssignee(login: "jonas", fullName: "Jonas Frei"),
        ])
        // The same read also carried the Priority scale — one request.
        #expect(schema.priorities == [FindingPriority(name: "Critical")])
    }

    @Test("a project with no assignable users yields an empty list; the read stays non-fatal")
    func noAssignableUsers() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: #"[{"field":{"name":"Priority"},"bundle":{"values":[{"name":"Critical"}]}}]"#)

        let schema = await core.loadProjectSchema(for: IssueFilingTests.session.project)
        #expect(schema.assignees.isEmpty)
        #expect(schema.priorities == [FindingPriority(name: "Critical")])
    }

    // MARK: - Filing translation

    @Test("Assignee rides the create body as a native user custom field, by login")
    func assigneeInCreateBody() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: IssueFilingTests.existingTypeTagJSON)
        transport.enqueue(json: IssueFilingTests.createdIssueJSON)
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)
        transport.enqueue(json: IssueFilingTests.appliedTypeTagJSON)

        let result = try await core.file(Self.assigneeFinding(), in: IssueFilingTests.session)
        #expect(result.droppedFields.isEmpty)

        let assigneeField = #"{"$type":"SingleUserIssueCustomField","name":"Assignee","value":{"login":"vera"}}"#
        let expected = #"{"customFields":[\#(assigneeField)],\#(IssueFilingTests.expectedIssueJSON.dropFirst())"#
        #expect(transport.sentRequests[4].httpBody.map { String(decoding: $0, as: UTF8.self) } == expected)
    }

    @Test("Priority and Assignee ride together, Priority first, so the body stays byte-stable")
    func priorityAndAssigneeInCreateBody() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: IssueFilingTests.existingTypeTagJSON)
        transport.enqueue(json: IssueFilingTests.createdIssueJSON)
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)
        transport.enqueue(json: IssueFilingTests.appliedTypeTagJSON)

        var finding = IssueFilingTests.finding()
        finding.priority = FindingPriority(name: "Critical")
        finding.assignee = Self.vera
        _ = try await core.file(finding, in: IssueFilingTests.session)

        let priorityField = #"{"$type":"SingleEnumIssueCustomField","name":"Priority","value":{"name":"Critical"}}"#
        let assigneeField = #"{"$type":"SingleUserIssueCustomField","name":"Assignee","value":{"login":"vera"}}"#
        let expected = #"{"customFields":[\#(priorityField),\#(assigneeField)],\#(IssueFilingTests.expectedIssueJSON.dropFirst())"#
        #expect(transport.sentRequests[4].httpBody.map { String(decoding: $0, as: UTF8.self) } == expected)
    }

    // MARK: - Write-side degradation

    @Test("a rejected assignee retries without it; the Finding still files and the drop is reported with the full name")
    func retriesWithoutRejectedAssignee() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: IssueFilingTests.existingTypeTagJSON)
        transport.enqueue(statusCode: 400, json: #"{"error":"unknown user"}"#)  // create w/ field
        transport.enqueue(json: IssueFilingTests.createdIssueJSON)               // retry w/o field
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)
        transport.enqueue(json: IssueFilingTests.appliedTypeTagJSON)

        let result = try await core.file(Self.assigneeFinding(), in: IssueFilingTests.session)
        #expect(result.issue == SessionTrayScenarioTests.filedIssue("RM-421"))
        #expect(result.droppedFields == [DroppedTriageField(field: .assignee, intendedValue: "Vera Baumann")])

        // The retry drops the custom field entirely — the base body returns.
        let requests = transport.sentRequests.dropFirst(2)
        let retried = requests[requests.startIndex + 3]
        #expect(retried.httpBody.map { String(decoding: $0, as: UTF8.self) } == IssueFilingTests.expectedIssueJSON)
    }

    @Test("a create rejection drops every optional field together and reports each — Priority and Assignee both")
    func rejectionDropsAndReportsBothFields() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: IssueFilingTests.existingTypeTagJSON)
        transport.enqueue(statusCode: 400, json: #"{"error":"bad custom fields"}"#)
        transport.enqueue(json: IssueFilingTests.createdIssueJSON)
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)
        transport.enqueue(json: IssueFilingTests.appliedTypeTagJSON)

        var finding = IssueFilingTests.finding()
        finding.priority = FindingPriority(name: "Critical")
        finding.assignee = Self.vera
        let result = try await core.file(finding, in: IssueFilingTests.session)

        #expect(result.issue == SessionTrayScenarioTests.filedIssue("RM-421"))
        // Both were omitted on the retry, so both are reported — nothing is
        // silently lost (ADR-0008: the whole optional set is dropped at once).
        #expect(result.droppedFields == [
            DroppedTriageField(field: .priority, intendedValue: "Critical"),
            DroppedTriageField(field: .assignee, intendedValue: "Vera Baumann"),
        ])
        let requests = transport.sentRequests.dropFirst(2)
        let retried = requests[requests.startIndex + 3]
        #expect(retried.httpBody.map { String(decoding: $0, as: UTF8.self) } == IssueFilingTests.expectedIssueJSON)
    }
}
