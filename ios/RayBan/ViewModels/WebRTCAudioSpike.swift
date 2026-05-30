/*
 * CourtLine — WebRTC audio coexistence spike (PROTOCOL.md §2.6).
 *
 * This is NOT the production transport. It is the de-risking spike the
 * protocol doc calls out: stand up a single bidirectional WebRTC audio leg
 * over the glasses' Bluetooth HFP route *while a DAT camera stream is live*,
 * and confirm the two coexist. The open risk is that WebRTC's audio device
 * module wants to own `AVAudioSession`, whereas the existing code configures
 * HFP by hand (see StreamSessionViewModel's AudioPublisher).
 *
 * Transport: Pipecat's SmallWebRTC client, which peers **directly with our own
 * server** (`server/webrtc_server.py`) — no SFU, no third party. Media (SRTP)
 * flows glasses -> our server over a peer connection; signaling is a plain HTTP
 * SDP exchange at `<webRTCServerURL>/api/offer`. The server beeps periodically
 * (downlink) and logs the mic audio it receives (uplink).
 *
 * Validation signals (watch the Xcode console while wearing the glasses):
 *   - `onLocalAudioLevel  > 0`  -> glasses MIC reaching WebRTC (uplink OK)
 *   - `onRemoteAudioLevel > 0`  -> server beep arriving (downlink OK)
 *   - audio route logs show `bluetoothHFP` -> routed to the glasses, not phone
 *   - the DAT camera preview keeps updating -> coexistence holds
 *
 * NETWORK NOTE: peer-to-peer WebRTC needs a routable media path. Use the Mac's
 * LAN IP here; this does NOT traverse the Cloudflare HTTP tunnel (that forwards
 * HTTP only, not the UDP media).
 */

import AVFoundation
import Foundation
import Observation
import PipecatClientIOS
import PipecatClientIOSSmallWebrtc

// ⚙️ CONFIG — base URL of the CourtLine agent (yc-voice-agents-hackathon/server,
// Pipecat runner, SmallWebRTC). Point this at the host running the agent, e.g.
// the Mac's LAN IP + port 7860. The client POSTs its SDP offer to
// `<this>/api/offer` (the runner serves that route). Compile-time constant —
// rebuild to change. NOTE: peer-to-peer WebRTC needs a routable media path; use
// a LAN IP on the same network (a Cloudflare HTTP tunnel won't carry the media).
let webRTCServerURL = "http://YOUR-AGENT-HOST:7860"

@MainActor
@Observable
final class WebRTCAudioSpike: NSObject {

  enum SpikeState: String {
    case idle, joining, joined, failed, left
  }

  private(set) var state: SpikeState = .idle
  /// Human-readable last event, surfaced in the debug UI.
  private(set) var lastEvent: String = "not started"

  private var client: PipecatClient?
  private var localLevelLogCount = 0
  private var remoteLevelLogCount = 0

