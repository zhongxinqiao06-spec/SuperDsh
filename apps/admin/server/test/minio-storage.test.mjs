import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { createObjectStorage } from '../files/object-storage.ts'

test(
  'fixed source MinIO serves private objects with restricted credentials and survives repeated initialization',
  { timeout: 60000 },
  async (t) => {
    const name = 'superdsh-minio-test-' + randomBytes(8).toString('hex')
    const rootPassword = randomBytes(24).toString('hex'),
      appPassword = randomBytes(24).toString('hex')
    const docker = (...args) =>
      execFileSync('docker', args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    docker(
      'run',
      '-d',
      '--name',
      name,
      '--label',
      'superdsh.test=' + name,
      '--tmpfs',
      '/data:rw,uid=10001,gid=10001',
      '-p',
      '127.0.0.1::9000',
      '-e',
      'MINIO_ROOT_USER=synthetic-root',
      '-e',
      'MINIO_ROOT_PASSWORD=' + rootPassword,
      '-e',
      'SUPERDSH_MINIO_APP_USER=synthetic-app',
      '-e',
      'SUPERDSH_MINIO_APP_PASSWORD=' + appPassword,
      '-e',
      'SUPERDSH_MINIO_ENDPOINT=http://127.0.0.1:9000',
      'superdsh-minio:2025-10-15',
    )
    t.after(() => {
      const [container] = JSON.parse(docker('inspect', name))
      assert.equal(container.Config.Labels['superdsh.test'], name)
      docker('rm', '-f', name)
    })
    const port = JSON.parse(docker('inspect', name))[0].NetworkSettings.Ports[
      '9000/tcp'
    ][0].HostPort
    const endpoint = 'http://127.0.0.1:' + port
    let ready = false
    for (let i = 0; i < 40; i++) {
      try {
        ready = (
          await fetch(endpoint + '/minio/health/live', {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      } catch {
        // The temporary server may still be starting; readiness is bounded below.
      }
      if (ready) break
      await new Promise((done) => setTimeout(done, 250))
    }
    assert.equal(ready, true)
    docker('exec', name, '/bin/sh', '/usr/local/bin/superdsh-minio-init')
    const store = createObjectStorage(
      {
        backend: 's3',
        endpoint,
        bucket: 'superdsh-files',
        region: 'us-east-1',
      },
      { accessKeyId: 'synthetic-app', secretAccessKey: appPassword },
    )
    t.after(() => store.close())
    await store.check()
    const large = Buffer.alloc(9 * 1024 * 1024, 117)
    await store.write(
      'objects/multipart',
      Readable.from([large]),
      large.length,
      'application/octet-stream',
    )
    assert.equal((await store.head('objects/multipart')).size, large.length)
    const tail = []
    for await (const chunk of await store.read('objects/multipart', {
      start: large.length - 10,
      end: large.length - 1,
    }))
      tail.push(chunk)
    assert.deepEqual(Buffer.concat(tail), large.subarray(-10))
    await assert.rejects(
      store.write(
        'objects/incomplete',
        Readable.from([large]),
        large.length + 1,
        'application/octet-stream',
      ),
      /大小/,
    )
    await assert.rejects(store.head('objects/incomplete'))
    assert.equal(
      await store.cleanIncomplete(
        new Date(Date.now() + 10000).toISOString(),
        false,
      ),
      0,
      'failed multipart writes are explicitly aborted',
    )
    const content = Buffer.from('临时中文文件·private storage')
    await store.write(
      'objects/synthetic',
      Readable.from([content]),
      content.length,
      'text/plain',
    )
    assert.equal((await store.head('objects/synthetic')).size, content.length)
    const chunks = []
    for await (const chunk of await store.read('objects/synthetic', {
      start: 2,
      end: 9,
    }))
      chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), content.subarray(2, 10))
    assert.equal(
      (await fetch(endpoint + '/superdsh-files/objects/synthetic')).status,
      403,
    )
    docker('exec', name, '/bin/sh', '/usr/local/bin/superdsh-minio-init')
    assert.equal((await store.head('objects/synthetic')).size, content.length)
    await store.remove('objects/synthetic')
    await assert.rejects(
      store.head('objects/synthetic'),
      (error) => error.$metadata?.httpStatusCode === 404,
    )
  },
)
