<script setup lang="ts">
import type { SkillProgram, SkillStage } from '@/types/skills/skills'
import type { SelectableResource } from '@/types/agents/agents'
import type { JsonSchema } from '@/types/tools/tools'
import { emptyProgram, newStage } from '@/utils/skills/program'
import {
  documentSkillProgram,
  withMultimodalTools,
} from '@/utils/skills/program-presets'
import { usePreferences } from '@/store/modules/preferences'
const model = defineModel<SkillProgram | null | undefined>({ required: true })
defineProps<{ tools: SelectableResource[]; skills: SelectableResource[] }>()
const { tr } = usePreferences()
const operations = [
  ['submit', '提交', 'Submit'],
  ['inspect', '检查资料', 'Inspect'],
  ['prepare', '准备与确认', 'Prepare'],
  ['execute', '执行', 'Execute'],
  ['review', '审核', 'Review'],
] as const
const checkOptions = [
  ['schema', '输出Schema', 'Output schema'],
  ['sources', '资料证据', 'Source evidence'],
  ['plan', '方案', 'Plan'],
  ['artifact', '成果文件', 'Artifact'],
  ['rendered-quality', '渲染质量', 'Rendered quality'],
] as const
const matchFields = [
  ['phrases', '匹配词（每行一项）', 'Matching phrases (one per line)'],
  ['excludePhrases', '排除词', 'Exclusion phrases'],
  [
    'inputExtensions',
    '输入扩展名（空表示不限）',
    'Input extensions (empty for any)',
  ],
  ['outputTypes', '输出类型', 'Output types'],
  ['examples', '适用请求示例', 'Example requests'],
] as const
function add() {
  if (model.value) model.value.stages.push(newStage(model.value.stages))
}
function move(index: number, offset: number) {
  if (!model.value) return
  const stages = [...model.value.stages],
    stage = stages.splice(index, 1)[0]
  if (stage) {
    stages.splice(index + offset, 0, stage)
    model.value = { ...model.value, stages }
  }
}
function schema(stage: SkillStage, event: Event) {
  const input = event.target as HTMLTextAreaElement
  try {
    const value: unknown = JSON.parse(input.value)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error()
    stage.outputSchema = value as JsonSchema
    input.setCustomValidity('')
  } catch {
    input.setCustomValidity(
      tr('请输入有效的Schema对象', 'Enter a valid schema object'),
    )
  }
}
</script>
<template>
  <fieldset class="skill-program-editor stack">
    <legend>{{ tr('自动匹配与阶段配置', 'Matching and stages') }}</legend>
    <p class="muted">
      {{
        tr(
          '保存只更新草稿；发布后供新会话选择。普通文本技能无需阶段程序。',
          'Saving updates the draft. Publish it for new sessions. Text skills do not require stages.',
        )
      }}
    </p>
    <div class="toolbar">
      <el-button @click="model = documentSkillProgram('ppt')">{{
        tr('使用 PPT 流程起点', 'Start with PPT stages')
      }}</el-button>
      <el-button @click="model = documentSkillProgram('word')">{{
        tr('使用 Word 流程起点', 'Start with Word stages')
      }}</el-button>
      <el-button
        v-if="model"
        :disabled="!model.stages.some((stage) => stage.operation === 'submit')"
        @click="model = withMultimodalTools(model)"
        >{{ tr('补齐多模态工具', 'Add multimodal tools') }}</el-button
      >
      <el-button v-if="!model" @click="model = emptyProgram()">{{
        tr('启用阶段程序', 'Add a stage program')
      }}</el-button
      ><el-button v-else @click="model = null">{{
        tr('撤销阶段草稿', 'Discard stage draft')
      }}</el-button>
    </div>

    <template v-if="model"
      ><label v-for="[key, zh, en] in matchFields" :key="key" class="field"
        >{{ tr(zh, en)
        }}<el-input
          :model-value="model.match[key].join('\n')"
          type="textarea"
          :rows="2"
          @update:model-value="model.match[key] = $event.split('\n')"
      /></label>
      <div class="toolbar">
        <label class="field"
          >{{ tr('最大修订次数', 'Maximum revisions')
          }}<el-input-number
            v-model="model.maxRevisions"
            :aria-label="tr('最大修订次数', 'Maximum revisions')"
            :min="0"
            :max="5" /></label
        ><label class="field"
          >{{ tr('单次工具执行时限（秒）', 'Tool execution timeout (seconds)')
          }}<el-input-number
            v-model="model.timeoutSeconds"
            :aria-label="
              tr('单次工具执行时限（秒）', 'Tool execution timeout (seconds)')
            "
            :min="30"
            :max="3600"
        /></label>
      </div>
      <details
        v-for="(stage, index) in model.stages"
        :key="index"
        class="skill-stage"
        open
      >
        <summary>
          {{ index + 1 }}. {{ stage.name || tr('新阶段', 'New stage') }}
        </summary>
        <div class="stack">
          <div class="toolbar">
            <strong>{{ tr('阶段', 'Stage') }} {{ index + 1 }}</strong
            ><el-button :disabled="index === 0" @click="move(index, -1)"
              >↑</el-button
            ><el-button
              :disabled="index === model.stages.length - 1"
              @click="move(index, 1)"
              >↓</el-button
            ><el-button
              type="danger"
              plain
              @click="model.stages.splice(index, 1)"
              >{{ tr('移除阶段', 'Remove stage') }}</el-button
            >
          </div>
          <label class="field"
            >{{ tr('阶段标识', 'Stage ID')
            }}<el-input v-model="stage.id" maxlength="100" /></label
          ><label class="field"
            >{{ tr('阶段名称', 'Stage name')
            }}<el-input v-model="stage.name" maxlength="100" /></label
          ><label class="field"
            >{{ tr('阶段操作', 'Operation')
            }}<el-select v-model="stage.operation"
              ><el-option
                v-for="[key, zh, en] in operations"
                :key="key"
                :value="key"
                :label="tr(zh, en)" /></el-select></label
          ><label class="field"
            >{{ tr('阶段指令', 'Instructions')
            }}<el-input
              v-model="stage.instructions"
              type="textarea"
              :rows="4"
              maxlength="6000" /></label
          ><label class="field"
            >{{ tr('引用资料技能（可选）', 'Reference skill (optional)')
            }}<el-select v-model="stage.skillId" clearable filterable
              ><el-option
                v-for="skill in skills"
                :key="skill.id"
                :value="skill.id"
                :label="skill.name" /></el-select></label
          ><label class="field"
            >{{ tr('授权工具', 'Authorized tools')
            }}<el-select v-model="stage.toolIds" multiple filterable
              ><el-option
                v-for="tool in tools"
                :key="tool.id"
                :value="tool.id"
                :label="tool.name"
                :disabled="!tool.enabled" /></el-select></label
          ><label v-if="stage.operation === 'submit'" class="field"
            >{{ tr('辅助检查工具', 'Inspection helpers')
            }}<el-select v-model="stage.inspectToolIds" multiple filterable
              ><el-option
                v-for="tool in tools"
                :key="tool.id"
                :value="tool.id"
                :label="tool.name"
                :disabled="!tool.enabled" /></el-select></label
          ><label class="field"
            >{{ tr('校验器', 'Checks')
            }}<el-select v-model="stage.checks" multiple
              ><el-option
                v-for="[key, zh, en] in checkOptions"
                :key="key"
                :value="key"
                :label="tr(zh, en)" /></el-select
          ></label>
          <details>
            <summary>
              {{ tr('输出 JSON Schema', 'Output JSON Schema') }}
            </summary>
            <p class="muted">
              {{
                tr(
                  '仅定义当前阶段结果的结构，不能声明执行权限。',
                  'Defines the stage output structure, without granting execution permissions.',
                )
              }}
            </p>
            <textarea
              :value="JSON.stringify(stage.outputSchema, null, 2)"
              rows="8"
              class="schema-editor"
              :aria-label="tr('阶段输出Schema', 'Stage output schema')"
              @input="schema(stage, $event)"
            />
          </details>
        </div>
      </details>
      <el-button :disabled="model.stages.length >= 20" @click="add">{{
        tr('添加阶段', 'Add stage')
      }}</el-button></template
    >
  </fieldset>
</template>
<style scoped>
.skill-program-editor {
  gap: 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  padding: 16px;
}
.skill-program-editor > .muted {
  margin: 0;
  font-size: 12px;
}
.skill-program-editor > .field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.skill-program-editor > .field :deep(.el-textarea__inner) {
  height: 64px;
  min-height: 64px !important;
  resize: none;
}
.skill-program-editor legend {
  padding: 0 4px;
  font-weight: 500;
}
.skill-stage {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.skill-stage > summary {
  cursor: pointer;
  font-weight: 500;
}
.skill-stage > .stack {
  margin-top: 12px;
}
.schema-editor {
  width: 100%;
  padding: 12px;
  font-family: monospace;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
}
</style>
