import Path from 'node:path'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import fs from 'fs'
import Docker from 'dockerode'
import _ from 'lodash'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Metrics from '@overleaf/metrics'
import LockManager from './LockManager.js'
import { getLastProjectAccessTime } from './LastProjectAccess.js'

logger.debug('using docker command runner')

const ONE_HOUR_IN_MS = 60 * 60 * 1000
const MAX_OUTPUT = 1024 * 1024 * 2 // limit ourselves to 2MB of output

const READ_ONLY_COMPILE_GROUPS = ['synctex', 'synctex-output', 'wordcount']

const dockerode = new Docker({
  socketPath: Settings.clsi?.docker?.socketPath || '/var/run/docker.sock',
})

// The compile and output directories are bind-mounted from the host, so the
// paths the CLSI sees are not the paths the docker daemon needs. When these
// settings are present we rewrite the bind source to the host-side path.
function usingSiblingContainers() {
  return Settings.path?.sandboxedCompilesHostDirCompiles != null
}

let containerMonitorTimeout
let containerMonitorInterval

const DockerRunner = {
  MAX_CONTAINER_AGE: ONE_HOUR_IN_MS,

  run(
    projectId,
    command,
    directory,
    image,
    timeout,
    environment,
    compileGroup,
    cwd,
    callback
  ) {
    if (environment == null) {
      environment = {}
    }
    callback = _.once(callback)

    if (image == null) {
      image = Settings.clsi.docker.image
    }

    const { allowedImages } = Settings.clsi.docker
    if (allowedImages && !allowedImages.includes(image)) {
      return callback(new Error('image not allowed'))
    }

    if (cwd != null) {
      // the working directory must stay inside the compile mount
      const resolvedCwd = Path.join('/compile', cwd)
      if (resolvedCwd !== '/compile' && !resolvedCwd.startsWith('/compile/')) {
        return callback(new Error('invalid cwd'))
      }
    }

    if (Settings.texliveImageNameOveride != null) {
      const img = image.split('/')
      image = `${Settings.texliveImageNameOveride}/${img[img.length - 1]}`
    }

    const volumes = DockerRunner._getVolumes(directory, compileGroup)

    command = command.map(arg =>
      arg.toString().replace('$COMPILE_DIR', '/compile')
    )

    const options = DockerRunner._getContainerOptions(
      command,
      image,
      volumes,
      timeout,
      environment,
      compileGroup,
      cwd
    )
    const fingerprint = DockerRunner._fingerprintContainer(options)
    const name = `project-${projectId}-${fingerprint}`
    options.name = name

    logger.debug({ projectId, name, image, timeout }, 'running docker compile')
    DockerRunner._runAndWaitForContainer(
      options,
      volumes,
      timeout,
      (error, output) => {
        if (error && error.statusCode === 500) {
          // a 500 error from docker usually means the container got into a
          // broken state - destroy it and retry once with a fresh container
          logger.debug(
            { err: error, projectId, name },
            'error running container so destroying and retrying'
          )
          DockerRunner.destroyContainer(name, null, true, error => {
            if (error) {
              return callback(error)
            }
            DockerRunner._runAndWaitForContainer(
              options,
              volumes,
              timeout,
              callback
            )
          })
        } else {
          callback(error, output)
        }
      }
    )

    // return the container name to allow the job to be killed if necessary
    return name
  },

  kill(containerId, callback) {
    logger.debug({ containerId }, 'sending kill signal to container')
    const container = dockerode.getContainer(containerId)
    container.kill(error => {
      if (
        error != null &&
        /Cannot kill container .* is not running/.test(error.message)
      ) {
        logger.warn(
          { err: error, containerId },
          'container not running, continuing'
        )
        error = undefined
      }
      if (error != null) {
        logger.error({ err: error, containerId }, 'error killing container')
        callback(error)
      } else {
        callback()
      }
    })
  },

  _getVolumes(directory, compileGroup) {
    let hostDir = directory
    if (compileGroup === 'synctex-output') {
      // the directory is inside the output dir,
      // e.g. <outputDir>/<projectId>/generated-files/<buildId>
      let relativePath
      const { outputDir, sandboxedCompilesHostDirOutput } = Settings.path
      if (outputDir != null && directory.startsWith(outputDir + '/')) {
        relativePath = directory.slice(outputDir.length + 1)
      } else {
        relativePath = directory.replace(/^.*\/output\//, '')
      }
      if (sandboxedCompilesHostDirOutput != null) {
        hostDir = Path.join(sandboxedCompilesHostDirOutput, relativePath)
      }
    } else if (usingSiblingContainers()) {
      hostDir = Path.join(
        Settings.path.sandboxedCompilesHostDirCompiles,
        Path.basename(directory)
      )
    }
    const isReadOnly = READ_ONLY_COMPILE_GROUPS.includes(compileGroup)
    return { [hostDir]: isReadOnly ? '/compile:ro' : '/compile' }
  },

  _getContainerOptions(
    command,
    image,
    volumes,
    timeout,
    environment,
    compileGroup,
    cwd
  ) {
    const timeoutInSeconds = timeout / 1000

    const dockerVolumes = {}
    const binds = []
    for (let [hostVol, dockerVol] of Object.entries(volumes)) {
      let mode = 'rw'
      if (dockerVol.endsWith(':ro')) {
        dockerVol = dockerVol.slice(0, -':ro'.length)
        mode = 'ro'
      }
      binds.push(`${hostVol}:${dockerVol}:${mode}`)
      dockerVolumes[dockerVol] = {}
    }

    // do not inherit the CLSI process environment - only pass the explicitly
    // configured base environment plus the per-request compile environment
    const env = Object.assign({}, Settings.clsi.docker.env, environment)

    const options = {
      Cmd: command,
      Image: image,
      Volumes: dockerVolumes,
      WorkingDir: cwd ? Path.join('/compile', cwd) : '/compile',
      NetworkDisabled: true,
      Memory: 1024 * 1024 * 1024, // 1 Gb
      User: Settings.clsi.docker.user,
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      HostConfig: {
        Binds: binds,
        LogConfig: { Type: 'none', Config: {} },
        Ulimits: [
          {
            Name: 'cpu',
            Soft: timeoutInSeconds + 5,
            Hard: timeoutInSeconds + 10,
          },
        ],
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: 'none',
        PidsLimit: 4096,
        Init: true,
      },
    }

    if (Settings.clsi.docker.seccomp_profile != null) {
      options.HostConfig.SecurityOpt.push(
        `seccomp=${Settings.clsi.docker.seccomp_profile}`
      )
    }

    if (Settings.clsi.docker.apparmor_profile != null) {
      options.HostConfig.SecurityOpt.push(
        `apparmor=${Settings.clsi.docker.apparmor_profile}`
      )
    }

    if (Settings.clsi.docker.runtime) {
      options.HostConfig.Runtime = Settings.clsi.docker.runtime
    }

    const compileGroupConfig =
      Settings.clsi.docker.compileGroupConfig?.[compileGroup]
    if (compileGroupConfig != null) {
      for (const [key, value] of Object.entries(compileGroupConfig)) {
        _.set(options, key, value)
      }
    }

    return options
  },

  _fingerprintContainer(containerOptions) {
    // generate a secure fingerprint from the container options, in order to
    // identify and re-use an existing container with the same configuration
    const optionsJson = JSON.stringify(containerOptions)
    return crypto.createHash('md5').update(optionsJson).digest('hex')
  },

  _runAndWaitForContainer(options, volumes, timeout, _callback) {
    const callback = _.once(_callback)
    const { name } = options

    let streamEnded = false
    let containerReturned = false
    let output = {}

    const timer = new Metrics.Timer('docker-container')

    function callbackIfFinished() {
      if (streamEnded && containerReturned) {
        timer.done()
        callback(null, output)
      }
    }

    function attachStreamHandler(error, _output) {
      if (error) {
        return callback(error)
      }
      output = _output
      streamEnded = true
      callbackIfFinished()
    }

    DockerRunner.startContainer(
      options,
      volumes,
      attachStreamHandler,
      (error, containerId) => {
        if (error) {
          return callback(error)
        }
        DockerRunner.waitForContainer(
          name,
          timeout,
          options,
          (error, exitCode) => {
            let err
            if (error) {
              return callback(error)
            }
            if (exitCode === 137) {
              // exit status from kill -9
              err = new Error('terminated')
              err.terminated = true
              return callback(err)
            }
            if (exitCode === 1) {
              // exit status from chktex
              err = new Error('exited')
              err.code = exitCode
              return callback(err)
            }
            containerReturned = true
            output.exitCode = exitCode
            callbackIfFinished()
          }
        )
      }
    )
  },

  startContainer(options, volumes, attachStreamHandler, callback) {
    LockManager.runWithLock(
      options.name,
      releaseLock =>
        DockerRunner._startContainer(
          options,
          volumes,
          attachStreamHandler,
          releaseLock
        ),
      callback
    )
  },

  // Check that volumes exist and are directories
  _startContainer(options, volumes, attachStreamHandler, callback) {
    callback = _.once(callback)
    const { name } = options
    const container = dockerode.getContainer(name)

    function createAndStartContainer() {
      dockerode.createContainer(options, (error, container) => {
        if (error) {
          return callback(error)
        }
        startExistingContainer()
      })
    }

    function startExistingContainer() {
      DockerRunner.attachToContainer(name, attachStreamHandler, error => {
        if (error) {
          return callback(error)
        }
        container.start(error => {
          if (error != null && error.statusCode !== 304) {
            // 304 = container already running
            callback(error)
          } else {
            callback()
          }
        })
      })
    }

    container.inspect((error, stats) => {
      if (error != null && error.statusCode === 404) {
        DockerRunner._checkVolumes(options, volumes, error => {
          if (error) {
            return callback(error)
          }
          createAndStartContainer()
        })
      } else if (error != null) {
        logger.err({ err: error, name }, 'unable to inspect container')
        callback(error)
      } else {
        startExistingContainer()
      }
    })
  },

  _checkVolumes(options, volumes, callback) {
    callback = _.once(callback)
    if (usingSiblingContainers()) {
      // Volumes will be on the host, so we can't check them here
      return callback()
    }
    const hostPaths = Object.keys(volumes)
    let remaining = hostPaths.length
    if (remaining === 0) {
      return callback()
    }
    for (const hostPath of hostPaths) {
      fs.stat(hostPath, (error, stats) => {
        if (error) {
          return callback(error)
        }
        if (!stats.isDirectory()) {
          const err = new Error('not a directory')
          err.path = hostPath
          return callback(err)
        }
        remaining--
        if (remaining === 0) {
          callback()
        }
      })
    }
  },

  attachToContainer(containerId, attachStreamHandler, attachStartCallback) {
    const container = dockerode.getContainer(containerId)
    container.attach({ stdout: 1, stderr: 1, stream: 1 }, (error, stream) => {
      if (error != null) {
        logger.error(
          { err: error, containerId },
          'error attaching to container'
        )
        return attachStartCallback(error)
      }
      attachStartCallback()

      logger.debug({ containerId }, 'attached to container')

      function createStringOutputStream(name) {
        return {
          data: '',
          overflowed: false,
          write(data) {
            if (this.overflowed) {
              return
            }
            if (this.data.length < MAX_OUTPUT) {
              this.data += data
            } else {
              logger.info(
                {
                  containerId,
                  length: this.data.length,
                  maxLen: MAX_OUTPUT,
                },
                `${name} exceeds max size`
              )
              this.data += `(...truncated at ${MAX_OUTPUT} chars...)`
              this.overflowed = true
            }
          },
        }
      }

      const stdout = createStringOutputStream('stdout')
      const stderr = createStringOutputStream('stderr')

      container.modem.demuxStream(stream, stdout, stderr)

      stream.on('error', err =>
        logger.error(
          { err, containerId },
          'error reading from container stream'
        )
      )
      stream.on('end', () =>
        attachStreamHandler(null, { stdout: stdout.data, stderr: stderr.data })
      )
    })
  },

  waitForContainer(containerId, timeout, options, _callback) {
    const callback = _.once(_callback)
    const container = dockerode.getContainer(containerId)

    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      logger.debug({ containerId }, 'timeout reached, killing container')
      container.kill(err => {
        if (err) {
          logger.warn({ err, containerId }, 'error killing timed out container')
        }
      })
    }, timeout)

    logger.debug({ containerId }, 'waiting for docker container')
    container.wait((error, res) => {
      clearTimeout(timeoutId)
      if (error != null) {
        if (error.statusCode === 404 && options?.HostConfig?.AutoRemove) {
          // The container has exited and been auto-removed before we could
          // collect its exit code. Treat this as a successful exit.
          return callback(null, 0)
        }
        logger.warn({ err: error, containerId }, 'error waiting for container')
        return callback(error)
      }
      if (timedOut) {
        logger.debug({ containerId }, 'docker container timed out')
        const err = new Error('container timed out')
        err.timedout = true
        callback(err)
      } else {
        logger.debug(
          { containerId, exitCode: res.StatusCode },
          'docker container returned'
        )
        callback(null, res.StatusCode)
      }
    })
  },

  destroyContainer(containerName, containerId, shouldForce, callback) {
    // We want the lock on the container name (which is the key used by the
    // monitor and the compile), but the delete itself can use the id if we
    // have one, which works even if the container has been renamed.
    LockManager.runWithLock(
      containerName,
      releaseLock =>
        DockerRunner._destroyContainer(
          containerId || containerName,
          shouldForce,
          releaseLock
        ),
      callback
    )
  },

  _destroyContainer(containerId, shouldForce, callback) {
    logger.debug({ containerId }, 'destroying docker container')
    const container = dockerode.getContainer(containerId)
    container.remove({ force: shouldForce === true, v: true }, error => {
      if (error != null && error.statusCode === 404) {
        logger.warn(
          { err: error, containerId },
          'container not found, continuing'
        )
        error = null
      }
      if (error != null) {
        logger.error({ err: error, containerId }, 'error destroying container')
      } else {
        logger.debug({ containerId }, 'destroyed container')
      }
      callback(error)
    })
  },

  destroyOldContainers(callback) {
    callback = _.once(callback)
    dockerode.listContainers({ all: true }, (error, containers) => {
      if (error != null) {
        return callback(error)
      }
      const now = Date.now()
      const candidates = []
      for (const container of containers || []) {
        const rawName = container.Name || container.Names?.[0] || ''
        const name = rawName.replace(/^\//, '')
        if (!name.startsWith('project-')) {
          continue
        }
        const age = now - container.Created * 1000 // creation time is returned in seconds
        if (age <= DockerRunner.MAX_CONTAINER_AGE) {
          continue
        }
        const projectId = name.match(/^project-([0-9a-f]{24})-/)?.[1]
        if (projectId != null) {
          const lastAccess = getLastProjectAccessTime(projectId)
          if (now - lastAccess <= DockerRunner.MAX_CONTAINER_AGE) {
            // the project has been accessed recently, the container is
            // likely to be re-used - keep it for now
            continue
          }
        }
        candidates.push({ name, id: container.Id })
      }

      logger.debug(
        { numberOfContainers: candidates.length },
        'destroying old containers'
      )
      let remaining = candidates.length
      if (remaining === 0) {
        return callback()
      }
      let firstError = null
      for (const { name, id } of candidates) {
        DockerRunner.destroyContainer(name, id, false, err => {
          if (err && firstError == null) {
            firstError = err
          }
          remaining--
          if (remaining === 0) {
            callback(firstError)
          }
        })
      }
    })
  },

  startContainerMonitor() {
    logger.debug(
      { maxAge: DockerRunner.MAX_CONTAINER_AGE },
      'starting container monitor'
    )
    // randomise the start time to avoid all CLSI instances cleaning up at once
    const randomDelay = Math.floor(Math.random() * 5 * 60 * 1000)
    containerMonitorTimeout = setTimeout(() => {
      containerMonitorInterval = setInterval(
        () =>
          DockerRunner.destroyOldContainers(err => {
            if (err) {
              logger.error({ err }, 'failed to destroy old containers')
            }
          }),
        ONE_HOUR_IN_MS
      )
      containerMonitorInterval.unref?.()
    }, randomDelay)
    containerMonitorTimeout.unref?.()
  },

  stopContainerMonitor() {
    if (containerMonitorTimeout) {
      clearTimeout(containerMonitorTimeout)
      containerMonitorTimeout = undefined
    }
    if (containerMonitorInterval) {
      clearInterval(containerMonitorInterval)
      containerMonitorInterval = undefined
    }
  },

  canRunSyncTeXInOutputDir() {
    return Boolean(Settings.path?.sandboxedCompilesHostDirOutput)
  },
}

DockerRunner.promises = {
  run: promisify(DockerRunner.run),
  kill: promisify(DockerRunner.kill),
}

if (Settings.clsi?.docker != null) {
  DockerRunner.startContainerMonitor()
}

export default DockerRunner
