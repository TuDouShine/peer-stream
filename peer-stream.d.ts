// Type declarations for peer-stream.js
// <video is="peer-stream"> — WebRTC player custom element for UE Pixel Streaming.

/** UE protocol message ids (player -> UE). Mirrors PixelStreamingProtocol::EToUE4Msg. */
export interface SendMessageTypes {
  IFrameRequest: number;
  RequestQualityControl: number;
  FpsRequest: number;
  AverageBitrateRequest: number;
  StartStreaming: number;
  StopStreaming: number;
  LatencyTest: number;
  RequestInitialSettings: number;
  UIInteraction: number;
  Command: number;
  KeyDown: number;
  KeyUp: number;
  KeyPress: number;
  FindFocus: number;
  CompositionEnd: number;
  MouseEnter: number;
  MouseLeave: number;
  MouseDown: number;
  MouseUp: number;
  MouseMove: number;
  MouseWheel: number;
  TouchStart: number;
  TouchEnd: number;
  TouchMove: number;
  GamepadButtonPressed: number;
  GamepadButtonReleased: number;
  GamepadAnalog: number;
}

/** UE protocol message ids (UE -> player). Mirrors PixelStreamingProtocol::EToClientMsg. */
export interface ReceiveMessageTypes {
  QualityControlOwnership: number;
  Response: number;
  Command: number;
  FreezeFrame: number;
  UnfreezeFrame: number;
  VideoEncoderAvgQP: number;
  LatencyTest: number;
  InitialSettings: number;
  InputControlOwnership: number;
  Protocol: number;
}

export type QualityLevel = "low" | "medium" | "high";

/** Custom events dispatched by a PeerStream element. */
export interface PeerStreamEventMap extends HTMLVideoElementEventMap {
  /** Data channel is open; ready to send/receive. */
  connected: CustomEvent<void>;
  /** Inbound message from the UE app. `detail` is the (already JSON.parse'd) payload. */
  message: CustomEvent<any>;
  /** WebRTC/socket dropped; the element auto-reconnects. */
  playerdisconnected: CustomEvent<void>;
  /** The UE instance exited. */
  ueDisConnected: CustomEvent<{ type: string;[k: string]: any }>;
  /** Queue position update while waiting for a free GPU instance. */
  playerqueue: CustomEvent<{ type: string; seq: number }>;
}

/**
 * The <video is="peer-stream"> custom element.
 *
 * @example
 * import "peer-stream";
 * const ps = document.createElement("video", { is: "peer-stream" }) as PeerStream;
 * ps.id = "ws://127.0.0.1:88/";          // signaling URL (empty = derive from page)
 * document.body.append(ps);
 * await ps.ready();
 * await ps.emitMessage({ hello: "ue" });
 * ps.addEventListener("message", e => console.log(e.detail));
 */
export interface PeerStream extends HTMLVideoElement {
  /** Signaling WebSocket URL (ws:// or wss://). Empty derives it from location.href. */
  id: string;
  /** Live video encoder quantization parameter (lower = better quality). */
  readonly VideoEncoderQP?: number;
  /** Underlying RTCPeerConnection. */
  readonly pc: RTCPeerConnection;
  /** Underlying RTCDataChannel. */
  readonly dc: RTCDataChannel;
  /** Underlying signaling WebSocket. */
  readonly ws: WebSocket;

  /** Resolve once the data channel is open. Rejects after `timeout` ms (0 = forever). */
  ready(timeout?: number): Promise<void>;
  /** Send a string/object to the UE app; awaits channel open, resolves true when sent. */
  emitMessage(msg: string | object, messageType?: number): Promise<boolean>;
  /** Send a message and resolve with the next inbound "message" payload. */
  request(msg: string | object, messageType?: number, timeout?: number): Promise<any>;
  /** Send a UE console command (requires -AllowPixelStreamingCommands). */
  emitCommand(command: string | object): Promise<boolean>;
  /** Apply a quality preset via PixelStreaming console commands. */
  setQuality(level: QualityLevel): void;

  addEventListener<K extends keyof PeerStreamEventMap>(
    type: K,
    listener: (this: PeerStream, ev: PeerStreamEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void;
}

export interface PeerStreamConstructor {
  new(): PeerStream;
  readonly prototype: PeerStream;
  readonly SEND: SendMessageTypes;
  readonly RECEIVE: ReceiveMessageTypes;
}

/** The PeerStream element constructor (also registered via customElements.define). */
export const PeerStream: PeerStreamConstructor;

declare global {
  interface Window {
    /** The most recently constructed PeerStream element. */
    ps: PeerStream;
  }
}
