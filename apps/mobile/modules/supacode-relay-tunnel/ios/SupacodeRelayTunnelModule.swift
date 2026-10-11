import ExpoModulesCore
import UIKit
import os

struct RelayStartOptions: Record {
  @Field var relayUrl: String = ""
  @Field var hostAddress: String = ""
  @Field var port: Int?
}

public final class SupacodeRelayTunnelModule: Module {
  private var tunnels: [String: RelayTunnel] = [:]
  private let lock = NSLock()
  private var backgrounded = false
  private var backgroundObserver: NSObjectProtocol?
  private var foregroundObserver: NSObjectProtocol?
  private var backgroundTask = UIBackgroundTaskIdentifier.invalid
  private var suspendWork: DispatchWorkItem?
  private var graceGeneration: UInt64 = 0
  private var backgroundSyncLeases = 0
  private var backgroundSyncGeneration: UInt64 = 0
  private var backgroundSyncExpiry: DispatchWorkItem?
  private let logger = Logger(subsystem: "sh.supacode.mobile", category: "relay-tunnel")

  public func definition() -> ModuleDefinition {
    Name("SupacodeRelayTunnel")
    Events("onStatus")
    OnCreate { [self] in
      self.backgroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
      ) { [weak self] _ in
        guard let self else { return }
        self.beginBackgroundGrace()
      }
      self.foregroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
      ) { [weak self] _ in
        guard let self else { return }
        self.cancelBackgroundGrace()
        let tunnels = self.setBackgrounded(false)
        Task { for tunnel in tunnels { _ = try? await tunnel.resume() } }
      }
    }
    AsyncFunction("start") { (options: RelayStartOptions) async throws -> [String: String] in
      if let port = options.port, !(0...65535).contains(port) {
        throw RelayError.invalid("Invalid loopback port")
      }
      let identity = try RelayIdentity(address: options.hostAddress)
      let (tunnel, shouldResume) = try self.getOrCreate(options: options, identity: identity)
      let origin = shouldResume
        ? try await tunnel.resume()
        : try await tunnel.start(port: options.port.map(UInt16.init))
      if self.shouldSuspendAfterBackgroundSync() {
        tunnel.suspend()
        throw RelayError.invalid("Relay tunnel is suspended while the app is in the background")
      }
      self.logger.notice("[native-relay] doorway origin=\(origin, privacy: .public) endpoint=\(identity.endpointID, privacy: .public)")
      return ["origin": origin]
    }
    AsyncFunction("stop") { (hostAddress: String?) async throws in
      let tunnels: [RelayTunnel]
      if let hostAddress {
        let identity = try RelayIdentity(address: hostAddress)
        tunnels = self.remove(identity.endpointID)
      } else { tunnels = self.removeAll() }
      for tunnel in tunnels { await tunnel.stop() }
    }
    AsyncFunction("beginBackgroundSync") { () async in
      let tunnels = await MainActor.run { self.beginBackgroundSyncLease() }
      for tunnel in tunnels { _ = try? await tunnel.resume() }
      await MainActor.run {
        if self.shouldSuspendAfterBackgroundSync() {
          for tunnel in tunnels { tunnel.suspend() }
        }
      }
    }
    AsyncFunction("endBackgroundSync") { () async in
      await MainActor.run { self.endBackgroundSyncLease() }
    }
    OnDestroy {
      DispatchQueue.main.async { self.cancelBackgroundGrace() }
      self.lock.lock()
      self.backgroundSyncGeneration += 1
      self.backgroundSyncExpiry?.cancel()
      self.backgroundSyncExpiry = nil
      self.lock.unlock()
      if let observer = self.backgroundObserver { NotificationCenter.default.removeObserver(observer) }
      if let observer = self.foregroundObserver { NotificationCenter.default.removeObserver(observer) }
      let tunnels = self.removeAll()
      Task { for tunnel in tunnels { await tunnel.stop() } }
    }
  }

  private func beginBackgroundGrace() {
    cancelBackgroundGrace()
    lock.lock()
    let hasTunnels = !tunnels.isEmpty
    let hasBackgroundLease = backgroundSyncLeases > 0
    backgrounded = true
    lock.unlock()
    guard hasTunnels && !hasBackgroundLease else { return }
    let generation = graceGeneration
    backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Finish relay requests") { [weak self] in
      guard let self, self.graceGeneration == generation else { return }
      self.suspendTunnels()
    }
    guard backgroundTask != .invalid else { suspendTunnels(); return }
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.graceGeneration == generation else { return }
      self.suspendTunnels()
    }
    suspendWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
  }

  private func suspendTunnels() {
    for tunnel in setBackgrounded(true) { tunnel.suspend() }
    cancelBackgroundGrace()
  }

  private func cancelBackgroundGrace() {
    graceGeneration += 1
    suspendWork?.cancel(); suspendWork = nil
    guard backgroundTask != .invalid else { return }
    let task = backgroundTask; backgroundTask = .invalid
    UIApplication.shared.endBackgroundTask(task)
  }

  private func setBackgrounded(_ value: Bool) -> [RelayTunnel] {
    lock.lock(); defer { lock.unlock() }
    backgrounded = value; return Array(tunnels.values)
  }
  private func beginBackgroundSyncLease() -> [RelayTunnel] {
    cancelBackgroundGrace()
    lock.lock()
    backgrounded = true
    backgroundSyncLeases += 1
    backgroundSyncGeneration += 1
    let generation = backgroundSyncGeneration
    backgroundSyncExpiry?.cancel()
    let expiry = DispatchWorkItem { [weak self] in self?.expireBackgroundSyncLease(generation) }
    backgroundSyncExpiry = expiry
    let active = Array(tunnels.values)
    lock.unlock()
    DispatchQueue.main.asyncAfter(deadline: .now() + 27, execute: expiry)
    return active
  }
  private func endBackgroundSyncLease() {
    lock.lock()
    backgroundSyncLeases = max(0, backgroundSyncLeases - 1)
    if backgroundSyncLeases == 0 {
      backgroundSyncGeneration += 1
      backgroundSyncExpiry?.cancel()
      backgroundSyncExpiry = nil
    }
    let shouldSuspend = backgrounded && backgroundSyncLeases == 0
    lock.unlock()
    if shouldSuspend { suspendTunnels() }
  }
  private func shouldSuspendAfterBackgroundSync() -> Bool {
    lock.lock(); defer { lock.unlock() }
    return backgrounded && backgroundSyncLeases == 0
  }
  private func expireBackgroundSyncLease(_ generation: UInt64) {
    lock.lock()
    guard backgroundSyncGeneration == generation else { lock.unlock(); return }
    backgroundSyncLeases = 0
    backgroundSyncExpiry = nil
    let shouldSuspend = backgrounded
    lock.unlock()
    if shouldSuspend { suspendTunnels() }
  }
  private func removeAll() -> [RelayTunnel] {
    lock.lock(); defer { lock.unlock() }
    let result = Array(tunnels.values); tunnels.removeAll(); return result
  }
  private func remove(_ key: String) -> [RelayTunnel] {
    lock.lock(); defer { lock.unlock() }
    return tunnels.removeValue(forKey: key).map { [$0] } ?? []
  }
  private func getOrCreate(options: RelayStartOptions, identity: RelayIdentity) throws -> (RelayTunnel, Bool) {
    lock.lock(); defer { lock.unlock() }
    guard !backgrounded || backgroundSyncLeases > 0 else {
      throw RelayError.invalid("Relay tunnel is suspended while the app is in the background")
    }
    if let tunnel = tunnels[identity.endpointID] { return (tunnel, backgroundSyncLeases > 0) }
    let tunnel = try RelayTunnel(relayURL: options.relayUrl, hostAddress: options.hostAddress) { [weak self] status in
      guard let self else { return }
      self.logger.debug("[native-relay] \(status.state, privacy: .public) origin=\(status.origin, privacy: .public) sessions=\(status.sessionCount) streams=\(status.activeStreams) up=\(status.bytesSent) down=\(status.bytesReceived) reason=\(status.reason ?? "", privacy: .public)")
      var event: [String: Any] = [
        "state": status.state, "hostAddress": status.hostAddress, "origin": status.origin,
        "bytesSent": status.bytesSent, "bytesReceived": status.bytesReceived,
        "activeStreams": status.activeStreams, "sessionCount": status.sessionCount
      ]
      if let reason = status.reason { event["reason"] = reason }
      self.sendEvent("onStatus", event)
    }
    tunnels[identity.endpointID] = tunnel
    return (tunnel, false)
  }
}