  /// Connect to the server, publish the mic over HFP, and play the server's
  /// audio back. Deliberately does NOT touch `AVAudioSession` directly — the
  /// SmallWebRTC transport's AudioManager owns it. Call this *after* the DAT
  /// camera stream is running so we exercise the real coexistence case.
  func start() async {
    guard client == nil else {
      log("already running (state=\(state))")
      return
    }
    guard let offerURL = URL(string: "\(webRTCServerURL)/api/offer"),
          !webRTCServerURL.contains("YOUR-MAC-LAN-IP") else {
      state = .failed
      log("set `webRTCServerURL` to your Mac's LAN IP, e.g. http://192.168.1.42:7860")
      return
    }

    state = .joining
    logAudioRoute(tag: "before connect")

    // Receive-only: we do NOT capture the glasses mic (WebRTC iOS can't reliably
    // pull the HFP mic). Audio is captured on the Mac server side; this app just
    // plays the agent's voice out through the glasses speaker.
    let options = PipecatClientOptions(
      transport: SmallWebRTCTransport(iceConfig: nil),
      enableMic: false,
      enableCam: false
    )
    let pipecat = PipecatClient(options: options)
    pipecat.delegate = self
    client = pipecat

    // Connect DIRECTLY to our single `/api/offer` endpoint — no RTVI `/start`
    // session indirection. The transport POSTs its SDP offer there and gets the
    // answer back (matches server/webrtc_server.py and webrtc_client.html).
    let params = SmallWebRTCTransportConnectionParams(
      webrtcRequestParams: APIRequest(endpoint: offerURL),
      iceConfig: nil
    )
    pipecat.connect(transportParams: params) { [weak self] result in
      Task { @MainActor in
        guard let self else { return }
        switch result {
        case .success:
          self.state = .joined
          self.log("connected to \(webRTCServerURL)")
          self.logAudioRoute(tag: "after connect")
        case .failure(let error):
          self.state = .failed
          self.log("connect failed: \(error)")
          self.client = nil
        }
      }
    }
  }

  func stop() async {
    guard let pipecat = client else { return }
    client = nil
    do {
      try await pipecat.disconnect()
      log("disconnected")
    } catch {
      log("disconnect error: \(error)")
    }
    state = .left
    logAudioRoute(tag: "after disconnect")
  }

  // MARK: - Logging

  private func log(_ message: String) {
    lastEvent = message
    print("[WebRTCAudioSpike] \(message)")
  }

  private func logAudioRoute(tag: String) {
    let session = AVAudioSession.sharedInstance()
    let route = session.currentRoute
    let inputs = route.inputs.map { "\($0.portName)(\($0.portType.rawValue))" }
    let outputs = route.outputs.map { "\($0.portName)(\($0.portType.rawValue))" }
    print("[WebRTCAudioSpike] route \(tag): category=\(session.category.rawValue) "
      + "mode=\(session.mode.rawValue) in=\(inputs) out=\(outputs)")
  }
}

// MARK: - PipecatClientDelegate
// The protocol ships default no-op implementations, so we override only the
// handful that prove the two audio legs and surface coexistence problems.
// Callbacks may arrive off the main actor, so hop back before touching state.
extension WebRTCAudioSpike: PipecatClientDelegate {

  nonisolated func onConnected() {
    Task { @MainActor in self.log("transport connected") }
  }

  nonisolated func onDisconnected() {
    Task { @MainActor in self.log("transport disconnected") }
  }

  nonisolated func onTransportStateChanged(state: TransportState) {
    Task { @MainActor in self.log("transport state=\(state)") }
  }

  nonisolated func onBotReady(botReadyData: BotReadyData) {
    Task { @MainActor in self.log("server bot ready") }
  }

  /// Glasses mic → WebRTC. Non-zero means the uplink leg is alive and HFP
  /// capture survived the SmallWebRTC transport taking over the audio session.
  nonisolated func onLocalAudioLevel(level: Float) {
    guard level > 0.01 else { return }
    Task { @MainActor in
      self.localLevelLogCount += 1
      if self.localLevelLogCount == 1 || self.localLevelLogCount % 25 == 0 {
        self.log(String(format: "uplink mic level=%.3f (#%d)", level, self.localLevelLogCount))
      }
    }
  }

  /// Server audio → glasses speaker. Non-zero means the downlink leg is alive.
  nonisolated func onRemoteAudioLevel(level: Float, participant: Participant) {
    guard level > 0.01 else { return }
    Task { @MainActor in
      self.remoteLevelLogCount += 1
      if self.remoteLevelLogCount == 1 || self.remoteLevelLogCount % 25 == 0 {
        self.log(String(format: "downlink server level=%.3f (#%d)", level, self.remoteLevelLogCount))
      }
    }
  }

  nonisolated func onBotStartedSpeaking() {
    Task { @MainActor in self.log("server started sending audio") }
  }
}
