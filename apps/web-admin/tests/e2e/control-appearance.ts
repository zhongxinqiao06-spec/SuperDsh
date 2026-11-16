import { expect, type Locator } from '@playwright/test'

/** 检查真实渲染的控件内部，防止页面无溢出但选中值被灰底输入框遮挡。 */
export async function expectControlAppearance(scope: Locator) {
  const faults = await scope.evaluate((root) => {
    const results: string[] = []
    for (const input of root.querySelectorAll(
      '.el-select__input, .el-input__inner',
    )) {
      if (!input.getClientRects().length) continue
      const style = getComputedStyle(input)
      const label = input.getAttribute('aria-label') || input.className
      if (style.backgroundColor !== 'rgba(0, 0, 0, 0)')
        results.push(`${label}: 内层有不透明背景 ${style.backgroundColor}`)
      if (parseFloat(style.borderTopWidth) || parseFloat(style.borderLeftWidth))
        results.push(`${label}: 内层出现第二重边框`)
      if (style.outlineStyle !== 'none')
        results.push(`${label}: 内层焦点框与外壳焦点框叠加`)
      if (
        input.matches('.el-select__input') &&
        (parseFloat(style.paddingTop) ||
          parseFloat(style.paddingLeft) ||
          parseFloat(style.minHeight))
      )
        results.push(`${label}: 搜索输入框被套用普通表单的间距或最小高度`)
    }
    for (const control of root.querySelectorAll('.native-control')) {
      if (!control.getClientRects().length) continue
      const style = getComputedStyle(control)
      const rect = control.getBoundingClientRect()
      const minimum = control.classList.contains('native-control--small')
        ? 32
        : 40
      if (rect.height < minimum - 1 || !parseFloat(style.borderTopWidth))
        results.push(`${control.tagName}: 原生控件失去公共尺寸或边框`)
    }
    return results
  })
  expect(faults, '控件外壳负责边框，内部输入不能遮住文字').toEqual([])
}
