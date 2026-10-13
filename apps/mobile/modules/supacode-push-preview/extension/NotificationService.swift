import Foundation
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var handler: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    content.title = "Supacode"
    content.subtitle = ""
    content.body = "Supacode has an update"
    lock.lock()
    handler = contentHandler
    fallback = content.copy() as? UNNotificationContent
    lock.unlock()
    do {
      guard let data = request.content.userInfo["supacode"],
            let group = Bundle.main.object(forInfoDictionaryKey: "SupacodePushAccessGroup") as? String,
            let appGroup = Bundle.main.object(forInfoDictionaryKey: "SupacodePushAppGroup") as? String else { throw PushPreviewError.invalidEnvelope }
      let encoded = try JSONSerialization.data(withJSONObject: data)
      guard encoded.count <= 3072 else { throw PushPreviewError.invalidEnvelope }
      let payload = try JSONDecoder().decode(PushPreviewPayload.self, from: encoded)
      let preview = try PushPreviewStore(accessGroup: group, appGroup: appGroup).decrypt(payload, now: Int64(Date().timeIntervalSince1970 * 1000))
      content.title = preview.title
      content.body = preview.body
    } catch {
      content.title = "Supacode"
      content.body = "Supacode has an update"
    }
    finish(content)
  }

  override func serviceExtensionTimeWillExpire() {
    lock.lock()
    let content = fallback
    lock.unlock()
    if let content { finish(content) }
  }

  private func finish(_ content: UNNotificationContent) {
    lock.lock()
    let completion = handler
    handler = nil
    fallback = nil
    lock.unlock()
    completion?(content)
  }
}
