#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/hid/IOHIDDevice.h>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <node_api.h>
#include <string>
#include <thread>
#include <vector>

namespace {
constexpr int vendor = 0x303a;
constexpr int product = 0x8360;
constexpr int usagePage = 0xff00;

CFMutableDictionaryRef matching() {
  auto dictionary = IOServiceMatching("IOHIDDevice");
  if (!dictionary)
    return nullptr;
  for (const auto &entry :
       {std::pair{CFSTR("VendorID"), vendor}, std::pair{CFSTR("ProductID"), product}}) {
    auto value = CFNumberCreate(nullptr, kCFNumberIntType, &entry.second);
    CFDictionarySetValue(dictionary, entry.first, value);
    CFRelease(value);
  }
  return dictionary;
}

int number(CFTypeRef value) {
  int result = 0;
  if (value && CFGetTypeID(value) == CFNumberGetTypeID())
    CFNumberGetValue(static_cast<CFNumberRef>(value), kCFNumberIntType, &result);
  return result;
}

std::string text(CFTypeRef value, const char *fallback = "") {
  if (!value || CFGetTypeID(value) != CFStringGetTypeID())
    return fallback;
  char buffer[512];
  return CFStringGetCString(static_cast<CFStringRef>(value), buffer, sizeof(buffer),
                            kCFStringEncodingUTF8)
             ? buffer
             : fallback;
}

bool hasVendorUsage(IOHIDDeviceRef device) {
  if (number(IOHIDDeviceGetProperty(device, CFSTR("PrimaryUsagePage"))) == usagePage)
    return true;
  auto value = IOHIDDeviceGetProperty(device, CFSTR("DeviceUsagePairs"));
  if (!value || CFGetTypeID(value) != CFArrayGetTypeID())
    return false;
  auto pairs = static_cast<CFArrayRef>(value);
  for (CFIndex i = 0; i < CFArrayGetCount(pairs); ++i) {
    auto pair = CFArrayGetValueAtIndex(pairs, i);
    if (CFGetTypeID(pair) == CFDictionaryGetTypeID() &&
        number(CFDictionaryGetValue(static_cast<CFDictionaryRef>(pair),
                                    CFSTR("DeviceUsagePage"))) == usagePage)
      return true;
  }
  return false;
}

struct Interface {
  std::string path, name, transport;
  int release;
};
struct FindWork {
  napi_async_work work;
  napi_deferred deferred;
  std::vector<Interface> devices;
  bool failed = false;
};

void findExecute(napi_env, void *data) {
  auto work = static_cast<FindWork *>(data);
  io_iterator_t iterator = 0;
  auto dictionary = matching();
  if (!dictionary ||
      IOServiceGetMatchingServices(MACH_PORT_NULL, dictionary, &iterator) != KERN_SUCCESS) {
    work->failed = true;
    return;
  }
  while (auto service = IOIteratorNext(iterator)) {
    auto device = IOHIDDeviceCreate(nullptr, service);
    uint64_t id = 0;
    if (device && hasVendorUsage(device) &&
        IORegistryEntryGetRegistryEntryID(service, &id) == KERN_SUCCESS) {
      auto transport = text(IOHIDDeviceGetProperty(device, CFSTR("Transport")));
      const int release = number(IOHIDDeviceGetProperty(device, CFSTR("VersionNumber")));
      work->devices.push_back(
          {"DevSrvsID:" + std::to_string(id),
           text(IOHIDDeviceGetProperty(device, CFSTR("Product")), "Codex Micro"),
           transport == "USB"                   ? "USB"
           : transport.starts_with("Bluetooth") ? "Bluetooth"
           : (release & 3) == 0                 ? "USB"
                                                : "Bluetooth",
           release});
    }
    if (device)
      CFRelease(device);
    IOObjectRelease(service);
  }
  IOObjectRelease(iterator);
}

void setString(napi_env env, napi_value object, const char *key, const std::string &value) {
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  napi_set_named_property(env, object, key, result);
}
void setNumber(napi_env env, napi_value object, const char *key, int value) {
  napi_value result;
  napi_create_int32(env, value, &result);
  napi_set_named_property(env, object, key, result);
}
void findComplete(napi_env env, napi_status status, void *data) {
  auto work = static_cast<FindWork *>(data);
  napi_value result;
  if (work->failed || status != napi_ok) {
    napi_value message;
    napi_create_string_utf8(env, "Could not discover Micro interfaces.", NAPI_AUTO_LENGTH,
                            &message);
    napi_create_error(env, nullptr, message, &result);
    napi_reject_deferred(env, work->deferred, result);
  } else {
    napi_create_array_with_length(env, work->devices.size(), &result);
    uint32_t index = 0;
    for (const auto &device : work->devices) {
      napi_value item;
      napi_create_object(env, &item);
      setString(env, item, "path", device.path);
      setString(env, item, "product", device.name);
      setString(env, item, "transport", device.transport);
      setNumber(env, item, "release", device.release);
      setNumber(env, item, "vendorId", vendor);
      setNumber(env, item, "productId", product);
      setNumber(env, item, "usagePage", usagePage);
      napi_set_element(env, result, index++, item);
    }
    napi_resolve_deferred(env, work->deferred, result);
  }
  napi_delete_async_work(env, work->work);
  delete work;
}
napi_value find(napi_env env, napi_callback_info) {
  auto work = new FindWork;
  napi_value result, name;
  napi_create_promise(env, &work->deferred, &result);
  napi_create_string_utf8(env, "Micro discovery", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, findExecute, findComplete, work, &work->work);
  napi_queue_async_work(env, work->work);
  return result;
}

struct Watcher {
  napi_threadsafe_function callback;
  std::thread thread;
  std::mutex mutex;
  std::condition_variable ready;
  CFRunLoopRef loop = nullptr;
  bool started = false, failed = false;
  std::atomic<bool> stopped{false};

