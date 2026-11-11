<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { AgentCatalog, AgentDraft } from '@/types/agents/agents'
import ResourceChoices from '@/components/form/ResourceChoices.vue'
import FormSection from '@/components/form/FormSection.vue'
import LongTextField from '@/components/form/LongTextField.vue'
import StringListEditor from '@/components/form/StringListEditor.vue'
import type {
  AgentEditorSection,
  AgentFieldIssue,
} from '@/utils/agents/editor-validation'
import {
  agentSkillPolicy,
  selectAgentResource,
} from '@/utils/agents/resource-selection'
/** 智能体只关联已有资源；布局及依赖选择保持旧编辑器契约，不承载文件上传。 */
const props = defineProps<{
  draft: AgentDraft
  catalog: AgentCatalog | null
  disabled?: boolean
  busy?: boolean
  issue?: AgentFieldIssue
}>()
const emit = defineEmits<{ 'update:draft': [value: AgentDraft] }>()
function patch(value: Partial<AgentDraft>): void {
  emit('update:draft', { ...props.draft, ...value })
}
const groups = computed(() =>
  [
    {
      key: 'knowledgeBaseIds' as const,
      title: '关联知识库',
      items: props.catalog?.knowledgeBases ?? [],
    },
    {
      key: 'knowledgeAssetIds' as const,
      title: '参考知识',
      items: (props.catalog?.assets ?? [])
        .filter(
          (asset) =>
            asset.kind === 'knowledge' &&
            props.draft.knowledgeAssetIds.includes(asset.id),
        )
        .map((asset) => ({ ...asset, description: asset.preview })),
    },
    {
      key: 'templateAssetIds' as const,
      title: '输出模板',
      items: (props.catalog?.assets ?? []).filter(
        (asset) =>
          asset.kind !== 'knowledge' &&
          props.draft.templateAssetIds.includes(asset.id),
      ),
    },
    {
      key: 'skillIds' as const,
      title: '业务技能',
      items: props.catalog?.skills ?? [],
    },
    {
      key: 'toolIds' as const,
      title: '可用工具',
      items: props.catalog?.tools ?? [],
    },
  ].filter(
    (group) =>
      !['knowledgeAssetIds', 'templateAssetIds'].includes(group.key) ||
      group.items.length,
  ),
)

