import type { User } from "../generated/prisma/client";

/**
 * Adds `req.user` to Express' own Request type ("declaration merging").
 *
 * Without this, TypeScript would reject `req.user` and the usual workaround is
 * `(req as any).user` at every use site — which throws away the type checking
 * this project turned on with `strict`.
 */
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export {};