  void stop() {
    if (stopped.exchange(true))
      return;
    {
      std::lock_guard lock(mutex);
      if (loop) {
        auto stoppingLoop = loop;
        CFRunLoopPerformBlock(loop, kCFRunLoopDefaultMode, ^{
          CFRunLoopStop(stoppingLoop);
        });
        CFRunLoopWakeUp(loop);
      }
    }
    if (thread.joinable())
      thread.join();
  }
};
void notify(void *context, io_iterator_t iterator) {
  auto watcher = static_cast<Watcher *>(context);
  bool changed = false;
  while (auto service = IOIteratorNext(iterator)) {
    IOObjectRelease(service);
    changed = true;
  }
  if (changed && !watcher->stopped)
    napi_call_threadsafe_function(watcher->callback, nullptr, napi_tsfn_nonblocking);
}
void callJs(napi_env env, napi_value callback, void *, void *) {
  if (env && callback) {
    napi_value receiver;
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, callback, 0, nullptr, nullptr);
  }
}
void cleanup(void *data) { static_cast<Watcher *>(data)->stop(); }
void finalize(napi_env env, void *data, void *) {
  auto watcher = static_cast<Watcher *>(data);
  napi_remove_env_cleanup_hook(env, cleanup, watcher);
  watcher->stop();
  delete watcher;
}
napi_value close(napi_env env, napi_callback_info info) {
  void *data = nullptr;
  napi_value receiver;
  napi_get_cb_info(env, info, nullptr, nullptr, &receiver, nullptr);
  if (napi_unwrap(env, receiver, &data) != napi_ok || !data) {
    napi_throw_type_error(env, nullptr, "Invalid Micro watcher.");
    return nullptr;
  }
  static_cast<Watcher *>(data)->stop();
  return nullptr;
}
napi_value watch(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value callback, name, result, closeFunction;
  napi_get_cb_info(env, info, &count, &callback, nullptr, nullptr);
  napi_valuetype type;
  if (count != 1 || napi_typeof(env, callback, &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "Micro watcher requires a callback.");
    return nullptr;
  }
  auto watcher = new Watcher;
  napi_create_string_utf8(env, "Micro topology", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, callback, nullptr, name, 1, 1, nullptr, nullptr, nullptr,
                                  callJs, &watcher->callback);
  watcher->thread = std::thread([watcher] {
    auto port = IONotificationPortCreate(MACH_PORT_NULL);
    io_iterator_t arrival = 0, removal = 0;
    auto loop = CFRunLoopGetCurrent();
    CFRetain(loop);
    bool valid = port != nullptr;
    if (valid) {
      CFRunLoopAddSource(loop, IONotificationPortGetRunLoopSource(port), kCFRunLoopDefaultMode);
      valid = IOServiceAddMatchingNotification(port, kIOFirstMatchNotification, matching(), notify,
                                               watcher, &arrival) == KERN_SUCCESS;
      valid = valid && IOServiceAddMatchingNotification(port, kIOTerminatedNotification, matching(),
                                                        notify, watcher, &removal) == KERN_SUCCESS;
      if (valid) {
        notify(watcher, arrival);
        notify(watcher, removal);
      }
    }
    {
      std::lock_guard lock(watcher->mutex);
      watcher->loop = loop;
      watcher->failed = !valid;
      watcher->started = true;
    }
    watcher->ready.notify_one();
    if (valid)
      CFRunLoopRun();
    {
      std::lock_guard lock(watcher->mutex);
      watcher->loop = nullptr;
    }
    if (arrival)
      IOObjectRelease(arrival);
    if (removal)
      IOObjectRelease(removal);
    if (port)
      IONotificationPortDestroy(port);
    CFRelease(loop);
    napi_release_threadsafe_function(watcher->callback, napi_tsfn_release);
  });
  {
    std::unique_lock lock(watcher->mutex);
    watcher->ready.wait(lock, [watcher] { return watcher->started; });
  }
  if (watcher->failed) {
    watcher->stop();
    delete watcher;
    napi_throw_error(env, nullptr, "Could not watch Micro device changes.");
    return nullptr;
  }
  napi_create_object(env, &result);
  napi_create_function(env, "close", NAPI_AUTO_LENGTH, close, nullptr, &closeFunction);
  napi_set_named_property(env, result, "close", closeFunction);
  napi_wrap(env, result, watcher, finalize, nullptr, nullptr);
  napi_add_env_cleanup_hook(env, cleanup, watcher);
  return result;
}
}

NAPI_MODULE_INIT() {
  for (const auto &entry : {std::pair{"find", find}, std::pair{"watch", watch}}) {
    napi_value function;
    napi_create_function(env, entry.first, NAPI_AUTO_LENGTH, entry.second, nullptr, &function);
    napi_set_named_property(env, exports, entry.first, function);
  }
  return exports;
}
