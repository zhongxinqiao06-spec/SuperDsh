import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { installArchive } from '../extensions/installer.ts'
import { runToolProcess, toolEnvironment } from '../extensions/process.ts'
import {
  validateManifest,
  validateValue,
  packagePath,
} from '../extensions/validation.ts'
import { builtinBinding } from '../extensions/service.ts'
import { agentInput } from '../agents/validation.ts'
import { installedSkillArchive } from '../extensions/skill-archive.ts'
import { readSkillPackage } from '../agents/skill-package.ts'

const tool = {
  id: 'company_custom',
  name: '公司可配置工具',
  description: '独立扩展测试',
  mode: 'action',
  inputSchema: {
    type: 'object',
    required: ['topic'],
    properties: { topic: { type: 'string', maxLength: 100 } },
    additionalProperties: false,
  },
  configurationSchema: {
    type: 'object',
    properties: { apiKey: { type: 'string', writeOnly: true } },
    additionalProperties: false,
  },
  permissions: ['sessions.run'],
  artifactTypes: [],
  timeoutSeconds: 10,
}
test('both shipped 2.0 manifests remain addressable and unknown digests are rejected', async () => {
  const digests = [
    [
      'builtin-tools-v2-initial.json',
      '2e24682f3d019f64cd87e8f60835fd7f6a5f2a0fb49fe19c95b07808fe39b95c',
    ],
    [
      'builtin-tools-v2.json',
      '263814108492a0fc8eededcfaf1e74dcba46fa3704b41f46b1e4cc3888f3e61c',
    ],
  ]
  for (const [file, digest] of digests) {
    const tools = JSON.parse(
      await readFile(new URL('../extensions/' + file, import.meta.url), 'utf8'),
    )
    assert.equal(
      createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
      digest,
    )
    for (const descriptor of tools) {
      const bound = builtinBinding(descriptor.id, '2.0.0', digest)
      assert.equal(bound.implementation.digest, digest)
      assert.deepEqual(bound.descriptor, descriptor)
    }
  }
  assert.throws(
    () => builtinBinding('presentation_report', '2.0.0', '0'.repeat(64)),
    /内容已改变/,
  )
  assert.throws(
    () => builtinBinding('presentation_report', '2.1.0', digests[0][1]),
    /内容已改变/,
  )
})
test('frozen 2.0 tools retain their digest and credential schema after new capabilities are added', async () => {
  const old = JSON.parse(
    await readFile(
      new URL('../extensions/builtin-tools-v2.json', import.meta.url),
      'utf8',
    ),
  )
  const digest = createHash('sha256').update(JSON.stringify(old)).digest('hex')
  for (const descriptor of old) {
    const binding = builtinBinding(descriptor.id, '2.0.0')
    assert.equal(binding.implementation.digest, digest)
    assert.deepEqual(binding.descriptor, descriptor)
  }
  assert.ok(
    builtinBinding('image_generate', '2.0.0').descriptor.configurationSchema
      .properties.apiKey.writeOnly,
  )
  assert.equal(
    builtinBinding('image_generate').descriptor.configurationSchema.properties
      .apiKey,
    undefined,
  )
  assert.throws(() => builtinBinding('vision_analyze', '2.0.0'), /不存在/)
})
const manifest = () => ({
  schemaVersion: 1,
  id: 'company.example',
  name: '公司工具包',
  version: '1.0.0',
  license: 'MIT',
  description: '脱敏测试扩展',
  runtime: 'node',
  entrypoint: 'index.mjs',
  tools: [tool],
})
const entry = `let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => input += value); process.stdin.on('end', () => { const request = JSON.parse(input); process.stdout.write(JSON.stringify(request.operation === 'health' ? {ok:true} : { text: request.arguments.topic, inheritedSecret: Boolean(process.env.TEST_PLATFORM_SECRET), workspace: process.cwd() })); });`
async function archive(files = {}, declaration = manifest()) {
  const zip = new JSZip()
  zip.file('superdsh-extension.json', JSON.stringify(declaration))
  zip.file('index.mjs', entry)
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer' })
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'superdsh-extension-test-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  })
  return directory
}

