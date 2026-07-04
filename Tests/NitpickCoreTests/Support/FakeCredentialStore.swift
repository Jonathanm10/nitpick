import Foundation
import NitpickCore
import Synchronization

/// In-memory stand-in for the credential seam. Sharing one instance across
/// two `AppCore` values simulates the Keychain surviving a relaunch.
final class FakeCredentialStore: CredentialStore {
    private let state = Mutex<[String: String]>([:])

    func secret(for key: String) throws -> String? {
        state.withLock { $0[key] }
    }

    func setSecret(_ secret: String?, for key: String) throws {
        state.withLock { $0[key] = secret }
    }

    var storedSecrets: [String: String] {
        state.withLock { $0 }
    }
}
