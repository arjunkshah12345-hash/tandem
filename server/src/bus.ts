import { EventEmitter } from "node:events";
import type { ServerEvent } from "./shared.ts";

class Bus extends EventEmitter {
  emitEvent(e: ServerEvent) {
    this.emit("event", e);
  }
  onEvent(fn: (e: ServerEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
