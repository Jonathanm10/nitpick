import Foundation
import Security

/// Live credential store backed by the user's Keychain: one generic-password
/// item per key under the given service. The designer's YouTrack token lives
/// here and nowhere else — never on disk.
public struct KeychainCredentialStore: CredentialStore {
    public var service: String

    public init(service: String = "ch.liip.nitpick") {
        self.service = service
    }

    public func secret(for key: String) throws -> String? {
        var query = baseQuery(for: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data else {
                throw KeychainError(operation: "read", status: errSecDecode)
            }
            return String(decoding: data, as: UTF8.self)
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError(operation: "read", status: status)
        }
    }

    public func setSecret(_ secret: String?, for key: String) throws {
        let query = baseQuery(for: key)

        guard let secret else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw KeychainError(operation: "delete", status: status)
            }
            return
        }

        let payload = [kSecValueData as String: Data(secret.utf8)]
        var insert = query
        insert.merge(payload) { _, new in new }
        var status = SecItemAdd(insert as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(query as CFDictionary, payload as CFDictionary)
        }
        guard status == errSecSuccess else {
            throw KeychainError(operation: "write", status: status)
        }
    }

    private func baseQuery(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

/// A Keychain call failed; carries Security.framework's own explanation.
public struct KeychainError: Error, Equatable, LocalizedError {
    public var operation: String
    public var status: OSStatus

    public init(operation: String, status: OSStatus) {
        self.operation = operation
        self.status = status
    }

    public var errorDescription: String? {
        let reason = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
        return "Keychain \(operation) failed: \(reason)"
    }
}
