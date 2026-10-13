import XCTest
import Foundation
import CryptoKit
@testable import PushPreviewCore

final class PushPreviewTests: XCTestCase {
  struct Vector: Decodable {
    let supacode: SupacodeVector
    let rfc9180: RFCVector
  }
  struct SupacodeVector: Decodable {
    let payload: PushPreviewPayload
    let binding: PushPreviewBinding
    let content: PushPreviewContent
  }
  struct RFCVector: Decodable {
    let info: String
    let privateKey: String
    let enc: String
    let encryptions: [Encryption]
  }
  struct Encryption: Decodable {
    let aad: String
    let ct: String
    let pt: String
  }
  func vectors() throws -> Vector {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "vectors", withExtension: "json"))
    return try JSONDecoder().decode(Vector.self, from: Data(contentsOf: url))
  }
  func hex(_ input: String) -> Data {
    var bytes = Data()
    var index = input.startIndex
    while index < input.endIndex {
      let end = input.index(index, offsetBy: 2)
      bytes.append(UInt8(input[index..<end], radix: 16)!)
      index = end
    }
    return bytes
  }
  func testRFC9180InteroperabilityAndSequence() throws {
    let vector = try vectors().rfc9180
    let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(vector.privateKey))
    var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: .Curve25519_SHA256_ChachaPoly,
      info: hex(vector.info), encapsulatedKey: hex(vector.enc))
    for encryption in vector.encryptions {
      XCTAssertEqual(try recipient.open(hex(encryption.ct), authenticating: hex(encryption.aad)), hex(encryption.pt))
    }
  }
  func testTypeScriptEnvelopeDecryptsAndAuthenticates() throws {
    let vector = try vectors().supacode
    XCTAssertEqual(try decryptPushPreview(vector.payload, binding: vector.binding, now: vector.payload.createdAt), vector.content)
  }
  func testModifiedMetadataOrCiphertextFallsBack() throws {
    let vector = try vectors().supacode
    let encoded = try JSONEncoder().encode(vector.payload)
    var values = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    for (field, value) in ["generation": 3, "expiresAt": vector.payload.expiresAt - 1] as [String: Any] {
      var changed = values
      changed[field] = value
      let data = try JSONSerialization.data(withJSONObject: changed)
      let payload = try JSONDecoder().decode(PushPreviewPayload.self, from: data)
      XCTAssertThrowsError(try decryptPushPreview(payload, binding: vector.binding, now: vector.payload.createdAt))
    }
    var envelope = try XCTUnwrap(values["preview"] as? [String: Any])
    envelope["ciphertext"] = "A" + vector.payload.preview.ciphertext.dropFirst()
    values["preview"] = envelope
    let payload = try JSONDecoder().decode(PushPreviewPayload.self, from: JSONSerialization.data(withJSONObject: values))
    XCTAssertThrowsError(try decryptPushPreview(payload, binding: vector.binding, now: vector.payload.createdAt))
  }
  func testExpiredOrDisabledOrWrongHostDoesNotExposePreview() throws {
    let vector = try vectors().supacode
    XCTAssertThrowsError(try decryptPushPreview(vector.payload, binding: vector.binding, now: vector.payload.expiresAt))
    let disabled = PushPreviewBinding(recipientId: vector.binding.recipientId, generation: vector.binding.generation,
      keyId: vector.binding.keyId, privateKey: vector.binding.privateKey, hostSigningKey: vector.binding.hostSigningKey, enabled: false)
    XCTAssertThrowsError(try decryptPushPreview(vector.payload, binding: disabled, now: vector.payload.createdAt))
    let wrong = PushPreviewBinding(recipientId: vector.binding.recipientId, generation: vector.binding.generation,
      keyId: vector.binding.keyId, privateKey: vector.binding.privateKey,
      hostSigningKey: pushPreviewEncode(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation), enabled: true)
    XCTAssertThrowsError(try decryptPushPreview(vector.payload, binding: wrong, now: vector.payload.createdAt))
  }

  final class MemoryStorage: PushPreviewStorage {
    var values: [String: Data] = [:]
    var rejectedWrite: String?
    var rejectedDelete: String?
    func read(_ account: String) throws -> Data? { values[account] }
    func write(_ account: String, data: Data) throws {
      if account == rejectedWrite { throw PushPreviewError.storage }
      values[account] = data
    }
    func delete(_ account: String) throws {
      if account == rejectedDelete { throw PushPreviewError.storage }
      values.removeValue(forKey: account)
    }
  }

  func seededStore() throws -> (PushPreviewStore, MemoryStorage, SupacodeVector) {
    let vector = try vectors().supacode
    let storage = MemoryStorage()
    let material = PushPreviewKeyMaterial(keyId: vector.binding.keyId, privateKey: vector.binding.privateKey)
    storage.values["environment:test"] = try JSONEncoder().encode(material)
    let store = PushPreviewStore(storage: storage, appGroup: "test")
    try store.bind("test", recipientId: vector.binding.recipientId, generation: vector.binding.generation,
      hostSigningKey: vector.binding.hostSigningKey, enabled: true)
    XCTAssertEqual(try decryptPushPreview(vector.payload, binding: store.binding(vector.binding.recipientId),
      now: vector.payload.createdAt), vector.content)
    return (store, storage, vector)
  }

  func testOrphanedRecipientCannotDecryptAfterAuthorityRemoval() throws {
    let (store, storage, vector) = try seededStore()
    let account = "recipient:\(vector.binding.recipientId)"
    let index = try XCTUnwrap(storage.values[account])
    XCTAssertFalse(String(decoding: index, as: UTF8.self).contains(vector.binding.privateKey))
    storage.rejectedDelete = account
    XCTAssertThrowsError(try store.remove("test"))
    XCTAssertNotNil(storage.values[account])
    XCTAssertNil(storage.values["environment:test"])
    XCTAssertThrowsError(try store.binding(vector.binding.recipientId))
  }

  func testInterruptedDisableAndRotationInvalidateRemainingIndex() throws {
    let (store, storage, vector) = try seededStore()
    storage.rejectedDelete = "recipient:\(vector.binding.recipientId)"
    XCTAssertThrowsError(try store.disable(vector.binding.recipientId))
    XCTAssertThrowsError(try store.binding(vector.binding.recipientId))
    try store.bind("test", recipientId: vector.binding.recipientId, generation: vector.binding.generation,
      hostSigningKey: vector.binding.hostSigningKey, enabled: true)
    XCTAssertThrowsError(try store.rotate("test"))
    XCTAssertNotEqual(try store.ensure("test").keyId, vector.binding.keyId)
    XCTAssertThrowsError(try store.binding(vector.binding.recipientId))
  }

  func testInterruptedRecipientSwitchDoesNotPreserveOldAuthority() throws {
    let (store, storage, vector) = try seededStore()
    let recipient = UUID().uuidString.lowercased()
    storage.rejectedWrite = "recipient:\(recipient)"
    XCTAssertThrowsError(try store.bind("test", recipientId: recipient, generation: 2,
      hostSigningKey: vector.binding.hostSigningKey, enabled: true))
    XCTAssertThrowsError(try store.binding(vector.binding.recipientId))
    XCTAssertThrowsError(try store.binding(recipient))
    try store.disable(vector.binding.recipientId)
    let material = try store.ensure("test")
    XCTAssertEqual(material.recipientId, recipient)
    XCTAssertEqual(material.enabled, true)
  }

  func testReplayLedgerSurvivesRestartAndPrunesExpiredReceipts() throws {
    let vector = try vectors().supacode
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    XCTAssertTrue(try PushPreviewReplayLedger(directory: directory).claim(vector.payload, now: vector.payload.createdAt))
    XCTAssertFalse(try PushPreviewReplayLedger(directory: directory).claim(vector.payload, now: vector.payload.createdAt))
    XCTAssertTrue(try PushPreviewReplayLedger(directory: directory).claim(vector.payload, now: vector.payload.expiresAt))
  }

  func testFullOrCorruptReplayLedgerFailsClosed() throws {
    let vector = try vectors().supacode
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("push-preview-receipts.json")
    let receipts = Dictionary(uniqueKeysWithValues: (0..<1024).map { (String($0), vector.payload.expiresAt) })
    try JSONEncoder().encode(receipts).write(to: url)
    XCTAssertFalse(try PushPreviewReplayLedger(directory: directory).claim(vector.payload, now: vector.payload.createdAt))
    try Data("invalid".utf8).write(to: url)
    XCTAssertThrowsError(try PushPreviewReplayLedger(directory: directory).claim(vector.payload, now: vector.payload.createdAt))
  }
}
