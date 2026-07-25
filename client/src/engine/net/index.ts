// @dd/engine/net — the online-transport seam (design/06, ROADMAP 3.1). The wire
// protocol shared by client and server, plus NetInputSource (the confirmed
// frame-stream half of the netcode). No WebSocket/DOM here — the transport injects a
// CmdSink and feeds decoded ServerMsgs in, so this stays headless-testable.
export * from './protocol';
export * from './NetInputSource';
export * from './FrameBroadcast';
