import logger from '@overleaf/logger'
import Errors from './Errors.js'
import RequestParser from './RequestParser.js'
import Metrics from '@overleaf/metrics'
import Settings from '@overleaf/settings'

// The lock timeout should be higher than the maximum end-to-end compile time.
// Here, we use the maximum compile timeout plus 2 minutes.
const LOCK_TIMEOUT_MS = RequestParser.MAX_TIMEOUT * 1000 + 120000

const LOCKS = new Map()

/**
 * @param key
 * @return {Lock | undefined}
 */
function getExistingLock(key) {
  return LOCKS.get(key)
}

function acquire(key) {
  const currentLock = LOCKS.get(key)
  if (currentLock != null) {
    if (currentLock.isExpired()) {
      logger.warn({ key }, 'Compile lock expired')
      currentLock.release()
    } else {
      throw new Errors.AlreadyCompilingError('compile in progress')
    }
  }

  checkConcurrencyLimit()

  const lock = new Lock(key)
  LOCKS.set(key, lock)
  return lock
}

function checkConcurrencyLimit() {
  Metrics.gauge('concurrent_compile_requests', LOCKS.size)

  if (LOCKS.size <= Settings.compileConcurrencyLimit) {
    return
  }

  Metrics.inc('exceeded-compilier-concurrency-limit')

  throw new Errors.TooManyCompileRequestsError(
    'too many concurrent compile requests'
  )
}

class Lock {
  constructor(key) {
    this.key = key
    this.expiresAt = Date.now() + LOCK_TIMEOUT_MS
  }

  isExpired() {
    return Date.now() >= this.expiresAt
  }

  waitForRelease() {
    if (this.waitingForRelease) return this.waitingForRelease
    this.waitingForRelease = new Promise(resolve => {
      this.onRelease = resolve
    })
    return this.waitingForRelease
  }

  release() {
    if (this.onRelease) this.onRelease()
    const lockWasActive = LOCKS.delete(this.key)
    if (!lockWasActive) {
      logger.error({ key: this.key }, 'Lock was released twice')
    }
    if (this.isExpired()) {
      Metrics.inc('compile_lock_expired_before_release')
    }
  }
}

// Per-key FIFO queues used by the DockerRunner to serialise container
// start/destroy operations on the same container name. Separate from the
// compile-level LOCKS above, which guard whole compile requests.
const KEY_QUEUES = new Map()

/**
 * Run `runner(releaseLock)` once any earlier operations on `key` have
 * released. `releaseLock(err, ...results)` releases the queue slot and
 * forwards its arguments to `callback`.
 */
function runWithLock(key, runner, callback) {
  const queue = KEY_QUEUES.get(key) || Promise.resolve()
  const job = queue.then(
    () =>
      new Promise(resolve => {
        let released = false
        const releaseLock = (...args) => {
          if (released) {
            logger.error({ key }, 'docker lock was released twice')
            return
          }
          released = true
          resolve()
          callback(...args)
        }
        try {
          runner(releaseLock)
        } catch (err) {
          releaseLock(err)
        }
      })
  )
  KEY_QUEUES.set(key, job)
  job.then(() => {
    if (KEY_QUEUES.get(key) === job) KEY_QUEUES.delete(key)
  })
}

export default { acquire, getExistingLock, runWithLock }
