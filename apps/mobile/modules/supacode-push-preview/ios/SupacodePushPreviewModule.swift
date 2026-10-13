import ExpoModulesCore
import Foundation

public final class SupacodePushPreviewModule: Module {
  private let lane = NSLock()

  private func run<T>(_ operation: (PushPreviewStore) throws -> T) throws -> T {
    lane.lock()
    defer { lane.unlock() }
    guard let group = Bundle.main.object(forInfoDictionaryKey: "SupacodePushAccessGroup") as? String,
          let appGroup = Bundle.main.object(forInfoDictionaryKey: "SupacodePushAppGroup") as? String,
          !group.contains("$("), !appGroup.contains("$(") else { throw PushPreviewError.storage }
    return try operation(PushPreviewStore(accessGroup: group, appGroup: appGroup))
  }

  public func definition() -> ModuleDefinition {
    Name("SupacodePushPreview")
    AsyncFunction("ensure") { (environmentId: String) throws -> [String: String] in
      try self.run { store in try store.publicKey(store.ensure(environmentId)) }
    }
    AsyncFunction("rotate") { (environmentId: String) throws -> [String: String] in
      try self.run { store in try store.publicKey(store.rotate(environmentId)) }
    }
    AsyncFunction("bind") { (environmentId: String, recipientId: String, generation: Int, hostSigningKey: String, enabled: Bool) throws in
      try self.run { store in try store.bind(environmentId, recipientId: recipientId, generation: generation, hostSigningKey: hostSigningKey, enabled: enabled) }
    }
    AsyncFunction("disable") { (recipientId: String) throws in
      try self.run { store in try store.disable(recipientId) }
    }
    AsyncFunction("remove") { (environmentId: String) throws in
      try self.run { store in try store.remove(environmentId) }
    }
  }
}