const active = ref<AgentEditorSection>('basic')
const resourceGroup = ref('knowledgeBaseIds')
const root = ref<HTMLElement>()
/** 保存发现隐藏字段错误时，切换到所属分区并将焦点归还给该字段。 */
async function focusIssue(issue: AgentFieldIssue): Promise<void> {
  active.value = issue.section
  await nextTick()
  root.value
    ?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-field="${issue.field}"] input, [data-field="${issue.field}"] textarea`,
    )
    ?.focus()
}
defineExpose({ focusIssue })
</script>

<template>
  <div ref="root" class="agent-editor">
    <el-tabs
      v-model="active"
      class="editor-sections"
      aria-label="智能体配置分区"
    >
      <el-tab-pane label="基本信息" name="basic">
        <FormSection
          title="定义智能体的用途"
          description="清楚说明帮助谁、解决什么问题，以及期望得到的结果。"
        >
          <label class="field" data-field="name"
            >名称
            <el-input
              :model-value="draft.name"
              maxlength="80"
              :disabled="busy"
              :aria-invalid="issue?.field === 'name'"
              placeholder="例如：企业资料问答助手"
              @update:model-value="patch({ name: $event })"
            />
            <small v-if="issue?.field === 'name'" class="field-error">{{
              issue.message
            }}</small>
          </label>
          <LongTextField
            data-field="description"
            :model-value="draft.description"
            label="用途说明"
            :maxlength="500"
            :disabled="busy"
            :error="issue?.field === 'description' ? issue.message : undefined"
            placeholder="说明使用场景与输出结果。"
            @update:model-value="patch({ description: $event })"
          />
        </FormSection>
      </el-tab-pane>
      <el-tab-pane label="行为规范" name="behavior">
        <FormSection
          title="执行方式与工作要求"
          description="使用自然语言定义步骤和边界，技能仍由独立模块维护。"
        >
          <label class="field"
            >技能选择策略
            <el-select
              :disabled="busy"
              :model-value="draft.skillPolicy?.mode ?? 'legacy'"
              aria-label="技能选择策略"
              @update:model-value="
                patch({ skillPolicy: agentSkillPolicy($event, draft, catalog) })
              "
            >
              <el-option value="legacy" label="原有方法指令（兼容已有技能）" />
              <el-option value="auto" label="自动匹配已关联的阶段技能" />
              <el-option value="fixed" label="固定执行一个阶段技能" />
            </el-select>
          </label>
          <label v-if="draft.skillPolicy?.mode === 'fixed'" class="field"
            >固定技能
            <el-select
              :disabled="busy || disabled"
              :model-value="draft.skillPolicy.fixedSkillId"
              aria-label="固定技能"
              placeholder="请选择已发布的技能"
              @update:model-value="
                patch({ skillPolicy: { mode: 'fixed', fixedSkillId: $event } })
              "
            >
              <el-option
                v-for="item in catalog?.skills.filter(
                  (skill) => draft.skillIds.includes(skill.id) && skill.program,
                ) ?? []"
                :key="item.id"
                :value="item.id"
                :label="item.name"
              />
            </el-select>
          </label>
          <LongTextField
            data-field="instructions"
            :model-value="draft.instructions"
            label="工作要求"
            :min-rows="8"
            :max-rows="18"
            :maxlength="6000"
            :disabled="busy"
            expandable
            :error="issue?.field === 'instructions' ? issue.message : undefined"
            placeholder="描述步骤、输出格式，以及资料不足时如何处理。"
            @update:model-value="patch({ instructions: $event })"
          />
        </FormSection>
      </el-tab-pane>
      <el-tab-pane label="资源关联" name="resources">
        <FormSection
          title="选择可用的知识、技能和工具"
          description="这里管理资源关联。知识内容、技能定义和工具配置在各自菜单维护。"
        >
          <el-tabs
            v-model="resourceGroup"
            type="card"
            class="resource-group-tabs"
            aria-label="资源类型"
          >
            <el-tab-pane
              v-for="group in groups"
              :key="group.key"
              :name="group.key"
              :label="group.title + ' · ' + draft[group.key].length"
            >
              <ResourceChoices
                v-if="resourceGroup === group.key"
                :title="group.title"
                :items="group.items"
                :selected="draft[group.key]"
                :disabled="disabled || busy"
                @change="
                  (ids, id, checked) =>
                    emit(
                      'update:draft',
                      selectAgentResource(
                        draft,
                        group.key,
                        ids,
                        id,
                        checked,
                        catalog,
                      ),
                    )
                "
              />
            </el-tab-pane>
          </el-tabs>
        </FormSection>
      </el-tab-pane>
      <el-tab-pane label="示例与发布" name="examples">
        <FormSection
          title="让使用者知道如何开始"
          description="每项独立编辑，内容会用于工作台的智能体说明与示例。"
        >
          <StringListEditor
            :model-value="draft.recommendedPrompts"
            label="推荐指令"
            :maxlength="4000"
            :disabled="busy"
            placeholder="例如：清理费用表，按部门汇总并制作图表。"
            @update:model-value="patch({ recommendedPrompts: $event })"
          />
          <StringListEditor
            :model-value="draft.inputRequirements"
            label="输入要求"
            :maxlength="4000"
            :disabled="busy"
            placeholder="文件格式、必要字段、适用范围及限制。"
            @update:model-value="patch({ inputRequirements: $event })"
          />
          <StringListEditor
            :model-value="draft.outputExamples"
            label="输出示例"
            :maxlength="4000"
            :disabled="busy"
            placeholder="例如：可编辑的分析报告与图表。"
            @update:model-value="patch({ outputExamples: $event })"
          />
          <div class="agent-editor-publish">
            <el-checkbox
              :model-value="draft.published"
              :disabled="busy"
              @update:model-value="patch({ published: Boolean($event) })"
              >发布到工作台</el-checkbox
            >
            <p>
              发布后，具备会话执行权限的用户可以使用；未发布的草稿仅用于管理。
            </p>
          </div>
          <p class="agent-editor-note">
            修改用于新会话，已有会话保留原版本。保存时检查资料归属、技能依赖和工具状态，发布后可从“试用”验证任务。
          </p>
        </FormSection>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.agent-editor {
  min-width: 0;
}
.editor-sections :deep(.el-tabs__header) {
  margin: 0 0 24px;
}
.editor-sections :deep(.el-tabs__item) {
  padding: 0 20px;
}
.resource-group-tabs :deep(.el-tabs__header) {
  margin-bottom: 16px;
}
.agent-editor-publish {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}
.agent-editor-publish p {
  margin: 8px 0 0;
  color: var(--muted-foreground);
  font-size: 13px;
}
.agent-editor-note {
  padding: 12px 16px;
  margin: 0;
  border-radius: var(--radius-control);
  background: var(--muted);
  color: var(--muted-foreground);
  font-size: 13px;
}
@media (max-width: 767px) {
  .editor-sections :deep(.el-tabs__item) {
    padding: 0 12px;
  }
}
</style>
