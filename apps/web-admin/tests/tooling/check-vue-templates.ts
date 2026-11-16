/** 编译所有 Vue 模板，捕获类型检查未覆盖的事件表达式解析错误。 */
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'

const source = resolve(import.meta.dirname, '../../fronted/src')
let count = 0
const failures: string[] = []
async function inspect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) await inspect(file)
    else if (entry.name.endsWith('.vue')) {
      count++
      const parsed = parse(await readFile(file, 'utf8'), { filename: file })
      const errors: (string | Error)[] = [...parsed.errors]
      if (parsed.descriptor.template)
        errors.push(
          ...compileTemplate({
            source: parsed.descriptor.template.content,
            filename: file,
            id: file,
            compilerOptions: { expressionPlugins: ['typescript'] },
          }).errors,
        )
      for (const error of errors) failures.push(file + ': ' + String(error))
    }
  }
}
await inspect(source)
if (failures.length) throw new Error(failures.join('\n'))
console.log(`${count} 个 Vue 模板编译通过`)
