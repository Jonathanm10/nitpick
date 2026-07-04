// EdDSA helper for the release pipeline — CryptoKit, so it runs on any Mac
// with Xcode (this repo's baseline) and needs no OpenSSL 3, which stock
// macOS lacks (/usr/bin/openssl is LibreSSL without ed25519 support).
//
// Usage:
//   swift eddsa.swift generate
//       Prints two lines: the private seed (base64, Sparkle's key-file
//       format) and the public key (base64, the SUPublicEDKey format).
//   swift eddsa.swift verify <public-key-b64> <file> <signature-b64>
//       Exit 0 when the signature verifies, 1 when it doesn't, 2 on misuse.
import CryptoKit
import Foundation

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "generate":
    let key = Curve25519.Signing.PrivateKey()
    print(key.rawRepresentation.base64EncodedString())
    print(key.publicKey.rawRepresentation.base64EncodedString())
case "verify" where args.count == 5:
    guard let publicKeyData = Data(base64Encoded: args[2]),
          let signature = Data(base64Encoded: args[4]),
          let contents = FileManager.default.contents(atPath: args[3]),
          let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)
    else { exit(2) }
    exit(publicKey.isValidSignature(signature, for: contents) ? 0 : 1)
default:
    FileHandle.standardError.write(Data(
        "usage: eddsa.swift generate | verify <public-key-b64> <file> <signature-b64>\n".utf8))
    exit(2)
}
