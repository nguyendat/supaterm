package expo.modules.supacoderelaytunnel

import android.util.Log
import android.os.SystemClock
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.supacoderelaytunnel.core.NativeTunnel
import expo.modules.supacoderelaytunnel.core.hex
import expo.modules.supacoderelaytunnel.core.parseRelayIdentity
import expo.modules.supacoderelaytunnel.core.sha256

class RelayTunnelOptions : Record {
  @Field var relayUrl: String = ""

  @Field var hostAddress: String = ""

  @Field var port: Int? = null
}

class SupacodeRelayTunnelModule : Module() {
  private val tunnels = LinkedHashMap<String, NativeTunnel>()
  private var backgrounded = false
  private var backgroundDeadline: Long? = null
  private var backgroundSyncLeases = 0
  private var backgroundSyncGeneration = 0L
  private val backgroundLeaseHandler = Handler(Looper.getMainLooper())
  private var backgroundSyncExpiry: Runnable? = null

  private fun stopAll() =
    synchronized(tunnels) {
      tunnels.values.forEach { it.close() }
      tunnels.clear()
    }

  override fun definition() = ModuleDefinition {
    Name("SupacodeRelayTunnel")
    Events("onStatus")
    AsyncFunction("start") { options: RelayTunnelOptions ->
      synchronized(tunnels) {
        val graceRemaining = backgroundDeadline?.minus(SystemClock.elapsedRealtime())
        check(!backgrounded || backgroundSyncLeases > 0 || (graceRemaining != null && graceRemaining > 0)) {
          "Relay tunnel is suspended while the app is in the background"
        }
        val digest = sha256(parseRelayIdentity(options.hostAddress))
        val key = digest.hex()
        val existing = tunnels[key]
        if (existing != null) {
          if (backgroundSyncLeases > 0) existing.resume()
          mapOf("origin" to existing.origin)
        } else {
          val port =
            options.port
              ?: (
                40000 +
                  (((digest[0].toInt() and 255) shl 8 or (digest[1].toInt() and 255)) % 20000)
                )
          fun create(port: Int) =
            NativeTunnel(
              options.relayUrl,
              options.hostAddress,
              port,
              { event -> sendEvent("onStatus", event) },
              { line -> Log.i("SupacodeRelayTunnel", line) },
            )
          val tunnel =
            try {
              create(port)
            } catch (error: java.net.BindException) {
              if (port == 0) throw error else create(0)
            }
          tunnels[key] = tunnel
          if (backgroundSyncLeases == 0) graceRemaining?.let { tunnel.background(it) }
          mapOf("origin" to tunnel.origin)
        }
      }
    }
    AsyncFunction("stop") { hostAddress: String? ->
      if (hostAddress == null) {
        stopAll()
      } else {
        synchronized(tunnels) {
          tunnels.remove(sha256(parseRelayIdentity(hostAddress)).hex())?.close()
        }
      }
    }
    AsyncFunction("beginBackgroundSync") {
      synchronized(tunnels) {
        backgrounded = true
        backgroundSyncLeases += 1
        backgroundSyncGeneration += 1
        val generation = backgroundSyncGeneration
        backgroundSyncExpiry?.let { backgroundLeaseHandler.removeCallbacks(it) }
        val expiry = Runnable { expireBackgroundSyncLease(generation) }
        backgroundSyncExpiry = expiry
        backgroundLeaseHandler.postDelayed(expiry, 27_000)
        tunnels.values.forEach { it.resume() }
      }
    }
    AsyncFunction("endBackgroundSync") {
      synchronized(tunnels) {
        backgroundSyncLeases = (backgroundSyncLeases - 1).coerceAtLeast(0)
        if (backgroundSyncLeases == 0) {
          backgroundSyncGeneration += 1
          backgroundSyncExpiry?.let { backgroundLeaseHandler.removeCallbacks(it) }
          backgroundSyncExpiry = null
        }
        if (backgroundSyncLeases == 0 && backgroundDeadline != null) {
          tunnels.values.forEach { it.background(0) }
        }
      }
    }
    OnActivityEntersBackground {
      synchronized(tunnels) {
        backgrounded = true
        backgroundDeadline = SystemClock.elapsedRealtime() + NativeTunnel.BACKGROUND_GRACE_MILLIS
        if (backgroundSyncLeases == 0) tunnels.values.forEach { it.background() }
      }
    }
    OnActivityEntersForeground {
      synchronized(tunnels) {
        backgrounded = false
        backgroundDeadline = null
        tunnels.values.forEach { it.resume() }
      }
    }
    OnDestroy {
      synchronized(tunnels) {
        backgroundSyncGeneration += 1
        backgroundSyncExpiry?.let { backgroundLeaseHandler.removeCallbacks(it) }
        backgroundSyncExpiry = null
      }
      stopAll()
    }
  }

  private fun expireBackgroundSyncLease(generation: Long) {
    synchronized(tunnels) {
      if (backgroundSyncGeneration != generation) return
      backgroundSyncLeases = 0
      backgroundSyncExpiry = null
      if (backgroundDeadline != null) tunnels.values.forEach { it.background(0) }
    }
  }
}
