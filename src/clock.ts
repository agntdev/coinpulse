// Injectable clock seam. Route every Date.now() / new Date() / "today" through
// this so time-based behavior is testable. DefaultClock uses real wall time.

export interface Clock {
  now(): Date;
  nowMs(): number;
}

export const defaultClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};