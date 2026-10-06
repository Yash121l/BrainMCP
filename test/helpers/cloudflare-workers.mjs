// Stand-in for the workerd-only "cloudflare:workers" module under node:test.
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
