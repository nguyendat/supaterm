import Foundation
import Security
import CryptoKit
import Darwin

public struct PushPreviewKeyMaterial: Codable {
  public let keyId: String
  public let privateKey: String
  public var recipientId: String?
  public var generation: Int?
  public var hostSigningKey: String?
  public var enabled: Bool?
}

struct PushPreviewRecipientIndex: Codable {
  let environmentId: String
  let keyId: String
}

protocol PushPreviewStorage {
  func read(_ account: String) throws -> Data?
  func write(_ account: String, data: Data) throws
  func delete(_ account: String) throws
}

private struct PushPreviewKeychainStorage: PushPreviewStorage {
  let accessGroup: String

  private func query(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: "sh.supacode.push-preview",
     kSecAttrAccount as String: account,
     kSecAttrAccessGroup as String: accessGroup]
  }

  func read(_ account: String) throws -> Data? {
    var request = query(account)
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw PushPreviewError.storage }
    return data
  }

  func write(_ account: String, data: Data) throws {
    let attributes: [String: Any] = [kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let request = query(account)
    let updated = SecItemUpdate(request as CFDictionary, attributes as CFDictionary)
    if updated == errSecSuccess { return }
    guard updated == errSecItemNotFound else { throw PushPreviewError.storage }
    var inserted = request
    for (key, value) in attributes { inserted[key] = value }
    guard SecItemAdd(inserted as CFDictionary, nil) == errSecSuccess else { throw PushPreviewError.storage }
  }

  func delete(_ account: String) throws {
    let status = SecItemDelete(query(account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw PushPreviewError.storage }
  }
}

public final class PushPreviewStore {
  private let storage: any PushPreviewStorage
  private let appGroup: String

  public init(accessGroup: String, appGroup: String) {
    self.storage = PushPreviewKeychainStorage(accessGroup: accessGroup)
    self.appGroup = appGroup
  }

  init(storage: any PushPreviewStorage, appGroup: String) {
    self.storage = storage
    self.appGroup = appGroup
  }

  private func read<T: Decodable>(_ account: String, as: T.Type) throws -> T? {
    guard let data = try storage.read(account) else { return nil }
    return try JSONDecoder().decode(T.self, from: data)
  }

  private func write<T: Encodable>(_ account: String, value: T) throws {
    try storage.write(account, data: JSONEncoder().encode(value))
  }

  public func ensure(_ environmentId: String) throws -> PushPreviewKeyMaterial {
    if let existing = try read("environment:\(environmentId)", as: PushPreviewKeyMaterial.self) { return existing }
    return try rotate(environmentId)
  }

  public func rotate(_ environmentId: String) throws -> PushPreviewKeyMaterial {
    let prior = try read("environment:\(environmentId)", as: PushPreviewKeyMaterial.self)
    let key = Curve25519.KeyAgreement.PrivateKey()
    let material = PushPreviewKeyMaterial(keyId: UUID().uuidString.lowercased(), privateKey: pushPreviewEncode(key.rawRepresentation))
    try write("environment:\(environmentId)", value: material)
    if let recipient = prior?.recipientId { try storage.delete("recipient:\(recipient)") }
    return material
  }

  public func publicKey(_ material: PushPreviewKeyMaterial) throws -> [String: String] {
    let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: pushPreviewDecode(material.privateKey, maxBytes: 32))
    return ["keyId": material.keyId, "publicKey": pushPreviewEncode(key.publicKey.rawRepresentation)]
  }

  public func bind(_ environmentId: String, recipientId: String, generation: Int, hostSigningKey: String, enabled: Bool) throws {
    guard pushPreviewUUID(recipientId), generation > 0,
          try pushPreviewDecode(hostSigningKey, maxBytes: 32).count == 32 else { throw PushPreviewError.invalidKey }
    var material = try ensure(environmentId)
    let prior = material.recipientId
    material.recipientId = recipientId
    material.generation = generation
    material.hostSigningKey = hostSigningKey
    material.enabled = enabled
    try write("environment:\(environmentId)", value: material)
    try write("recipient:\(recipientId)", value: PushPreviewRecipientIndex(environmentId: environmentId, keyId: material.keyId))
    if let prior, prior != recipientId { try storage.delete("recipient:\(prior)") }
  }

  public func disable(_ recipientId: String) throws {
    guard pushPreviewUUID(recipientId) else { throw PushPreviewError.invalidEnvelope }
    if let index = try read("recipient:\(recipientId)", as: PushPreviewRecipientIndex.self),
       var material = try read("environment:\(index.environmentId)", as: PushPreviewKeyMaterial.self),
       material.keyId == index.keyId, material.recipientId == recipientId {
      material.enabled = false
      try write("environment:\(index.environmentId)", value: material)
    }
    try storage.delete("recipient:\(recipientId)")
  }

  public func remove(_ environmentId: String) throws {
    let material = try read("environment:\(environmentId)", as: PushPreviewKeyMaterial.self)
    try storage.delete("environment:\(environmentId)")
    if let recipient = material?.recipientId { try storage.delete("recipient:\(recipient)") }
  }

  func binding(_ recipientId: String) throws -> PushPreviewBinding {
    guard let index = try read("recipient:\(recipientId)", as: PushPreviewRecipientIndex.self),
          let material = try read("environment:\(index.environmentId)", as: PushPreviewKeyMaterial.self),
          material.keyId == index.keyId, material.recipientId == recipientId,
          let generation = material.generation, let hostSigningKey = material.hostSigningKey,
          material.enabled == true else { throw PushPreviewError.invalidKey }
    return PushPreviewBinding(recipientId: recipientId, generation: generation, keyId: material.keyId,
      privateKey: material.privateKey, hostSigningKey: hostSigningKey, enabled: true)
  }

  public func decrypt(_ payload: PushPreviewPayload, now: Int64) throws -> PushPreviewContent {
    let content = try decryptPushPreview(payload, binding: binding(payload.recipientId), now: now)
    guard let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { throw PushPreviewError.storage }
    guard try PushPreviewReplayLedger(directory: directory).claim(payload, now: now) else { throw PushPreviewError.invalidEnvelope }
    return content
  }
}

public struct PushPreviewReplayLedger {
  private let directory: URL

  public init(directory: URL) {
    self.directory = directory
  }

  public func claim(_ payload: PushPreviewPayload, now: Int64) throws -> Bool {
    let lockURL = directory.appendingPathComponent("push-preview-receipts.lock")
    let descriptor = open(lockURL.path, O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw PushPreviewError.storage }
    defer { close(descriptor) }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { throw PushPreviewError.storage }
    defer { flock(descriptor, LOCK_UN) }
    let url = directory.appendingPathComponent("push-preview-receipts.json")
    var receipts: [String: Int64] = [:]
    if FileManager.default.fileExists(atPath: url.path) {
      let encoded = try Data(contentsOf: url)
      guard encoded.count <= 200_000 else { throw PushPreviewError.storage }
      receipts = try JSONDecoder().decode([String: Int64].self, from: encoded)
    }
    receipts = receipts.filter { $0.value > now }
    let id = "\(payload.recipientId):\(payload.preview.keyId):\(payload.notificationId)"
    if receipts[id] != nil || receipts.count >= 1024 { return false }
    receipts[id] = payload.expiresAt
    try JSONEncoder().encode(receipts).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    return true
  }
}
