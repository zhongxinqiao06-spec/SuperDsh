import assert from 'node:assert/strict'
import test from 'node:test'
import {
  openCompatibility,
  OPEN_COMPATIBILITY_EVENT,
} from '../src/compatibility/extensions.ts'

test('ordinary Web opens a separate compatibility document without an opener', async () => {
  const calls = [],
    events = []
  globalThis.window = {
    open: (...args) => {
      calls.push(args)
      return null
    },
    dispatchEvent: (event) => {
      events.push(event.type)
    },
  }
  try {
    await openCompatibility()
    assert.deepEqual(calls, [
      [
        '/compatibility.html?surface=standalone',
        '_blank',
        'noopener,noreferrer',
      ],
    ])
    assert.deepEqual(events, [OPEN_COMPATIBILITY_EVENT])
  } finally {
    delete globalThis.window
  }
})

test('desktop compatibility uses the managed view and propagates bridge failures', async () => {
  let opened = 0
  globalThis.window = {
    superdshExtensions: {
      open: async () => {
        opened++
      },
    },
  }
  try {
    await openCompatibility()
    assert.equal(opened, 1)
    window.superdshExtensions.open = async () => {
      throw new Error('Engine is unavailable')
    }
    await assert.rejects(openCompatibility(), /Engine is unavailable/)
  } finally {
    delete globalThis.window
  }
})
