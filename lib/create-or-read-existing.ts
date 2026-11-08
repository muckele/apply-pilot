import { Prisma } from "@prisma/client";

/** Prisma's unique-constraint error (P2002). */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Creates a row that exists once per key, such as a user's settings on their first visit, or
 * returns the row a simultaneous request created first.
 *
 * Prisma's upsert reads and then creates, so two first requests can both try the create and the
 * slower one fails with P2002. On that error this reads the winner's row instead of failing. The
 * read never writes, so anything the user already chose is kept.
 *
 * Not for use inside an interactive transaction: PostgreSQL aborts the transaction on the failed
 * create, so the read would fail too. Retry the whole transaction instead.
 */
export async function createOrReadExisting<T>(
  create: () => Promise<T>,
  readExisting: () => Promise<T>
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;
    return readExisting();
  }
}
