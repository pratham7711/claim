import { decide } from "./decide.js";
import { initialState, mutate } from "./state.js";
import type { Command, EngineConfig, EngineEvent, EngineState } from "./types.js";

/** Decides and applies one command. Pure: returns the next state and the events that produced it. */
export function execute(state: EngineState, command: Command, now: number): { state: EngineState; events: EngineEvent[] } {
  const events = decide(state, command, now);
  if (!events.length) return { state, events };
  const next = structuredClone(state);
  for (const e of events) mutate(next, e);
  return { state: next, events };
}

export interface Engine {
  readonly state: EngineState;
  readonly events: readonly EngineEvent[];
  execute(command: Command, now: number): EngineEvent[];
}

/** Convenience holder for one show: current state plus the append-only event log. */
export function createEngine(config: EngineConfig, history: readonly EngineEvent[] = []): Engine {
  let state = initialState(config);
  for (const e of history) mutate(state, e);
  const log: EngineEvent[] = [...history];
  return {
    get state() {
      return state;
    },
    get events() {
      return log;
    },
    execute(command, now) {
      const r = execute(state, command, now);
      state = r.state;
      log.push(...r.events);
      return r.events;
    },
  };
}
