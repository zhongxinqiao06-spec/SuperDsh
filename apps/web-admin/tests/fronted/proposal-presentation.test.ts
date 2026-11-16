import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElButton, ElCheckbox } from 'element-plus'
import { proposalPresenter } from '../../fronted/src/utils/studio/proposal-presentation'
import StudioProposalReview from '../../fronted/src/views/studio/components/project/StudioProposalReview.vue'
import { preparationApi } from '../../fronted/src/api/studio/preparation-api'
import { studioProposalFixture } from '../fixtures/studio-proposal'

vi.mock('../../fronted/src/api/studio/preparation-api', () => ({
  preparationApi: { compare: vi.fn(), review: vi.fn() },
}))

describe('导演方案人类可读展示', () => {
  it('场次、角色与顺序使用真实名称，时间转秒，不显示空技术字段', () => {
    const { project, comparison, shot, roleId, sceneId } =
      studioProposalFixture()
    const presenter = proposalPresenter(project, comparison.changes)
    const scene = presenter.display(comparison.changes[1]!, 'after')
    expect(scene).toContain('第 1 场 · 海滩 · 清晨')
    expect(scene).toContain('关联原稿：')
    expect(scene).not.toMatch(/scriptRange|start|end|10000000/)
    const value = presenter.display(comparison.changes[2]!, 'after')
    expect(value).toContain('时长：5 秒')
    expect(value).toContain('小鹿：一起去看看吧！')
    expect(value).not.toContain(roleId)
    expect(value).not.toContain(sceneId)
    expect(value).not.toMatch(/subtitle|start|end|volume|构图：|音色：/)
    const order = presenter.display(comparison.changes[3]!, 'after')
    expect(order).toContain('第 1 镜 · 主角在海边')
    expect(order).not.toContain(shot.id)
    expect(
      presenter.display(
        {
          key: 'line:x:start',
          label: '',
          before: 0,
          current: 0,
          after: 2500,
          conflict: false,
        },
        'after',
      ),
    ).toBe('2.5 秒')
  })
  it('渲染可读比较但采用仍提交原字段身份，手工冲突必须显式覆盖', async () => {
    const { project, comparison } = studioProposalFixture()
    vi.mocked(preparationApi.compare).mockResolvedValue(comparison)
    vi.mocked(preparationApi.review).mockResolvedValue({ revision: 4 })
    const wrapper = mount(StudioProposalReview, {
      props: {
        project,
        readonly: false,
        save: vi.fn().mockResolvedValue(undefined),
      },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    const button = (text: string) =>
      wrapper.findAllComponents(ElButton).find((item) => item.text() === text)!
    expect(wrapper.text()).toContain('时长：5 秒')
    expect(wrapper.text()).not.toMatch(/scriptRange|30000000/)
    const expand = button('展开完整内容')
    await expand.trigger('click')
    expect(expand.attributes('aria-expanded')).toBe('true')
    await button('选择无冲突建议').trigger('click')
    const script = wrapper
      .findAllComponents(ElCheckbox)
      .find((item) => item.text() === '剧本正文')!
    script.vm.$emit('update:modelValue', true)
    await flushPromises()
    expect(button('采用选中字段').props('disabled')).toBe(true)
    const override = wrapper
      .findAllComponents(ElCheckbox)
      .find((item) => item.text().includes('确认用此建议覆盖'))!
    override.vm.$emit('update:modelValue', true)
    await flushPromises()
    await button('采用选中字段').trigger('click')
    await flushPromises()
    expect(preparationApi.review).toHaveBeenCalledWith(
      project.id,
      comparison.id,
      expect.objectContaining({
        revision: 3,
        selected: [
          ...comparison.changes.slice(1).map((item) => item.key),
          'script',
        ],
        overrides: ['script'],
        requestKey: expect.any(String),
      }),
    )
    expect(wrapper.emitted('reviewed')).toHaveLength(1)
    wrapper.unmount()
  })
})
