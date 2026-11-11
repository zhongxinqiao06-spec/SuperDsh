<script setup lang="ts">
import ManagementList from '@/components/management/ManagementList.vue'
import RowActions from '@/components/management/RowActions.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import DateTime from '@/components/base/DateTime.vue'
import { useSkills } from '@/composables/skills/use-skills'
import { usePreferences } from '@/store/modules/preferences'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ResourceHistoryDialog from '@/components/overlay/ResourceHistoryDialog.vue'
import ResourceChoices from '@/components/form/ResourceChoices.vue'
import SkillProgramEditor from '@/views/skills/components/SkillProgramEditor.vue'
const vm = useSkills(),
  { tr } = usePreferences()
</script>
<template>
  <section class="page paged-page management-page resource-management-page">
    <PageHeader :title="tr('技能管理', 'Skills')" />
    <FilterBar class="toolbar" @submit="vm.filter">
      <el-input
        v-model="vm.query.value"
        clearable
        :placeholder="tr('搜索名称或描述', 'Search name or description')"
      /><el-button native-type="submit">{{ tr('搜索', 'Search') }}</el-button>

      <el-button @click="vm.matching.value = true">{{
        tr('匹配试验', 'Match preview')
      }}</el-button>
      <el-button @click="vm.openImport()">{{
        tr('导入技能包', 'Import skill')
      }}</el-button>
      <el-button type="primary" @click="vm.edit('new')">{{
        tr('新增技能', 'New skill')
      }}</el-button>
    </FilterBar>
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :has-data="Boolean(vm.resource.data.value)"
      :error="vm.resource.error.value || vm.catalog.error.value"
      @retry="vm.changed"
    /><ManagementList :page="vm.page.value" :page-size="vm.pageSize.value">
      <el-table
        :data="vm.resource.data.value?.items ?? []"
        :empty-text="
          vm.resource.error.value
            ? '技能加载失败，请重试。'
            : vm.resource.loading.value
              ? '正在加载技能…'
              : vm.query.value
                ? '没有匹配的技能。'
                : '暂无技能。'
        "
        ><el-table-column
          prop="name"
          :label="tr('名称与用途', 'Name and purpose')"
          min-width="180"
          ><template #default="{ row }"
            ><strong>{{ row.name }}</strong
            ><small class="resource-table-note">{{
              row.description
            }}</small></template
          ></el-table-column
        ><el-table-column :label="tr('状态', 'Status')"
          ><template #default="{ row }"
            ><el-tag :type="row.enabled ? 'success' : 'info'">{{
              row.enabled ? tr('启用', 'Enabled') : tr('停用', 'Disabled')
            }}</el-tag
            ><el-tag v-if="row.programDraft" type="warning">{{
              tr('有程序草稿', 'Program draft')
            }}</el-tag
            ><el-tag v-if="row.program">{{
              tr('已发布程序', 'Published program')
            }}</el-tag></template
          ></el-table-column
        ><el-table-column :label="tr('配置', 'Configuration')"
          ><template #default="{ row }"
            >依赖 {{ row.requiredToolIds.length }} 个工具<small
              class="resource-table-note"
              >版本 {{ row.version }}</small
            ></template
          ></el-table-column
        ><el-table-column :label="tr('最近更新', 'Updated')"
          ><template #default="{ row }"
            ><DateTime :value="row.updatedAt" /></template></el-table-column
        ><el-table-column :label="tr('操作', 'Actions')" min-width="270"
          ><template #default="{ row }"
            ><RowActions :busy="vm.mutation.busy.value">
              <el-button link @click="vm.edit(row)">{{
                tr('编辑', 'Edit')
              }}</el-button>
              <el-button
                v-if="row.programDraft"
                link
                @click="vm.publishing.value = row"
                >{{ tr('发布', 'Publish') }}</el-button
              >
              <el-button link @click="vm.history.value = row">{{
                tr('历史', 'History')
              }}</el-button>
              <el-button link @click="vm.openImport(row)">{{
                tr('更新包', 'Update package')
              }}</el-button>
              <el-button
                link
                class="danger-action"
                @click="vm.deleting.value = row"
                >{{ tr('删除', 'Delete') }}</el-button
              >
            </RowActions></template
          ></el-table-column
        ></el-table
      >
      <template #pagination>
        <ManagementPagination
          v-model:current-page="vm.page.value"
          v-model:page-size="vm.pageSize.value"
          :total="vm.resource.data.value?.total ?? 0"
          :page-sizes="[10, 20, 50]"
        />
      </template>
    </ManagementList>
    <ManagementDialog
      :model-value="vm.editing.value !== null"
      :title="
        vm.editing.value === 'new'
          ? tr('新增技能', 'New skill')
          : tr('编辑技能', 'Edit skill')
      "
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.editing.value = null"
      @submit="vm.save"
      ><label class="field"
        >{{ tr('名称', 'Name')
        }}<el-input v-model="vm.draft.name" maxlength="100" /></label
      ><label class="field"
        >{{ tr('用途说明', 'Purpose')
        }}<el-input
          v-model="vm.draft.description"
          type="textarea"
          maxlength="500"
      /></label>
      <SkillProgramEditor
        v-model="vm.draft.programDraft"
        :tools="vm.catalog.data.value?.tools ?? []"
        :skills="
          (vm.catalog.data.value?.skills ?? []).filter(
            (skill) =>
              vm.editing.value === 'new' || skill.id !== vm.editing.value?.id,
          )
        "
      />
      <label class="field"
        >{{ tr('执行要求', 'Instructions')
        }}<el-input
          v-model="vm.draft.instructions"
          type="textarea"
          :rows="8"
          maxlength="12000"
          show-word-limit
      /></label>
      <ResourceChoices
        :title="tr('依赖工具', 'Required tools')"
        :items="vm.catalog.data.value?.tools ?? []"
        :selected="vm.draft.requiredToolIds"
        :empty="tr('暂无工具。', 'No tools available.')"
        @change="vm.draft.requiredToolIds = $event"
      />
      <div v-if="vm.draft.references?.length">
        <h3>{{ tr('包内资料引用', 'Package references') }}</h3>
        <ul>
          <li v-for="reference in vm.draft.references" :key="reference.path">
            {{ reference.path }} ·
            <code>{{ reference.sha256.slice(0, 12) }}</code>
          </li>
        </ul>
      </div>
      <el-checkbox v-model="vm.draft.enabled">{{
        tr('启用', 'Enabled')
      }}</el-checkbox>
    </ManagementDialog>
    <ManagementDialog
      :model-value="vm.deleting.value !== null"
      :title="tr('删除技能', 'Delete skill')"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.deleting.value = null"
      @submit="vm.remove"
      ><p>
        {{
          tr(
            '仍被智能体引用的技能不能删除。',
            'Skills referenced by agents cannot be deleted.',
          )
        }}
        {{ vm.deleting.value?.name }}
      </p></ManagementDialog
    >
    <ManagementDialog
      :model-value="vm.publishing.value !== null"
      :title="tr('发布技能程序', 'Publish skill program')"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.publishing.value = null"
      @submit="vm.publish"
      ><p>
        {{
          tr(
            '发布将校验工具、阶段和引用，新会话使用新版本。已有会话保留冻结版本。',
            'Publishing validates tools, stages and references. New sessions use the new revision; existing bindings stay pinned.',
          )
        }}
      </p></ManagementDialog
    >
    <ManagementDialog
      v-model="vm.importing.value"
      :title="tr('导入技能包', 'Import skill package')"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @submit="vm.importPackage"
      ><p v-if="vm.importTarget.value">
        {{ tr('更新技能', 'Update skill') }}：{{ vm.importTarget.value.name }}
      </p>
      <el-radio-group v-model="vm.importKind.value"
        ><el-radio value="package">{{
          tr('数据ZIP包', 'Data ZIP package')
        }}</el-radio
        ><el-radio value="extension">{{
          tr('已安装扩展', 'Installed extension')
        }}</el-radio></el-radio-group
      ><input
        v-if="vm.importKind.value === 'package'"
        type="file"
        accept=".zip,application/zip"
        :aria-label="tr('技能ZIP包', 'Skill ZIP package')"
        @change="vm.fileSelected" /><template v-else
        ><label class="field"
          >{{ tr('来源', 'Source')
          }}<el-select v-model="vm.sourceId.value"
            ><el-option
              v-for="source in (vm.sources.data.value ?? []).filter(
                (item) => item.enabled && item.skills?.length,
              )"
              :key="source.id"
              :value="source.id"
              :label="source.name" /></el-select></label
        ><label class="field"
          >{{ tr('来源版本', 'Source version')
          }}<el-input v-model="vm.sourceVersion.value" /></label
        ><label class="field"
          >{{ tr('来源技能', 'Source skill')
          }}<el-select v-model="vm.sourceSkill.value"
            ><el-option
              v-for="skill in vm.sources.data.value?.find(
                (item) => item.id === vm.sourceId.value,
              )?.skills ?? []"
              :key="skill.id"
              :value="skill.id"
              :label="skill.name" /></el-select></label></template
      ><label class="field"
        >{{ tr('绑定已有工具配置', 'Bind existing tool configurations')
        }}<el-select v-model="vm.importTools.value" multiple filterable
          ><el-option
            v-for="tool in vm.catalog.data.value?.tools ?? []"
            :key="tool.id"
            :value="tool.id"
            :label="tool.name"
            :disabled="!tool.enabled" /></el-select></label
    ></ManagementDialog>
    <ManagementDialog
      v-model="vm.matching.value"
      :title="tr('技能匹配预览', 'Skill match preview')"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @submit="vm.match"
      ><label class="field"
        >{{ tr('用户请求', 'User request')
        }}<el-input
          v-model="vm.matchRequest.value"
          type="textarea"
          :rows="4" /></label
      ><label class="field"
        >{{ tr('附件扩展名', 'Attachment extensions')
        }}<el-select
          v-model="vm.matchExtensions.value"
          multiple
          filterable
          allow-create /></label
      ><label class="field"
        >{{ tr('限定技能（留空使用全部）', 'Limit skills (blank for all)')
        }}<el-select v-model="vm.matchSkills.value" multiple filterable
          ><el-option
            v-for="skill in vm.catalog.data.value?.skills ?? []"
            :key="skill.id"
            :value="skill.id"
            :label="skill.name" /></el-select></label
      ><el-empty
        v-if="vm.candidates.value?.length === 0"
        :description="
          tr('没有可匹配的已发布程序', 'No published program candidates')
        "
      />
      <article
        v-for="candidate in vm.candidates.value ?? []"
        :key="candidate.id"
        class="panel"
      >
        <strong>{{ candidate.name }} · {{ candidate.score }}</strong>
        <p>
          {{
            candidate.reasons.join('；') ||
            tr('未命中触发短语', 'No trigger phrases matched')
          }}
        </p>
        <p>{{ candidate.outputTypes.join(', ') }}</p>
      </article></ManagementDialog
    >
    <ResourceHistoryDialog
      v-if="vm.history.value"
      :resource="vm.history.value"
      kind="skills"
      @close="vm.history.value = null"
      @changed="vm.changed"
    />
  </section>
</template>
