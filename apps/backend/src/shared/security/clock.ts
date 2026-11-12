/** Injected time source; tests replace it to exercise expiry without sleeping. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