test('a new extension installs, passes health check and executes without adding a dispatch branch', async (t) => {
  const root = await temporary(t)
  const installed = await installArchive({
    root,
    bytes: await archive(),
    signal: new AbortController().signal,
  })
  assert.equal(installed.manifest.tools[0].id, 'company_custom')
  process.env.TEST_PLATFORM_SECRET = 'must-not-be-inherited'
  try {
    const result = await runToolProcess({
      installation: installed.directory,
      entrypoint: 'index.mjs',
      runtime: 'node',
      workRoot: join(root, 'work'),
      input: {
        operation: 'invoke',
        toolId: 'company_custom',
        arguments: { topic: '实际工具调用' },
      },
      timeoutSeconds: 10,
      signal: new AbortController().signal,
    })
    assert.equal(result.text, '实际工具调用')
    assert.equal(result.inheritedSecret, false)
    await assert.rejects(() => readFile(join(result.workspace, 'missing')), {
      code: 'ENOENT',
    })
  } finally {
    delete process.env.TEST_PLATFORM_SECRET
  }
})

test('failed health checks do not publish an installed version', async (t) => {
  const root = await temporary(t)
  await assert.rejects(
    () =>
      installArchive({
        root,
        bytes: Buffer.alloc(0),
        signal: new AbortController().signal,
      }),
    /大小/,
  )
  await assert.rejects(
    async () =>
      installArchive({
        root,
        bytes: await archive({
          'index.mjs': 'process.stdout.write(JSON.stringify({ok:false}))',
        }),
        signal: new AbortController().signal,
      }),
    /健康检查/,
  )
})

test(
  'Python extension executes from its final installed directory using managed Python 3.12',
  {
    skip:
      process.env.SUPERDSH_EXTENSION_PYTHON_TEST !== '1'
        ? 'requires managed Python preparation'
        : false,
    timeout: 240000,
  },
  async (t) => {
    const root = await temporary(t)
    const declaration = {
      ...manifest(),
      runtime: 'python',
      entrypoint: 'entry.py',
    }
    const bytes = await archive(
      {
        'pyproject.toml':
          '[project]\nname = "superdsh-python-fixture"\nversion = "1.0.0"\nrequires-python = ">=3.12,<3.13"\ndependencies = []\n',
        'uv.lock':
          'version = 1\nrevision = 3\nrequires-python = ">=3.12, <3.13"\n\n[[package]]\nname = "superdsh-python-fixture"\nversion = "1.0.0"\nsource = { virtual = "." }\n',
        'entry.py':
          'import json,sys\nr=json.load(sys.stdin)\nprint(json.dumps({"ok":sys.version_info[:2]==(3,12)} if r["operation"]=="health" else {"text":r["arguments"]["topic"],"python":list(sys.version_info[:2])}))\n',
      },
      declaration,
    )
    const installed = await installArchive({
      root,
      bytes,
      signal: new AbortController().signal,
    })
    assert.ok(!installed.directory.includes('.install-'))
    const result = await runToolProcess({
      installation: installed.directory,
      entrypoint: 'entry.py',
      runtime: 'python',
      workRoot: join(root, 'work'),
      input: {
        operation: 'invoke',
        arguments: { topic: '正式安装后的中文调用' },
      },
      timeoutSeconds: 10,
      signal: new AbortController().signal,
    })
    assert.equal(result.text, '正式安装后的中文调用')
    assert.deepEqual(result.python, [3, 12])
    const repeated = await installArchive({
      root,
      bytes,
      signal: new AbortController().signal,
    })
    assert.equal(repeated.directory, installed.directory)
  },
)

test('an installed package exposes a skill and its reference data without exporting executable dependencies', async (t) => {
  const root = await temporary(t)
  const signal = new AbortController().signal
  const declaration = {
    ...manifest(),
    skills: [
      {
        id: 'workflow',
        name: '工作方法',
        description: '来源检查',
        entrypoint: 'skills/workflow/SKILL.md',
        requiredToolIds: ['company_custom'],
      },
    ],
  }
  const installed = await installArchive({
    root,
    signal,
    bytes: await archive(
      {
        'skills/workflow/SKILL.md':
          '---\nname: 工作方法\ndescription: 来源检查\n---\n先核查资料，再执行工具。',
        'skills/workflow/references/policy.md': '资料需要先获得授权。',
        'skills/workflow/tool.mjs': 'throw new Error("not skill data")',
      },
      declaration,
    ),
  })
  const bytes = await installedSkillArchive(
    installed.directory,
    declaration.skills[0].entrypoint,
    signal,
  )
  const data = await readSkillPackage(bytes, signal)
  assert.deepEqual(
    data.resources.map((file) => file.path),
    ['references/policy.md'],
  )
  assert.equal(data.name, '工作方法')
  assert.equal(
    Object.keys((await JSZip.loadAsync(bytes)).files).some((name) =>
      name.endsWith('.mjs'),
    ),
    false,
  )
})

