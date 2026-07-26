/**
 * Room registry (design/06, ROADMAP 3.1) — maps roomId → MatchRoom and routes client
 * messages. A room is created on demand by the first joiner (its seed/playerCount define
 * the match); later joiners for the same roomId must agree or are rejected (mirrors
 * funny's ticket seed cross-check). Pure of any socket/timer import — the entrypoint
 * injects the Scheduler and wraps sockets as RoomConnections.
 */
import type { ClientMsg } from '@dd/engine';
import { MatchRoom, type RoomConnection, type Scheduler, type SettledMatch } from './MatchRoom';
import type { MatchMode } from './ticket';

export interface RoomManagerDeps {
  scheduler: Scheduler;
  batchMs?: number;
  framesPerBatch?: number;
  /** Forwarded to every room's `MatchRoomDeps.onSettled` (design/15, ROADMAP 4.6). */
  onSettled?: (match: SettledMatch) => void;
}

export class RoomManager {
  private readonly rooms = new Map<string, MatchRoom>();

  constructor(private readonly deps: RoomManagerDeps) {}

  get size(): number {
    return this.rooms.size;
  }
  room(roomId: string): MatchRoom | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Handle a `join`: create the room if new (this joiner's seed/playerCount define it),
   * else cross-check the joiner agrees with the existing room, then seat the connection.
   * Returns false if the room parameters mismatch or the seat is taken/out of range —
   * the caller closes the socket.
   */
  join(conn: RoomConnection, roomId: string, seed: number, playerCount: number, mode: MatchMode = 'coop'): boolean {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new MatchRoom(roomId, seed, playerCount, {
        scheduler: this.deps.scheduler,
        mode,
        onDestroy: (id) => this.rooms.delete(id),
        onSettled: this.deps.onSettled,
        batchMs: this.deps.batchMs,
        framesPerBatch: this.deps.framesPerBatch,
      });
      this.rooms.set(roomId, room);
    } else if (room.seedValue !== seed || room.playerCountValue !== playerCount || room.modeValue !== mode) {
      return false; // a joiner disagreeing about the match cannot share the room
    }
    return room.join(conn);
  }

  /** Route an in-match message from a seated connection to its room. */
  handle(conn: RoomConnection, roomId: string, msg: ClientMsg): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    switch (msg.type) {
      case 'cmd':
        room.submitCmd(conn.owner, msg.cmd);
        return;
      case 'resume':
        room.resume(conn, msg.lastFrame);
        return;
      case 'result':
        room.reportResult(conn.owner, msg.stateHash, msg.winner, msg.placements);
        return;
      case 'checkpoint':
        room.reportCheckpoint(conn.owner, msg.tick, msg.stateHash);
        return;
      // 'join' is handled by join() at connection time, not here.
      default:
        return;
    }
  }

  onClose(conn: RoomConnection, roomId: string): void {
    this.rooms.get(roomId)?.onDisconnect(conn);
  }

  destroyAll(): void {
    for (const room of [...this.rooms.values()]) room.destroy();
    this.rooms.clear();
  }
}
