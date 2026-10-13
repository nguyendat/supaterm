import Foundation
import CryptoKit

public struct PushPreviewContent: Codable, Equatable {
  public let title: String
  public let body: String
}

public struct PushPreviewEnvelope: Codable {
  public let version: Int
  public let keyId: String
  public let enc: String
  public let ciphertext: String
  public let signature: String
}

public struct PushPreviewPayload: Codable {
  public let version: Int
  public let recipientId: String
  public let generation: Int
  public let notificationId: String
  public let createdAt: Int64
  public let expiresAt: Int64
  public let preview: PushPreviewEnvelope

  public var associatedData: Data {
    Data([
      "supacode-push-preview-v1", "32:1:3", String(version), recipientId,
      String(generation), preview.keyId, notificationId, String(createdAt), String(expiresAt)
    ].joined(separator: "\n").utf8)
  }

  public var signatureData: Data {
    Data("supacode-push-preview-signature-v1\n".utf8) + associatedData +
      Data("\n\(preview.enc)\n\(preview.ciphertext)".utf8)
  }
}

public struct PushPreviewBinding: Codable {
  public let recipientId: String
  public let generation: Int
  public let keyId: String
  public let privateKey: String
  public let hostSigningKey: String
  public let enabled: Bool
}

public enum PushPreviewError: Error {
  case invalidEnvelope
  case invalidKey
  case invalidSignature
  case expired
  case invalidContent
  case storage
}

public func pushPreviewUUID(_ value: String) -> Bool {
  value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
}

public func pushPreviewDecode(_ value: String, maxBytes: Int) throws -> Data {
  guard !value.isEmpty, value.count <= (maxBytes * 4 + 2) / 3,
        value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
    throw PushPreviewError.invalidEnvelope
  }
  let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") +
    String(repeating: "=", count: (4 - value.count % 4) % 4)
  guard let data = Data(base64Encoded: padded), data.count <= maxBytes,
        pushPreviewEncode(data) == value else { throw PushPreviewError.invalidEnvelope }
  return data
}

public func pushPreviewEncode(_ value: Data) -> String {
  value.base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

public func decryptPushPreview(_ payload: PushPreviewPayload, binding: PushPreviewBinding, now: Int64) throws -> PushPreviewContent {
  guard payload.version == 1, payload.preview.version == 1, payload.generation > 0,
        pushPreviewUUID(payload.recipientId), pushPreviewUUID(payload.notificationId), pushPreviewUUID(payload.preview.keyId),
        binding.enabled, binding.recipientId == payload.recipientId, binding.generation == payload.generation,
        binding.keyId == payload.preview.keyId else { throw PushPreviewError.invalidEnvelope }
  guard payload.createdAt >= 0, payload.createdAt <= now + 300_000,
        payload.expiresAt > now, payload.expiresAt > payload.createdAt,
        payload.expiresAt - payload.createdAt <= 86_400_000 else { throw PushPreviewError.expired }
  let hostBytes = try pushPreviewDecode(binding.hostSigningKey, maxBytes: 32)
  let signature = try pushPreviewDecode(payload.preview.signature, maxBytes: 64)
  guard hostBytes.count == 32, signature.count == 64 else { throw PushPreviewError.invalidKey }
  let host = try Curve25519.Signing.PublicKey(rawRepresentation: hostBytes)
  guard host.isValidSignature(signature, for: payload.signatureData) else { throw PushPreviewError.invalidSignature }
  let keyBytes = try pushPreviewDecode(binding.privateKey, maxBytes: 32)
  let encapsulated = try pushPreviewDecode(payload.preview.enc, maxBytes: 32)
  let ciphertext = try pushPreviewDecode(payload.preview.ciphertext, maxBytes: 784)
  guard keyBytes.count == 32, encapsulated.count == 32, ciphertext.count >= 16 else { throw PushPreviewError.invalidKey }
  let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: keyBytes)
  var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: .Curve25519_SHA256_ChachaPoly,
    info: Data("supacode-push-preview-hpke-v1".utf8), encapsulatedKey: encapsulated)
  let plaintext = try recipient.open(ciphertext, authenticating: payload.associatedData)
  guard plaintext.count <= 768 else { throw PushPreviewError.invalidContent }
  let content = try JSONDecoder().decode(PushPreviewContent.self, from: plaintext)
  guard !content.title.isEmpty, content.title.utf16.count <= 120, content.body.utf16.count <= 400 else {
    throw PushPreviewError.invalidContent
  }
  return content
}