test('extension packages reject traversal, symlinks and machine caches before execution', async (t) => {
  const root = await temporary(t)
  for (const name of [
    '../escaped.mjs',
    'node_modules/cache.js',
    '.venv/config',
    'C:/absolute',
  ])
    await assert.rejects(
      async () =>
        installArchive({
          root,
          bytes: await archive({ [name]: 'bad' }),
          signal: new AbortController().signal,
        }),
      /相对路径|机器缓存/,
    )
  const zip = new JSZip()
  zip.file('superdsh-extension.json', JSON.stringify(manifest()))
  zip.file('index.mjs', '../elsewhere', { unixPermissions: 0o120777 })
  await assert.rejects(
    async () =>
      installArchive({
        root,
        bytes: await zip.generateAsync({
          type: 'nodebuffer',
          platform: 'UNIX',
        }),
        signal: new AbortController().signal,
      }),
    /符号链接/,
  )
})

test('tool cancellation kills the owned process and releases its temporary directory', async (t) => {
  const root = await temporary(t)
  const bytes = await archive({
    'index.mjs': `let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{if(JSON.parse(input).operation==='health')process.stdout.write('{"ok":true}');else setInterval(()=>{},1000)})`,
  })
  const installed = await installArchive({
    root,
    bytes,
    signal: new AbortController().signal,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1000)
  try {
    await assert.rejects(
      () =>
        runToolProcess({
          installation: installed.directory,
          entrypoint: 'index.mjs',
          runtime: 'node',
          workRoot: join(root, 'work'),
          input: { operation: 'invoke' },
          timeoutSeconds: 20,
          signal: controller.signal,
        }),
      (error) => error.status === 499,
    )
  } finally {
    clearTimeout(timer)
  }
})

test('registry schemas reject unchecked execution paths, refs, regexes and nested secrets', () => {
  for (const path of ['../x', 'C:/x', 'a\\b', '/absolute', 'CON', 'file.'])
    assert.throws(() => packagePath(path))
  assert.throws(
    () =>
      validateManifest({
        ...manifest(),
        tools: [
          {
            ...tool,
            inputSchema: {
              type: 'object',
              properties: { item: { $ref: 'https://other' } },
            },
          },
        ],
      }),
    /引用/,
  )
  assert.throws(
    () =>
      validateManifest({
        ...manifest(),
        tools: [
          {
            ...tool,
            inputSchema: { type: 'object', patternProperties: { '(a+)+': {} } },
          },
        ],
      }),
    /正则/,
  )
  assert.throws(
    () =>
      validateManifest({
        ...manifest(),
        tools: [
          {
            ...tool,
            configurationSchema: {
              type: 'object',
              properties: {
                nested: {
                  type: 'object',
                  properties: { password: { type: 'string', writeOnly: true } },
                },
              },
            },
          },
        ],
      }),
    /顶层/,
  )
  assert.throws(
    () =>
      validateValue(
        tool.inputSchema,
        { topic: 'valid', script: 'unexpected' },
        '输入',
      ),
    /Schema/,
  )
  assert.throws(() => validateValue(tool.inputSchema, {}, '输入'), /Schema/)
})

test('agent configuration accepts dynamic tool IDs while builtins retain their original identities', () => {
  const agent = agentInput({
    name: '自定义业务',
    description: '脱敏案例',
    instructions: '调用已授权的公司工具。',
    published: true,
    toolIds: ['company.custom-tool'],
  })
  assert.deepEqual(agent.toolIds, ['company.custom-tool'])
  for (const id of [
    'knowledge_search',
    'spreadsheet_report',
    'presentation_report',
  ])
    assert.equal(builtinBinding(id).implementation.toolId, id)
  assert.equal(builtinBinding('document_report').descriptor.mode, 'office')
  assert.equal(toolEnvironment('x').DATABASE_URL, undefined)
})
