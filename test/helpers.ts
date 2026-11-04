/** Awaits a promise that must reject and returns the rejection reason. */
export async function caught<E = Error>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise
  }
  catch (error) {
    return error as E
  }
  throw new Error('Expected the promise to reject')
}
