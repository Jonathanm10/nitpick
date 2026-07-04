import Foundation
import NitpickCore
import Synchronization

/// Scripted stand-in for the HTTP seam. Responses are consumed in FIFO order;
/// every sent request is recorded for exact-shape assertions.
final class FakeHTTPTransport: HTTPTransport {
    struct Stub {
        var statusCode: Int
        var body: Data
    }

    struct NoStubbedResponse: Error {
        var url: URL?
    }

    private struct State {
        var stubs: [Result<Stub, Error>] = []
        var sent: [URLRequest] = []
    }

    private let state = Mutex(State())

    func enqueue(statusCode: Int = 200, json: String) {
        state.withLock {
            $0.stubs.append(.success(Stub(statusCode: statusCode, body: Data(json.utf8))))
        }
    }

    func enqueue(error: Error) {
        state.withLock { $0.stubs.append(.failure(error)) }
    }

    var sentRequests: [URLRequest] {
        state.withLock { $0.sent }
    }

    func send(_ request: URLRequest) async throws -> (data: Data, response: HTTPURLResponse) {
        let stub = try state.withLock { state in
            state.sent.append(request)
            guard !state.stubs.isEmpty else { throw NoStubbedResponse(url: request.url) }
            return try state.stubs.removeFirst().get()
        }
        let response = HTTPURLResponse(
            url: request.url ?? URL(fileURLWithPath: "/"),
            statusCode: stub.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        return (stub.body, response)
    }
}
